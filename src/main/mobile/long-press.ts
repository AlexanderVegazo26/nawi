import { ANDROID_MIN_HOLD_MS } from '../../shared/flow/schema'

/**
 * Long presses on Android (roadmap M5d-3), shared by the recorder (which touch was one) and the replayer (how long a
 * `hold_ms` must be). Android takes a resting finger for a long press once it outlasts the long-press timeout, which
 * the person can change ("touch & hold delay": 400 ms by default since Android 12, 500 ms before, longer by choice).
 */

/** The device setting, in ms; prints `null` until the person changes it. */
export const LONG_PRESS_TIMEOUT_LINE = 'settings get secure long_press_timeout'

/**
 * The timeout to assume when the device doesn't say: Android's default before 12. The longer of the two defaults, so
 * a hold it allows is long enough on either, and a recorded touch shorter than it is a tap on either.
 */
export const DEFAULT_LONG_PRESS_TIMEOUT_MS = 500

/** How much longer than the timeout a replayed hold lasts, so the device never reads it as a tap. */
export const LONG_PRESS_MARGIN_MS = 100

/** The device's long-press timeout from LONG_PRESS_TIMEOUT_LINE's output; `null`, blank or junk = the default. */
export function parseLongPressTimeout(stdout: string): number {
  const out = stdout.trim()
  return /^\d{1,6}$/.test(out) && Number(out) > 0 ? Number(out) : DEFAULT_LONG_PRESS_TIMEOUT_MS
}

/** The shortest hold a device with this timeout takes for a long press, margin included. */
export const shortestHold = (timeoutMs: number): number => Math.max(ANDROID_MIN_HOLD_MS, timeoutMs + LONG_PRESS_MARGIN_MS)
