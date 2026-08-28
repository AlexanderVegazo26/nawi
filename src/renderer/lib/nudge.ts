import type { Rect } from '@shared/types'

/**
 * Keyboard region adjustment (UX-CAP.5 / UX-A11Y.2).
 *
 * Extracted from the overlay's keydown handler because the step sizes are the
 * requirement. Left inline, "arrows move by 1 px" could only be checked by
 * driving a real browser window, and the shipped code was wrong in exactly that
 * way for both specs at once.
 *
 * ## The binding conflict, resolved explicitly
 *
 * Two normative requirements claim the `Shift` modifier and cannot both hold:
 *
 *   UX-CAP.5   "arrow keys move the edge by 1 px, Shift+arrow by 10 px"
 *   UX-A11Y.2  "arrows to move, Shift+arrows to resize"
 *
 * Implemented here: **arrows move by 1 px, Shift+arrow moves by 10 px** — the
 * step-size requirement, which is also what this task's brief states
 * explicitly. Resize keeps the `Ctrl` modifier the shipped overlay already
 * used, so UX-A11Y.2's P0 substance (a region fully sized *and* positioned from
 * the keyboard, `Enter` to capture) still holds end to end. No new modifier was
 * introduced; `Ctrl` swapped from move to resize.
 *
 * That Shift means "10 px" rather than "resize" is a real deviation from
 * UX-A11Y.2's letter and is raised for ux-designer rather than papered over.
 */

/** Step sizes in DIP. */
export const NUDGE = 1
export const NUDGE_FAST = 10

export interface NudgeModifiers {
  shiftKey: boolean
  ctrlKey: boolean
}

export interface Bounds {
  width: number
  height: number
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
}

export function isNudgeKey(key: string): boolean {
  // `key in ARROWS` walks the prototype chain, so it answered true for
  // 'toString' and 'constructor'. A KeyboardEvent's `key` is attacker-adjacent
  // input in the general case and is arbitrary text in every case, so the
  // lookup has to be own-property only.
  return Object.prototype.hasOwnProperty.call(ARROWS, key)
}

/**
 * The rect a keyboard user starts from when they press an arrow before dragging.
 *
 * A zero-size rect would make `Enter` produce nothing, so the keyboard path
 * opens with a real, visible selection centred on the display — otherwise
 * "fully keyboard-drivable" is true only for someone who already dragged.
 */
export function seedRect(bounds: Bounds): Rect {
  const width = Math.max(1, Math.round(bounds.width / 4))
  const height = Math.max(1, Math.round(bounds.height / 4))
  return {
    x: Math.round((bounds.width - width) / 2),
    y: Math.round((bounds.height - height) / 2),
    width,
    height
  }
}

/**
 * Applies one arrow keypress.
 *
 * Returns a rect clamped inside `bounds`: a selection nudged off the display
 * cannot be captured, and silently letting it leave means `Enter` fails for a
 * reason the user cannot see.
 */
export function nudgeRect(
  rect: Rect | null,
  key: string,
  mods: NudgeModifiers,
  bounds: Bounds
): Rect | null {
  // Same own-property guard as `isNudgeKey`: a bare `ARROWS[key]` returns a
  // function for 'toString', and `dir[0]` would then be undefined and every
  // coordinate NaN.
  if (!isNudgeKey(key)) return rect
  const dir = ARROWS[key]
  const base = rect ?? seedRect(bounds)
  const step = mods.shiftKey ? NUDGE_FAST : NUDGE
  const dx = dir[0] * step
  const dy = dir[1] * step

  if (mods.ctrlKey) {
    // Resize from the bottom/right edge; the origin stays put so the user's
    // anchor does not wander while they size.
    const width = clamp(base.width + dx, 1, bounds.width - base.x)
    const height = clamp(base.height + dy, 1, bounds.height - base.y)
    return { ...base, width, height }
  }

  return {
    ...base,
    x: clamp(base.x + dx, 0, Math.max(0, bounds.width - base.width)),
    y: clamp(base.y + dy, 0, Math.max(0, bounds.height - base.height))
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi))
}
