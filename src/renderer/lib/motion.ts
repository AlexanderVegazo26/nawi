import { cssVar } from './theme'

/**
 * Motion helpers for animation that CSS cannot reach.
 *
 * `styles.css` already neutralises CSS transitions under
 * `prefers-reduced-motion`. Canvas drawing is outside that entirely: a
 * `@media` block cannot stop a JS-driven cross-fade painted with `fillText`, so
 * UX-A11Y.7 has to be honoured in code — which is what this module is for.
 * Adding a `.motion-*` class to a canvas would typecheck, look compliant, and
 * do nothing.
 */

/** True when the user has asked for reduced motion. Read live, not cached. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Reads one of the UX-VIS.2 budget tokens as a number of milliseconds.
 *
 * The budget lives in `styles.css` as the single source of truth; hardcoding
 * 200 here would let the token and the behaviour drift apart silently.
 */
export function motionDurationMs(token: string, fallbackMs: number): number {
  const raw = cssVar(token, '')
  const m = /^([\d.]+)(ms|s)$/.exec(raw.trim())
  if (!m) return fallbackMs
  const n = Number(m[1])
  if (!Number.isFinite(n)) return fallbackMs
  return m[2] === 's' ? n * 1000 : n
}
