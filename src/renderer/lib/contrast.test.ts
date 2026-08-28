import { describe, expect, it } from 'vitest'
import {
  averageRgb,
  contrastRatio,
  formatRatio,
  luminanceExtremes,
  parseHexColor,
  pickTextColor,
  relativeLuminance,
  requiredRatio
} from './contrast'

/**
 * FR-ANN.4 / UX-ANN.5. The requirement is a *measured* WCAG ratio, so these
 * assert against values published in the WCAG 2.x definition rather than
 * against whatever the implementation happens to return.
 */

describe('parseHexColor', () => {
  it('reads long, short and alpha forms', () => {
    expect(parseHexColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0 })
    expect(parseHexColor('#f00')).toEqual({ r: 255, g: 0, b: 0 })
    expect(parseHexColor('4c8dff')).toEqual({ r: 0x4c, g: 0x8d, b: 0xff })
    // Alpha is parsed off and ignored — contrast is defined on the composited
    // colour, and a caller passing 8 digits still wants the RGB.
    expect(parseHexColor('#00ff0080')).toEqual({ r: 0, g: 255, b: 0 })
  })

  it('returns null rather than a wrong colour', () => {
    expect(parseHexColor('rgb(1,2,3)')).toBeNull()
    expect(parseHexColor('#gg0000')).toBeNull()
    expect(parseHexColor('')).toBeNull()
  })
})

describe('relativeLuminance', () => {
  it('matches the sRGB definition at the endpoints', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0)
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 10)
  })

  it('weights green far above blue', () => {
    const g = relativeLuminance({ r: 0, g: 255, b: 0 })
    const b = relativeLuminance({ r: 0, g: 0, b: 255 })
    expect(g).toBeCloseTo(0.7152, 4)
    expect(b).toBeCloseTo(0.0722, 4)
  })
})

describe('contrastRatio', () => {
  it('gives 21:1 for black on white', () => {
    expect(
      contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })
    ).toBeCloseTo(21, 6)
  })

  it('gives 1:1 for a colour against itself', () => {
    expect(contrastRatio({ r: 90, g: 151, b: 255 }, { r: 90, g: 151, b: 255 })).toBeCloseTo(1, 10)
  })

  it('is order-independent', () => {
    const a = { r: 17, g: 96, b: 216 }
    const b = { r: 246, g: 247, b: 249 }
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10)
  })
})

describe('requiredRatio', () => {
  it('uses the bold large-text threshold at 14pt and above', () => {
    // 14pt bold == 18.667px, the SC 1.4.3 large-text boundary for bold text.
    expect(requiredRatio(18.667)).toBe(3)
    expect(requiredRatio(24)).toBe(3)
    expect(requiredRatio(18.6)).toBe(4.5)
    expect(requiredRatio(16)).toBe(4.5)
  })

  it('uses the 18pt boundary when the text is not bold', () => {
    expect(requiredRatio(20, false)).toBe(4.5)
    expect(requiredRatio(24, false)).toBe(3)
  })
})

/** Builds an RGBA run from a list of opaque colours. */
function rgba(colors: Array<[number, number, number]>, alpha = 255): Uint8ClampedArray {
  const out = new Uint8ClampedArray(colors.length * 4)
  colors.forEach(([r, g, b], i) => {
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = alpha
  })
  return out
}

describe('averageRgb', () => {
  it('averages opaque pixels', () => {
    expect(averageRgb(rgba([[0, 0, 0], [255, 255, 255]]))).toEqual({ r: 128, g: 128, b: 128 })
  })

  it('skips fully transparent pixels rather than pulling the mean toward black', () => {
    const px = rgba([[255, 255, 255], [0, 0, 0]])
    px[7] = 0 // make the black pixel transparent
    expect(averageRgb(px)).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('returns null when nothing was sampled', () => {
    expect(averageRgb(new Uint8ClampedArray(0))).toBeNull()
    expect(averageRgb(rgba([[1, 2, 3]], 0))).toBeNull()
  })
})

describe('luminanceExtremes', () => {
  it('finds the darkest and lightest sampled pixels', () => {
    const ext = luminanceExtremes(rgba([[128, 128, 128], [10, 10, 10], [240, 240, 240]]))
    expect(ext?.min).toEqual({ r: 10, g: 10, b: 10 })
    expect(ext?.max).toEqual({ r: 240, g: 240, b: 240 })
  })

  it('returns null for an empty sample', () => {
    expect(luminanceExtremes(new Uint8ClampedArray(0))).toBeNull()
  })
})

describe('pickTextColor', () => {
  const white = { r: 255, g: 255, b: 255 }
  const black = { r: 0, g: 0, b: 0 }

  it('picks black on a light background and reports the real ratio', () => {
    const c = pickTextColor(white, 24)
    expect(c.color).toBe('#000000')
    expect(c.ratio).toBeCloseTo(21, 6)
    expect(c.meetsAA).toBe(true)
    expect(c.required).toBe(3)
  })

  it('picks white on a dark background', () => {
    const c = pickTextColor(black, 16)
    expect(c.color).toBe('#ffffff')
    expect(c.meetsAA).toBe(true)
    expect(c.required).toBe(4.5)
  })

  it('ranks on the worst-case pixel, not the average', () => {
    // Mean is mid-grey, so either candidate looks acceptable "on average" —
    // but the sample spans pure black and pure white, where nothing passes.
    const c = pickTextColor({ r: 128, g: 128, b: 128 }, 16, { min: black, max: white })
    expect(c.worstRatio).toBeLessThan(c.ratio)
    expect(c.meetsAA).toBe(false)
  })

  it('never claims AA on a background where no fill can reach it', () => {
    // Mid-grey #777 is the classic case: 4.48:1 to white, 4.68:1 to black, so
    // small text cannot clear 4.5:1 against BOTH. Against this single flat
    // background the better candidate is black, and it does clear it.
    const grey = { r: 0x77, g: 0x77, b: 0x77 }
    const c = pickTextColor(grey, 16)
    expect(c.color).toBe('#000000')
    expect(c.ratio).toBeGreaterThan(4.5)

    // With a sample that also contains near-black pixels, nothing passes and
    // the result must say so instead of quietly drawing unreadable text.
    const mixed = pickTextColor(grey, 16, { min: { r: 20, g: 20, b: 20 }, max: grey })
    expect(mixed.meetsAA).toBe(false)
  })

  it('always returns one of the two bracketing candidates', () => {
    for (let v = 0; v <= 255; v += 17) {
      const c = pickTextColor({ r: v, g: v, b: v }, 20)
      expect(['#000000', '#ffffff']).toContain(c.color)
      // Whatever it picks must be the better of the two, by construction.
      const other = c.color === '#000000' ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }
      const chosen = c.color === '#000000' ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }
      const bg = { r: v, g: v, b: v }
      expect(contrastRatio(chosen, bg)).toBeGreaterThanOrEqual(contrastRatio(other, bg) - 1e-9)
    }
  })
})

describe('formatRatio', () => {
  it('renders the way the UI states it', () => {
    expect(formatRatio(21)).toBe('21.0:1')
    expect(formatRatio(7.23)).toBe('7.2:1')
  })
})
