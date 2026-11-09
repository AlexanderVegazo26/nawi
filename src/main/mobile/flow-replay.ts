import { createInterpolator, MissingFlowInputsError, type FlowInputs, type FlowInterpolator } from '../../shared/flow/interpolate'
import { ANDROID_KEYS, ANDROID_MIN_SWIPE_PX, locatorLayer, type Flow, type FlowStep, type Selector } from '../../shared/flow/schema'
import type { DeviceLogLine } from '../replay/evidence'
import type { FlowRun, LocatorMiss, StepProgress, StepRun, StepScreenshots } from '../replay/replay'
import { findAll } from './blockers'
import { ANR_POLL_MS, CRASH_POLL_MS, crashMessage, logLineKey, startCrashWatch, type CrashFound } from './crash'
import type { Exec, ExecResult } from './doctor'
import { MAX_LOGCAT_LINES, readDeviceClockOffset, startAndroidEvidence, toUiLocator, type AndroidEvidence } from './flow-evidence'
import { center, isTextField, type UiBounds, type UiNode, type UiScreen } from './hierarchy'
import { KEYBOARD_SHOWN_LINE, parseAmStart, readScreen } from './open'
import type { BinaryExec } from './screen'
import { shQuote } from './shell'
import { coveredBy, typeLines, TYPABLE_RE } from './sign-in'

/**
 * Roadmap M5, first slice (M5a): replay an android flow (`target.kind: android`) on a device or emulator over adb.
 *
 * Same step format and run shape as the browser replayer (`FlowRun` / `StepRun`), so run records, reports and heal
 * proposals read both. Each step reads the screen (`uiautomator dump`) and tries the step's locators in order on the
 * app's own windows: `id` = resource id, `desc` = content description, `text` = text, each exact. The first locator
 * that finds exactly one view wins; the step auto-waits (re-reading the screen) until one does and the view can take
 * the action (enabled, with a size, not under another app's window), or until its timeout. An earlier locator that
 * found nothing makes the match a `fallback`, like on the web.
 *
 * What reaches the device's shell: tap coordinates parsed from the dump as integers, key event names from
 * ANDROID_KEYS, and typed values / deep links quoted by shQuote. Secret values never appear in what is reported
 * (`redact`), and a failed `input text` is reported without the device's own words (they could echo the value).
 *
 * Electron-free: adb, the clock and the delays are injectable, so tests drive a simulated app behind a fake adb.
 * Launching the app and choosing the device are the caller's (mobile_open does both).
 */

export interface AndroidReplayHost {
  exec: Exec
  /** Takes the step screenshots (`screencap`); without it a run has none. */
  execBinary?: BinaryExec
  delay(ms: number, signal?: AbortSignal): Promise<void>
  /** Epoch milliseconds (step timestamps and timeouts). */
  now(): number
}

export interface AndroidReplayRequest extends FlowInputs {
  adb: string
  serial: string
  flow: Flow
  /** Fallback when a step has no `timeout_ms`. */
  defaultTimeoutMs?: number
  /** Stops the run between steps: the step in progress finishes, the rest are `not_run`. */
  signal?: AbortSignal
  /** Told about every step in order as it settles (no values, errors or screen text). */
  onStep?: (event: StepProgress) => void
  /**
   * Device screenshots around each step (roadmap M5b-2), like a browser run's: `all` = the screen before the first
   * step and after every step, `failed` = after the failing step only; default `off`. Secret fields are masked.
   */
  stepScreenshots?: StepScreenshots
  /** Keep each step's device log (the app's warnings and errors, `logcat`) in its record; default off. */
  logcat?: boolean
  /**
   * Epoch ms (host clock) from which a crash or ANR of the app counts against the run (M5d-1): when the caller
   * launched the app for it, so a crash right after the launch fails the first step. Default: the run's start.
   */
  crashesSince?: number
}

export const DEFAULT_ANDROID_STEP_TIMEOUT_MS = 10_000
/** How long to wait between screen reads while a step waits for its view. */
export const ANDROID_POLL_MS = 250
/** After Back hides the on-screen keyboard, how long the app takes to lay itself out again. */
export const KEYBOARD_SETTLE_MS = 500
const SHELL_TIMEOUT_MS = 30_000
const DEEP_LINK_TIMEOUT_MS = 60_000
/** How long the app gets after the last step's action before the run looks for a crash one last time. */
export const LAST_STEP_CRASH_SETTLE_MS = 1_000
/** A deep link is a URI with a scheme, on one line. */
const DEEP_LINK_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\x00-\x1f\x7f]+$/

export const failed = (r: ExecResult): boolean => r.code !== 0 || !!r.error
/** Why adb failed, in Nawi's words: the device's own output could echo a typed value. */
export const why = (r: ExecResult): string =>
  r.error === 'timeout' ? 'the device did not answer' : r.error === 'not_found' ? 'adb could not be started' : `adb exited with code ${r.code ?? 'unknown'}`

const describeLocator = (s: Selector): string =>
  'id' in s ? `id=${s.id}` : 'desc' in s ? `desc=${JSON.stringify(s.desc)}` : 'text' in s ? `text=${JSON.stringify(s.text)}` : JSON.stringify(s)

const fold = (s: string): string => s.replace(/\s+/g, ' ').trim()

interface Located {
  node: UiNode
  index: number
  misses: LocatorMiss[]
}

/** The first of `selectors` that finds exactly one view of `pkg` on `screen`, plus the ones tried before it. */
export function locateView(screen: UiScreen, pkg: string, selectors: readonly Selector[]): Located | { misses: LocatorMiss[] } {
  const misses: LocatorMiss[] = []
  for (const [index, selector] of selectors.entries()) {
    const loc = toUiLocator(selector)
    if (loc === null) {
      misses.push({ index, selector, found: 0, invalid: `${locatorLayer(selector)} locators do not apply to Android views` })
      continue
    }
    const found = findAll(screen.nodes, loc).filter((n) => n.package === pkg)
    if (found.length === 1) return { node: found[0], index, misses }
    misses.push({ index, selector, found: found.length })
  }
  return { misses }
}

const missText = (misses: readonly LocatorMiss[]): string =>
  misses.map((m) => `${describeLocator(m.selector as Selector)} ${m.invalid ? `is invalid (${m.invalid})` : m.found === 0 ? 'found nothing' : `found ${m.found} views`}`).join('; ')

class StepFailure extends Error {
  constructor(
    message: string,
    readonly misses?: LocatorMiss[]
  ) {
    super(message)
  }
}

/** The run was cancelled while a step waited: the step did not fail, it was stopped. */
class Stopped extends Error {}

/** The app crashed or stopped responding while the step waited for it (M5d-1). */
class AppCrashed extends StepFailure {
  constructor(readonly found: CrashFound) {
    super(crashMessage(found.crash))
  }
}


/** Longest field content a fill empties (the dump caps a screen at 1 MB; a field holding more is not a form field). */
export const MAX_CLEAR_CHARS = 4096
const KEYS_PER_LINE = 256

/**
 * The key presses that empty a field holding `length` characters wherever the tap left the caret (a multi-line
 * field, a caret mid-text): to the end of its line, then `length` deletes backwards and `length` forwards.
 */
export function clearLines(length: number): string[] {
  const lines: string[] = []
  for (const key of ['KEYCODE_DEL', 'KEYCODE_FORWARD_DEL']) {
    for (let left = length; left > 0; left -= KEYS_PER_LINE) lines.push(`input keyevent ${` ${key}`.repeat(Math.min(left, KEYS_PER_LINE)).trim()}`)
  }
  return lines.length === 0 ? [] : ['input keyevent KEYCODE_MOVE_END', ...lines]
}

/**
 * How fast a scroll swipe moves the finger. `input swipe` moves it in a straight line at one speed and a list keeps
 * that speed as a fling when the finger lifts, so a fast swipe overshoots; at ~0.6 px/ms the list stops about where
 * the finger did (loop emulator, Settings: 900 px in 1.5 s moved the list 909 px, in 0.6 s 1043 px; 100 px in 150 ms
 * moved it 113 px, the same 100 px in 400 ms only 84, the touch slop eating more of a slow short swipe).
 */
export const SWIPE_PX_PER_MS = 0.6
/** The shortest swipe duration: shorter, the device sees few moves between the finger's down and up. */
export const MIN_SWIPE_MS = 150
/** After a swipe, how long the list gets to come to rest before the screen is read again. */
export const SCROLL_SETTLE_MS = 300
/**
 * The longest share of an area's height (or width) one swipe covers; a longer scroll takes several swipes. Each swipe
 * is centred on the area, so it starts and ends at least 10% inside it: on the list, not on the views around it or
 * the screen edge (where the system's own gestures start).
 */
export const SWIPE_SPAN = 0.8
/** Most swipes one scroll step makes: past it a `delta` is too long for the area, or the list never ends. */
export const MAX_SWIPES = 30
/**
 * Default time a scroll to a view gets (when the step has no `timeout_ms`): each swipe is a screen read (~2 s on an
 * emulator), a swipe and a settle, so the general step default would end a search after three or four swipes.
 */
export const SCROLL_TO_VIEW_TIMEOUT_MS = 60_000

export interface Swipe {
  from: { x: number; y: number }
  to: { x: number; y: number }
  ms: number
}

/** The shell line for one swipe: integers only, computed from the dump's bounds and the flow's whole-px delta. */
export const swipeLine = (w: Swipe): string => `input swipe ${w.from.x} ${w.from.y} ${w.to.x} ${w.to.y} ${w.ms}`

/**
 * The swipes that move the content of `area` by `dx`, `dy` px (positive dy = toward the end of a list, like a mouse
 * wheel: the finger moves the other way), or why that can't be done. Each swipe is centred in the area and spans at
 * most SWIPE_SPAN of it; a longer delta is split into equal whole-px pieces that add up to it exactly. A piece shorter
 * than ANDROID_MIN_SWIPE_PX would be a tap or a long press to Android, so it is refused rather than sent.
 */
export function planSwipes(area: UiBounds, dx: number, dy: number): Swipe[] | string {
  if (dx === 0 && dy === 0) return 'has nothing to scroll by ([0, 0])'
  const reach = (size: number): number => Math.floor(size * SWIPE_SPAN)
  const [w, h] = [area.right - area.left, area.bottom - area.top]
  if ((dx !== 0 && reach(w) < ANDROID_MIN_SWIPE_PX) || (dy !== 0 && reach(h) < ANDROID_MIN_SWIPE_PX)) return `is too small to swipe in (${w}x${h} px)`
  const count = Math.max(dx === 0 ? 0 : Math.ceil(Math.abs(dx) / reach(w)), dy === 0 ? 0 : Math.ceil(Math.abs(dy) / reach(h)))
  if (count > MAX_SWIPES) return `is too small to scroll [${dx}, ${dy}] in at most ${MAX_SWIPES} swipes`
  const c = center(area)
  const swipes: Swipe[] = []
  for (let k = 0; k < count; k++) {
    const px = Math.round((dx * (k + 1)) / count) - Math.round((dx * k) / count)
    const py = Math.round((dy * (k + 1)) / count) - Math.round((dy * k) / count)
    const length = Math.hypot(px, py)
    if (length < ANDROID_MIN_SWIPE_PX) return `can't be scrolled by [${dx}, ${dy}]: each swipe would move under ${ANDROID_MIN_SWIPE_PX} px, which Android takes for a tap`
    const from = { x: c.x + Math.trunc(px / 2), y: c.y + Math.trunc(py / 2) }
    swipes.push({ from, to: { x: from.x - px, y: from.y - py }, ms: Math.max(MIN_SWIPE_MS, Math.round(length / SWIPE_PX_PER_MS)) })
  }
  return swipes
}

const hasSize = (b: UiBounds | null): b is UiBounds => b !== null && b.right > b.left && b.bottom > b.top
const areaOf = (b: UiBounds): number => (b.right - b.left) * (b.bottom - b.top)
const inside = (nodes: readonly UiNode[], n: UiNode, ancestor: number): boolean => {
  for (let p = n.parent; p !== null; p = nodes[p].parent) if (p === ancestor) return true
  return false
}

/** The app's largest scrollable view on screen (a list, a scroll view, a pager), or null when it shows none. */
export function scrollArea(screen: UiScreen, pkg: string): UiNode | null {
  let best: UiNode | null = null
  for (const n of screen.nodes) {
    if (n.package !== pkg || !n.scrollable || !hasSize(n.bounds)) continue
    if (best === null || areaOf(n.bounds) > areaOf(best.bounds!)) best = n
  }
  return best
}

/** The app's largest window on screen: what a scroll without a target swipes when the app shows no list. */
const appWindow = (screen: UiScreen, pkg: string): UiNode | null =>
  screen.nodes.filter((n) => n.package === pkg && n.parent === null && hasSize(n.bounds)).sort((a, b) => areaOf(b.bounds!) - areaOf(a.bounds!))[0] ?? null

/** Where the views inside `root` are, keyed by what they show (views that show the same thing twice are left out). */
function positions(screen: UiScreen, root: UiNode): Map<string, string> {
  const out = new Map<string, string>()
  const twice = new Set<string>()
  for (const n of screen.nodes) {
    if (!(n.resource_id || n.text || n.content_desc) || !inside(screen.nodes, n, root.i)) continue
    const key = JSON.stringify([n.class, n.resource_id, n.content_desc, n.text])
    if (out.has(key)) twice.add(key)
    out.set(key, JSON.stringify(n.bounds))
  }
  for (const key of twice) out.delete(key)
  return out
}

/**
 * Whether a swipe moved an area's content: a view shown before and after is somewhere else, or (when none is in
 * both) what it shows changed. A view that changes by itself in place (a ticking clock, a progress text) is in
 * neither reading's common part, so it does not count as movement and a list at its end is still seen to be there.
 */
export function contentMoved(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): boolean {
  let common = 0
  for (const [key, at] of before) {
    const now = after.get(key)
    if (now === undefined) continue
    common++
    if (now !== at) return true
  }
  return common === 0 && (before.size > 0 || after.size > 0)
}

/** What a step's screen check says: go on with this, or why not yet (and what each locator found). */
type Attempt<T> = { ok: T } | { wait: string; misses?: LocatorMiss[] }

/** One look at the screen while scrolling to a view: found it (cut or not), or not found but a list to swipe. */
type Look =
  | { hit: Located; list: UiNode | null; screen: UiScreen }
  | { hit: null; notFound: string; misses: LocatorMiss[]; list: UiNode; screen: UiScreen }

const NOT_ON_SCREEN = 'is not on screen (it has no size there)'

const describeArea = (n: UiNode): string => `the ${n.class.replace(/^.*\./, '')}${n.resource_id ? ` ${n.resource_id}` : ''}`

/** A view's text for assertions: its own text or description, else its descendants' texts in order (a row's labels). */
function shownText(nodes: readonly UiNode[], node: UiNode): string {
  const own = node.text || node.content_desc
  if (own) return own
  return nodes
    .filter((n) => n.i > node.i && (n.text || n.content_desc) && inside(nodes, n, node.i))
    .map((n) => n.text || n.content_desc)
    .join(' ')
}

export async function replayAndroidFlow(req: AndroidReplayRequest, host: AndroidReplayHost): Promise<FlowRun> {
  const { adb, serial, flow, signal } = req
  const startedAt = host.now()
  const notRun = (): StepRun[] => flow.steps.map((s) => ({ id: s.id, action: s.action, status: 'not_run' as const }))
  const abort = (error: string): FlowRun => ({ status: 'failed', startedAt, durationMs: host.now() - startedAt, error, steps: notRun() })
  if (flow.target.kind !== 'android') return abort(`this replayer runs android flows; the flow targets a ${flow.target.kind}`)
  const pkg = flow.target.package

  let interp: FlowInterpolator
  try {
    interp = createInterpolator(flow, req)
  } catch (error) {
    if (error instanceof MissingFlowInputsError) return abort(error.message)
    throw error
  }

  const shell = (line: string, timeoutMs = SHELL_TIMEOUT_MS): Promise<ExecResult> => host.exec(adb, ['-s', serial, 'shell', line], timeoutMs)
  /** Locators of the fields this run typed a secret into: screenshots paint them over. */
  const secretFields: Selector[][] = []
  const must = async (line: string, what: string): Promise<void> => {
    const r = await shell(line)
    if (failed(r)) throw new StepFailure(`could not ${what} on ${serial}: ${why(r)}`)
  }
  const keyboardShown = async (): Promise<boolean> => {
    const r = await shell(KEYBOARD_SHOWN_LINE)
    return !failed(r) && /mInputShown=true/.test(r.stdout)
  }

  // One read of the device clock serves the crash watch and the step logs (both read the device log by its time).
  const clockOffset = await readDeviceClockOffset(shell, host)
  const crashWatch = startCrashWatch(
    { adb, serial, pkg, sinceDeviceMs: clockOffset === null ? null : Math.min(req.crashesSince ?? startedAt, startedAt) + clockOffset, redact: interp.redact },
    host
  )
  let lastCrashCheck = Number.NEGATIVE_INFINITY
  const checkCrash = async (opts?: { last?: boolean }): Promise<CrashFound | null> => {
    lastCrashCheck = host.now()
    return crashWatch.check(opts)
  }
  /**
   * While a step waits, ask the device whether the app crashed, so the step fails with the crash now instead of with a
   * missing view at its timeout: every CRASH_POLL_MS once no view of the app is on screen (its windows are gone: a
   * crash dialog, the launcher), else every ANR_POLL_MS (a frozen app's views stay on screen under the ANR dialog).
   */
  const crashedWhileWaiting = async (screen: UiScreen | null): Promise<void> => {
    const gone = screen !== null && !screen.nodes.some((n) => n.package === pkg)
    if (host.now() - lastCrashCheck < (gone ? CRASH_POLL_MS : ANR_POLL_MS)) return
    const found = await checkCrash()
    if (found !== null) throw new AppCrashed(found)
  }

  /**
   * Read the screen until `attempt` says the step can go on (`{ ok }`), or the deadline: a screen that can't be read
   * and an attempt that says why not yet (`{ wait }`) both read again; the last reason is the step's error.
   */
  const poll = async <T>(deadline: number, attempt: (screen: UiScreen) => Attempt<T>): Promise<T> => {
    let last = ''
    let misses: LocatorMiss[] = []
    for (;;) {
      const screen = await readScreen(host, adb, serial)
      if ('skipped' in screen) last = screen.skipped
      else {
        const r = attempt(screen)
        if ('ok' in r) return r.ok
        last = r.wait
        misses = r.misses ?? []
      }
      if (signal?.aborted) throw new Stopped()
      await crashedWhileWaiting('skipped' in screen ? null : screen)
      if (host.now() >= deadline) throw new StepFailure(interp.redact(last), misses)
      await host.delay(ANDROID_POLL_MS, signal)
    }
  }

  /**
   * Wait until the step's view is on screen and `ready` says it can take the action (null = ready, else why not).
   * A locator that finds nothing waits like a view that isn't ready.
   */
  const waitForView = (selectors: readonly Selector[], deadline: number, ready: (node: UiNode, screen: UiScreen) => string | null): Promise<Located & { screen: UiScreen }> =>
    poll<Located & { screen: UiScreen }>(deadline, (screen) => {
      const hit = locateView(screen, pkg, selectors)
      if (!('node' in hit)) return { wait: `no view of ${pkg} matched: ${missText(hit.misses)}`, misses: hit.misses }
      const notReady = ready(hit.node, screen)
      return notReady === null ? { ok: { ...hit, screen } } : { wait: `${describeLocator(selectors[hit.index])} ${notReady}`, misses: hit.misses }
    })

  /**
   * On screen: a view the dump keeps with bounds that don't parse is not (a list row scrolled past the top keeps
   * inverted ones). A zero-size view stays a match, as before: a merged container can carry its children's text.
   */
  const onScreen = (node: UiNode): string | null => (node.bounds !== null ? null : NOT_ON_SCREEN)

  const tappable = (node: UiNode, screen: UiScreen): string | null => {
    if (!node.enabled) return 'is disabled'
    if (!hasSize(node.bounds)) return 'has no size on screen'
    const cover = coveredBy(screen, pkg, center(node.bounds))
    return cover ? `is covered by ${cover}` : null
  }

  /**
   * The on-screen keyboard is not in the dump, so a tap or a swipe could land on it: when it is up, press Back to
   * hide it and say so (the caller reads the screen again, the app having laid itself out anew). `again` = it was
   * hidden once already in this step: it came back, and pressing Back again could leave the screen instead.
   */
  const keyboardHidden = async (again: boolean, what: string): Promise<boolean> => {
    if (!(await keyboardShown())) return false
    if (again) throw new StepFailure(`the on-screen keyboard stays up after Back, so ${what}`)
    await must('input keyevent KEYCODE_BACK', 'hide the on-screen keyboard')
    await host.delay(KEYBOARD_SETTLE_MS, signal)
    return true
  }

  /** Tap the step's view, first hiding the on-screen keyboard. */
  const tapView = async (selectors: readonly Selector[], deadline: number, check?: (node: UiNode, index: number) => void): Promise<Located & { screen: UiScreen }> => {
    for (let hidden = 0; ; hidden++) {
      const hit = await waitForView(selectors, deadline, tappable)
      check?.(hit.node, hit.index)
      if (await keyboardHidden(hidden > 0, 'the tap could land on a key')) continue
      const at = center(hit.node.bounds!)
      // Only integers parsed from the dump reach the shell here.
      await must(`input tap ${at.x} ${at.y}`, 'tap')
      return hit
    }
  }

  /** The swipes to make in `box`, unless another app's window is where one would start (a prompt over the list). */
  const swipesIn = (box: UiBounds, dx: number, dy: number, screen: UiScreen): Swipe[] | string => {
    const plan = planSwipes(box, dx, dy)
    if (typeof plan === 'string') return plan
    for (const w of plan) {
      const cover = coveredBy(screen, pkg, w.from)
      if (cover) return `is covered by ${cover}`
    }
    return plan
  }

  const swipe = async (plan: readonly Swipe[]): Promise<void> => {
    for (const w of plan) {
      await must(swipeLine(w), 'swipe')
      await host.delay(SCROLL_SETTLE_MS, signal)
    }
  }

  /**
   * Swipe the content of a box by `delta`: the step's view (`selectors`: a pager, a carousel) or, without one, the
   * app's largest scrollable view (else its window). Waits like a tap for the box to be on screen and uncovered, then
   * reads the screen once more: a swipe that moved nothing fails the step here, not a later step far from the cause.
   */
  const swipeBy = async (selectors: readonly Selector[] | undefined, dx: number, dy: number, deadline: number): Promise<Located | null> => {
    /** The box on `screen`: the step's view, or the app's list or window. */
    const find = (screen: UiScreen): Attempt<{ box: UiNode; hit: Located | null }> => {
      if (selectors !== undefined) {
        const hit = locateView(screen, pkg, selectors)
        if (!('node' in hit)) return { wait: `no view of ${pkg} matched: ${missText(hit.misses)}`, misses: hit.misses }
        if (!hasSize(hit.node.bounds)) return { wait: `${describeLocator(selectors[hit.index])} has no size on screen`, misses: hit.misses }
        return { ok: { box: hit.node, hit } }
      }
      const box = scrollArea(screen, pkg) ?? appWindow(screen, pkg)
      return box === null ? { wait: `no window of ${pkg} is on screen to scroll` } : { ok: { box, hit: null } }
    }
    const name = (f: { box: UiNode; hit: Located | null }): string =>
      f.hit !== null && selectors !== undefined ? describeLocator(selectors[f.hit.index]) : f.box.scrollable ? describeArea(f.box) : `the window of ${pkg}`
    for (let hidden = 0; ; hidden++) {
      const { found, plan, screen } = await poll<{ found: { box: UiNode; hit: Located | null }; plan: Swipe[]; screen: UiScreen }>(deadline, (screen) => {
        const f = find(screen)
        if (!('ok' in f)) return f
        const p = swipesIn(f.ok.box.bounds!, dx, dy, screen)
        return typeof p === 'string' ? { wait: `${name(f.ok)} ${p}`, misses: f.ok.hit?.misses } : { ok: { found: f.ok, plan: p, screen } }
      })
      if (await keyboardHidden(hidden > 0, 'a swipe could land on a key')) continue
      await swipe(plan)
      const after = await readScreen(host, adb, serial)
      if (!('skipped' in after)) {
        const again = find(after)
        if ('ok' in again && !contentMoved(positions(screen, found.box), positions(after, again.ok.box))) {
          throw new StepFailure(
            interp.redact(`the swipe moved nothing in ${name(found)}: it is already at that end, or it springs back (a pager turns a page only when one swipe covers most of its width)`),
            found.hit?.misses
          )
        }
      }
      return found.hit
    }
  }

  /**
   * Scroll the app's largest scrollable view until one of `selectors` finds its view on screen: toward the end of the
   * list first, then back toward its start once a swipe moves nothing (that end reached). A view found cut by the
   * list's edge is brought further in with one more swipe, so a tap on it lands on it. Fails when both ends were
   * reached, after MAX_SWIPES swipes, or at the deadline, with every locator's result.
   */
  const scrollToView = async (selectors: readonly Selector[], deadline: number): Promise<Located> => {
    let direction = 1
    let turned = false
    let swipes = 0
    let nudged = false
    let hidden = false
    let before: { list: UiNode; at: Map<string, string> } | null = null
    for (;;) {
      const step = await poll<Look>(deadline, (screen) => {
        const hit = locateView(screen, pkg, selectors)
        const list = scrollArea(screen, pkg)
        if ('node' in hit && hasSize(hit.node.bounds)) return { ok: { hit, list, screen } }
        const notFound = 'node' in hit ? `${describeLocator(selectors[hit.index])} ${NOT_ON_SCREEN}` : `no view of ${pkg} matched: ${missText(hit.misses)}`
        if (list === null) return { wait: `${notFound}, and no scrollable view of ${pkg} is on screen to look further`, misses: hit.misses }
        return { ok: { hit: null, notFound, misses: hit.misses, list, screen } }
      })
      const { list, screen } = step
      if (step.hit !== null) {
        const b = step.hit.node.bounds!
        const l = list?.bounds
        // Cut by the list's edge (only the part on screen has bounds): one swipe brings it a third of the way in. At the
        // top edge only when the search scrolled up to it: on a list at its start that pull would be a pull-to-refresh.
        const third = l ? Math.floor((l.bottom - l.top) / 3) : 0
        const cut =
          nudged || list === null || !l || !inside(screen.nodes, step.hit.node, list.i)
            ? 0
            : b.bottom >= l.bottom - 1 && b.top > l.top
              ? b.top - (l.top + third)
              : b.top <= l.top + 1 && b.bottom < l.bottom && direction < 0 && swipes > 0
                ? b.bottom - (l.bottom - third)
                : 0
        const plan = Math.abs(cut) >= ANDROID_MIN_SWIPE_PX ? swipesIn(l!, 0, cut, screen) : null
        if (plan === null || typeof plan === 'string') return step.hit
        nudged = true
        if (await keyboardHidden(hidden, 'a swipe could land on a key')) {
          hidden = true
          continue
        }
        await swipe(plan)
        continue
      }
      const { notFound, misses } = step
      const at = positions(screen, list!)
      if (before !== null && before.list.resource_id === list!.resource_id && !contentMoved(before.at, at)) {
        // The last swipe moved nothing: this end of the list is reached.
        if (turned) throw new StepFailure(interp.redact(`scrolled ${describeArea(list!)} to both ends; ${notFound}`), misses)
        turned = true
        direction = -direction
      }
      if (swipes >= MAX_SWIPES) throw new StepFailure(interp.redact(`${notFound} after ${MAX_SWIPES} swipes of ${describeArea(list!)}`), misses)
      if (signal?.aborted) throw new Stopped()
      if (host.now() >= deadline) throw new StepFailure(interp.redact(`${notFound} (searched ${describeArea(list!)} with ${swipes} swipes)`), misses)
      const lb = list!.bounds!
      const plan = swipesIn(lb, 0, direction * Math.floor((lb.bottom - lb.top) * SWIPE_SPAN), screen)
      if (typeof plan === 'string') {
        // Not swipeable now (another app's window over it): wait for that like any step, then look again.
        await poll<null>(deadline, (s) => {
          const l2 = scrollArea(s, pkg)
          if (l2 === null || 'node' in locateView(s, pkg, selectors)) return { ok: null }
          const p2 = swipesIn(l2.bounds!, 0, direction * Math.floor((l2.bounds!.bottom - l2.bounds!.top) * SWIPE_SPAN), s)
          return typeof p2 === 'string' ? { wait: `${notFound}; ${describeArea(l2)} ${p2}`, misses } : { ok: null }
        })
        continue
      }
      if (await keyboardHidden(hidden, 'a swipe could land on a key')) {
        hidden = true
        continue
      }
      await swipe(plan)
      swipes++
      before = { list: list!, at }
      await crashedWhileWaiting(screen)
    }
  }

  const runStep = async (step: FlowStep, record: StepRun): Promise<void> => {
    const scrollTo = step.action === 'scroll' && step.target !== undefined && (step.delta === undefined || (step.delta[0] === 0 && step.delta[1] === 0))
    const fallbackTimeout = req.defaultTimeoutMs ?? DEFAULT_ANDROID_STEP_TIMEOUT_MS
    const deadline = host.now() + (step.timeout_ms ?? (scrollTo ? Math.max(fallbackTimeout, SCROLL_TO_VIEW_TIMEOUT_MS) : fallbackTimeout))
    const matched = (hit: Located): void => {
      const selector = (step as { target: { selectors: Selector[] } }).target.selectors[hit.index]
      const fallback = hit.misses.some((m) => m.found === 0 || m.invalid !== undefined)
      record.matched = { index: hit.index, selector, layer: locatorLayer(selector), fallback }
      if (hit.misses.length > 0) record.misses = hit.misses
      else delete record.misses
    }
    switch (step.action) {
      case 'click':
        matched(await tapView(step.target.selectors, deadline))
        return
      case 'fill': {
        const value = interp.interpolate(step.value)
        if (!TYPABLE_RE.test(value)) throw new StepFailure('the value has characters a device cannot type with `input text` (only printable ASCII)')
        // A view that is not a text field fails before it is tapped: a drifted locator must not press a button.
        const hit = await tapView(step.target.selectors, deadline, (node, index) => {
          if (isTextField(node)) return
          throw new StepFailure(`${describeLocator(step.target.selectors[index])} is a ${node.class.replace(/^.*\./, '')}, not a text field`)
        })
        matched(hit)
        // Before typing: a screenshot taken from here on masks the field, even if typing then fails halfway.
        if (interp.redact(value) !== value) secretFields.push(step.target.selectors)
        if (hit.node.text.length > MAX_CLEAR_CHARS) throw new StepFailure(`the field holds more than ${MAX_CLEAR_CHARS} characters, more than Nawi empties before typing`)
        for (const line of clearLines(hit.node.text.length)) await must(line, 'clear the field')
        for (const line of typeLines(value)) await must(line, 'type into the field')
        return
      }
      case 'press': {
        // parseFlow allows only ANDROID_KEYS names; own properties only, so `constructor` never names a key.
        const key = Object.hasOwn(ANDROID_KEYS, step.key) ? ANDROID_KEYS[step.key] : undefined
        if (key === undefined) throw new StepFailure(`android flows can press ${Object.keys(ANDROID_KEYS).join(', ')}`)
        // The keyboard is not part of a flow (the dump doesn't show it): Back means Back in the app, so a keyboard a
        // fill left up is hidden first, as before a tap. The recorder drops a Back that only closed the keyboard.
        if (step.key === 'Back' && (await keyboardHidden(false, ''))) {
          if (await keyboardShown()) throw new StepFailure('the on-screen keyboard stays up after Back, so Back would only close it')
        }
        await must(`input keyevent ${key}`, `press ${step.key}`)
        return
      }
      case 'scroll': {
        // Like a browser flow: a target alone = bring it on screen; a target and a delta = scroll inside it (a pager, a
        // carousel); a delta alone = scroll the app's list. parseFlow refuses a target-less scroll without a delta.
        if (scrollTo) {
          matched(await scrollToView(step.target!.selectors, deadline))
          return
        }
        const [dx, dy] = step.delta ?? [0, 0]
        if (dx === 0 && dy === 0) throw new StepFailure('an android scroll without a target needs a delta')
        const hit = await swipeBy(step.target?.selectors, dx, dy, deadline)
        if (hit !== null) matched(hit)
        return
      }
      case 'navigate': {
        const url = interp.interpolate(step.url)
        if (!DEEP_LINK_RE.test(url)) throw new StepFailure(`${interp.redact(url).slice(0, 200)} is not a deep link (a URI with a scheme, such as myapp://orders/42)`)
        const r = await shell(`am start -W -a android.intent.action.VIEW -d ${shQuote(url)} ${shQuote(pkg)}`, DEEP_LINK_TIMEOUT_MS)
        if (r.error) throw new StepFailure(`could not open the deep link on ${serial}: ${why(r)}`)
        const started = parseAmStart(r.stdout, r.stderr)
        if (!started.ok) throw new StepFailure(interp.redact(`${pkg} did not open the deep link: ${started.error}`))
        return
      }
      case 'wait':
        if (step.target === undefined) {
          await host.delay(step.ms ?? 0, signal)
          return
        }
        matched(await waitForView(step.target.selectors, deadline, onScreen))
        return
      case 'assert': {
        const target = step.target
        if (target === undefined) throw new StepFailure('an android assertion needs a target')
        const want = step.expect
        // Scrub secrets before folding or cutting: redact() matches a secret only whole.
        const wantText = want.text !== undefined ? fold(interp.redact(interp.interpolate(want.text))) : undefined
        let last = ''
        for (;;) {
          delete record.matched
          delete record.misses
          const screen = await readScreen(host, adb, serial)
          if ('skipped' in screen) last = screen.skipped
          else {
            const hit = locateView(screen, pkg, target.selectors)
            // A view the dump keeps with no size (a list row scrolled past the top keeps inverted bounds) is not shown.
            if ('node' in hit && onScreen(hit.node) !== null) {
              matched(hit)
              if (want.visible === false && want.enabled === undefined && wantText === undefined) return
              last = `${describeLocator(target.selectors[hit.index])} ${NOT_ON_SCREEN}`
            } else if (!('node' in hit)) {
              // Gone (or ambiguous everywhere): only `visible: false` holds, and only when every locator finds nothing.
              if (want.visible === false && want.enabled === undefined && wantText === undefined && hit.misses.every((m) => m.found === 0 && !m.invalid)) return
              last = `no view of ${pkg} matched: ${missText(hit.misses)}`
              record.misses = hit.misses
            } else {
              const problems: string[] = []
              const n = hit.node
              if (want.visible === false) problems.push('expected it to be gone, but it is on screen')
              if (want.enabled !== undefined && n.enabled !== want.enabled) problems.push(`expected enabled=${want.enabled}, got ${n.enabled}`)
              const shown = fold(interp.redact(shownText(screen.nodes, n)))
              if (wantText !== undefined && !shown.includes(wantText)) problems.push(`expected text containing ${JSON.stringify(wantText)}, got ${JSON.stringify(shown.slice(0, 200))}`)
              matched(hit)
              if (problems.length === 0) return
              last = `${describeLocator(target.selectors[hit.index])}: ${problems.join('; ')}`
            }
          }
          if (signal?.aborted) throw new Stopped()
          await crashedWhileWaiting('skipped' in screen ? null : screen)
          if (host.now() >= deadline) throw new StepFailure(interp.redact(last), record.misses)
          await host.delay(ANDROID_POLL_MS, signal)
        }
      }
      default:
        throw new StepFailure(`"${step.action}" steps are not supported in android flows yet`)
    }
  }

  const shots = req.stepScreenshots ?? 'off'
  const evidence: AndroidEvidence | null =
    shots !== 'off' || req.logcat
      ? await startAndroidEvidence(
          { adb, serial, pkg, logcat: req.logcat === true, secretFields, usesSecrets: JSON.stringify(flow).includes('${secret.'), redact: interp.redact, clockOffset },
          host
        )
      : null
  /**
   * Where the next step's device log starts: the previous log read, so what the app logs while a shot is taken or
   * between steps (a crash just after a tap) lands in a step instead of between two.
   */
  let logSince: number | undefined
  // The latest "after" shot; a disabled step in between changes nothing on the screen.
  let lastAfter: string | undefined

  const steps: StepRun[] = []
  /** The last step that will run (not disabled): the run's final crash check waits for the app first. */
  const lastRunnable = flow.steps.reduce((at, s, i) => (s.disabled ? at : i), -1)
  let failedStepId: string | undefined
  let error: string | undefined
  const notify = (index: number, step: StepRun): void => {
    try {
      req.onStep?.({ index, total: flow.steps.length, id: step.id, action: step.action, status: step.status })
    } catch {
      // A progress listener never affects the run.
    }
  }
  for (const [index, step] of flow.steps.entries()) {
    const record: StepRun = { id: step.id, action: step.action, status: 'not_run' }
    if (step.intent !== undefined) record.intent = interp.redact(step.intent)
    steps.push(record)
    if (failedStepId !== undefined || error !== undefined) {
      notify(index, record)
      continue
    }
    if (signal?.aborted) {
      error = `stopped before step ${step.id}: ${String(signal.reason ?? 'cancelled')}`
      notify(index, record)
      continue
    }
    if (step.disabled) {
      record.status = 'skipped'
      notify(index, record)
      continue
    }
    const before = evidence !== null && shots === 'all' ? (lastAfter ?? (await evidence.shot())) : undefined
    record.startedAt = host.now()
    let crash: CrashFound | null = null
    try {
      await runStep(step, record)
      record.status = 'passed'
    } catch (e) {
      if (e instanceof AppCrashed) crash = e.found
      if (e instanceof Stopped) {
        // Cancelled while waiting: like a step after the stop, it did not run to an outcome.
        delete record.matched
        delete record.misses
        delete record.startedAt
        error = `stopped during step ${step.id}: ${String(signal?.reason ?? 'cancelled')}`
        notify(index, record)
        continue
      }
      if (!(e instanceof StepFailure)) throw e
      record.status = 'failed'
      record.error = e.message
      if (e.misses && e.misses.length > 0) record.misses = e.misses
      failedStepId = step.id
    }
    // A crash the step's own checks did not see (the app died after the action, or its window stayed up): it fails
    // the step whatever the step's result, and is named first, since it explains a step that failed too. After the
    // last step the app gets a moment first: no later step would notice a crash its action caused.
    const last = index === lastRunnable
    if (crash === null && last && record.status === 'passed' && !signal?.aborted) await host.delay(LAST_STEP_CRASH_SETTLE_MS, signal)
    if (crash === null && !signal?.aborted) {
      crash = await checkCrash({ last })
      if (crash !== null) {
        const said = crashMessage(crash.crash)
        record.error = record.status === 'failed' ? `${said} (the step: ${record.error})` : said
        record.status = 'failed'
        failedStepId = step.id
      }
    }
    if (crash !== null) record.crash = crash.crash
    record.durationMs = host.now() - record.startedAt
    let logLines: DeviceLogLine[] = []
    let logDropped = 0
    // A cancelled run stops collecting at once: shots and logs can take many seconds on a slow device.
    if (evidence !== null && !signal?.aborted) {
      const after = shots === 'all' || (shots === 'failed' && record.status === 'failed') ? await evidence.shot() : undefined
      lastAfter = after
      if (before !== undefined || after !== undefined) record.shots = { ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }
      if (req.logcat) {
        const since = logSince ?? record.startedAt
        logSince = host.now()
        const log = await evidence.stepLog(since)
        logLines = log.lines
        logDropped = log.dropped
      }
    }
    if (crash !== null) {
      // The crash's own lines lead the step's log (kept even without logcat), then the step's other lines once.
      const own = crash.lineKeys
      const rest = logLines.filter((l) => !own.has(logLineKey(l)))
      const room = Math.max(0, MAX_LOGCAT_LINES - crash.log.length)
      logLines = [...crash.log, ...rest.slice(0, room)]
      logDropped += crash.dropped + Math.max(0, rest.length - room)
    }
    if (logLines.length > 0) record.logcat = logLines
    if (logDropped > 0) record.logcatDropped = logDropped
    notify(index, record)
  }
  const run: FlowRun = { status: failedStepId === undefined && error === undefined ? 'passed' : 'failed', startedAt, durationMs: host.now() - startedAt, steps }
  if (failedStepId !== undefined) run.failedStepId = failedStepId
  if (error !== undefined) run.error = error
  return run
}
