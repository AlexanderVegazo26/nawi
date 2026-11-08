/**
 * `getevent -lt` lines as the loop's API 36 emulator prints them (touch panel /dev/input/event2, raw range 0..32767 on
 * a 1080x2400 display; keys on /dev/input/event1), for the recorder tests (roadmap M5c).
 */

export const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')
/** The raw panel value whose scaled pixel is `px` (the inverse of GestureReader's scaling). */
export const raw = (px: number, size: number): number => Math.ceil((px * 32767) / size)

/** `getevent -lt` lines for one finger: down at `from`, moved through `path`, up after `ms`. */
export function touchLines(t0: number, from: [number, number], ms: number, path: Array<[number, number]> = [], slot = 0, id = 1): string {
  const at = (t: number): string => `[${(t / 1000).toFixed(6).padStart(14)}] /dev/input/event2:`
  const lines = [
    `${at(t0)} EV_ABS       ABS_MT_SLOT          ${hex(slot)}`,
    `${at(t0)} EV_ABS       ABS_MT_TRACKING_ID   ${hex(id)}`,
    `${at(t0)} EV_ABS       ABS_MT_POSITION_X    ${hex(raw(from[0], 1080))}`,
    `${at(t0)} EV_ABS       ABS_MT_POSITION_Y    ${hex(raw(from[1], 2400))}`,
    `${at(t0)} EV_SYN       SYN_REPORT           00000000`
  ]
  path.forEach(([x, y], i) => {
    const t = t0 + ((i + 1) * ms) / (path.length + 1)
    lines.push(`${at(t)} EV_ABS       ABS_MT_POSITION_X    ${hex(raw(x, 1080))}`, `${at(t)} EV_ABS       ABS_MT_POSITION_Y    ${hex(raw(y, 2400))}`, `${at(t)} EV_SYN       SYN_REPORT           00000000`)
  })
  lines.push(`${at(t0 + ms)} EV_ABS       ABS_MT_TRACKING_ID   ffffffff`, `${at(t0 + ms)} EV_SYN       SYN_REPORT           00000000`)
  return `${lines.join('\n')}\n`
}

export const keyLines = (t: number, key: string): string =>
  [`[${(t / 1000).toFixed(6).padStart(14)}] /dev/input/event1: EV_KEY       ${key}             DOWN`, `[${((t + 50) / 1000).toFixed(6).padStart(14)}] /dev/input/event1: EV_KEY       ${key}             UP`].join('\n') + '\n'

