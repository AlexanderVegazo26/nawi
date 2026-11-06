import { contrastRatio, type Rgb } from '../../shared/wcag'
import type { UiBounds } from './hierarchy'
import type { RgbImage } from './png'

/**
 * Roadmap M3b2: the contrast of a text on a device screenshot, measured from the pixels inside its bounds (the dump
 * gives where a text is, the screenshot what colours it is drawn in). The background is the colour most of the box
 * shows; the text colour is, among the other colours that cover a fair share of it, the one furthest from the
 * background (anti-aliased edge pixels sit between the two and cover less). Colours are grouped 5 bits per channel
 * so compression noise and gradients of one step don't split them; the ratio is computed from each group's mean.
 *
 * It refuses to guess rather than report a false failure: a box whose most common colour covers under
 * MIN_BACKGROUND_SHARE (a photo, a gradient, an image behind the text) or that has no second colour (no text pixels
 * found) is not measured. The second case includes text drawn within ~8 levels of its background (the same group):
 * nearly invisible, but not told apart from an empty box, so the study's note asks for a look by eye.
 */

/** WCAG 2.2 SC 1.4.3 minimums: normal text, and large text (18 pt, or 14 pt bold). */
export const MIN_RATIO = 4.5
export const MIN_RATIO_LARGE = 3

/** The background must cover this share of the box, else the box is too busy to tell text from background. */
export const MIN_BACKGROUND_SHARE = 0.35
/**
 * A colour group needs this share of the box (and at least MIN_TEXT_PIXELS) to count as the text colour: low, because
 * a short thin label ("OK") in a full-width view covers well under 1% of it; a screencap is lossless, so a group
 * this small is drawn, not noise.
 */
export const MIN_TEXT_SHARE = 0.002
export const MIN_TEXT_PIXELS = 8
/** Boxes bigger than this are sampled on a grid (a full-screen TextView would otherwise read millions of pixels). */
export const MAX_SAMPLES_PER_BOX = 200_000

export interface TextContrast {
  text: Rgb
  background: Rgb
  ratio: number
}

export type ContrastMeasure = { ok: true; contrast: TextContrast } | { ok: false; reason: 'too_small' | 'busy_background' | 'no_text_pixels' }

/** `#rrggbb`. */
export const colorHex = (c: Rgb): string => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

const counts = new Uint32Array(1 << 15)
/** Up to 200,000 samples x 255 per channel fits in 32 bits. */
const sums = new Uint32Array(3 << 15)
const touched: number[] = []

/** The contrast inside `bounds` (screen pixels; the part outside the image is ignored). */
export function measureTextContrast(image: RgbImage, bounds: UiBounds): ContrastMeasure {
  const left = Math.max(0, Math.floor(bounds.left))
  const top = Math.max(0, Math.floor(bounds.top))
  const right = Math.min(image.width, Math.ceil(bounds.right))
  const bottom = Math.min(image.height, Math.ceil(bounds.bottom))
  const w = right - left
  const h = bottom - top
  if (w < 2 || h < 4 || w * h < 32) return { ok: false, reason: 'too_small' }
  const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / MAX_SAMPLES_PER_BOX)))
  // Per 15-bit colour group: pixel count and channel sums (for the group's mean colour), in scratch arrays that
  // are reset through the list of groups this box touched (a Map per pixel is several times slower).
  touched.length = 0
  let total = 0
  const { rgb, width } = image
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const o = (y * width + x) * 3
      const r = rgb[o]
      const g = rgb[o + 1]
      const b = rgb[o + 2]
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      if (counts[key]++ === 0) touched.push(key)
      sums[key * 3] += r
      sums[key * 3 + 1] += g
      sums[key * 3 + 2] += b
      total++
    }
  }
  const mean = (k: number): Rgb => ({ r: Math.round(sums[k * 3] / counts[k]), g: Math.round(sums[k * 3 + 1] / counts[k]), b: Math.round(sums[k * 3 + 2] / counts[k]) })
  let bg = touched[0]
  for (const k of touched) if (counts[k] > counts[bg]) bg = k
  let best: TextContrast | null = null
  const busy = counts[bg] / total < MIN_BACKGROUND_SHARE
  if (!busy) {
    const background = mean(bg)
    const minPixels = Math.max(MIN_TEXT_PIXELS, total * MIN_TEXT_SHARE)
    for (const k of touched) {
      if (k === bg || counts[k] < minPixels) continue
      const text = mean(k)
      const ratio = contrastRatio(text, background)
      if (best === null || ratio > best.ratio) best = { text, background, ratio }
    }
  }
  for (const k of touched) {
    counts[k] = 0
    sums[k * 3] = 0
    sums[k * 3 + 1] = 0
    sums[k * 3 + 2] = 0
  }
  if (busy) return { ok: false, reason: 'busy_background' }
  return best === null ? { ok: false, reason: 'no_text_pixels' } : { ok: true, contrast: best }
}

/** A ratio as WCAG writes it, never rounded up past a threshold: 4.49 stays 4.49, not 4.5. */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`
}
