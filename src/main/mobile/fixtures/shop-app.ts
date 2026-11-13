import type { PermissionAnswer } from '../../../shared/flow/schema'
import type { ExecResult } from '../doctor'
import type { AndroidReplayHost } from '../flow-replay'
import { encodePng } from '../png'
import { DISPLAY_ROTATION_LINE } from '../rotation'

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
  /** Where a long press leads (roadmap M5d-3): a screen name; the view is long-clickable. */
  hold?: string
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
        button('order_1', 'Order #1', [0, 300, 1080, 450], 'order', { fromRead: 3, hold: 'order_menu' }),
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
    /** What a long press on an order opens (M5d-3). */
    order_menu: { controls: [button('cancel_order', 'Cancel order', [40, 300, 1040, 450], 'up'), button('share_order', 'Share', [40, 450, 1040, 600], 'up')] },
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
    `focusable="${tappable}" focused="${c.id !== undefined && c.id === focusedId}" scrollable="${c.scroll !== undefined}" long-clickable="${c.hold !== undefined}" password="${c.id === ID('password')}" selected="false" ` +
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
  /**
   * What `settings get secure long_press_timeout` prints (default `null`: never changed, so 400 ms like Android 12+).
   * A finger resting on one point (`input swipe x y x y ms`) for at least that long is a long press, else a tap.
   */
  longPressTimeout?: string
  /** `settings get secure long_press_timeout` fails (adb error). */
  longPressTimeoutFails?: boolean
  /**
   * Roadmap M5d-4, turning the screen: what `wm size` prints (default a 1080x2400 phone), the rotation settings'
   * starting values as `settings get system` prints them (default auto-rotate on, no locked rotation: `1` / `null`),
   * an app that `fixed` its own rotation (the screen stays there whatever the settings), how many screen reads a new
   * rotation takes to show (`lagReads`, default 0), an adb failure reading one setting, and failing writes: the
   * `nth` (1-based) put or delete of a setting fails, so a test names exactly which change or restore breaks.
   */
  rotation?: {
    wmSize?: string
    auto?: string
    user?: string
    fixed?: number
    lagReads?: number
    getFails?: 'accelerometer_rotation' | 'user_rotation'
    writeFails?: Array<{ name: 'accelerometer_rotation' | 'user_rotation'; nth: number }>
  }
  /**
   * Roadmap M5d-5, the app in the background. Home shows the launcher with the app's screens kept (and hides the
   * keyboard); the restore `am start` (the launcher intent) brings them back as they were. `pinned`: Home leaves the
   * app on screen (screen pinning). `launcher`: what `cmd package resolve-activity` answers (default this app's
   * `.MainActivity`). `restore`: what the restore `am start` prints (default `Status: ok`), `killed` = Android ended
   * the app while it was away, so it starts again on its first screen, `stays` = it does not come back, `fails` = adb
   * fails. `returnReads`: screen reads the app takes to show after the restore. `emptyReads`: screen reads right after
   * Home that come back empty (between two windows).
   */
  background?: {
    pinned?: boolean
    emptyReads?: number
    launcher?: ExecResult
    restore?: { stdout?: string; killed?: boolean; stays?: boolean; fails?: boolean }
    returnReads?: number
  }
  /**
   * Roadmap M5d-6, Android's permission prompt: a tap on the control with resource id name `on` makes the app ask, one
   * prompt after another (`asks`: what each prompt says, the answers it offers in that order, and `accuracy` = the
   * location prompt's Precise/Approximate choice above them). As on a real device, a screen read while one shows has
   * only the prompt's window (package PROMPT_PKG, view ids under `com.android.permissioncontroller:id/`), never the
   * app's. A tap on an answer button closes it (the next one shows) and is kept in `answered`; `stays` = it stays up
   * whatever is tapped; `disabled` = its answer buttons are disabled; `showAfterReads` = screen reads after the tap
   * before the first prompt shows (default 0).
   */
  permission?: { on: string; asks: PromptAsk[]; stays?: boolean; disabled?: boolean; showAfterReads?: number }
}

export interface PromptAsk {
  message: string
  answers: PermissionAnswer[]
  accuracy?: boolean
}

/** The package that draws the fake device's permission prompt (a Google build's, like the loop emulator's). */
export const PROMPT_PKG = 'com.google.android.permissioncontroller'
const PROMPT_ID = (name: string): string => `com.android.permissioncontroller:id/${name}`
/** The fake prompt's answer buttons: view id name and label, as API 36 shows them. */
export const PROMPT_BUTTONS: Readonly<Record<PermissionAnswer, { id: string; text: string }>> = {
  allow: { id: 'permission_allow_button', text: 'Allow' },
  while_using: { id: 'permission_allow_foreground_only_button', text: 'While using the app' },
  once: { id: 'permission_allow_one_time_button', text: 'Only this time' },
  deny: { id: 'permission_deny_button', text: 'Don’t allow' }
}
/** Where the fake prompt draws its n-th answer button (0-based), and its Precise choice. */
export const promptButtonBox = (n: number): Box => [133, 1398 + n * 157, 947, 1545 + n * 157]
export const PRECISE_BOX: Box = [157, 917, 498, 1330]

/** The prompt's controls for one ask, as the dump shows them. */
function promptControls(ask: PromptAsk, disabled: boolean): Control[] {
  return [
    { id: PROMPT_ID('permission_message'), pkg: PROMPT_PKG, text: ask.message, bounds: [133, 721, 947, 854] },
    ...(ask.accuracy ? [{ cls: 'android.widget.RadioButton', id: PROMPT_ID('permission_location_accuracy_radio_fine'), pkg: PROMPT_PKG, text: 'Precise', bounds: PRECISE_BOX }] : []),
    ...ask.answers.map((a, n): Control => ({ cls: 'android.widget.Button', id: PROMPT_ID(PROMPT_BUTTONS[a].id), pkg: PROMPT_PKG, text: PROMPT_BUTTONS[a].text, bounds: promptButtonBox(n), enabled: !disabled }))
  ]
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
  /** The rotation settings now, as `settings get system` would print them (M5d-4). */
  settings: Record<'accelerometer_rotation' | 'user_rotation', string>
  /** The rotation the screen shows now (the dump's `rotation`). */
  rotation(): number
  /** Whether the app is in the background now (M5d-5): the launcher is on screen, its screens kept. */
  away(): boolean
  /** The answers given to the permission prompt, in order (M5d-6). */
  answered: PermissionAnswer[]
  /** Whether a permission prompt is on screen now. */
  prompting(): boolean
}

/** The launcher component the fake device names for the shop app (M5d-5). */
export const SHOP_LAUNCHER = `${PKG}/.MainActivity`

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
  const rot = over.rotation ?? {}
  const settings: Device['settings'] = { accelerometer_rotation: rot.auto ?? '1', user_rotation: rot.user ?? 'null' }
  /** What the settings ask for: the locked rotation with auto-rotate off, else the sensor's (the phone held upright). */
  const asked = (): number => (settings.accelerometer_rotation === '0' && /^[0-3]$/.test(settings.user_rotation) ? Number(settings.user_rotation) : 0)
  let shown = rot.fixed ?? asked()
  /** Puts and deletes of each setting so far (writeFails counts them). */
  const writes = { accelerometer_rotation: 0, user_rotation: 0 }
  /** Screen reads left before a change of rotation shows (lagReads). */
  let lag = 0
  const rotationNow = (): number => {
    const want = rot.fixed ?? asked()
    if (want !== shown) {
      if (lag > 0) lag--
      else shown = want
    }
    return shown
  }
  let clock = 1_000_000
  /** In the background (M5d-5); `returning` = screen reads left before it shows again after the restore. */
  let away = false
  let returning = 0
  /** Empty screen reads left after Home (emptyReads): the dump between two windows. */
  let empty = 0
  let keyboard = false
  let focused: string | null = null
  /** The prompts still to answer (M5d-6), the first on screen once `promptIn` reads have passed. */
  const prompts: PromptAsk[] = []
  let promptIn = 0
  const answered: PermissionAnswer[] = []
  const promptUp = (): boolean => prompts.length > 0 && promptIn === 0
  const top = (): string => stack[stack.length - 1]
  const loaded = (name: string): Control[] => screens[name].controls.filter((c) => (c.fromRead ?? 0) <= (readsOf[name] ?? 0))
  /** What is on screen in drawing order: a scrollable view's shown content right after (over) the view. */
  const visible = (name: string): Control[] => loaded(name).flatMap((c) => [c, ...shownContent(c, offsets[c.id ?? ''] ?? 0)])
  const textOf = (c: Control): string => (c.id && c.cls === 'android.widget.EditText' ? (c.id === ID('password') ? '•'.repeat((typed[c.id] ?? '').length) : (typed[c.id] ?? '')) : (c.text ?? ''))
  const dump = (): string => {
    reads++
    over.onRead?.(reads, screens)
    if (returning > 0) returning--
    if (prompts.length > 0 && promptIn > 0) promptIn--
    if (promptUp()) {
      // Only the prompt's window, as a real dump shows it: the app's views are not in it.
      const inner = promptControls(prompts[0], over.permission?.disabled === true).map((c) => node(PROMPT_PKG, c, c.text ?? '')).join('')
      return `UI hierchary dumped to: /data/local/tmp/x.xml\n<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="${rotationNow()}">${node(PROMPT_PKG, { cls: 'android.widget.FrameLayout', bounds: [28, 500, 1052, 1964] }, '', inner)}</hierarchy>`
    }
    if (empty > 0) {
      empty--
      return 'UI hierchary dumped to: /data/local/tmp/x.xml\n<?xml version=\'1.0\' encoding=\'UTF-8\' standalone=\'yes\' ?><hierarchy rotation="0"></hierarchy>'
    }
    // Away (or still coming back): the launcher is on screen; the app's screens wait under it as they were.
    const name = away || returning > 0 ? 'launcher' : top()
    readsOf[name] = (readsOf[name] ?? 0) + 1
    const spec = screens[name]
    const inner = loaded(name).map((c) => node(PKG, c, textOf(c), '', focused, offsets)).join('')
    // Once the app died, the window on screen is the launcher's.
    let windows = node(name === 'launcher' ? 'com.android.launcher3' : PKG, { cls: 'android.widget.FrameLayout', bounds: [0, 0, 1080, 2400] }, '', inner)
    if (spec.overlay) windows += node(spec.overlay.pkg, { cls: 'android.widget.FrameLayout', bounds: spec.overlay.bounds }, '', node(spec.overlay.pkg, { cls: 'android.widget.Button', text: 'Allow', bounds: spec.overlay.bounds }, 'Allow'))
    return `UI hierchary dumped to: /data/local/tmp/x.xml\n<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="${rotationNow()}">${windows}</hierarchy>`
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
      if (line === 'input keyevent KEYCODE_HOME') {
        empty = over.background?.emptyReads ?? 0
        if (!over.background?.pinned) {
          away = true
          keyboard = false
        }
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
        // A deep link brings the app to the front, from the background too.
        away = false
        if (answer.go) stack.push(answer.go)
        return ok(answer.stdout)
      }
      if (line === `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER '${PKG}'`) {
        return over.background?.launcher ?? ok(`priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n${SHOP_LAUNCHER}\n`)
      }
      if (line === `am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000 -n '${SHOP_LAUNCHER}'`) {
        const r = over.background?.restore ?? {}
        if (r.fails) return { code: 1, stdout: r.stdout ?? '', stderr: r.stdout ? '' : 'adb: device offline', error: 'failed' }
        if (!r.stays) {
          away = false
          returning = over.background?.returnReads ?? 0
          if (r.killed) {
            stack.splice(0, stack.length, start)
            focused = null
            for (const k of Object.keys(typed)) delete typed[k]
          }
        }
        return ok(r.stdout ?? `Starting: Intent { act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] flg=0x10200000 cmp=${SHOP_LAUNCHER} }\nStatus: ok\nLaunchState: UNKNOWN (0)\nActivity: ${SHOP_LAUNCHER}\nWaitTime: 80\nComplete\n`)
      }
      if (line === 'wm size') return ok(rot.wmSize ?? 'Physical size: 1080x2400\n')
      // The recorder's quick look (M5d-4): the rotation the screen shows now, not one still waiting for lagReads.
      if (line === DISPLAY_ROTATION_LINE) return ok(`mDisplayRotation=ROTATION_${(lag > 0 ? shown : (rot.fixed ?? asked())) * 90}\n`)
      const setting = /^settings (get|put|delete) system (accelerometer_rotation|user_rotation)(?: (\d+))?$/.exec(line)
      if (setting) {
        const [, verb, name, value] = setting as unknown as [string, string, 'accelerometer_rotation' | 'user_rotation', string | undefined]
        const fail: ExecResult = { code: 1, stdout: '', stderr: 'cmd: Failure calling service settings', error: 'failed' }
        if (verb === 'get') return rot.getFails === name ? fail : ok(`${settings[name]}\n`)
        writes[name]++
        if (rot.writeFails?.some((w) => w.name === name && w.nth === writes[name])) return fail
        const before = asked()
        settings[name] = verb === 'delete' ? 'null' : value!
        if (asked() !== before) lag = rot.lagReads ?? 0
        return ok()
      }
      if (line === 'settings get secure long_press_timeout') {
        return over.longPressTimeoutFails ? { code: 1, stdout: '', stderr: 'cmd: Failure calling service settings', error: 'failed' } : ok(`${over.longPressTimeout ?? 'null'}\n`)
      }
      const swipe = /^input swipe (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\d+)$/.exec(line)
      if (swipe) {
        const [x1, y1, x2, y2, ms] = swipe.slice(1, 6).map(Number)
        // `input swipe` returns once the finger lifted.
        clock += ms
        if (x1 === x2 && y1 === y2) {
          const timeout = /^\d+$/.test(over.longPressTimeout ?? '') ? Number(over.longPressTimeout) : 400
          if (ms < timeout) return tapAt(x1, y1)
          // A long press: the view's long-press action; a view without one clicks when the finger lifts, as on Android.
          const hit = hitAt(x1, y1)
          if (!hit?.hold) return tapAt(x1, y1)
          stack.push(hit.hold)
          return ok()
        }
        const on = loaded(top())
          .filter((c) => c.scroll && x1 >= c.bounds[0] && x1 < c.bounds[2] && y1 >= c.bounds[1] && y1 < c.bounds[3])
          .pop()
        if (on?.id) offsets[on.id] = Math.min(scrollEnd(on), Math.max(0, (offsets[on.id] ?? 0) + (on.scroll!.axis === 'x' ? x1 - x2 : y1 - y2)))
        return ok()
      }
      const tap = /^input tap (\d+) (\d+)$/.exec(line)
      if (!tap) return { code: 1, stdout: '', stderr: `unexpected ${line}`, error: 'failed' }
      return tapAt(Number(tap[1]), Number(tap[2]))
    },
    delay: async (ms) => {
      clock += ms
    },
    now: () => clock
  }
  function hitAt(x: number, y: number): Control | undefined {
    return visible(away || returning > 0 ? 'launcher' : top())
      .filter((c) => c.enabled !== false && x >= c.bounds[0] && x < c.bounds[2] && y >= c.bounds[1] && y < c.bounds[3])
      .pop()
  }
  function tapAt(x: number, y: number): ExecResult {
    if (promptUp()) {
      // The prompt is in front of the app: a tap lands on it or nowhere.
      const ask = prompts[0]
      const n = ask.answers.findIndex((_a, i) => {
        const b = promptButtonBox(i)
        return x >= b[0] && x < b[2] && y >= b[1] && y < b[3]
      })
      if (n >= 0 && !over.permission?.disabled) {
        answered.push(ask.answers[n])
        if (!over.permission?.stays) prompts.shift()
      }
      return ok()
    }
    const hit = hitAt(x, y)
    if (over.permission && hit?.id === ID(over.permission.on)) {
      prompts.splice(0, prompts.length, ...over.permission.asks)
      promptIn = over.permission.showAfterReads ?? 0
    }
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
  return { host, lines, evidenceLines, crashReads, typed, stack, offsets, settings, rotation: () => shown, away: () => away, answered, prompting: promptUp }
}
