import { describe, expect, it } from 'vitest'
import { decodePng, encodePng, type RgbImage } from '../mobile/png'
import { findAnchor, scaleImage } from '../replay/visual-anchor'
import { cropFromShot, MAX_CROP_SIDE, parseShotRequest, scaledRegion } from './crop'

/** A seeded pseudo-random "UI": flat panels with distinct, textured buttons, at `scale` device px per CSS px. */
function page(cssWidth: number, cssHeight: number, scale: number, seed = 7): RgbImage {
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32)
  const width = Math.round(cssWidth * scale)
  const height = Math.round(cssHeight * scale)
  const css = new Uint8Array(cssWidth * cssHeight * 3).fill(245)
  // Buttons: 40x16 CSS px blocks, each with its own noise so no two look alike.
  for (let by = 4; by + 16 < cssHeight; by += 24) {
    for (let bx = 4; bx + 40 < cssWidth; bx += 52) {
      for (let y = by; y < by + 16; y++) for (let x = bx; x < bx + 40; x++) css.fill(Math.floor(rand() * 200), (y * cssWidth + x) * 3, (y * cssWidth + x) * 3 + 3)
    }
  }
  // Nearest-neighbour up to device px, as a renderer at that DPR would draw flat colours.
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (Math.min(cssHeight - 1, Math.floor(y / scale)) * cssWidth + Math.min(cssWidth - 1, Math.floor(x / scale))) * 3
      rgb.set(css.subarray(k, k + 3), (y * width + x) * 3)
    }
  }
  return { width, height, rgb }
}

describe('parseShotRequest — the page asks for a crop; nothing it sends is trusted', () => {
  it('accepts a control-sized box fully inside an integer viewport', () => {
    expect(parseShotRequest([10, 20.5, 80, 24], [1280, 800])).toEqual({ box: [10, 20.5, 80, 24], viewport: [1280, 800] })
  })

  it.each([
    ['a box with three numbers', [1, 2, 3], [100, 100]],
    ['a non-finite coordinate', [Number.NaN, 2, 30, 30], [100, 100]],
    ['a string coordinate', ['1', 2, 30, 30], [100, 100]],
    ['a side below the anchor minimum', [0, 0, 7, 30], [100, 100]],
    [`a side above ${MAX_CROP_SIDE} px`, [0, 0, MAX_CROP_SIDE + 1, 30], [2000, 2000]],
    ['a box starting left of the viewport', [-0.5, 0, 30, 30], [100, 100]],
    ['a box ending below the viewport', [0, 80, 30, 30], [100, 100]],
    ['a fractional viewport', [0, 0, 30, 30], [100.5, 100]],
    ['a zero viewport', [0, 0, 30, 30], [0, 100]],
    ['a huge viewport', [0, 0, 30, 30], [20_000, 100]],
    ['a viewport that is not a pair', [0, 0, 30, 30], [100]]
  ])('refuses %s', (_label, box, viewport) => {
    expect(parseShotRequest(box, viewport), `box ${JSON.stringify(box)} in viewport ${JSON.stringify(viewport)}`).toBeNull()
  })
})

describe('cropFromShot — a recorded crop is what the replayer will look for', () => {
  it.each([1, 1.5, 2])('at DPR %s the crop of a button is found again by findAnchor at the same CSS position', (dpr) => {
    const css = { w: 320, h: 200 }
    const shot = page(css.w, css.h, dpr)
    const box = [56, 28, 40, 16] as const // the second button of the second row
    const crop = cropFromShot(encodePng(shot), [css.w, css.h], box)
    if (!crop) throw new Error(`no crop at DPR ${dpr}`)
    const decoded = decodePng(crop)
    if (!decoded.ok) throw new Error(decoded.error)
    expect([decoded.image.width, decoded.image.height], 'one image px per CSS px').toEqual([40, 16])

    // What the replayer does on a later run: shoot the same viewport, scale it to CSS px, match.
    const match = findAnchor(scaleImage(shot, css.w, css.h), decoded.image)
    expect(match, `match at DPR ${dpr}`).toMatchObject({ found: 1, x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 })
  })

  it('rounds a fractional box to whole CSS px', () => {
    const crop = cropFromShot(encodePng(page(100, 60, 1)), [100, 60], [4.4, 4.6, 39.8, 15.8])
    const decoded = crop && decodePng(crop)
    if (!decoded || !decoded.ok) throw new Error('no crop')
    expect([decoded.image.width, decoded.image.height], 'x 4..44, y 5..20').toEqual([40, 15])
  })

  it('returns null for bytes that are not a PNG, and for a box that rounds below the minimum side', () => {
    expect(cropFromShot(new Uint8Array([1, 2, 3]), [100, 60], [0, 0, 20, 20]), 'not a PNG').toBeNull()
    expect(cropFromShot(encodePng(page(100, 60, 1)), [100, 60], [0, 0, 7.4, 20]), '7.4 px rounds to 7').toBeNull()
  })
})

describe('encodePng', () => {
  it('round-trips through decodePng losslessly', () => {
    const image = page(37, 23, 1, 3)
    const back = decodePng(encodePng(image))
    if (!back.ok) throw new Error(back.error)
    expect(back.image.width).toBe(37)
    expect(back.image.height).toBe(23)
    expect(Buffer.compare(Buffer.from(back.image.rgb), Buffer.from(image.rgb)), 'pixels differ after a round trip').toBe(0)
  })

  it('refuses an image whose pixel buffer does not match its size', () => {
    expect(() => encodePng({ width: 2, height: 2, rgb: new Uint8Array(11) })).toThrow(/2x2 image with 11 bytes/)
  })
})

describe('scaledRegion', () => {
  it.each([
    [1, 'same size'],
    [1.5, 'fractional DPR'],
    [2, 'DPR 2'],
    [0.75, 'a screenshot smaller than the viewport']
  ])('is pixel-identical to the same region of scaleImage at scale %s (%s)', (scale) => {
    const shot = page(150, 90, scale, 11)
    const full = scaleImage(shot, 150, 90)
    const [x0, y0, x1, y1] = [7, 5, 61, 40]
    const region = scaledRegion(shot, 150, 90, x0, y0, x1, y1)
    const want = new Uint8Array((x1 - x0) * (y1 - y0) * 3)
    for (let y = y0; y < y1; y++) want.set(full.rgb.subarray((y * 150 + x0) * 3, (y * 150 + x1) * 3), (y - y0) * (x1 - x0) * 3)
    expect([region.width, region.height]).toEqual([x1 - x0, y1 - y0])
    expect(Buffer.compare(Buffer.from(region.rgb), Buffer.from(want)), 'region differs from scaleImage').toBe(0)
  })
})

