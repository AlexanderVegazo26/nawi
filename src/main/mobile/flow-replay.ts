import { createInterpolator, MissingFlowInputsError, type FlowInputs, type FlowInterpolator } from '../../shared/flow/interpolate'
import { ANDROID_KEYS, locatorLayer, type Flow, type FlowStep, type Selector } from '../../shared/flow/schema'
import type { FlowRun, LocatorMiss, StepProgress, StepRun } from '../replay/replay'
import { findAll, type UiLocator } from './blockers'
import type { Exec, ExecResult } from './doctor'
import { center, type UiNode, type UiScreen } from './hierarchy'
import { KEYBOARD_SHOWN_LINE, parseAmStart, readScreen } from './open'
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
}

export const DEFAULT_ANDROID_STEP_TIMEOUT_MS = 10_000
/** How long to wait between screen reads while a step waits for its view. */
export const ANDROID_POLL_MS = 250
/** After Back hides the on-screen keyboard, how long the app takes to lay itself out again. */
export const KEYBOARD_SETTLE_MS = 500
const SHELL_TIMEOUT_MS = 30_000
const DEEP_LINK_TIMEOUT_MS = 60_000
/** A deep link is a URI with a scheme, on one line. */
const DEEP_LINK_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\x00-\x1f\x7f]+$/

const failed = (r: ExecResult): boolean => r.code !== 0 || !!r.error
/** Why adb failed, in Nawi's words: the device's own output could echo a typed value. */
const why = (r: ExecResult): string =>
  r.error === 'timeout' ? 'the device did not answer' : r.error === 'not_found' ? 'adb could not be started' : `adb exited with code ${r.code ?? 'unknown'}`

const toUiLocator = (s: Selector): UiLocator | null =>
  'id' in s ? { resource_id: s.id } : 'desc' in s ? { content_desc: s.desc } : 'text' in s ? { text: s.text } : null

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

/** A view's text for assertions: its own text or description, else its descendants' texts in order (a row's labels). */
function shownText(nodes: readonly UiNode[], node: UiNode): string {
  const own = node.text || node.content_desc
  if (own) return own
  const inside = (n: UiNode): boolean => {
    for (let p = n.parent; p !== null; p = nodes[p].parent) if (p === node.i) return true
    return false
  }
  return nodes
    .filter((n) => n.i > node.i && (n.text || n.content_desc) && inside(n))
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
  const must = async (line: string, what: string): Promise<void> => {
    const r = await shell(line)
    if (failed(r)) throw new StepFailure(`could not ${what} on ${serial}: ${why(r)}`)
  }
  const keyboardShown = async (): Promise<boolean> => {
    const r = await shell(KEYBOARD_SHOWN_LINE)
    return !failed(r) && /mInputShown=true/.test(r.stdout)
  }

  /**
   * Wait until the step's view is on screen and `ready` says it can take the action (null = ready, else why not).
   * A screen that can't be read, a view that isn't ready and a locator that finds nothing all wait; the last reason
   * is the step's error at the deadline.
   */
  const waitForView = async (selectors: readonly Selector[], deadline: number, ready: (node: UiNode, screen: UiScreen) => string | null): Promise<Located & { screen: UiScreen }> => {
    let last = ''
    let misses: LocatorMiss[] = []
    for (;;) {
      const screen = await readScreen(host, adb, serial)
      if ('skipped' in screen) last = screen.skipped
      else {
        const hit = locateView(screen, pkg, selectors)
        if ('node' in hit) {
          const notReady = ready(hit.node, screen)
          if (notReady === null) return { ...hit, screen }
          last = `${describeLocator(selectors[hit.index])} ${notReady}`
          misses = hit.misses
        } else {
          last = `no view of ${pkg} matched: ${missText(hit.misses)}`
          misses = hit.misses
        }
      }
      if (signal?.aborted) throw new Stopped()
      if (host.now() >= deadline) throw new StepFailure(interp.redact(last), misses)
      await host.delay(ANDROID_POLL_MS, signal)
    }
  }

  const tappable = (node: UiNode, screen: UiScreen): string | null => {
    if (!node.enabled) return 'is disabled'
    const b = node.bounds
    if (b === null || b.right <= b.left || b.bottom <= b.top) return 'has no size on screen'
    const cover = coveredBy(screen, pkg, center(b))
    return cover ? `is covered by ${cover}` : null
  }

  /** Tap the step's view, first hiding the on-screen keyboard (it is not in the dump, so the view could be under it). */
  const tapView = async (selectors: readonly Selector[], deadline: number, check?: (node: UiNode, index: number) => void): Promise<Located & { screen: UiScreen }> => {
    for (let hidden = 0; ; hidden++) {
      const hit = await waitForView(selectors, deadline, tappable)
      check?.(hit.node, hit.index)
      if (await keyboardShown()) {
        if (hidden > 0) throw new StepFailure('the on-screen keyboard stays up after Back, so the tap could land on a key')
        await must('input keyevent KEYCODE_BACK', 'hide the on-screen keyboard')
        await host.delay(KEYBOARD_SETTLE_MS, signal)
        continue
      }
      const at = center(hit.node.bounds!)
      // Only integers parsed from the dump reach the shell here.
      await must(`input tap ${at.x} ${at.y}`, 'tap')
      return hit
    }
  }

  const runStep = async (step: FlowStep, record: StepRun): Promise<void> => {
    const deadline = host.now() + (step.timeout_ms ?? req.defaultTimeoutMs ?? DEFAULT_ANDROID_STEP_TIMEOUT_MS)
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
          if (/EditText$/.test(node.class)) return
          throw new StepFailure(`${describeLocator(step.target.selectors[index])} is a ${node.class.replace(/^.*\./, '')}, not a text field`)
        })
        matched(hit)
        if (hit.node.text.length > MAX_CLEAR_CHARS) throw new StepFailure(`the field holds more than ${MAX_CLEAR_CHARS} characters, more than Nawi empties before typing`)
        for (const line of clearLines(hit.node.text.length)) await must(line, 'clear the field')
        for (const line of typeLines(value)) await must(line, 'type into the field')
        return
      }
      case 'press': {
        // parseFlow allows only ANDROID_KEYS names; own properties only, so `constructor` never names a key.
        const key = Object.hasOwn(ANDROID_KEYS, step.key) ? ANDROID_KEYS[step.key] : undefined
        if (key === undefined) throw new StepFailure(`android flows can press ${Object.keys(ANDROID_KEYS).join(', ')}`)
        await must(`input keyevent ${key}`, `press ${step.key}`)
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
        matched(await waitForView(step.target.selectors, deadline, () => null))
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
            if (!('node' in hit)) {
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
          if (host.now() >= deadline) throw new StepFailure(interp.redact(last), record.misses)
          await host.delay(ANDROID_POLL_MS, signal)
        }
      }
      default:
        throw new StepFailure(`"${step.action}" steps are not supported in android flows yet`)
    }
  }

  const steps: StepRun[] = []
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
    record.startedAt = host.now()
    try {
      await runStep(step, record)
      record.status = 'passed'
    } catch (e) {
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
    record.durationMs = host.now() - record.startedAt
    notify(index, record)
  }
  const run: FlowRun = { status: failedStepId === undefined && error === undefined ? 'passed' : 'failed', startedAt, durationMs: host.now() - startedAt, steps }
  if (failedStepId !== undefined) run.failedStepId = failedStepId
  if (error !== undefined) run.error = error
  return run
}
