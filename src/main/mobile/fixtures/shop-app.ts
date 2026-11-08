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
    cart: { controls: [{ id: ID('empty'), text: 'Your cart is empty', bounds: [40, 100, 1040, 250] }] }
  }
}

const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const box = (b: Box): string => `[${b[0]},${b[1]}][${b[2]},${b[3]}]`

function node(pkg: string, c: Control, text: string, inner = '', focusedId: string | null = null): string {
  const tappable = c.go !== undefined || /Button|EditText/.test(c.cls ?? '')
  const open =
    `<node index="0" text="${attr(text)}" resource-id="${c.id ?? ''}" class="${c.cls ?? 'android.widget.TextView'}" package="${c.pkg ?? pkg}" ` +
    `content-desc="${attr(c.desc ?? '')}" checkable="false" checked="false" clickable="${tappable}" enabled="${c.enabled ?? true}" ` +
    `focusable="${tappable}" focused="${c.id !== undefined && c.id === focusedId}" scrollable="false" long-clickable="false" password="${c.id === ID('password')}" selected="false" ` +
    `bounds="${box(c.bounds)}"`
  const kids = inner + (c.children ?? []).map((k) => node(pkg, k, k.text ?? '', '', focusedId)).join('')
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
}

export interface Device {
  host: AndroidReplayHost
  /** Every shell line, in order, minus the screen reads, keyboard checks and evidence commands. */
  lines: string[]
  /** The evidence commands (date, uid, logcat) and `screencap` calls, in order. */
  evidenceLines: string[]
  /** Text typed into each field, by resource id name. */
  typed: Record<string, string>
  stack: string[]
}

export function device(start = 'login', over: DeviceOptions = {}): Device {
  const screens = app()
  const stack = [start]
  const lines: string[] = []
  const evidenceLines: string[] = []
  const typed: Record<string, string> = {}
  const readsOf: Record<string, number> = {}
  let reads = 0
  let clock = 1_000_000
  let keyboard = false
  let focused: string | null = null
  const top = (): string => stack[stack.length - 1]
  const visible = (name: string): Control[] => screens[name].controls.filter((c) => (c.fromRead ?? 0) <= (readsOf[name] ?? 0))
  const textOf = (c: Control): string => (c.id && c.cls === 'android.widget.EditText' ? (c.id === ID('password') ? '•'.repeat((typed[c.id] ?? '').length) : (typed[c.id] ?? '')) : (c.text ?? ''))
  const dump = (): string => {
    reads++
    over.onRead?.(reads, screens)
    readsOf[top()] = (readsOf[top()] ?? 0) + 1
    const spec = screens[top()]
    const inner = visible(top()).map((c) => node(PKG, c, textOf(c), '', focused)).join('')
    let windows = node(PKG, { cls: 'android.widget.FrameLayout', bounds: [0, 0, 1080, 2400] }, '', inner)
    if (spec.overlay) windows += node(spec.overlay.pkg, { cls: 'android.widget.FrameLayout', bounds: spec.overlay.bounds }, '', node(spec.overlay.pkg, { cls: 'android.widget.Button', text: 'Allow', bounds: spec.overlay.bounds }, 'Allow'))
    return `UI hierchary dumped to: /data/local/tmp/x.xml\n<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${windows}</hierarchy>`
  }
  const host: AndroidReplayHost = {
    exec: async (_file, args) => {
      const line = args[3] ?? ''
      if (line.startsWith('uiautomator dump')) return ok(dump())
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
      const tap = /^input tap (\d+) (\d+)$/.exec(line)
      if (!tap) return { code: 1, stdout: '', stderr: `unexpected ${line}`, error: 'failed' }
      const [x, y] = [Number(tap[1]), Number(tap[2])]
      const hit = visible(top())
        .filter((c) => c.enabled !== false && x >= c.bounds[0] && x < c.bounds[2] && y >= c.bounds[1] && y < c.bounds[3])
        .pop()
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
  return { host, lines, evidenceLines, typed, stack }
}
