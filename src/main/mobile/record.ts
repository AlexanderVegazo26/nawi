import { ANDROID_KEYS, FLOW_VERSION, MAX_BACKGROUND_MS, MAX_HOLD_MS, MAX_INTENT_CHARS, MAX_TEXT_LOCATOR_CHARS, type Flow, type FlowStep, type Selector } from '../../shared/flow/schema'
import { parseFlow, stringifyFlow } from '../../shared/flow/yaml'
import { labelOf, PERMISSION_PACKAGES } from './blockers'
import { isTextField, type UiBounds, type UiNode, type UiScreen } from './hierarchy'
import { DEFAULT_LONG_PRESS_TIMEOUT_MS, shortestHold } from './long-press'
import { orientationOf } from './rotation'

/**
 * Roadmap M5c, first slice: turn what a person did on an Android device into an android flow (`target.kind: android`)
 * that replayAndroidFlow (flow-replay.ts) can run. Electron-free and pure, so tests pin it; reading the device live
 * (`getevent`, a screen dump after each gesture) is the next slice.
 *
 * Input:
 * - the touch panels and keys from `getevent -lp`, and the raw events from `getevent -lt` (the kernel's view: taps,
 *   long presses, swipes and hardware keys; `input tap` from adb never shows there);
 * - the screen (`uiautomator dump`) and the on-screen keyboard's area just before each gesture, and the screen after
 *   the last one.
 *
 * Output: click, fill and press steps with layered locators (resource id, content description, text: each kept only
 * when it finds that view alone among the app's views), plus one warning per thing that was not recorded and why.
 * - A tap is resolved on the screen it landed on: the topmost view under the finger, then its nearest tappable
 *   ancestor. A tap on another app's window (Android's permission prompt, the launcher) is not a step.
 * - Typing is not seen as keys (the on-screen keyboard is another app, and taps on its area are skipped): it is read
 *   from how the focused text field's text changed between screens, and becomes one `fill` with the final text,
 *   replacing the tap that focused the field (a fill taps it itself). A password field's text is hidden by Android,
 *   so its fill types `${secret.<name>}` at run time; the password is never in the flow.
 * - Back while the keyboard is up only closes the keyboard, so it is dropped (the replayer closes the keyboard before
 *   each tap on its own).
 * - A long press becomes a click with `hold_ms` (M5d-3): the time the finger rested, rounded up to 100 ms, at least
 *   the device's long-press timeout plus the replayer's margin, at most MAX_HOLD_MS; it goes to the view a tap would.
 * - Leaving the app and coming back to it (its icon, its card in the app switcher) becomes one `background` step
 *   (M5d-5) whose `ms` is the time from leaving to the touch that brought the app back, to the nearest 100 ms. It
 *   left with Home or the app switcher once a screen of other apps shows after the key, or without a key when the
 *   screen after an input shows other apps only (gesture navigation's swipe up: its swipe is no warning then). What
 *   was touched on the way (the launcher, the app switcher, another app) is not a step. A Home that left the app on
 *   screen, or after which the recording ended away from the app, stays a press step.
 * - Multi-finger gestures have no android step yet, and swipes are not turned into the `scroll` steps android flows
 *   have since M5d-2: both are warnings, not steps.
 */

/** A touch panel from `getevent -lp`: its device node and the raw range of its multi-touch axes. */
export interface TouchPanel {
  path: string
  x: { min: number; max: number }
  y: { min: number; max: number }
}

/** The display in its natural (portrait for a phone) orientation, from `wm size` / `wm density`. */
export interface DisplayInfo {
  width: number
  height: number
  /** Dots per inch class (`wm density`, e.g. 420); used for the touch slop. */
  density: number
}

export interface Point {
  x: number
  y: number
}

/** One finger-down-to-all-fingers-up gesture, in display pixels of the natural orientation. */
export interface Stroke {
  kind: 'stroke'
  /** Device time in ms (getevent's clock). */
  t0: number
  t1: number
  start: Point
  end: Point
  /** Farthest the first finger moved from where it went down, in px. */
  travel: number
  /** Most fingers down at once. */
  pointers: number
  /** The kernel dropped events during it (SYN_DROPPED): its path is not reliable. */
  dropped: boolean
}

export interface KeyPress {
  kind: 'key'
  t: number
  /** The kernel's key name, e.g. `KEY_BACK`. */
  key: string
}

export type RawInput = Stroke | KeyPress

/** The screen and the on-screen keyboard's area at one moment. */
export interface Snapshot {
  screen: UiScreen
  /** The keyboard's touchable boxes while it is up, else null. */
  keyboard: UiBounds[] | null
}

export interface RecordedEvent {
  input: RawInput
  /** The screen just before the input (the screen it acted on). */
  before: Snapshot
}

export interface AndroidRecording {
  /** The app under test; taps on other packages' windows are not steps. */
  package: string
  name?: string
  display: DisplayInfo
  /** The device's long-press timeout (long-press.ts); DEFAULT_LONG_PRESS_TIMEOUT_MS when unknown. */
  longPressTimeoutMs?: number
  events: RecordedEvent[]
  /** The screen after the last input settled (where its typing shows). */
  after: Snapshot
}

export interface AndroidRecordingResult {
  flow: Flow
  /** One sentence per input that did not become a step and was not plain typing. */
  warnings: string[]
}

/** Android's touch slop: how far a finger may drift and still be a tap, in dp. */
export const TOUCH_SLOP_DP = 8
/** How many locator layers a step keeps (id, desc, text). */
const MAX_SELECTORS = 3
const NO_TRACKING_ID = 0xffffffff

const PANEL_RE = /^add device \d+: (\/dev\/input\/event\d+)\s*$/
const AXIS_RE = /\b(ABS_MT_POSITION_[XY])\s*: value -?\d+, min (-?\d+), max (-?\d+)/

/** The multi-touch panels in `getevent -lp` output (devices that report both MT position axes). */
export function parseTouchPanels(text: string): TouchPanel[] {
  const panels: TouchPanel[] = []
  let path: string | null = null
  let x: TouchPanel['x'] | null = null
  let y: TouchPanel['y'] | null = null
  const flush = (): void => {
    if (path && x && y) panels.push({ path, x, y })
  }
  for (const line of text.split(/\r?\n/)) {
    const dev = PANEL_RE.exec(line)
    if (dev) {
      flush()
      path = dev[1]
      x = y = null
      continue
    }
    const axis = AXIS_RE.exec(line)
    if (!axis || !path) continue
    const range = { min: Number(axis[2]), max: Number(axis[3]) }
    if (range.max <= range.min) continue
    if (axis[1].endsWith('X')) x = range
    else y = range
  }
  flush()
  return panels
}

const EVENT_RE = /^\[\s*(\d+)\.(\d{1,9})\]\s+(\/dev\/input\/event\d+):\s+(EV_[A-Z]+)\s+(\S+)\s+(\S+)/

interface Contact {
  x: number | null
  y: number | null
}

interface PanelState {
  slot: number
  contacts: Map<number, Contact>
  /**
   * Each slot's last position. The kernel sends an axis only when its value changes, so a finger that goes down where
   * the slot's previous finger lifted (the same button twice) arrives with a tracking id and no position.
   */
  last: Map<number, Contact>
  /** Slots whose finger lifted in the current frame. */
  lifted: Set<number>
  /** After SYN_DROPPED: events up to the next SYN_REPORT are partial and skipped (the kernel's resync rule). */
  syncing: boolean
  gesture: { t0: number; first: number; start: Point | null; end: Point | null; travel: number; pointers: number; dropped: boolean } | null
}

/**
 * Reads `getevent -lt` output line by line into gestures and key presses (multi-touch protocol B, as Android's touch
 * panels and the emulator report it). Lines it does not know (other devices, `add device`, sensors) are skipped.
 */
export class GestureReader {
  private readonly panels = new Map<string, TouchPanel>()
  private readonly state = new Map<string, PanelState>()
  /** A line cut off at the end of the last chunk (adb streams output in arbitrary pieces). */
  private rest = ''

  constructor(
    panels: readonly TouchPanel[],
    private readonly display: DisplayInfo
  ) {
    for (const p of panels) this.panels.set(p.path, p)
  }

  /** The inputs completed by this chunk of output; a line cut off at its end waits for the next chunk. */
  push(chunk: string): RawInput[] {
    const lines = (this.rest + chunk).split(/\r?\n/)
    this.rest = lines.pop() ?? ''
    return this.read(lines)
  }

  /** A finger is on a touch panel now (a gesture has started and not ended). */
  get touching(): boolean {
    for (const s of this.state.values()) if (s.gesture !== null || s.contacts.size > 0) return true
    return false
  }

  /** The inputs completed by what is left once the stream ended (a last line without its newline). */
  end(): RawInput[] {
    const last = this.rest
    this.rest = ''
    return this.read([last])
  }

  private read(lines: readonly string[]): RawInput[] {
    const out: RawInput[] = []
    for (const line of lines) {
      const m = EVENT_RE.exec(line)
      if (!m) continue
      const [, sec, frac, path, type, code, value] = m
      const t = Number(sec) * 1000 + Number(frac.padEnd(6, '0').slice(0, 6)) / 1000
      if (type === 'EV_KEY' && !code.startsWith('BTN_')) {
        if (value === 'DOWN') out.push({ kind: 'key', t, key: code })
        continue
      }
      const panel = this.panels.get(path)
      if (!panel) continue
      const s = this.stateOf(path)
      if (type === 'EV_SYN' && code === 'SYN_DROPPED') {
        // Lost events may include a finger-up: end the gesture here (marked) and start clean after the next report,
        // instead of waiting forever for a lift that never comes.
        const g = s.gesture
        if (g?.start && g.end) out.push({ kind: 'stroke', t0: g.t0, t1: t, start: g.start, end: g.end, travel: g.travel, pointers: g.pointers, dropped: true })
        s.gesture = null
        s.contacts.clear()
        s.lifted.clear()
        s.syncing = true
        continue
      }
      if (type === 'EV_SYN' && code === 'SYN_REPORT') {
        if (s.syncing) {
          s.syncing = false
          continue
        }
        const done = this.frame(s, t)
        if (done) out.push(done)
        continue
      }
      if (type === 'EV_ABS' && !s.syncing && /^[0-9a-f]{1,8}$/i.test(value)) this.abs(s, panel, code, Number.parseInt(value, 16))
    }
    return out
  }

  private stateOf(path: string): PanelState {
    let s = this.state.get(path)
    if (!s) {
      s = { slot: 0, contacts: new Map(), last: new Map(), lifted: new Set(), syncing: false, gesture: null }
      this.state.set(path, s)
    }
    return s
  }

  private abs(s: PanelState, panel: TouchPanel, code: string, raw: number): void {
    if (code === 'ABS_MT_SLOT') {
      s.slot = raw
      return
    }
    if (code === 'ABS_MT_TRACKING_ID') {
      if (raw === NO_TRACKING_ID) s.lifted.add(s.slot)
      else {
        s.contacts.set(s.slot, { ...(s.last.get(s.slot) ?? { x: null, y: null }) })
        s.lifted.delete(s.slot)
      }
      return
    }
    const axis = code === 'ABS_MT_POSITION_X' ? 'x' : code === 'ABS_MT_POSITION_Y' ? 'y' : null
    if (!axis) return
    const px = axis === 'x' ? this.scale(raw, panel.x, this.display.width) : this.scale(raw, panel.y, this.display.height)
    const last = s.last.get(s.slot) ?? { x: null, y: null }
    last[axis] = px
    s.last.set(s.slot, last)
    const c = s.contacts.get(s.slot)
    if (c) c[axis] = px
  }

  private scale(raw: number, range: { min: number; max: number }, size: number): number {
    const f = (Math.min(Math.max(raw, range.min), range.max) - range.min) / (range.max - range.min)
    return Math.min(size - 1, Math.floor(f * size))
  }

  private frame(s: PanelState, t: number): Stroke | null {
    const down = [...s.contacts.entries()].filter(([, c]) => c.x !== null && c.y !== null)
    if (down.length > 0) {
      if (!s.gesture) s.gesture = { t0: t, first: down[0][0], start: null, end: null, travel: 0, pointers: 0, dropped: false }
      const g = s.gesture
      g.pointers = Math.max(g.pointers, down.length)
      const first = s.contacts.get(g.first)
      if (first && first.x !== null && first.y !== null) {
        const p = { x: first.x, y: first.y }
        g.start ??= p
        g.end = p
        g.travel = Math.max(g.travel, Math.hypot(p.x - g.start.x, p.y - g.start.y))
      }
    }
    for (const slot of s.lifted) s.contacts.delete(slot)
    s.lifted.clear()
    if (s.contacts.size > 0 || !s.gesture) return null
    const g = s.gesture
    s.gesture = null
    if (!g.start || !g.end) return null
    return { kind: 'stroke', t0: g.t0, t1: t, start: g.start, end: g.end, travel: g.travel, pointers: g.pointers, dropped: g.dropped }
  }
}

/** A point of the natural orientation on a screen rotated by `rotation` quarter turns (the dump's `rotation`). */
export function toScreen(p: Point, rotation: number, display: DisplayInfo): Point {
  const { width: w, height: h } = display
  switch (rotation) {
    case 1:
      return { x: p.y, y: w - 1 - p.x }
    case 2:
      return { x: w - 1 - p.x, y: h - 1 - p.y }
    case 3:
      return { x: h - 1 - p.y, y: p.x }
    default:
      return p
  }
}

export type TouchKind = 'tap' | 'long_press' | 'swipe' | 'multi'

/** A finger that rests without moving for the device's long-press timeout (`longPressMs`) is a long press, else a tap. */
export function classifyStroke(s: Stroke, display: DisplayInfo, longPressMs = DEFAULT_LONG_PRESS_TIMEOUT_MS): TouchKind {
  if (s.pointers > 1) return 'multi'
  const slop = (TOUCH_SLOP_DP * display.density) / 160
  if (s.travel > slop) return 'swipe'
  return s.t1 - s.t0 >= longPressMs ? 'long_press' : 'tap'
}

/** Kernel key names that are steps, as the press keys of an android flow. */
const KEY_STEPS: Readonly<Record<string, string>> = {
  KEY_BACK: 'Back',
  KEY_HOME: 'Home',
  KEY_HOMEPAGE: 'Home',
  KEY_APPSELECT: 'AppSwitch',
  KEY_ENTER: 'Enter',
  KEY_KPENTER: 'Enter',
  KEY_TAB: 'Tab',
  KEY_ESC: 'Escape',
  KEY_UP: 'ArrowUp',
  KEY_DOWN: 'ArrowDown',
  KEY_LEFT: 'ArrowLeft',
  KEY_RIGHT: 'ArrowRight'
}
/** Keys that change the device, not the app: never replayed. */
const DEVICE_KEYS = /^KEY_(POWER|VOLUMEUP|VOLUMEDOWN|MUTE|SLEEP|WAKEUP|CAMERA)$/

/** Whether `p` is in box `b` (right and bottom edges excluded). */
export const inside = (b: UiBounds | null, p: Point): boolean => b !== null && p.x >= b.left && p.x < b.right && p.y >= b.top && p.y < b.bottom
const actionable = (n: UiNode): boolean => n.clickable || n.long_clickable || n.checkable || isTextField(n)
const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * The topmost view under `p` (later in the dump = drawn above), then its nearest actionable ancestor within 6 hops
 * (the hit itself when none is). A disabled target took the tap without doing anything.
 */
export function viewAt(screen: UiScreen, p: Point): { hit: UiNode; target: UiNode } | null {
  const nodes = screen.nodes
  let hit: UiNode | null = null
  for (let i = nodes.length - 1; i >= 0; i--) {
    const b = nodes[i].bounds
    if (b && b.right > b.left && b.bottom > b.top && inside(b, p)) {
      hit = nodes[i]
      break
    }
  }
  if (!hit) return null
  let cur: UiNode | null = hit
  for (let hops = 0; cur && hops < 7; hops++) {
    if (actionable(cur)) return { hit, target: cur }
    cur = cur.parent === null ? null : nodes[cur.parent]
  }
  return { hit, target: hit }
}

/**
 * A recorded long press's hold: the finger's rest rounded up to 100 ms, at least what the device takes for a long
 * press with the replayer's margin (shortestHold), at most MAX_HOLD_MS.
 */
export const holdFor = (restedMs: number, timeoutMs = DEFAULT_LONG_PRESS_TIMEOUT_MS): number =>
  Math.min(MAX_HOLD_MS, Math.max(shortestHold(timeoutMs), Math.ceil(restedMs / 100) * 100))

/** The locator layers (id, desc, text) that each find `n` and no other view of `pkg`; never a field's typed text. */
export function selectorsFor(screen: UiScreen, pkg: string, n: UiNode): Selector[] {
  const app = screen.nodes.filter((v) => v.package === pkg)
  const unique = (same: (v: UiNode) => boolean): boolean => app.filter(same).length === 1
  const out: Selector[] = []
  // A flow locator needs a non-blank value (parseFlow); blank ones would also match every other blank view.
  const usable = (v: string): boolean => /\S/.test(v) && v.length <= MAX_TEXT_LOCATOR_CHARS
  if (/\S/.test(n.resource_id) && unique((v) => v.resource_id === n.resource_id)) out.push({ id: n.resource_id })
  if (usable(n.content_desc) && unique((v) => v.content_desc === n.content_desc)) out.push({ desc: n.content_desc })
  if (!isTextField(n) && usable(n.text) && unique((v) => v.text === n.text)) out.push({ text: n.text })
  return out.slice(0, MAX_SELECTORS)
}

/** Locators for a tap's target, or for the view under the finger inside it when the target has none of its own. */
function tapSelectors(screen: UiScreen, pkg: string, target: UiNode, hit: UiNode): { node: UiNode; selectors: Selector[] } | null {
  const own = selectorsFor(screen, pkg, target)
  if (own.length > 0) return { node: target, selectors: own }
  // A row with no id of its own: a label inside it, under the finger, taps the same row when replayed.
  for (let cur: UiNode | null = hit; cur && cur !== target; cur = cur.parent === null ? null : screen.nodes[cur.parent]) {
    const sel = selectorsFor(screen, pkg, cur)
    if (sel.length > 0) return { node: cur, selectors: sel }
  }
  return null
}

const fieldName = (n: UiNode): string => oneLine(n.hint || n.content_desc || n.resource_id.replace(/^.*:id\//, '') || 'text field', 80)
/**
 * A field's text as typed: '' when it equals the hint, since Android reports an empty field's hint as its text (seen
 * on API 36; the dump does not say whether the hint is showing). Typing exactly the hint is therefore read as empty.
 */
const fieldValue = (n: UiNode): string => (n.hint && n.text === n.hint ? '' : n.text)

function secretName(n: UiNode, used: Set<string>): string {
  const base =
    (n.resource_id.replace(/^.*:id\//, '') || n.hint || n.content_desc || 'password')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'password'
  const safe = /^[0-9]/.test(base) || ['__proto__', 'constructor', 'prototype'].includes(base) ? `field_${base}` : base
  let name = safe
  for (let i = 2; used.has(name); i++) name = `${safe}_${i}`
  used.add(name)
  return name
}

interface PendingFocus {
  key: string
  selectors: Selector[]
  label: string
}

type FillStep = Extract<FlowStep, { action: 'fill' }>

/** Build an android flow from a recording; see the module comment for what becomes a step. */
export function flowFromAndroidRecording(rec: AndroidRecording): AndroidRecordingResult {
  const pkg = rec.package
  const longPressMs = rec.longPressTimeoutMs ?? DEFAULT_LONG_PRESS_TIMEOUT_MS
  // Step ids are numbered once the steps are final.
  const steps: FlowStep[] = []
  const warnings: string[] = []
  const secrets = new Map<string, string>()
  const usedSecrets = new Set<string>()
  /** Fills whose value is our own `${secret.*}` placeholder, not text the person typed. */
  const secretFills = new WeakSet<FillStep>()
  // Assigned inside the closures below too, so typed by hand (TS would narrow a `null` initializer for good).
  let pending = null as PendingFocus | null
  /** The field the last fill step typed into, so more typing in it updates that step. */
  let lastFill = null as { key: string; step: FillStep } | null
  const keyOf = (selectors: Selector[]): string => JSON.stringify(selectors)
  const flushFocus = (): void => {
    if (!pending) return
    steps.push({ id: '', action: 'click', intent: `Tap the ${pending.label} field`, target: { selectors: pending.selectors } })
    pending = null
  }
  const push = (step: FlowStep): void => {
    flushFocus()
    lastFill = null
    steps.push(step)
  }

  /** Text typed into fields between two screens: one fill per field, merged with the last fill when it is the same field. */
  const typing = (from: Snapshot, to: Snapshot): void => {
    for (const before of from.screen.nodes) {
      if (before.package !== pkg || !isTextField(before)) continue
      const selectors = selectorsFor(from.screen, pkg, before)
      if (selectors.length === 0) continue
      const key = keyOf(selectors)
      const first = selectors[0]
      const after = to.screen.nodes.find((v) => v.package === pkg && isTextField(v) && ('id' in first ? v.resource_id === first.id : 'desc' in first ? v.content_desc === first.desc : false))
      if (!after || after.text === before.text) continue
      // Text the app put into a field the person was not in (a computed total, an autofill) is not typing.
      if (!after.focused && pending?.key !== key && lastFill?.key !== key) continue
      let value: string
      const secret = after.password || before.password
      if (secret) {
        let name = secrets.get(key)
        if (!name) {
          name = secretName(after, usedSecrets)
          secrets.set(key, name)
          warnings.push(`The password typed into "${fieldName(after)}" is not in the flow: it types \${secret.${name}} at run time (NAWI_SECRET_${name} for nawi run).`)
        }
        value = `\${secret.${name}}`
      } else value = fieldValue(after)
      if (lastFill && lastFill.key === key) {
        lastFill.step.value = value
        if (secret) secretFills.add(lastFill.step)
        continue
      }
      if (pending && pending.key !== key) flushFocus()
      pending = null
      const step: FillStep = { id: '', action: 'fill', intent: `Type into the ${fieldName(after)} field`, target: { selectors }, value }
      if (secret) secretFills.add(step)
      steps.push(step)
      lastFill = { key, step }
    }
  }

  /**
   * The screen turned (roadmap M5d-4): a rotate step to where it shows now. Added to the steps as they stand, without
   * closing the field being typed into: typing that goes on after the turn stays one fill. A flow that turns the
   * screen also starts with a rotate to where the recording started (added at the end), so its first steps replay
   * on the screen they were recorded on whichever way the device stands.
   */
  const rotate = (r: number): FlowStep | null => {
    const orientation = orientationOf(r, rec.display)
    return orientation === null ? null : { id: '', action: 'rotate', intent: `Turn the screen to ${orientation}`, orientation }
  }
  const firstRotation = (rec.events[0]?.before ?? rec.after).screen.rotation
  let rotation = firstRotation
  let turns = 0
  const turned = (snap: Snapshot): void => {
    const step = rotate(snap.screen.rotation)
    if (snap.screen.rotation === rotation || step === null) return
    rotation = snap.screen.rotation
    turns++
    steps.push(step)
  }

  /**
   * The app left the screen (M5d-5): through Home or the app switcher (`key`; `left` once a screen of other apps showed
   * after it), or without a key (`key` null, left at once): gesture navigation's swipe up, a tap that opened another
   * app. `t` = when it went, `back` = the end of the last input while it was away (the touch that brought it back).
   */
  let away = null as { key: string | null; t: number; left: boolean; back: number } | null
  const shows = (screen: UiScreen): boolean => screen.nodes.some((n) => n.package === pkg)
  /** A screen of other apps only; an empty read (between two windows) says nothing about where the app is. */
  const elsewhere = (screen: UiScreen): boolean => screen.nodes.length > 0 && !shows(screen)
  /** The app is in front again, or the recording ended: the background step, or the key press when it never left. */
  const settleAway = (): void => {
    if (away === null) return
    const { key, t, left, back } = away
    away = null
    if (!left) {
      if (key !== null) push({ id: '', action: 'press', key })
      return
    }
    const spent = Math.max(0, Math.round((back - t) / 100) * 100)
    const ms = Math.min(MAX_BACKGROUND_MS, spent)
    if (spent > MAX_BACKGROUND_MS) warnings.push(`The app was in the background for ${Math.round(spent / 1000)} s: the step keeps it there ${MAX_BACKGROUND_MS / 60_000} minutes, the longest a flow does.`)
    push({ id: '', action: 'background', intent: `Leave the app in the background for ${(ms / 1000).toFixed(1)} s, then come back to it`, ms })
  }
  /** Where the previous input's swipe warning is: dropped when that swipe turns out to have been the Home gesture. */
  let swipeWarning = null as number | null
  /** When the previous input ended (device ms). */
  let lastEnd = 0

  const snapshots = [...rec.events.map((e) => e.before), rec.after]
  for (const [k, { input, before }] of rec.events.entries()) {
    const end = input.kind === 'key' ? input.t : input.t1
    const swipedBefore = swipeWarning
    swipeWarning = null
    if (away === null && k > 0 && shows(snapshots[k - 1].screen) && elsewhere(before.screen)) {
      // Gone without Home or the app switcher: gesture navigation's swipe up (not a scroll to warn about), or a tap.
      if (swipedBefore !== null) warnings.splice(swipedBefore, 1)
      away = { key: null, t: lastEnd, left: true, back: lastEnd }
    }
    lastEnd = end
    if (away !== null) {
      // Away from the app: the launcher, the app switcher or another app; nothing done there is a step of this flow.
      if (elsewhere(before.screen)) {
        away.left = true
        away.back = end
        continue
      }
      if (before.screen.nodes.length === 0) {
        away.back = end
        warnings.push(`${input.kind === 'key' ? `The ${input.key.slice(4).toLowerCase()} key` : 'A touch'} right after leaving the app is not recorded: the screen could not be read then.`)
        continue
      }
      settleAway()
    }
    // After a background step: the screen before is another app's, so this finds no typing (none is done away).
    if (k > 0) typing(snapshots[k - 1], before)
    turned(before)
    if (input.kind === 'key') {
      const press = KEY_STEPS[input.key]
      if (DEVICE_KEYS.test(input.key)) warnings.push(`The ${input.key.slice(4).toLowerCase()} key is not recorded: it changes the device, not the app.`)
      // Back while the keyboard is up only closes the keyboard; the replayer closes it before each tap itself.
      if (!press || (press === 'Back' && before.keyboard !== null)) continue
      if (!(press in ANDROID_KEYS)) continue
      if (press === 'Home' || press === 'AppSwitch') {
        // Whether this leaves the app shows on the next screens: a background step once the app is back.
        away = { key: press, t: input.t, left: false, back: input.t }
        continue
      }
      push({ id: '', action: 'press', key: press })
      continue
    }
    const at = toScreen(input.start, before.screen.rotation, rec.display)
    // Typing: skipped before any warning is written, so no message says where a key of a password was.
    if (before.keyboard?.some((b) => inside(b, at))) continue
    const where = `(${at.x}, ${at.y})`
    if (input.dropped) {
      warnings.push(`A touch at ${where} is not recorded: the device dropped some of its events.`)
      continue
    }
    const kind = classifyStroke(input, rec.display, longPressMs)
    const held = kind === 'long_press'
    // A long press goes to the same view a tap would: the first one up from the finger that takes touches (a
    // clickable label inside a long-clickable row gets it, and clicks on lift when it has no long press of its own).
    const found = viewAt(before.screen, at)
    const label = found ? oneLine(labelOf(found.target) || labelOf(found.hit), 60) : ''
    const on = label ? ` on "${label}"` : ''
    if (kind === 'swipe' || kind === 'multi') {
      const what = kind === 'swipe' ? 'A swipe' : `A ${input.pointers}-finger gesture`
      const why = kind === 'swipe' ? 'the recorder does not turn swipes into scroll steps yet (add a scroll step to the flow by hand)' : 'android flows have no step for it yet'
      if (kind === 'swipe') swipeWarning = warnings.length
      warnings.push(`${what} at ${where}${on} is not recorded: ${why}.`)
      continue
    }
    const what = held ? 'A long press' : 'A tap'
    if (!found) {
      warnings.push(`${what} at ${where} is not recorded: no view is there on the screen it landed on.`)
      continue
    }
    if (found.target.package !== pkg) {
      warnings.push(
        PERMISSION_PACKAGES.has(found.target.package)
          ? `${what}${on} in Android's permission prompt is not recorded: grant the permission before the run (the profile's permissions.grant).`
          : `${what} at ${where}${on} is not recorded: it landed on ${found.target.package || 'the system'}, not ${pkg}.`
      )
      continue
    }
    if (!found.target.enabled) {
      warnings.push(`${what} at ${where}${on} is not recorded: that view was disabled, so ${held ? 'the long press' : 'the tap'} did nothing.`)
      continue
    }
    const loc = tapSelectors(before.screen, pkg, found.target, found.hit)
    if (!loc) {
      warnings.push(`${what} at ${where}${on} is not recorded: no resource id, description or text finds that view alone.`)
      continue
    }
    if (held) {
      const rested = input.t1 - input.t0
      if (shortestHold(longPressMs) > MAX_HOLD_MS) {
        warnings.push(`A long press at ${where}${on} is not recorded: the device takes a touch for a long press only after ${longPressMs} ms, longer than a flow holds (${MAX_HOLD_MS} ms).`)
        continue
      }
      const hold_ms = holdFor(rested, longPressMs)
      if (rested > MAX_HOLD_MS) warnings.push(`A long press at ${where}${on} lasted ${(rested / 1000).toFixed(1)} s: the step holds ${MAX_HOLD_MS / 1000} s, the longest a flow holds.`)
      push({ id: '', action: 'click', intent: label ? `Long press "${label}"` : 'Long press the view', target: { selectors: loc.selectors }, hold_ms })
      continue
    }
    if (isTextField(found.target) && loc.node === found.target) {
      const key = keyOf(loc.selectors)
      // Back into the field the last fill typed into: more typing updates that fill.
      if (lastFill?.key === key) continue
      flushFocus()
      lastFill = null
      pending = { key, selectors: loc.selectors, label: fieldName(found.target) }
      continue
    }
    push({ id: '', action: 'click', intent: label ? `Tap "${label}"` : 'Tap the view', target: { selectors: loc.selectors } })
  }
  if (rec.events.length > 0) {
    // Still away when the recording ended: the flow ends where the person left it, with the key they pressed.
    if (away !== null && !shows(rec.after.screen)) away.left = false
    settleAway()
    typing(snapshots[rec.events.length - 1], rec.after)
    turned(rec.after)
  }
  flushFocus()
  const start = rotate(firstRotation)
  if (start !== null && (turns > 0 || firstRotation !== 0)) steps.unshift(start)

  // A literal "${" would be read as a placeholder at run time; a value replay can't type is refused there with its own message.
  const kept = steps.filter((s) => {
    if (s.action !== 'fill' || secretFills.has(s) || !s.value.includes('${')) return true
    warnings.push(`The text typed into a field contains "\${", which a flow reads as a placeholder; that fill is not recorded.`)
    return false
  })
  kept.forEach((s, i) => (s.id = `s${i + 1}`))
  for (const s of kept) if (s.intent) s.intent = oneLine(s.intent, MAX_INTENT_CHARS)

  const flow: Flow = { version: FLOW_VERSION, name: rec.name ?? `Recorded on ${pkg}`, target: { kind: 'android', package: pkg }, steps: kept }
  if (rec.events.length === 0) warnings.push('Nothing was recorded: no touches or keys reached the device.')
  // The flow must read back as written: a recorder bug shows here, not at replay.
  const check = parseFlow(stringifyFlow(flow))
  if (!check.ok) throw new Error(`the recorded flow does not parse: ${check.errors.map((e) => e.message).join('; ')}`)
  return { flow, warnings }
}
