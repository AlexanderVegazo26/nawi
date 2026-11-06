import type { RgbImage } from '../mobile/png'

/**
 * The visual-anchor locator layer (roadmap AI1): when none of a step's DOM
 * locators finds exactly one element, find the step's reference crop
 * (`target.image`) in a screenshot of the viewport, and act on the element at
 * the centre of the match.
 *
 * Deterministic and dependency-free: both images go to 8-bit luma, a coarse
 * pass scores every position on box-downscaled copies (mean absolute
 * difference), and the best few distinct candidates are refined at full
 * resolution. A match must be close overall (`MAX_MEAN_DIFF`) and in every
 * 8x8 block of the crop (`MAX_BLOCK_DIFF`: one changed letter on a flat button
 * barely moves the overall mean, but fails its block), and unique: a second
 * place that matches as well is ambiguous, like a selector that finds two
 * elements, and the layer reports it instead of guessing.
 *
 * Coordinates are CSS px: the crop is stored at one image px per CSS px, and
 * the replayer scales the screenshot down by the device pixel ratio first
 * (`scaleImage`).
 */

/** Mean absolute luma difference (0-255) a match may have: anti-aliasing and re-rendered edges pass, a different control does not. */
export const MAX_MEAN_DIFF = 12
/**
 * The same, for the worst BLOCK x BLOCK block of the crop: a local change (a
 * different letter or icon, ~80+) fails here. Text re-rasterised with other
 * anti-aliasing (Chromium switches from subpixel to greyscale under a
 * translucent overlay) differs by up to ~35 in a block and must still pass.
 */
export const MAX_BLOCK_DIFF = 56
const BLOCK = 8
/** A crop smaller than this (either side, CSS px) carries too little to tell elements apart. */
export const MIN_ANCHOR_SIDE = 8
/** Upper bound for the coarse pass (positions x crop pixels), so a look stays far under a poll interval on the main thread. */
const COARSE_BUDGET = 20_000_000
/**
 * Coarse candidates refined at full resolution. Only direct neighbours are
 * merged on the coarse grid: on periodic content (a row of letters) the best
 * coarse cell can sit one period off the true spot, so the cells around it
 * must be refined too.
 */
const CANDIDATES = 16

export type AnchorResult =
  | { found: 1; x: number; y: number; score: number }
  | { found: 0 | 2; score?: number }
  | { found: 0; invalid: string }

interface Gray {
  width: number
  height: number
  px: Uint8Array
}

/** Crops are reused for every look in a run: their luma and shrunk copies are computed once per image object. */
const lumaCache = new WeakMap<RgbImage, Gray>()
const shrinkCache = new WeakMap<Gray, Map<number, Gray>>()

function lumaOf(image: RgbImage): Gray {
  let g = lumaCache.get(image)
  if (!g) lumaCache.set(image, (g = luma(image)))
  return g
}

function shrinkOf(g: Gray, f: number): Gray {
  let byFactor = shrinkCache.get(g)
  if (!byFactor) shrinkCache.set(g, (byFactor = new Map()))
  let out = byFactor.get(f)
  if (!out) byFactor.set(f, (out = shrink(g, f)))
  return out
}

function luma(image: RgbImage): Gray {
  const { width, height, rgb } = image
  const px = new Uint8Array(width * height)
  for (let i = 0, j = 0; i < px.length; i++, j += 3) {
    // Rec. 601 weights in integers: r 0.299, g 0.587, b 0.114.
    px[i] = (rgb[j] * 77 + rgb[j + 1] * 150 + rgb[j + 2] * 29) >> 8
  }
  return { width, height, px }
}

/** Box-average downscale by an integer factor (partial edge blocks dropped). */
function shrink(g: Gray, f: number): Gray {
  if (f === 1) return g
  const width = Math.floor(g.width / f)
  const height = Math.floor(g.height / f)
  const px = new Uint8Array(width * height)
  const area = f * f
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * g.width + x * f
        for (let dx = 0; dx < f; dx++) sum += g.px[row + dx]
      }
      px[y * width + x] = Math.round(sum / area)
    }
  }
  return { width, height, px }
}

/**
 * The image resampled to `width` x `height` by area averaging (each output
 * pixel is the mean of the source pixels it covers). Used to bring a
 * device-pixel screenshot to CSS px; same size returns the input.
 */
export function scaleImage(image: RgbImage, width: number, height: number): RgbImage {
  if (image.width === width && image.height === height) return image
  if (width <= 0 || height <= 0) return { width: 0, height: 0, rgb: new Uint8Array(0) }
  const sx = image.width / width
  const sy = image.height / height
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((y + 1) * sy)))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((x + 1) * sx)))
      let r = 0
      let g = 0
      let b = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const k = (yy * image.width + xx) * 3
          r += image.rgb[k]
          g += image.rgb[k + 1]
          b += image.rgb[k + 2]
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const o = (y * width + x) * 3
      rgb[o] = Math.round(r / n)
      rgb[o + 1] = Math.round(g / n)
      rgb[o + 2] = Math.round(b / n)
    }
  }
  return { width, height, rgb }
}

/** Mean absolute difference of `crop` placed at (x, y) in `screen`; stops early once it exceeds `limit` (returns Infinity). */
function meanDiff(screen: Gray, crop: Gray, x: number, y: number, limit = Infinity): number {
  const n = crop.width * crop.height
  const cap = limit * n
  let sum = 0
  for (let cy = 0; cy < crop.height; cy++) {
    const s = (y + cy) * screen.width + x
    const c = cy * crop.width
    for (let cx = 0; cx < crop.width; cx++) {
      const d = screen.px[s + cx] - crop.px[c + cx]
      sum += d < 0 ? -d : d
    }
    if (sum > cap) return Infinity
  }
  return sum / n
}

/**
 * The smallest factor that keeps the coarse pass in budget, preferring to keep
 * the shrunk crop at least 4 px a side; a thin crop (a 600x10 bar) goes down to
 * 2 px rather than blowing the budget (the full-resolution refinement decides).
 */
function coarseFactor(screen: Gray, crop: Gray): number {
  const cost = (f: number): number => (screen.width / f) * (screen.height / f) * (crop.width / f) * (crop.height / f)
  let f = 1
  while (cost(f) > COARSE_BUDGET && Math.min(crop.width, crop.height) / (f + 1) >= 2) f++
  return f
}

/** Block starts along a side: every BLOCK px, the last one moved back so it is whole (crops are >= BLOCK a side). */
function blockStarts(size: number): number[] {
  const starts: number[] = []
  for (let k = 0; k + BLOCK <= size; k += BLOCK) starts.push(k)
  if (size % BLOCK !== 0) starts.push(size - BLOCK)
  return starts
}

/** The mean absolute difference of the worst BLOCK x BLOCK block of `crop` placed at (x, y). */
function worstBlockDiff(screen: Gray, crop: Gray, x: number, y: number): number {
  let worst = 0
  const h = BLOCK
  const w = BLOCK
  for (const by of blockStarts(crop.height)) {
    for (const bx of blockStarts(crop.width)) {
      let sum = 0
      for (let cy = by; cy < by + h; cy++) {
        const s = (y + cy) * screen.width + x
        const c = cy * crop.width
        for (let cx = bx; cx < bx + w; cx++) {
          const d = screen.px[s + cx] - crop.px[c + cx]
          sum += d < 0 ? -d : d
        }
      }
      worst = Math.max(worst, sum / (w * h))
    }
  }
  return worst
}

/**
 * Find `crop` in `screen` (both CSS px). `found: 1` gives the centre of the
 * unique match and its score (1 = identical); `found: 2` = it matches in two
 * or more places; `found: 0` = nowhere close enough, with the best score seen;
 * `invalid` = the crop cannot be used (too small, larger than the viewport).
 */
export function findAnchor(screenImage: RgbImage, cropImage: RgbImage): AnchorResult {
  if (cropImage.width < MIN_ANCHOR_SIDE || cropImage.height < MIN_ANCHOR_SIDE) {
    return { found: 0, invalid: `the reference crop is ${cropImage.width}x${cropImage.height} px, smaller than ${MIN_ANCHOR_SIDE} px a side` }
  }
  if (cropImage.width > screenImage.width || cropImage.height > screenImage.height) {
    return {
      found: 0,
      invalid: `the reference crop (${cropImage.width}x${cropImage.height}) is larger than the viewport (${screenImage.width}x${screenImage.height})`
    }
  }
  const screen = luma(screenImage)
  const crop = lumaOf(cropImage)
  const f = coarseFactor(screen, crop)
  const cs = shrink(screen, f)
  const cc = shrinkOf(crop, f)

  // Coarse pass: the best cells, direct neighbours merged.
  const coarse: Array<{ x: number; y: number; d: number }> = []
  const radiusX = 1
  const radiusY = 1
  let worstKept = Infinity
  for (let y = 0; y + cc.height <= cs.height; y++) {
    for (let x = 0; x + cc.width <= cs.width; x++) {
      const d = meanDiff(cs, cc, x, y, coarse.length < CANDIDATES ? Infinity : worstKept)
      if (d === Infinity) continue
      const near = coarse.findIndex((c) => Math.abs(c.x - x) <= radiusX && Math.abs(c.y - y) <= radiusY)
      if (near >= 0) {
        if (d < coarse[near].d) coarse[near] = { x, y, d }
      } else {
        coarse.push({ x, y, d })
      }
      coarse.sort((a, b) => a.d - b.d)
      if (coarse.length > CANDIDATES) coarse.length = CANDIDATES
      worstKept = coarse.length < CANDIDATES ? Infinity : coarse[coarse.length - 1].d
    }
  }

  // Full-resolution refinement around each candidate (the coarse grid hides up to f-1 px of offset).
  const candidates: Array<{ x: number; y: number; d: number }> = []
  for (const c of coarse) {
    let best = { x: 0, y: 0, d: Infinity }
    for (let y = c.y * f - f; y <= c.y * f + f; y++) {
      for (let x = c.x * f - f; x <= c.x * f + f; x++) {
        if (x < 0 || y < 0 || x + crop.width > screen.width || y + crop.height > screen.height) continue
        const d = meanDiff(screen, crop, x, y, best.d)
        if (d < best.d) best = { x, y, d }
      }
    }
    if (best.d !== Infinity) candidates.push(best)
  }
  // Best first, then one place per crop-sized area: cells of one match refine onto (nearly) the same spot.
  candidates.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x)
  const refined: Array<{ x: number; y: number; d: number }> = []
  for (const c of candidates) {
    if (!refined.some((r) => Math.abs(r.x - c.x) < crop.width / 2 && Math.abs(r.y - c.y) < crop.height / 2)) refined.push(c)
  }
  const score = (d: number): number => Math.round((1 - d / 255) * 1000) / 1000
  const hits = refined.filter((r) => r.d <= MAX_MEAN_DIFF && worstBlockDiff(screen, crop, r.x, r.y) <= MAX_BLOCK_DIFF)
  if (hits.length === 0) return refined.length > 0 ? { found: 0, score: score(refined[0].d) } : { found: 0 }
  if (hits.length > 1) return { found: 2, score: score(hits[0].d) }
  const [hit] = hits
  return { found: 1, x: hit.x + crop.width / 2, y: hit.y + crop.height / 2, score: score(hit.d) }
}

/** Why the visual anchor missed, in words, for failure text, run records and reports. */
export function anchorMissText(m: { found: number; score?: number; at?: [number, number] }): string {
  if (m.at) return `found on screen at (${m.at[0]}, ${m.at[1]}) but no element is there`
  const best = m.score !== undefined ? `, best score ${m.score}` : ''
  return m.found === 0 ? `no close match${best}` : `matches in ${m.found}+ places (ambiguous)${best}`
}
