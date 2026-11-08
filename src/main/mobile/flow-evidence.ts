import type { Selector } from '../../shared/flow/schema'
import type { DeviceLogLine } from '../replay/evidence'
import { findAll, type UiLocator } from './blockers'
import type { Exec } from './doctor'
import type { UiBounds, UiScreen } from './hierarchy'
import { KEYBOARD_SHOWN_LINE, readScreen } from './open'
import { decodePng, encodePng } from './png'
import { captureScreen, type BinaryExec } from './screen'
import { shQuote } from './shell'

/**
 * Roadmap M5b-2: what an android run records around each step, next to the step's result: the device's screen before
 * and after it (PNG, from `screencap`), and the device log of the step (`logcat`), so a failed step on a phone can be
 * read like a failed step in a browser run (F4b/F4b2).
 *
 * Secrets: a field the run typed a secret into is painted over in every screenshot, wherever it is on screen then
 * (the screen is read before and after the capture and every position of it is covered), and so is any view whose
 * text or description shows a secret the run used. While a secret has been typed, the on-screen keyboard is painted
 * over too when it is up: its suggestion strip repeats what was typed, and it is not in the screen read (its area
 * comes from the window manager instead). A shot that cannot be masked (the screen can't be read, or it is
 * not in the screenshot's coordinates) is not taken. Log lines are scrubbed of the run's secrets before they are cut.
 *
 * Log lines are the step's warnings and errors (`*:W`) from the app's own uid, plus the system's lines that name the
 * package (an ANR is logged by the system, not the app). Never throws: missing evidence must not change a run.
 */

/** Most log lines kept per step; the rest are counted. The first lines of a crash say what crashed. */
export const MAX_LOGCAT_LINES = 50
/** A log message longer than this is cut. */
export const MAX_LOGCAT_MESSAGE = 500
const SHELL_TIMEOUT_MS = 30_000
/** Grey the masked boxes are painted with. */
const MASK_RGB = [0x5f, 0x63, 0x68] as const

export interface AndroidEvidenceHost {
  exec: Exec
  /** Takes screenshots; without one the run has none. */
  execBinary?: BinaryExec
  now(): number
}

/**
 * `logcat -v epoch,uid`: `<seconds>.<ms> <uid> <pid> <tid> <level> <tag>: <message>`. The uid is a number on recent
 * images and a name (`u0_a123`, `system`) on older ones.
 */
const LOGCAT_LINE_RE = /^\s*(\d+)\.(\d{3})\s+(\S+)\s+(\d+)\s+\d+\s+([VDIWEFA])\s+(.*?)\s*: (.*)$/

/** The names `logcat -v uid` may print for `uid` instead of its number. */
function uidNames(uid: number): string[] {
  const names = [String(uid)]
  if (uid === 1000) names.push('system')
  const app = uid % 100_000
  if (app >= 10_000 && app < 20_000) names.push(`u${Math.floor(uid / 100_000)}_a${app - 10_000}`)
  return names
}

/**
 * Whether `text` names `pkg` as a whole name: `com.a` is not named by `com.ab` or `com.a.debug` (another package),
 * but is by `com.a/.Main` or a sentence ending in `com.a.`
 */
export function namesPackage(text: string, pkg: string): boolean {
  for (let at = text.indexOf(pkg); at !== -1; at = text.indexOf(pkg, at + 1)) {
    const before = text.slice(0, at)
    const after = text.slice(at + pkg.length)
    if (!/[\w.]$/.test(before) && !/^(\w|\.\w)/.test(after)) return true
  }
  return false
}

/**
 * The app's warnings and errors in `logcat -v epoch,uid` output, scrubbed and capped. The app's lines are those of
 * its uid; where the device can't name the uid, those of its running process (`pids`).
 */
export function parseLogcat(
  stdout: string,
  opts: { pkg: string; uid: number | null; pids?: readonly string[]; redact: (text: string) => string; max?: number }
): { lines: DeviceLogLine[]; dropped: number } {
  const own = new Set(opts.uid === null ? [] : uidNames(opts.uid))
  const pids = new Set(opts.pids ?? [])
  const max = opts.max ?? MAX_LOGCAT_LINES
  const lines: DeviceLogLine[] = []
  let dropped = 0
  for (const raw of stdout.split(/\r?\n/)) {
    const m = LOGCAT_LINE_RE.exec(raw)
    if (!m) continue
    const [, sec, ms, uid, pid, level, tag, message] = m
    if (level !== 'W' && level !== 'E' && level !== 'F' && level !== 'A') continue
    if (!own.has(uid) && !pids.has(pid) && !namesPackage(message, opts.pkg) && !namesPackage(tag, opts.pkg)) continue
    if (lines.length >= max) {
      dropped++
      continue
    }
    const at = new Date(Number(sec) * 1000 + Number(ms))
    if (Number.isNaN(at.getTime())) continue
    const text = opts.redact(message)
    lines.push({
      at: at.toISOString(),
      level,
      tag: opts.redact(tag).slice(0, 100),
      message: text.length > MAX_LOGCAT_MESSAGE ? `${text.slice(0, MAX_LOGCAT_MESSAGE)}…` : text
    })
  }
  return { lines, dropped }
}

/** `cmd package list packages -U <pkg>` lists every package starting with `pkg`; the uid of exactly `pkg`. */
export function parsePackageUid(stdout: string, pkg: string): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^package:(\S+)\s+uid:(\d+)/.exec(line.trim())
    if (m && m[1] === pkg) return Number(m[2])
  }
  return null
}

/** The device's epoch clock in ms, from `date +%s%3N` (null when the device can't tell, e.g. no %N). */
export function parseDeviceClock(stdout: string): number | null {
  const t = stdout.trim()
  return /^\d{12,14}$/.test(t) ? Number(t) : null
}

/**
 * `png` with every box painted over, or null when it can't be: not a PNG, or a box outside it (the screen read is not
 * in the screenshot's coordinates, e.g. it rotated in between).
 */
export function maskPng(png: Uint8Array, boxes: readonly UiBounds[]): Uint8Array | null {
  if (boxes.length === 0) return png
  const decoded = decodePng(png)
  if (!decoded.ok) return null
  const { width, height, rgb } = decoded.image
  for (const b of boxes) {
    if (b.left < 0 || b.top < 0 || b.right > width || b.bottom > height) return null
    for (let y = b.top; y < b.bottom; y++) {
      for (let x = b.left; x < b.right; x++) rgb.set(MASK_RGB, (y * width + x) * 3)
    }
  }
  return encodePng(decoded.image)
}

/** The keyboard window's details; its touchable region is the part of the screen it covers. */
export const KEYBOARD_WINDOW_LINE = 'dumpsys window InputMethod'

/**
 * The boxes of `touchable region=SkRegion((l,t,r,b)(...))` in `dumpsys window InputMethod`, or null when the line is
 * missing or holds none (then the keyboard's area is unknown).
 */
export function parseKeyboardRegion(stdout: string): UiBounds[] | null {
  const line = /touchable region=SkRegion\((.*)\)\s*$/m.exec(stdout)
  if (!line) return null
  const boxes: UiBounds[] = []
  for (const m of line[1].matchAll(/\((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)/g)) {
    const [left, top, right, bottom] = m.slice(1).map(Number)
    if (right > left && bottom > top) boxes.push({ left, top, right, bottom })
  }
  return boxes.length > 0 ? boxes : null
}

/**
 * The on-screen keyboard's area when it is up, [] when it is down, null when it is up (or may be) and its area can't
 * be read. Shared by the run evidence (masking) and the recorder (which touches are typing).
 */
export async function readKeyboardBoxes(shell: (line: string) => ReturnType<Exec>): Promise<UiBounds[] | null> {
  const shown = await shell(KEYBOARD_SHOWN_LINE)
  // grep exits 1 when the line is missing: like the replayer, that is a keyboard that is not shown. No answer is unknown.
  if (shown.error === 'timeout' || shown.error === 'not_found' || shown.error === 'too_large') return null
  if (!/mInputShown=true/.test(shown.stdout)) return []
  const win = await shell(KEYBOARD_WINDOW_LINE)
  return win.code !== 0 || win.error ? null : parseKeyboardRegion(win.stdout)
}

/** An android flow locator as a screen-dump query; null for layers that don't apply to Android views. */
export const toUiLocator = (s: Selector): UiLocator | null =>
  'id' in s ? { resource_id: s.id } : 'desc' in s ? { content_desc: s.desc } : 'text' in s ? { text: s.text } : null

/**
 * The boxes to paint over on `screen`: every view of `pkg` any of the secret fields' locators finds, and every view
 * whose text or description shows a secret (`redact` changes it).
 */
export function secretBoxes(screen: UiScreen, pkg: string, secretFields: readonly (readonly Selector[])[], redact: (text: string) => string): UiBounds[] {
  const hit = new Set<number>()
  for (const selectors of secretFields) {
    for (const s of selectors) {
      const loc = toUiLocator(s)
      if (loc === null) continue
      for (const n of findAll(screen.nodes, loc)) if (n.package === pkg) hit.add(n.i)
    }
  }
  for (const n of screen.nodes) {
    if ((n.text && redact(n.text) !== n.text) || (n.content_desc && redact(n.content_desc) !== n.content_desc)) hit.add(n.i)
  }
  const boxes: UiBounds[] = []
  for (const i of hit) {
    const b = screen.nodes[i].bounds
    if (b !== null && b.right > b.left && b.bottom > b.top) boxes.push(b)
  }
  return boxes
}

export interface AndroidEvidence {
  /** A screenshot of the device now, base64 PNG, secrets masked; undefined when none could be taken safely. */
  shot(): Promise<string | undefined>
  /** The step's log since `startedAt` (host epoch ms); empty without a device clock. */
  stepLog(startedAt: number): Promise<{ lines: DeviceLogLine[]; dropped: number }>
}

export interface AndroidEvidenceRequest {
  adb: string
  serial: string
  pkg: string
  /** Read the device log per step. */
  logcat: boolean
  /** Locators of the fields the run has typed a secret into so far (the list grows during the run). */
  secretFields: readonly (readonly Selector[])[]
  /**
   * The flow uses `${secret.*}` anywhere: every shot is then masked (views showing a secret, the keyboard), even
   * before a secret field is filled, since a deep link or a tap may already have put one on screen.
   */
  usesSecrets: boolean
  /** Scrubs the secrets the run has used so far. */
  redact(text: string): string
}

/** Sets up the evidence for one run: asks the device for its clock and the app's uid once (logcat only). */
export async function startAndroidEvidence(req: AndroidEvidenceRequest, host: AndroidEvidenceHost): Promise<AndroidEvidence> {
  const { adb, serial, pkg } = req
  const shell = (line: string): ReturnType<Exec> => host.exec(adb, ['-s', serial, 'shell', line], SHELL_TIMEOUT_MS)
  let offset: number | null = null
  let uid: number | null = null
  if (req.logcat) {
    const before = host.now()
    const clock = await shell('date +%s%3N')
    const device = clock.code === 0 && !clock.error ? parseDeviceClock(clock.stdout) : null
    // Half the round trip: the device read its clock somewhere in the middle of it.
    if (device !== null) offset = device - Math.round((before + host.now()) / 2)
    const listed = await shell(`cmd package list packages -U ${shQuote(pkg)}`)
    uid = listed.code === 0 && !listed.error ? parsePackageUid(listed.stdout, pkg) : null
  }
  let shotsGaveUp = false
  const keyboardBoxes = (): Promise<UiBounds[] | null> => readKeyboardBoxes(shell)

  return {
    async shot() {
      if (shotsGaveUp || host.execBinary === undefined) return undefined
      const masking = req.usesSecrets || req.secretFields.length > 0
      const first = masking ? await readScreen(host, adb, serial) : null
      if (first !== null && 'skipped' in first) return undefined
      const keyboardBefore = masking ? await keyboardBoxes() : []
      if (keyboardBefore === null) return undefined
      const frame = await captureScreen(adb, serial, host.execBinary)
      if (!frame.ok) {
        // A device that stopped answering or left: no more shots this run. A blocked screen (FLAG_SECURE) may pass later.
        if (/did not send|no longer connected|could not be started/.test(frame.error)) shotsGaveUp = true
        return undefined
      }
      let png: Uint8Array | null = frame.png
      if (first !== null) {
        const second = await readScreen(host, adb, serial)
        if ('skipped' in second) return undefined
        const keyboardAfter = await keyboardBoxes()
        if (keyboardAfter === null) return undefined
        png = maskPng(frame.png, [
          ...secretBoxes(first, pkg, req.secretFields, req.redact),
          ...secretBoxes(second, pkg, req.secretFields, req.redact),
          ...keyboardBefore,
          ...keyboardAfter
        ])
      }
      return png === null ? undefined : Buffer.from(png).toString('base64')
    },

    async stepLog(startedAt) {
      if (offset === null) return { lines: [], dropped: 0 }
      const since = Math.floor(startedAt + offset)
      const r = await shell(`logcat -d -v epoch,uid -t ${Math.floor(since / 1000)}.${String(since % 1000).padStart(3, '0')} '*:W'`)
      if (r.code !== 0 || r.error) return { lines: [], dropped: 0 }
      let pids: string[] = []
      if (uid === null) {
        const p = await shell(`pidof ${shQuote(pkg)}`)
        pids = p.code === 0 && !p.error ? p.stdout.trim().split(/\s+/).filter((x) => /^\d+$/.test(x)) : []
      }
      return parseLogcat(r.stdout, { pkg, uid, pids, redact: req.redact })
    }
  }
}
