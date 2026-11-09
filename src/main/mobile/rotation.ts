import type { AndroidOrientation } from '../../shared/flow/schema'

/**
 * Turning the screen of an Android device (roadmap M5d-4), shared by the replayer (`rotate` steps) and the recorder
 * (a screen that turned between two reads).
 *
 * Android counts a screen's rotation in quarter turns from the device's natural orientation (the dump's `rotation`,
 * `Surface.ROTATION_0..270`). A phone's natural orientation is portrait, many tablets' is landscape, so the same
 * quarter turn is portrait on one and landscape on the other: the mapping goes through the natural size (`wm size`),
 * as Android's own (DisplayRotation, default `config_reverseDefaultRotation`).
 *
 * The replayer turns the screen the way `adb` can on any device without root: auto-rotate off
 * (`accelerometer_rotation` 0) and the locked rotation (`user_rotation`) set, then puts both settings back as they
 * were when the run ends.
 */

export interface NaturalSize {
  width: number
  height: number
}

/** `wm size`: the override when one is set (what the app draws with), else the physical size; natural orientation. */
export function parseWmSize(stdout: string): NaturalSize | null {
  const read = (label: string): NaturalSize | null => {
    const m = new RegExp(`^${label} size:\\s*(\\d{2,5})x(\\d{2,5})\\s*$`, 'm').exec(stdout)
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null
  }
  return read('Override') ?? read('Physical')
}

/**
 * A quick look at the screen's rotation (~0.1 s, against ~2 s for a screen read), for the live recorder to notice the
 * screen turning between touches: the window manager's first display (the device's own screen).
 */
export const DISPLAY_ROTATION_LINE = "dumpsys window displays | grep -m1 -o 'mDisplayRotation=ROTATION_[0-9]*'"

/** The rotation in quarter turns from DISPLAY_ROTATION_LINE's output; null when it says none. */
export function parseDisplayRotation(stdout: string): number | null {
  const m = /mDisplayRotation=ROTATION_(0|90|180|270)\b/.exec(stdout)
  return m ? Number(m[1]) / 90 : null
}

/** Quarter turns for each orientation, on a device whose natural orientation is portrait / landscape. */
const TURNS: Readonly<Record<'portrait' | 'landscape', Readonly<Record<AndroidOrientation, number>>>> = {
  portrait: { portrait: 0, landscape: 1, 'reverse-portrait': 2, 'reverse-landscape': 3 },
  landscape: { landscape: 0, 'reverse-portrait': 1, 'reverse-landscape': 2, portrait: 3 }
}

const naturally = (size: NaturalSize): 'portrait' | 'landscape' => (size.width > size.height ? 'landscape' : 'portrait')

/** The rotation (quarter turns, 0..3) that shows the screen in `orientation` on a device of this natural size. */
export function rotationFor(orientation: AndroidOrientation, size: NaturalSize): number {
  return TURNS[naturally(size)][orientation]
}

/** The orientation a rotation of 0..3 quarter turns shows on a device of this natural size; null for anything else. */
export function orientationOf(rotation: number, size: NaturalSize): AndroidOrientation | null {
  const turns = TURNS[naturally(size)]
  for (const [name, r] of Object.entries(turns)) if (r === rotation) return name as AndroidOrientation
  return null
}

/** The two settings a `rotate` step changes, as `settings get system <name>` prints them. */
export const AUTO_ROTATE_SETTING = 'accelerometer_rotation'
export const USER_ROTATION_SETTING = 'user_rotation'

/**
 * A rotation setting's value from `settings get system <name>`: the number when it is one of `allowed`, `null` when the
 * device never stored one (it prints `null`), undefined when the output is anything else (an unreadable setting must
 * not be "restored" to a guess).
 */
export function parseRotationSetting(stdout: string, allowed: readonly number[]): number | null | undefined {
  const out = stdout.trim()
  if (out === 'null') return null
  if (!/^\d$/.test(out)) return undefined
  const n = Number(out)
  return allowed.includes(n) ? n : undefined
}

/** The shell lines that put a setting back as it was: its old value, or no value at all when it had none. */
export const restoreLine = (name: string, value: number | null): string => (value === null ? `settings delete system ${name}` : `settings put system ${name} ${value}`)
