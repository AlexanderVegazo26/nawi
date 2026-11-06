import { describe, expect, it } from 'vitest'
import { canvas, type Colour } from '../mobile/fixtures/make-png'
import type { RgbImage } from '../mobile/png'
import { MAX_MEAN_DIFF, MIN_ANCHOR_SIDE, findAnchor, scaleImage } from './visual-anchor'

const WHITE: Colour = [255, 255, 255]
const GREEN: Colour = [34, 170, 119]
const RED: Colour = [204, 51, 51]
const BLUE: Colour = [51, 102, 204]

/** The `[left, top, width, height]` region of `image`, copied. */
function cropOf(image: RgbImage, left: number, top: number, width: number, height: number): RgbImage {
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    rgb.set(image.rgb.subarray(((top + y) * image.width + left) * 3, ((top + y) * image.width + left + width) * 3), y * width * 3)
  }
  return { width, height, rgb }
}

/** A 1280x800 page with a green "Save" button at (101, 99), a red "Delete" at (403, 301) and a text field. */
function page(): ReturnType<typeof canvas> {
  const c = canvas(1280, 800, WHITE)
  c.rect(101, 99, 241, 147, GREEN)
  c.text(101, 99, 241, 147, WHITE, [150, 210, 190])
  c.rect(403, 301, 543, 349, RED)
  c.text(403, 301, 503, 349, WHITE)
  c.rect(700, 100, 906, 136, [160, 0, 160])
  c.rect(703, 103, 903, 133, WHITE)
  return c
}

const SAVE = { left: 101, top: 99, width: 140, height: 48 }
const centre = (r: typeof SAVE): { x: number; y: number } => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })

describe('findAnchor: the visual-anchor locator layer', () => {
  it('finds a crop at its exact position, off the coarse grid (odd offsets), and gives the centre in CSS px', () => {
    const screen = page()
    const crop = cropOf(screen, SAVE.left, SAVE.top, SAVE.width, SAVE.height)
    const hit = findAnchor(screen, crop)
    expect(hit, 'the Save button crop on the page it was cut from').toEqual({ found: 1, ...centre(SAVE), score: 1 })
  })

  it('still matches after the element moved and its edges re-rendered slightly differently (anti-aliasing)', () => {
    const recorded = page()
    const crop = cropOf(recorded, SAVE.left, SAVE.top, SAVE.width, SAVE.height)
    // The page today: Save moved 37 px right and 23 px down, its glyph edges a shade darker.
    const today = canvas(1280, 800, WHITE)
    today.rect(138, 122, 278, 170, GREEN)
    today.text(138, 122, 278, 170, WHITE, [140, 200, 180])
    today.rect(403, 301, 543, 349, RED)
    const hit = findAnchor(today, crop)
    expect(hit.found, JSON.stringify(hit)).toBe(1)
    expect(hit, 'centre of the moved button').toMatchObject({ x: 138 + 70, y: 122 + 24 })
    expect((hit as { score: number }).score, 'close but not identical').toBeLessThan(1)
    expect((hit as { score: number }).score).toBeGreaterThan(1 - MAX_MEAN_DIFF / 255)
  })

  it('reports no match, with the best score, when the element is gone or looks different', () => {
    const recorded = page()
    const crop = cropOf(recorded, SAVE.left, SAVE.top, SAVE.width, SAVE.height)
    const restyled = canvas(1280, 800, WHITE)
    restyled.rect(101, 99, 241, 147, BLUE)
    restyled.text(101, 99, 241, 147, WHITE)
    const miss = findAnchor(restyled, crop)
    expect(miss.found, JSON.stringify(miss)).toBe(0)
    expect(miss, 'a best score below the threshold explains the miss').toHaveProperty('score')
    expect((miss as { score: number }).score).toBeLessThan(1 - MAX_MEAN_DIFF / 255)
  })

  it('rejects a look-alike that differs in one place (a changed letter on the same button), though the overall mean is close', () => {
    const recorded = page()
    const crop = cropOf(recorded, SAVE.left, SAVE.top, SAVE.width, SAVE.height)
    const today = page()
    // One "glyph" changes: a stroke 4 px wide is gone and the gap filled with the button colour.
    today.rect(101 + 8 + 24, 99 + 12, 101 + 8 + 24 + 5, 99 + 36, GREEN)
    const miss = findAnchor(today, crop)
    expect(miss.found, `one changed glyph must not count as the same control: ${JSON.stringify(miss)}`).toBe(0)
    expect((miss as { score: number }).score, 'the overall mean alone would have accepted it').toBeGreaterThan(1 - MAX_MEAN_DIFF / 255)
  })

  it('finds a thin crop (a 600x10 bar) within budget', () => {
    const screen = canvas(1280, 720, WHITE)
    screen.rect(300, 400, 900, 410, BLUE)
    screen.rect(500, 402, 520, 408, RED)
    const crop = cropOf(screen, 300, 400, 600, 10)
    const started = performance.now()
    expect(findAnchor(screen, crop)).toEqual({ found: 1, x: 600, y: 405, score: 1 })
    expect(performance.now() - started, 'one look stays far under a poll interval').toBeLessThan(2000)
  })

  it('refuses to guess when the crop matches in two places (two identical buttons), like an ambiguous selector', () => {
    const screen = canvas(1280, 800, WHITE)
    for (const left of [100, 600]) {
      screen.rect(left, 500, left + 120, 540, BLUE)
      screen.text(left, 500, left + 120, 540, WHITE)
    }
    const crop = cropOf(screen, 100, 500, 120, 40)
    expect(findAnchor(screen, crop)).toEqual({ found: 2, score: 1 })
  })

  it('counts one match once even when neighbouring positions also score well (a flat area around the element)', () => {
    const screen = canvas(400, 300, WHITE)
    screen.rect(50, 50, 90, 70, RED)
    // Mostly white crop: positions a pixel or two off still score under the threshold.
    const crop = cropOf(screen, 40, 40, 60, 40)
    const hit = findAnchor(screen, crop)
    expect(hit, JSON.stringify(hit)).toMatchObject({ found: 1, x: 70, y: 60 })
  })

  it('marks a crop that cannot work as invalid: under the minimum size, or larger than the viewport', () => {
    const screen = page()
    expect(findAnchor(screen, cropOf(screen, 0, 0, MIN_ANCHOR_SIDE - 1, 20))).toMatchObject({ found: 0, invalid: expect.stringMatching(/smaller than 8 px/) })
    expect(findAnchor(cropOf(screen, 0, 0, 100, 100), cropOf(screen, 0, 0, 120, 20))).toMatchObject({
      found: 0,
      invalid: expect.stringMatching(/larger than the viewport \(100x100\)/)
    })
  })

  it('is deterministic: the same inputs give the same answer every time', () => {
    const screen = page()
    const crop = cropOf(screen, 403, 301, 140, 48)
    const first = findAnchor(screen, crop)
    for (let k = 0; k < 3; k++) expect(findAnchor(screen, crop), `run ${k + 2}`).toEqual(first)
  })
})

describe('scaleImage: device pixels to CSS px', () => {
  it('averages each 2x2 block when halving (a deviceScaleFactor 2 screenshot)', () => {
    const big = canvas(4, 2, [0, 0, 0])
    big.rect(0, 0, 1, 1, [200, 100, 40]) // one bright pixel in the first 2x2 block
    big.rect(2, 0, 4, 2, [255, 255, 255])
    const small = scaleImage(big, 2, 1)
    expect(Array.from(small.rgb), 'first block = mean of 1 coloured + 3 black pixels; second all white').toEqual([50, 25, 10, 255, 255, 255])
  })

  it('returns the very image when the size already matches, and a matched crop survives a 2x round trip', () => {
    const screen = page()
    expect(scaleImage(screen, 1280, 800)).toBe(screen)
    // A crisp-edged page rendered at 2x (every CSS pixel drawn as 2x2), scaled back down.
    const doubled = canvas(2560, 1600, WHITE)
    for (let y = 0; y < 800; y++) {
      for (let x = 0; x < 1280; x++) {
        const k = (y * 1280 + x) * 3
        const c: Colour = [screen.rgb[k], screen.rgb[k + 1], screen.rgb[k + 2]]
        doubled.rect(x * 2, y * 2, x * 2 + 2, y * 2 + 2, c)
      }
    }
    const crop = cropOf(screen, SAVE.left, SAVE.top, SAVE.width, SAVE.height)
    expect(findAnchor(scaleImage(doubled, 1280, 800), crop)).toEqual({ found: 1, ...centre(SAVE), score: 1 })
  })
})
