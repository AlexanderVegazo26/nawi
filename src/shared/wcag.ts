/**
 * WCAG 2.2 contrast maths (SC 1.4.3), shared by the editor's auto-contrast (FR-ANN.4 / UX-ANN.5, renderer) and the
 * mobile screen study (roadmap M3b2, main). Relative luminance per the sRGB definition,
 * ratio = (L1 + 0.05) / (L2 + 0.05).
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

function channelLuminance(v255: number): number {
  const c = v255 / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** sRGB relative luminance, 0 (black) .. 1 (white). */
export function relativeLuminance(c: Rgb): number {
  return 0.2126 * channelLuminance(c.r) + 0.7152 * channelLuminance(c.g) + 0.0722 * channelLuminance(c.b)
}

/** WCAG contrast ratio between two colours, 1..21. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
