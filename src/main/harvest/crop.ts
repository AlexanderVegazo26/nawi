import { decodePng, encodePng, type RgbImage } from '../mobile/png'
import { MIN_ANCHOR_SIDE } from '../replay/visual-anchor'

/**
 * Reference crops for the visual-anchor locator layer (roadmap AI1), cut at
 * record time. The harvest takes a lossless screenshot of the viewport when the
 * user presses on an element and keeps only the element's box, at one image
 * px per CSS px: the same scale the replayer brings its own screenshot to
 * (`scaleImage` by the viewport size), so a recorded crop matches 1:1.
 */

/** `[x, y, width, height]` in CSS px of the viewport. */
export type CropBox = readonly [number, number, number, number]

/** Largest side the page probe allows (probe.js CROP_MAX_SIDE); anything bigger here is a forged request. */
export const MAX_CROP_SIDE = 640
/** Largest viewport side accepted from the page, CSS px. */
const MAX_VIEWPORT_SIDE = 16_384

/** The request's box and viewport if they are plausible, else null (the page sends them, so nothing is trusted). */
export function parseShotRequest(box: unknown, viewport: unknown): { box: CropBox; viewport: [number, number] } | null {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  if (!Array.isArray(viewport) || viewport.length !== 2) return null
  const [vw, vh] = viewport as unknown[]
  if (!Number.isInteger(vw) || !Number.isInteger(vh)) return null
  const w = vw as number
  const h = vh as number
  if (w <= 0 || h <= 0 || w > MAX_VIEWPORT_SIDE || h > MAX_VIEWPORT_SIDE) return null
  const [x, y, bw, bh] = box as number[]
  if (bw < MIN_ANCHOR_SIDE || bh < MIN_ANCHOR_SIDE || bw > MAX_CROP_SIDE || bh > MAX_CROP_SIDE) return null
  if (x < 0 || y < 0 || x + bw > w || y + bh > h) return null
  return { box: [x, y, bw, bh], viewport: [w, h] }
}

/**
 * The PNG of `box` cut from a viewport screenshot (`png`, device px), scaled to
 * CSS px first exactly as the replayer scales its screenshot, or null when the
 * screenshot can't be read or the box rounds to less than MIN_ANCHOR_SIDE.
 */
export function cropFromShot(png: Uint8Array, viewport: readonly [number, number], box: CropBox): Uint8Array | null {
  const decoded = decodePng(png)
  if (!decoded.ok) return null
  const x0 = Math.max(0, Math.round(box[0]))
  const y0 = Math.max(0, Math.round(box[1]))
  const x1 = Math.min(viewport[0], Math.round(box[0] + box[2]))
  const y1 = Math.min(viewport[1], Math.round(box[1] + box[3]))
  if (x1 - x0 < MIN_ANCHOR_SIDE || y1 - y0 < MIN_ANCHOR_SIDE) return null
  return encodePng(scaledRegion(decoded.image, viewport[0], viewport[1], x0, y0, x1, y1))
}

/**
 * The pixels `[x0, x1) x [y0, y1)` of `scaleImage(image, width, height)`,
 * computed for that region only (the same area average on the same grid, so
 * the result is identical), instead of scaling a whole 4K screenshot on the
 * main thread to keep one button.
 */
export function scaledRegion(image: RgbImage, width: number, height: number, x0: number, y0: number, x1: number, y1: number): RgbImage {
  const sx = image.width / width
  const sy = image.height / height
  const w = x1 - x0
  const h = y1 - y0
  const rgb = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    const ya = Math.floor((y0 + y) * sy)
    const yb = Math.max(ya + 1, Math.min(image.height, Math.floor((y0 + y + 1) * sy)))
    for (let x = 0; x < w; x++) {
      const xa = Math.floor((x0 + x) * sx)
      const xb = Math.max(xa + 1, Math.min(image.width, Math.floor((x0 + x + 1) * sx)))
      let r = 0
      let g = 0
      let b = 0
      for (let yy = ya; yy < yb; yy++) {
        for (let xx = xa; xx < xb; xx++) {
          const k = (yy * image.width + xx) * 3
          r += image.rgb[k]
          g += image.rgb[k + 1]
          b += image.rgb[k + 2]
        }
      }
      const n = (yb - ya) * (xb - xa)
      const o = (y * w + x) * 3
      rgb[o] = Math.round(r / n)
      rgb[o + 1] = Math.round(g / n)
      rgb[o + 2] = Math.round(b / n)
    }
  }
  return { width: w, height: h, rgb }
}
