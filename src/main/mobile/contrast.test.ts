import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../../shared/wcag'
import { colorHex, formatRatio, measureTextContrast, type ContrastMeasure } from './contrast'
import { canvas } from './fixtures/make-png'

/**
 * Roadmap M3b2: the contrast of one text on a screenshot, from the pixels inside its bounds. Painted screenshots
 * with known colours pin what is taken as the text and the background, and that the measure refuses (instead of
 * reporting a false failure) when the box is too busy or shows no text.
 */

const BOX = { left: 40, top: 100, right: 1040, bottom: 250 }

function measured(m: ContrastMeasure): { text: string; background: string; ratio: number } {
  if (!m.ok) throw new Error(`expected a measurement, got ${m.reason}`)
  return { text: colorHex(m.contrast.text), background: colorHex(m.contrast.background), ratio: m.contrast.ratio }
}

describe('measureTextContrast', () => {
  it('takes the most common colour as the background and the core stroke colour as the text, not the anti-aliased edge', () => {
    const img = canvas(1080, 400, [255, 255, 255])
    img.text(BOX.left, BOX.top, BOX.right, BOX.bottom, [33, 33, 33], [150, 150, 150])
    const m = measured(measureTextContrast(img, BOX))
    expect(m, 'dark grey text with a mid-grey edge on white').toEqual({ text: '#212121', background: '#ffffff', ratio: contrastRatio({ r: 33, g: 33, b: 33 }, { r: 255, g: 255, b: 255 }) })
    expect(m.ratio).toBeGreaterThan(15)
  })

  it('measures light text on a dark background (dark theme) the same way', () => {
    const img = canvas(1080, 400, [18, 18, 18])
    img.text(BOX.left, BOX.top, BOX.right, BOX.bottom, [255, 255, 255])
    expect(measured(measureTextContrast(img, BOX))).toMatchObject({ text: '#ffffff', background: '#121212' })
  })

  it('reports grey text just under 4.5:1 below it (#777 on white is 4.47:1, never rounded up)', () => {
    const img = canvas(1080, 400, [255, 255, 255])
    img.text(BOX.left, BOX.top, BOX.right, BOX.bottom, [0x77, 0x77, 0x77])
    const m = measured(measureTextContrast(img, BOX))
    expect(m.ratio, '#777777 on #ffffff').toBeLessThan(4.5)
    expect(formatRatio(m.ratio)).toBe('4.47:1')
  })

  it('finds the text colour of a short thin label in a full-width view (glyphs under 1% of the box)', () => {
    const img = canvas(1080, 400, [255, 255, 255])
    // "OK" as two 3 px strokes 75 px tall (450 px, 0.3% of the 1000x150 box) with a grey anti-aliased edge.
    for (const x of [500, 520]) {
      img.rect(x, 140, x + 3, 215, [33, 33, 33])
      img.rect(x - 1, 140, x, 215, [160, 160, 160])
      img.rect(x + 3, 140, x + 4, 215, [160, 160, 160])
    }
    expect(measured(measureTextContrast(img, BOX)), 'the core, not the edge').toMatchObject({ text: '#212121', background: '#ffffff' })
  })

  it('only looks inside the bounds: a black bar just outside the box changes nothing', () => {
    const img = canvas(1080, 400, [255, 255, 255])
    img.text(BOX.left, BOX.top, BOX.right, BOX.bottom, [0x99, 0x99, 0x99])
    img.rect(0, BOX.bottom, 1080, BOX.bottom + 40, [0, 0, 0])
    img.rect(0, 0, BOX.left, 400, [0, 0, 0])
    expect(measured(measureTextContrast(img, BOX)).text).toBe('#999999')
  })

  it('refuses a busy background (a photo or gradient) instead of guessing', () => {
    const img = canvas(1080, 400, [255, 255, 255])
    for (let x = BOX.left; x < BOX.right; x++) img.rect(x, BOX.top, x + 1, BOX.bottom, [x % 256, (x * 3) % 256, 128])
    img.text(BOX.left, BOX.top, BOX.right, BOX.bottom, [0, 0, 0])
    expect(measureTextContrast(img, BOX)).toEqual({ ok: false, reason: 'busy_background' })
  })

  it('refuses a box with no text pixels (one colour, or a speck too small to be text) and a box too small to read', () => {
    const img = canvas(1080, 400, [240, 240, 240])
    expect(measureTextContrast(img, BOX), 'one colour').toEqual({ ok: false, reason: 'no_text_pixels' })
    img.rect(500, 150, 502, 152, [0, 0, 0])
    expect(measureTextContrast(img, BOX), 'a 2x2 speck in a 1000x150 box').toEqual({ ok: false, reason: 'no_text_pixels' })
    expect(measureTextContrast(img, { left: 10, top: 10, right: 12, bottom: 12 })).toEqual({ ok: false, reason: 'too_small' })
  })

  it('clamps bounds that reach past the image to the part on it', () => {
    const img = canvas(1080, 400, [255, 255, 255])
    img.text(900, 300, 1080, 400, [0, 0, 0])
    expect(measured(measureTextContrast(img, { left: 900, top: 300, right: 1200, bottom: 520 })).text).toBe('#000000')
    expect(measureTextContrast(img, { left: 2000, top: 0, right: 2100, bottom: 100 }), 'entirely off the image').toEqual({ ok: false, reason: 'too_small' })
  })

  it('samples a full-screen box on a grid and still finds the text colour, and leaves no state behind between boxes', () => {
    const img = canvas(1080, 2400, [250, 250, 250])
    img.text(0, 0, 1080, 2400, [10, 10, 120])
    const full = { left: 0, top: 0, right: 1080, bottom: 2400 }
    expect(measured(measureTextContrast(img, full))).toMatchObject({ text: '#0a0a78', background: '#fafafa' })
    // A second, different box right after: counts from the first must not leak into it.
    const other = canvas(1080, 400, [0, 0, 0])
    other.text(BOX.left, BOX.top, BOX.right, BOX.bottom, [200, 200, 0])
    expect(measured(measureTextContrast(other, BOX))).toMatchObject({ text: '#c8c800', background: '#000000' })
  })
})

describe('formatRatio', () => {
  it('truncates to two decimals so a ratio under a threshold never prints as the threshold', () => {
    expect(formatRatio(4.4999)).toBe('4.49:1')
    expect(formatRatio(21)).toBe('21.00:1')
    expect(formatRatio(2.999)).toBe('2.99:1')
  })
})
