import type { ExecResult } from '../doctor'
import type { AndroidReplayHost } from '../flow-replay'
import { encodePng } from '../png'

/**
 * A simulated shop app behind a fake adb, shared by the Android replayer (roadmap M5a) and recorder (M5c) tests: every
 * screen is a uiautomator dump built from the spec below, a tap lands on the topmost tappable control whose bounds
 * hold the point, typed text goes into the focused field, Back closes the keyboard or pops the screen.
 */

export const PKG = 'dev.nawi.shop'
export const ID = (name: string): string => `${PKG}:id/${name}`
export type Box = [number, number, number, number]

export interface Control {
  cls?: string
  id?: string
  text?: string
  desc?: string
  pkg?: string
  enabled?: boolean
  bounds: Box
  /** Where a tap leads: a screen name, or 'up'. */
  go?: string
  children?: Control[]
  /** Shown only from the n-th read of the screen on (1-based): a list that loads. */
  fromRead?: number
  /**
   * A scrollable view (roadmap M5d-2): `content` boxes are relative to the view's top-left at scroll offset 0; a swipe
   * that starts on the view moves its offset along `axis` by the finger's travel (exactly, no fling or touch slop),
   * kept between 0 and the content's end. Only the content inside the view is on screen, cut to the view's box.
   */
  scroll?: { axis: 'x' | 'y'; content: Control[] }
}

export interface ScreenSpec {
  controls: Control[]
  /** A top-level window of another package drawn over part of the screen (a prompt). */
  overlay?: { pkg: string; bounds: Box }
}

const field = (name: string, bounds: Box, hint: string): Control => ({ cls: 'android.widget.EditText', id: ID(name), desc: hint, bounds })
const button = (name: string, text: string, bounds: Box, go?: string, extra: Partial<Control> = {}): Control => ({ cls: 'android.widget.Button', id: ID(name), text, bounds, go, ...extra })

function app(): Record<string, ScreenSpec> {
  return {
    login: {
      controls: [
        field('email', [40, 300, 1040, 450], 'Email'),
        field('password', [40, 500, 1040, 650], 'Password'),
        button('sign_in', 'Sign in', [40, 700, 1040, 850], 'orders')
      ]
    },
    orders: {
      controls: [
        { id: ID('title'), text: 'Your orders', bounds: [40, 100, 1040, 250] },
        { cls: 'android.widget.ImageButton', id: ID('cart'), desc: 'Cart', bounds: [900, 100, 1060, 250], go: 'cart' },
        button('order_1', 'Order #1', [0, 300, 1080, 450], 'order', { fromRead: 3 }),
        button('order_2', 'Order #2', [0, 450, 1080, 600], 'order', { fromRead: 3 })
      ]
    },
    order: {
      controls: [
        { id: ID('status'), text: 'Shipped  to   Ana', bounds: [40, 100, 1040, 250] },
        button('track', 'Track', [40, 300, 1040, 450])
      ]
    },
    /** A long list and a banner pager, for scroll steps (M5d-2). */
    catalog: {
      controls: [
        { id: ID('title'), text: 'Catalog', bounds: [40, 100, 1040, 250] },
        {
          cls: 'androidx.recyclerview.widget.RecyclerView',
          id: ID('list'),
          bounds: [0, 300, 1080, 1800],
          scroll: { axis: 'y', content: Array.from({ length: 30 }, (_, i) => button(`item_${i + 1}`, `Item ${i + 1}`, [0, i * 150, 1080, i * 150 + 150], 'order')) }
        },
        {
          cls: 'androidx.viewpager.widget.ViewPager',
          id: ID('banner'),
          bounds: [0, 1850, 1080, 2150],
          scroll: { axis: 'x', content: [1, 2, 3].map((n) => ({ id: ID(`deal_${n}`), text: `Deal ${n}`, bounds: [(n - 1) * 1080, 0, n * 1080, 300] as Box })) }
        },
        field('search', [40, 2200, 1040, 2350], 'Search')
      ]
    },
    cart: { controls: [{ id: ID('empty'), text: 'Your cart is empty', bounds: [40, 100, 1040, 250] }] },
    /** What is on screen once the app died (crashOn): another package's home screen. */
    launcher: { controls: [{ id: 'com.android.launcher3:id/workspace', pkg: 'com.android.launcher3', text: 'Home', bounds: [0, 0, 1080, 2400] }] }
  }
}

const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const box = (b: Box): string => `[${b[0]},${b[1]}][${b[2]},${b[3]}]`

/** Where a scrollable view's offset is, by its resource id. */
type Offsets = Record<string, number>

/** The content of a scrollable view that is on screen at `offset`, moved into screen coordinates and cut to the view. */
function shownContent(c: Control, offset: number): Control[] {
  if (!c.scroll) return []
  const [l, t, r, b] = c.bounds
  const [ox, oy] = c.scroll.axis === 'x' ? [l - offset, t] : [l, t - offset]
  return c.scroll.content
    .map((k): Control => ({ ...k, bounds: [Math.max(l, k.bounds[0] + ox), Math.max(t, k.bounds[1] + oy), Math.min(r, k.bounds[2] + ox), Math.min(b, k.bounds[3] + oy)] }))
    .filter((k) => k.bounds[2] > k.bounds[0] && k.bounds[3] > k.bounds[1])
}

/** How far a scrollable view's content can move: its length past the view's own. */
function scrollEnd(c: Control): number {
  if (!c.scroll) return 0
  const along = c.scroll.axis === 'x' ? ([0, 2] as const) : ([1, 3] as const)
  const length = Math.max(...c.scroll.content.map((k) => k.bounds[along[1]]))
  return Math.max(0, length - (c.bounds[along[1]] - c.bounds[along[0]]))
}

function node(pkg: string, c: Control, text: string, inner = '', focusedId: string | null = null, offsets: Offsets = {}): string {
  const tappable = c.go !== undefined || /Button|EditText/.test(c.cls ?? '')
  const open =
    `<node index="0" text="${attr(text)}" resource-id="${c.id ?? ''}" class="${c.cls ?? 'android.widget.TextView'}" package="${c.pkg ?? pkg}" ` +
    `content-desc="${attr(c.desc ?? '')}" checkable="false" checked="false" clickable="${tappable}" enabled="${c.enabled ?? true}" ` +
    `focusable="${tappable}" focused="${c.id !== undefined && c.id === focusedId}" scrollable="${c.scroll !== undefined}" long-clickable="false" password="${c.id === ID('password')}" selected="false" ` +
    `bounds="${box(c.bounds)}"`
  const kids = inner + [...(c.children ?? []), ...shownContent(c, offsets[c.id ?? ''] ?? 0)].map((k) => node(pkg, k, k.text ?? '', '', focusedId)).join('')
  return kids ? `${open}>${kids}</node>` : `${open}/>`
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
/** How far the fake device's epoch clock is ahead of the test's fake host clock (which starts at 1_000_000). */
export const DEVICE_AHEAD_MS = 1_794_137_000_000

export interface DeviceOptions {
  /** Changes the app before a screen read (1-based count of reads so far). */
  onRead?: (reads: number, screens: Record<string, ScreenSpec>) => void
  /** The keyboard comes up when a text field is tapped. */
  keyboardOnFocus?: boolean
  /** What `am start -a VIEW` prints for a deep link. */
  deepLink?: (url: string) => { stdout: string; go?: string }
  /** `input text` fails in adb. */
  typeFails?: boolean
  /**
   * Answers the evidence commands (M5b-2): `date`, the package's uid, `logcat` (these lines, whatever the time asked),
   * and screenshots of the current screen: every view's box in its own colour (text fields red), the rest white.
   */
  evidence?: { logcat?: string; keyboardWindow?: string }
  /**
   * Roadmap M5d-1: a tap on the control with this resource id name crashes the app (the launcher's home screen comes
   * up; `hang` = an ANR: the screen stays). From `logAfterReads` more screen reads on (default 0), `logcat -b crash`
   * returns `log(deviceSec)` (the device time of the tap, in seconds, for timestamps); before that and before the tap
   * it returns `before` (another app's crash, say); `logAfterMs` also holds it back until that much fake time passed.
   */
  crashOn?: { control: string; hang?: boolean; logAfterReads?: number; logAfterMs?: number; log: (deviceSec: number) => string; before?: string }
}

export interface Device {
  host: AndroidReplayHost
  /** Every shell line, in order, minus the screen reads, keyboard checks, the clock, crash log reads and evidence commands. */
  lines: string[]
  /** The evidence commands (date, uid, logcat) and `screencap` calls, in order. */
  evidenceLines: string[]
  /** The crash log reads (`logcat -d -b crash ...`), in order. */
  crashReads: string[]
  /** Text typed into each field, by resource id name. */
  typed: Record<string, string>
  stack: string[]
  /** Scroll offset of each scrollable view that moved, by resource id (M5d-2). */
  offsets: Record<string, number>
}

export function device(start = 'login', over: DeviceOptions = {}): Device {
  const screens = app()
  const stack = [start]
  const lines: string[] = []
  const evidenceLines: string[] = []
  const crashReads: string[] = []
  /** Screen reads when the crashOn control was tapped; null before. */
  let crashedAtRead: number | null = null
  let crashedAtClock = 0
  const typed: Record<string, string> = {}
  const readsOf: Record<string, number> = {}
  const offsets: Offsets = {}
  let reads = 0
  let clock = 1_000_000
  let keyboard = false
  let focused: string | null = null
  const top = (): string => stack[stack.length - 1]
  const loaded = (name: string): Control[] => screens[name].controls.filter((c) => (c.fromRead ?? 0) <= (readsOf[name] ?? 0))
  /** What is on screen in drawing order: a scrollable view's shown content right after (over) the view. */
  const visible = (name: string): Control[] => loaded(name).flatMap((c) => [c, ...shownContent(c, offsets[c.id ?? ''] ?? 0)])
  const textOf = (c: Control): string => (c.id && c.cls === 'android.widget.EditText' ? (c.id === ID('password') ? '•'.repeat((typed[c.id] ?? '').length) : (typed[c.id] ?? '')) : (c.text ?? ''))
  const dump = (): string => {
    reads++
    over.onRead?.(reads, screens)
    readsOf[top()] = (readsOf[top()] ?? 0) + 1
    const spec = screens[top()]
    const inner = loaded(top()).map((c) => node(PKG, c, textOf(c), '', focused, offsets)).join('')
    // Once the app died, the window on screen is the launcher's.
    let windows = node(top() === 'launcher' ? 'com.android.launcher3' : PKG, { cls: 'android.widget.FrameLayout', bounds: [0, 0, 1080, 2400] }, '', inner)
    if (spec.overlay) windows += node(spec.overlay.pkg, { cls: 'android.widget.FrameLayout', bounds: spec.overlay.bounds }, '', node(spec.overlay.pkg, { cls: 'android.widget.Button', text: 'Allow', bounds: spec.overlay.bounds }, 'Allow'))
    return `UI hierchary dumped to: /data/local/tmp/x.xml\n<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${windows}</hierarchy>`
  }
  const host: AndroidReplayHost = {
    exec: async (_file, args) => {
      const line = args[3] ?? ''
      if (line.startsWith('uiautomator dump')) return ok(dump())
      // Like a real device, the fake always has a clock and a crash log (empty unless crashOn says otherwise).
      if (line.startsWith('logcat -d -b crash ')) {
        crashReads.push(line)
        const c = over.crashOn
        if (c === undefined) return ok('')
        const logged = crashedAtRead !== null && reads - crashedAtRead >= (c.logAfterReads ?? 0) && clock - crashedAtClock >= (c.logAfterMs ?? 0)
        return ok(`${c.before ?? ''}${logged ? c.log(Math.floor((crashedAtClock + DEVICE_AHEAD_MS) / 1000)) : ''}`)
      }
      if (!over.evidence && line.startsWith('date ')) return ok(`${clock + DEVICE_AHEAD_MS}\n`)
      if (line.startsWith('dumpsys input_method')) return ok(`    mInputShown=${keyboard}\n`)
      if (over.evidence && line === 'dumpsys window InputMethod') return ok(over.evidence.keyboardWindow ?? '    touchable region=SkRegion((0,1517,1080,2400))\n')
      if (over.evidence && /^(date |cmd package list packages|logcat )/.test(line)) {
        evidenceLines.push(line)
        if (line.startsWith('date ')) return ok(`${clock + DEVICE_AHEAD_MS}\n`)
        if (line.startsWith('cmd package')) return ok(`package:${PKG} uid:10234\npackage:${PKG}.debug uid:10235\n`)
        return ok(over.evidence.logcat ?? '')
      }
      lines.push(line)
      if (line === 'input keyevent KEYCODE_BACK') {
        if (keyboard) keyboard = false
        else stack.pop()
        return ok()
      }
      if (line.startsWith('input keyevent')) {
        if (focused && line.includes('KEYCODE_DEL')) typed[focused] = ''
        return ok()
      }
      const text = /^input text '(.*)'$/s.exec(line)
      if (text) {
        if (over.typeFails) return { code: 1, stdout: '', stderr: `Error typing ${text[1]}`, error: 'failed' }
        if (focused) typed[focused] = (typed[focused] ?? '') + text[1].replace(/'\\''/g, "'")
        return ok()
      }
      const am = /^am start -W -a android\.intent\.action\.VIEW -d '(.*)' 'dev\.nawi\.shop'$/.exec(line)
      if (am) {
        const answer = over.deepLink?.(am[1]) ?? { stdout: 'Starting: Intent { act=android.intent.action.VIEW }\nStatus: ok\nTotalTime: 120\n' }
        if (answer.go) stack.push(answer.go)
        return ok(answer.stdout)
      }
      const swipe = /^input swipe (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\d+)$/.exec(line)
      if (swipe) {
        const [x1, y1, x2, y2, ms] = swipe.slice(1, 6).map(Number)
        // `input swipe` returns once the finger lifted.
        clock += ms
        const on = loaded(top())
          .filter((c) => c.scroll && x1 >= c.bounds[0] && x1 < c.bounds[2] && y1 >= c.bounds[1] && y1 < c.bounds[3])
          .pop()
        if (on?.id) offsets[on.id] = Math.min(scrollEnd(on), Math.max(0, (offsets[on.id] ?? 0) + (on.scroll!.axis === 'x' ? x1 - x2 : y1 - y2)))
        return ok()
      }
      const tap = /^input tap (\d+) (\d+)$/.exec(line)
      if (!tap) return { code: 1, stdout: '', stderr: `unexpected ${line}`, error: 'failed' }
      const [x, y] = [Number(tap[1]), Number(tap[2])]
      const hit = visible(top())
        .filter((c) => c.enabled !== false && x >= c.bounds[0] && x < c.bounds[2] && y >= c.bounds[1] && y < c.bounds[3])
        .pop()
      if (over.crashOn && hit?.id === ID(over.crashOn.control) && crashedAtRead === null) {
        crashedAtRead = reads
        crashedAtClock = clock
        if (!over.crashOn.hang) stack.splice(0, stack.length, 'launcher')
        return ok()
      }
      focused = hit?.cls === 'android.widget.EditText' ? (hit.id ?? null) : null
      if (focused && over.keyboardOnFocus) keyboard = true
      if (hit?.go === 'up') stack.pop()
      else if (hit?.go) stack.push(hit.go)
      return ok()
    },
    delay: async (ms) => {
      clock += ms
    },
    now: () => clock
  }
  if (over.evidence) {
    host.execBinary = async (_file, args) => {
      evidenceLines.push(args.slice(2).join(' '))
      const [w, h] = [1080, 2400]
      const rgb = new Uint8Array(w * h * 3).fill(255)
      for (const c of visible(top())) {
        const colour = c.cls === 'android.widget.EditText' ? [255, 0, 0] : [0, 0, 255]
        for (let y = c.bounds[1]; y < c.bounds[3]; y++) for (let x = c.bounds[0]; x < c.bounds[2]; x++) rgb.set(colour, (y * w + x) * 3)
      }
      return { code: 0, stdout: encodePng({ width: w, height: h, rgb }), stderr: '' }
    }
  }
  return { host, lines, evidenceLines, crashReads, typed, stack, offsets }
}
