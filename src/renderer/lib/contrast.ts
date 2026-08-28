/**
 * WCAG contrast maths for FR-ANN.4 / UX-ANN.5.
 *
 * Deliberately pure and canvas-free: the requirement is a *measured* ratio, not
 * a look, so the part that decides has to be testable without a renderer. The
 * only impure step — reading the pixels beneath a text box — lives in the
 * editor and hands its result in here as plain numbers.
 *
 * Ratios follow WCAG 2.2 SC 1.4.3: relative luminance per the sRGB definition,
 * ratio = (L1 + 0.05) / (L2 + 0.05).
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** Parses `#rgb`, `#rrggbb`, or `#rrggbbaa` (alpha ignored). Returns null if unparseable. */
export function parseHexColor(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3,8})$/i.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (h.length !== 6 && h.length !== 8) return null
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  }
}

function channelLuminance(v255: number): number {
  const c = v255 / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** sRGB relative luminance, 0 (black) .. 1 (white). */
export function relativeLuminance(c: Rgb): number {
  return (
    0.2126 * channelLuminance(c.r) +
    0.7152 * channelLuminance(c.g) +
    0.0722 * channelLuminance(c.b)
  )
}

/** WCAG contrast ratio between two colours, 1..21. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The AA threshold for text of this size (SC 1.4.3).
 *
 * "Large text" is >= 18pt, or >= 14pt bold. Annotation text is drawn at weight
 * 600, which is bold for this purpose, so the bold thresholds apply: 14pt is
 * 18.667 CSS px. Callers passing non-bold text get the 18pt (24px) threshold.
 */
export function requiredRatio(fontSizePx: number, bold = true): number {
  const largeAt = bold ? 18.667 : 24
  return fontSizePx >= largeAt ? 3 : 4.5
}

/**
 * Mean colour of an RGBA pixel run, ignoring fully transparent pixels.
 *
 * A mean is the honest summary for the common case (text over one broad
 * background) and degrades gracefully over busy pixels — where no single fill
 * can be guaranteed readable, which is why `pickTextColor` also reports the
 * worst-case ratio rather than only the mean-case one.
 */
export function averageRgb(rgba: ArrayLike<number>): Rgb | null {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3]
    if (a === 0) continue
    r += rgba[i]
    g += rgba[i + 1]
    b += rgba[i + 2]
    n += 1
  }
  if (n === 0) return null
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) }
}

/**
 * The darkest and lightest pixels in a run, as the worst cases a fill must
 * survive. Text over a light/dark boundary has no single passing fill; the
 * editor uses this to know it must say so rather than pretend.
 */
export function luminanceExtremes(rgba: ArrayLike<number>): { min: Rgb; max: Rgb } | null {
  let min: Rgb | null = null
  let max: Rgb | null = null
  let minL = Infinity
  let maxL = -Infinity
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue
    const c = { r: rgba[i], g: rgba[i + 1], b: rgba[i + 2] }
    const l = relativeLuminance(c)
    if (l < minL) {
      minL = l
      min = c
    }
    if (l > maxL) {
      maxL = l
      max = c
    }
  }
  return min && max ? { min, max } : null
}

export interface ContrastChoice {
  /** The chosen fill, as `#rrggbb`. */
  color: string
  /** Ratio against the mean background. */
  ratio: number
  /** Ratio against the worst-case (nearest-luminance) background pixel. */
  worstRatio: number
  /** True when `worstRatio` clears `requiredRatio` — i.e. readable everywhere it sits. */
  meetsAA: boolean
  /** The threshold that was applied, so the UI can state it. */
  required: number
}

/**
 * Two candidates on purpose.
 *
 * FR-ANN.4 asks for a *contrasting* colour, not a palette match. Black and
 * white bracket the luminance range, so if neither clears AA no other colour
 * would either — which is exactly the case the UI must surface instead of
 * quietly drawing unreadable text.
 */
export const CONTRAST_CANDIDATES = ['#000000', '#ffffff'] as const

/**
 * Picks the text fill with the best guaranteed contrast over the sampled pixels.
 *
 * `background` is the mean; `extremes` (when given) are the darkest and
 * lightest pixels present, so the returned `worstRatio` is a floor rather than
 * an average-case flatter.
 */
export function pickTextColor(
  background: Rgb,
  fontSizePx: number,
  extremes?: { min: Rgb; max: Rgb } | null
): ContrastChoice {
  const required = requiredRatio(fontSizePx)
  let best: ContrastChoice | null = null

  for (const hex of CONTRAST_CANDIDATES) {
    const fg = parseHexColor(hex)
    if (!fg) continue
    const ratio = contrastRatio(fg, background)
    const worstRatio = extremes
      ? Math.min(contrastRatio(fg, extremes.min), contrastRatio(fg, extremes.max))
      : ratio
    const choice: ContrastChoice = {
      color: hex,
      ratio,
      worstRatio,
      meetsAA: worstRatio >= required,
      required
    }
    // Rank on the guaranteed floor, not the average, so a fill that reads well
    // "on average" never beats one that reads everywhere.
    if (!best || choice.worstRatio > best.worstRatio) best = choice
  }

  // CONTRAST_CANDIDATES is a non-empty literal, so this is unreachable; the
  // fallback exists so the return type needs no non-null assertion.
  return (
    best ?? { color: '#000000', ratio: 1, worstRatio: 1, meetsAA: false, required }
  )
}

/** Formats a ratio the way the UI states it: `7.2:1`. */
export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(1)}:1`
}
