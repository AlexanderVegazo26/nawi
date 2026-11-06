/**
 * Deterministic browser replay of a flow over raw CDP (roadmap F3).
 *
 * Takes a parsed flow and an attached page session and runs the steps in
 * order: each step resolves its ranked selectors with the fallback chain (the
 * first selector that matches exactly one element wins; a selector matching
 * several is ambiguous and skipped), auto-waits until the element is ready
 * (visible, enabled, not covered) up to the step's timeout, then acts through
 * `Input.dispatch*` so the page sees trusted events. The first failing step
 * stops the run; later steps are reported `not_run`.
 *
 * What it returns is the seed of F4's run record: per step the status, timing,
 * the locator that matched, what each earlier locator found, and a reason a
 * person or an agent can act on. Values typed into fields never appear in it,
 * and secret values are scrubbed from every message (`redact`).
 *
 * Desktop targets need computer use (F7) and are refused here.
 */

import replaySource from './inject/replay.js?raw'
import { buildProbeSource, type ProbeClient } from '../cdp/probe'
import { createInterpolator, MissingFlowInputsError, type FlowInputs, type FlowInterpolator } from '@shared/flow/interpolate'
import { locatorLayer, type Flow, type FlowStep, type LocatorLayer, type Selector } from '@shared/flow/schema'
import { MODIFIER_BITS, parseKey, UnknownKeyError, type KeyPress } from './keys'
import { EvidenceCollector, type StepEvidence } from './evidence'

/**
 * Just enough of `CdpClient`. `on` is optional so a bare `send` double still
 * works, but without it JavaScript dialogs are not answered and a click that
 * opens `confirm()` blocks until the CDP command timeout.
 */
export interface ReplayClient extends ProbeClient {
  on?(method: string, listener: (event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void): () => void
}

export const DEFAULT_STEP_TIMEOUT_MS = 5_000
const POLL_MS = 50
/** A page screenshot that takes longer than this is skipped, never waited on. */
export const SHOT_TIMEOUT_MS = 3_000
/** JPEG quality of the per-step page screenshots: readable text, a fraction of a PNG's size. */
const SHOT_QUALITY = 60

/**
 * Page screenshots around each step (roadmap F4b2): `all` = the page before
 * the first step and after every step (a step's "before" is the previous
 * step's "after", taken just as it started); `failed` = only the page the
 * failing step left; `off` = none.
 */
export type StepScreenshots = 'all' | 'failed' | 'off'

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'not_run'

export interface LocatorMiss {
  index: number
  selector: Selector
  /** Elements it matched: 0 = gone, 2+ = ambiguous. */
  found: number
  /** Set when the selector itself is broken (bad CSS). */
  invalid?: string
}

/**
 * Besides its own result, a step carries what the page did while it ran
 * (roadmap F4b, `StepEvidence`): console errors, failed requests and the URL
 * after it, all scrubbed of secrets.
 */
export interface StepRun extends StepEvidence {
  id: string
  action: FlowStep['action']
  status: StepStatus
  /** Epoch ms. Absent for steps that never started. */
  startedAt?: number
  durationMs?: number
  /**
   * The locator that resolved the target, by its position in `target.selectors`,
   * and its layer (roadmap AI1). `fallback` = an earlier, more stable locator
   * found nothing (or is broken): the flow is drifting from the app and should
   * be updated before this locator breaks too. An earlier locator that only
   * matched several elements does not count (see `isFallback`).
   */
  matched?: { index: number; selector: Selector; layer: LocatorLayer; fallback: boolean }
  /** The step's `intent` from the flow (what it is for), scrubbed. */
  intent?: string
  /** Locators tried before the match (or all of them, when nothing matched). */
  misses?: LocatorMiss[]
  error?: string
  /** `screenshot` steps: the PNG, base64. */
  screenshotPng?: string
  /**
   * The viewport before and after the step, base64 JPEG (`stepScreenshots`).
   * `before` is the very string of the previous step's `after` when nothing
   * ran in between, so a writer can store it once. Fields that received a
   * secret are masked in it.
   */
  shots?: { before?: string; after?: string }
  /** JavaScript dialogs the step opened; the replayer dismisses them (accepts `beforeunload`). */
  dialogs?: Array<{ type: string; message: string }>
}

export interface FlowRun {
  status: 'passed' | 'failed'
  startedAt: number
  durationMs: number
  /** Why the run failed before any step (missing inputs, unsupported target). */
  error?: string
  failedStepId?: string
  steps: StepRun[]
  /** Console errors and failed requests while the flow's target was opening, before the first step. */
  opening?: Omit<StepEvidence, 'url'>
  /** The page's URL when the run ended, scrubbed. */
  finalUrl?: string
}

export interface ReplayOptions extends FlowInputs {
  sessionId?: string
  /** Fallback when a step has no `timeout_ms`. */
  defaultTimeoutMs?: number
  /** Navigate to `flow.target.url` before the first step (default true). */
  openTarget?: boolean
  /** Limit for opening the target; defaults to the larger of 30 s and `defaultTimeoutMs`. */
  navigationTimeoutMs?: number
  /** Injected for tests; defaults to Date.now. */
  now?: () => number
  /**
   * Stops the run between steps (the agent kill switch): the step in progress
   * finishes, the rest are `not_run`, and the run fails with the signal's reason.
   */
  signal?: AbortSignal
  /** Page screenshots around each step; default `off`. */
  stepScreenshots?: StepScreenshots
  /**
   * Told about every step in order as it settles: passed, failed, skipped, or
   * not_run once the run has failed or stopped.
   * For progress reports: it carries no error text, values or URLs, and a
   * throwing listener never affects the run.
   */
  onStep?: (event: StepProgress) => void
}

/** One settled step, for progress reporting. `index` is 0-based into `flow.steps`. */
export interface StepProgress {
  index: number
  total: number
  id: string
  action: string
  /** `not_run`: a step after the failure (or the stop), so progress still reaches `total`. */
  status: 'passed' | 'failed' | 'skipped' | 'not_run'
}

/** Shapes returned by `inject/replay.js`. */
interface PageAnswer {
  found: boolean
  index: number
  tried: Array<{ index: number; found: number; invalid?: string }>
  blocked?: string
  /** The element can never satisfy the step (e.g. fill on a button): stop waiting. */
  permanent?: boolean
  visible?: boolean
  enabled?: boolean
  text?: string
  x?: number
  y?: number
  focused?: boolean
  /** focusForFill: the field ignores typed text (date, time...); set its value instead. */
  setValue?: boolean
  box?: { x: number; y: number; width: number; height: number }
  /** mask: the token its unmask takes. */
  generation?: number
}

class StepFailure extends Error {
  readonly answer: PageAnswer | null
  constructor(message: string, answer: PageAnswer | null = null) {
    super(message)
    this.name = 'StepFailure'
    this.answer = answer
  }
}

interface EvaluateResponse {
  result?: { value?: unknown }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

/** Errors a navigation in flight causes; the poll simply asks again. */
const TRANSIENT = /Execution context was destroyed|Cannot find context|Inspected target navigated|uniqueContextId not found/i

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** `{ testid: "x" }` → `testid=x`, for messages. */
export function describeSelector(selector: Selector): string {
  if ('testid' in selector) return `testid=${selector.testid}`
  if ('id' in selector) return `id=${selector.id}`
  if ('css' in selector) return `css=${selector.css}`
  // JSON quoting: a text with quotes or line breaks stays one readable, pasteable token.
  if ('text' in selector) return `text=${JSON.stringify(selector.text)}`
  return selector.name === undefined ? `role=${selector.role}` : `role=${selector.role}[name="${selector.name}"]`
}

export function replaySources(): string {
  return `${buildProbeSource()}\n${replaySource}`
}

/**
 * How long past its deadline a step's CDP command may still answer. A command
 * that started just before the deadline (the last poll, the click after the
 * locate) gets this long; one that hangs fails the step here instead of
 * waiting out the client's own 20-30 s command timeout.
 */
export const STEP_COMMAND_GRACE_MS = 2_000

class Session {
  /**
   * While a step runs: its commands must answer by `until` on the monotonic
   * clock. The budget comes from the run's (injectable) clock, so it matches
   * the step's deadline; elapsed time is real, since the timers are.
   */
  private answerBy: { until: number; timeoutMs: number } | undefined

  constructor(
    private readonly client: ReplayClient,
    private readonly sessionId: string | undefined,
    private readonly now: () => number
  ) {}

  /** Bound every command sent until `clearLimit()` to `deadline + STEP_COMMAND_GRACE_MS`. */
  limit(deadline: number, timeoutMs: number): void {
    const budget = deadline - this.now() + STEP_COMMAND_GRACE_MS
    // A clock that can't give a budget (tests' NaN clocks) leaves commands to the client's own timeout.
    this.answerBy = Number.isFinite(budget) ? { until: performance.now() + budget, timeoutMs } : undefined
  }

  clearLimit(): void {
    this.answerBy = undefined
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const limit = this.answerBy
    if (!limit) return this.client.send<T>(method, params, this.sessionId)
    const late = (): StepFailure =>
      new StepFailure(
        `the browser did not answer ${method} within the step's ${limit.timeoutMs} ms (+${STEP_COMMAND_GRACE_MS} ms grace)`
      )
    const left = limit.until - performance.now()
    // Past the limit, don't start anything new on the page (an input event the step no longer owns).
    if (left <= 0) return Promise.reject(late())
    const sent = this.client.send<T>(method, params, this.sessionId)
    // The command may still answer (or fail) after the step gave up on it: nobody listens then.
    sent.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(late()), left)))
    return Promise.race([sent, timeout]).finally(() => clearTimeout(timer))
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<EvaluateResponse>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (response.exceptionDetails) {
      const detail =
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'unknown page exception'
      throw new Error(`page evaluation failed: ${detail}`)
    }
    return response.result?.value as T
  }

  /** Call `window.__nawiReplay[fn](...args)`; null while the helpers are not installed in this document yet. */
  async call(fn: string, ...args: unknown[]): Promise<PageAnswer | null> {
    const argList = args.map((a) => JSON.stringify(a)).join(', ')
    try {
      return await this.evaluate<PageAnswer | null>(
        `(() => { const r = window.__nawiReplay; return r ? r.${fn}(${argList}) : null })()`
      )
    } catch (error) {
      if (TRANSIENT.test(String((error as Error)?.message ?? error))) return null
      throw error
    }
  }
}

/**
 * Install the probe + replay helpers in this document and every later one.
 * Returns the function that unregisters them, so repeated replays on one
 * long-lived session don't stack copies onto every navigation.
 */
export async function installReplayHelpers(client: ReplayClient, sessionId?: string): Promise<() => Promise<void>> {
  const source = replaySources()
  const { identifier } = await client.send<{ identifier?: string }>(
    'Page.addScriptToEvaluateOnNewDocument',
    { source },
    sessionId
  )
  await client.send('Runtime.evaluate', { expression: source, returnByValue: true }, sessionId)
  return async () => {
    if (identifier) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId)
  }
}

/**
 * Poll `attempt` until it returns a value or the deadline passes. `attempt`
 * returns undefined to keep waiting and records why in `last`.
 */
async function until<T>(deadline: number, now: () => number, attempt: () => Promise<T | undefined>): Promise<T | undefined> {
  for (;;) {
    const value = await attempt()
    if (value !== undefined) return value
    if (now() >= deadline) return undefined
    await sleep(Math.max(0, Math.min(POLL_MS, deadline - now())))
  }
}

/** A step's id and action, plus its `intent` when the flow gave one (scrubbed when secrets are known). */
export function withIntent(step: FlowStep, redact: (text: string) => string = (t) => t): Pick<StepRun, 'id' | 'action' | 'intent'> {
  return step.intent === undefined ? { id: step.id, action: step.action } : { id: step.id, action: step.action, intent: redact(step.intent) }
}

/**
 * Drift (roadmap AI1): an earlier, more stable locator is gone (finds nothing)
 * or broken. An earlier locator that is merely ambiguous is not drift: the
 * recorder keeps ranked candidates that were never unique (a test id shared by
 * every row), so they are skipped on the very day the flow was recorded.
 */
function isFallback(answer: PageAnswer): boolean {
  return answer.tried.some((t) => t.index < answer.index && (t.found === 0 || t.invalid !== undefined))
}

function missesOf(answer: PageAnswer | null, selectors: Selector[]): LocatorMiss[] {
  return (answer?.tried ?? []).map((t) => ({
    index: t.index,
    selector: selectors[t.index],
    found: t.found,
    ...(t.invalid !== undefined ? { invalid: t.invalid } : {})
  }))
}

function notFoundMessage(answer: PageAnswer | null, selectors: Selector[], timeoutMs: number): string {
  if (!answer) return `the page never became ready for the step within ${timeoutMs} ms`
  if (!answer.found) {
    const parts = missesOf(answer, selectors).map((m) =>
      m.invalid !== undefined
        ? `${describeSelector(m.selector)}: invalid (${m.invalid})`
        : `${describeSelector(m.selector)}: ${m.found === 0 ? 'no element' : `${m.found} elements (ambiguous)`}`
    )
    return `no locator matched exactly one element within ${timeoutMs} ms — ${parts.join('; ')}`
  }
  return `${describeSelector(selectors[answer.index])} matched but ${answer.blocked ?? 'it never became ready'} (waited ${timeoutMs} ms)`
}

const WS = /\s+/g
const normalize = (s: string): string => s.replace(WS, ' ').trim()

export async function replayFlow(client: ReplayClient, flow: Flow, options: ReplayOptions = {}): Promise<FlowRun> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const notRun = (): StepRun[] =>
    flow.steps.map((s) => ({ ...withIntent(s), status: s.disabled ? 'skipped' : 'not_run' }))
  const abort = (error: string): FlowRun => ({
    status: 'failed',
    startedAt,
    durationMs: now() - startedAt,
    error,
    steps: notRun()
  })

  if (flow.target.kind !== 'browser') {
    return abort('desktop targets need computer-use replay, which this build does not have yet (roadmap F7)')
  }

  const openTarget = options.openTarget !== false
  let interp: FlowInterpolator
  try {
    interp = createInterpolator(flow, options, { includeTarget: openTarget })
  } catch (error) {
    if (error instanceof MissingFlowInputsError) return abort(error.message)
    throw error
  }

  if (options.signal?.aborted) return abort(stopReason(options.signal))

  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const session = new Session(client, options.sessionId, now)
  const runner = new StepRunner(session, interp, now, defaultTimeoutMs)

  // A dialog blocks the page (and the Input command that opened it) until it
  // is answered: dismiss it, accept beforeunload so navigations go on, and
  // note it on the step that was running.
  const offDialog = client.on?.('Page.javascriptDialogOpening', (event) => {
    if (event.sessionId !== options.sessionId) return
    const type = String(event.params.type ?? 'alert')
    runner.noteDialog({ type, message: interp.redact(String(event.params.message ?? '')) })
    void client
      .send('Page.handleJavaScriptDialog', { accept: type === 'beforeunload' }, options.sessionId)
      .catch(() => undefined)
  })

  const evidence = new EvidenceCollector(client, options.sessionId, interp.redact)
  let uninstall: (() => Promise<void>) | undefined
  let run: FlowRun | undefined
  try {
    try {
      await evidence.start()
      await session.send('Page.enable')
      uninstall = await installReplayHelpers(client, options.sessionId)
      if (openTarget) {
        await runner.navigate(
          interp.interpolate(flow.target.url),
          options.navigationTimeoutMs ?? Math.max(30_000, defaultTimeoutMs)
        )
      }
    } catch (error) {
      run = abort(interp.redact(`could not open the flow's target: ${(error as Error).message ?? error}`))
    }
    run ??= await runSteps(flow, runner, startedAt, now, options.signal, evidence, options.stepScreenshots ?? 'off', options.onStep)
  } finally {
    evidence.stop()
    offDialog?.()
    await uninstall?.().catch(() => undefined)
  }
  return withEvidence(run, flow, evidence)
}

/** Files the collected evidence onto the run's steps (aligned with `flow.steps` by index). */
function withEvidence(run: FlowRun, flow: Flow, evidence: EvidenceCollector): FlowRun {
  const steps = run.steps.map((step, index) => {
    const e = flow.steps[index]?.id === step.id ? evidence.forStep(index) : undefined
    return e ? { ...step, ...e } : step
  })
  const opening = evidence.forStep(-1)
  const finalUrl = evidence.finalUrl()
  return {
    ...run,
    steps,
    ...(opening ? { opening } : {}),
    ...(finalUrl !== undefined ? { finalUrl } : {})
  }
}

/** The message an aborted run reports: the signal's string reason, else a generic one. */
function stopReason(signal: AbortSignal): string {
  return typeof signal.reason === 'string' ? signal.reason : 'the run was stopped'
}

async function runSteps(
  flow: Flow,
  runner: StepRunner,
  startedAt: number,
  now: () => number,
  signal: AbortSignal | undefined,
  evidence: EvidenceCollector,
  shots: StepScreenshots,
  onStep?: (event: StepProgress) => void
): Promise<FlowRun> {
  const steps: StepRun[] = []
  const settled = (index: number, step: FlowStep, status: StepProgress['status']): void => {
    try {
      onStep?.({ index, total: flow.steps.length, id: step.id, action: step.action, status })
    } catch {
      // A progress listener is a spectator: its failure must not change the run.
    }
  }
  let failed: string | undefined
  let stopped: string | undefined
  // The latest "after" shot; a disabled step in between changes nothing on the page.
  let lastAfter: string | undefined
  for (const [index, step] of flow.steps.entries()) {
    if (step.disabled) {
      steps.push({ ...withIntent(step, runner.redact), status: 'skipped' })
      settled(index, step, 'skipped')
      continue
    }
    if (failed === undefined && stopped === undefined && signal?.aborted) stopped = stopReason(signal)
    if (failed !== undefined || stopped !== undefined) {
      steps.push({ ...withIntent(step, runner.redact), status: 'not_run' })
      settled(index, step, 'not_run')
      continue
    }
    const before = shots === 'all' ? (lastAfter ?? (await runner.capturePage())) : undefined
    evidence.beginStep(index)
    const run = await runner.run(step)
    await evidence.endStep()
    // After endStep: the URL read gave a navigation the step started time to land.
    const after = shots === 'all' || (shots === 'failed' && run.status === 'failed') ? await runner.capturePage() : undefined
    lastAfter = after
    if (before !== undefined || after !== undefined) {
      run.shots = { ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }
    }
    steps.push(run)
    if (run.status === 'failed') failed = step.id
    settled(index, step, run.status === 'failed' ? 'failed' : 'passed')
  }
  await evidence.settle()

  return {
    status: failed === undefined && stopped === undefined ? 'passed' : 'failed',
    startedAt,
    durationMs: now() - startedAt,
    ...(stopped !== undefined ? { error: stopped } : {}),
    ...(failed !== undefined ? { failedStepId: failed } : {}),
    steps
  }
}

class StepRunner {
  constructor(
    private readonly session: Session,
    private readonly interp: FlowInterpolator,
    private readonly now: () => number,
    private readonly defaultTimeoutMs: number
  ) {}

  /** Scrubs the run's secret values out of text (for step intents). */
  readonly redact = (text: string): string => this.interp.redact(text)

  private dialogs: Array<{ type: string; message: string }> = []
  /** Locators of fields this run typed a secret into; screenshots mask them. */
  private readonly secretTargets: Selector[][] = []
  private readonly secretTargetKeys = new Set<string>()
  /** Set once a page screenshot timed out: the page cannot be captured, so later steps don't wait on it again. */
  private shotsGaveUp = false

  noteDialog(dialog: { type: string; message: string }): void {
    this.dialogs.push(dialog)
  }

  async run(step: FlowStep): Promise<StepRun> {
    const startedAt = this.now()
    const record: StepRun = { id: step.id, action: step.action, status: 'passed', startedAt }
    if (step.intent !== undefined) record.intent = this.interp.redact(step.intent)
    this.dialogs = []
    // `wait` with a target and `ms`: ms is how long to wait for it.
    const waitMs = step.action === 'wait' && step.target && step.ms !== undefined ? step.ms : undefined
    const timeoutMs = step.timeout_ms ?? waitMs ?? this.defaultTimeoutMs
    const deadline = startedAt + timeoutMs
    const selectors = 'target' in step && step.target ? step.target.selectors : []
    let answer: PageAnswer | null = null
    try {
      this.session.limit(deadline, timeoutMs)
      answer = await this.execute(step, deadline, timeoutMs)
    } catch (error) {
      record.status = 'failed'
      const message = error instanceof Error ? error.message : String(error)
      record.error = this.interp.redact(message)
      if (error instanceof StepFailure) answer = error.answer
    } finally {
      this.session.clearLimit()
    }
    if (answer && selectors.length > 0) {
      if (answer.found && answer.index >= 0) {
        const selector = selectors[answer.index]
        record.matched = { index: answer.index, selector, layer: locatorLayer(selector), fallback: isFallback(answer) }
      }
      const misses = missesOf(answer, selectors)
      if (misses.length > 0) record.misses = misses
    }
    if (this.dialogs.length > 0) record.dialogs = this.dialogs
    if (step.action === 'screenshot' && answer && 'png' in answer) {
      record.screenshotPng = (answer as PageAnswer & { png: string }).png
    }
    record.durationMs = this.now() - startedAt
    return record
  }

  /** Wait for a page answer that `ready` accepts; on timeout, fail with the last answer. */
  private async waitFor(
    deadline: number,
    timeoutMs: number,
    selectors: Selector[],
    ask: () => Promise<PageAnswer | null>,
    ready: (a: PageAnswer) => boolean = (a) => a.found && a.blocked === undefined
  ): Promise<PageAnswer> {
    let last: PageAnswer | null = null
    const ok = await until(deadline, this.now, async () => {
      last = await ask()
      if (last && last.found && last.permanent) {
        throw new StepFailure(`${describeSelector(selectors[last.index])} matched but ${last.blocked}`, last)
      }
      return last && ready(last) ? last : undefined
    })
    if (ok) return ok
    throw new StepFailure(notFoundMessage(last, selectors, timeoutMs), last)
  }

  private async execute(step: FlowStep, deadline: number, timeoutMs: number): Promise<PageAnswer | null> {
    const s = this.session
    switch (step.action) {
      case 'click':
      case 'hover': {
        const sel = step.target.selectors
        const at = await this.waitFor(deadline, timeoutMs, sel, () => s.call('point', sel, step.action === 'click'))
        await this.mouse('mouseMoved', at.x!, at.y!)
        if (step.action === 'click') {
          await this.mouse('mousePressed', at.x!, at.y!, 1)
          await this.mouse('mouseReleased', at.x!, at.y!, 1)
        }
        return at
      }
      case 'fill': {
        const sel = step.target.selectors
        const value = this.interp.interpolate(step.value)
        // redact() changes text only when it holds a secret, also one reached through a var.
        const secret = value !== '' && this.interp.redact(value) !== value
        if (secret && !this.secretTargetKeys.has(JSON.stringify(sel))) {
          this.secretTargetKeys.add(JSON.stringify(sel))
          this.secretTargets.push(sel)
        }
        const at = await this.waitFor(deadline, timeoutMs, sel, () => s.call('focusForFill', sel, secret))
        if (at.setValue) {
          // date/time-like inputs ignore typed text: set the value and check it took.
          const set = await s.call('setValue', sel, value)
          if (!set || set.blocked) {
            throw new StepFailure(
              `${describeSelector(sel[at.index])} matched but ${set?.blocked ?? 'the page changed before the value was set'}`,
              set ?? at
            )
          }
        } else if (value === '') await this.key(parseKey('Backspace'))
        else await s.send('Input.insertText', { text: value })
        return at
      }
      case 'select': {
        const sel = step.target.selectors
        const value = this.interp.interpolate(step.value)
        return this.waitFor(deadline, timeoutMs, sel, () => s.call('selectOption', sel, value))
      }
      case 'press': {
        let key: KeyPress
        try {
          key = parseKey(this.interp.interpolate(step.key))
        } catch (error) {
          if (error instanceof UnknownKeyError) throw new StepFailure(error.message)
          throw error
        }
        let at: PageAnswer | null = null
        if (step.target) {
          const sel = step.target.selectors
          at = await this.waitFor(deadline, timeoutMs, sel, () => s.call('focus', sel))
        }
        await this.key(key)
        return at
      }
      case 'scroll': {
        const [dx, dy] = step.delta ?? [0, 0]
        if (!step.target) {
          // null = the helpers are not in this document yet (a navigation is landing): ask again.
          const done = await until(deadline, this.now, async () => (await s.call('scroll', null, dx, dy)) ?? undefined)
          if (!done) throw new StepFailure(notFoundMessage(null, [], timeoutMs))
          return null
        }
        const sel = step.target.selectors
        return this.waitFor(deadline, timeoutMs, sel, () => s.call('scroll', sel, dx, dy))
      }
      case 'navigate':
        await this.navigate(this.interp.interpolate(step.url), timeoutMs, true)
        return null
      case 'wait': {
        // With a target, wait for it to be visible (ms is ignored); without one, sleep ms.
        if (step.ms !== undefined && !step.target) {
          await sleep(step.ms)
          return null
        }
        const sel = step.target!.selectors
        return this.waitFor(deadline, timeoutMs, sel, async () => {
          const a = await s.call('state', sel)
          if (a?.found && !a.visible) a.blocked = 'it is not visible'
          return a
        })
      }
      case 'assert':
        return this.assert(step, deadline, timeoutMs)
      case 'screenshot': {
        let clip: Record<string, unknown> | undefined
        let at: PageAnswer | null = null
        if (step.target) {
          const sel = step.target.selectors
          at = await this.waitFor(deadline, timeoutMs, sel, () => s.call('box', sel))
          const b = at.box!
          if (b.width <= 0 || b.height <= 0) throw new StepFailure('the element has no area to capture', at)
          clip = { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 }
        }
        const shot = await this.masked(() =>
          s.send<{ data: string }>('Page.captureScreenshot', {
            format: 'png',
            ...(clip ? { clip, captureBeyondViewport: true } : {})
          })
        )
        return { ...(at ?? { found: true, index: -1, tried: [] }), png: shot.data } as PageAnswer
      }
    }
  }

  /**
   * Runs `capture` with every field that received a secret drawn as discs,
   * then restores them. Fails closed: when the page could not be masked (no
   * helpers, mid-navigation) nothing is captured, since the old frame may
   * still show the secret.
   */
  private async masked<T>(capture: () => Promise<T>): Promise<T> {
    if (this.secretTargets.length === 0) return capture()
    const mask = await this.session.call('mask', this.secretTargets)
    if (typeof mask?.generation !== 'number') {
      throw new StepFailure('the fields that received a secret could not be masked, so no screenshot was taken')
    }
    try {
      return await capture()
    } finally {
      await this.session.call('unmask', mask.generation).catch(() => undefined)
    }
  }

  /**
   * The viewport as a base64 JPEG for the run record, secrets masked; undefined
   * when it cannot be masked or captured within SHOT_TIMEOUT_MS (after a
   * timeout, for the rest of the run). Never throws: a missing screenshot must
   * not change the run's result.
   */
  async capturePage(): Promise<string | undefined> {
    if (this.shotsGaveUp) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const shot = this.masked(() =>
      this.session.send<{ data?: unknown }>('Page.captureScreenshot', { format: 'jpeg', quality: SHOT_QUALITY })
    )
      .then((r) => (typeof r?.data === 'string' && r.data !== '' ? r.data : undefined))
      .catch(() => undefined)
    const timeout = new Promise<'timeout'>((done) => (timer = setTimeout(() => done('timeout'), SHOT_TIMEOUT_MS)))
    const result = await Promise.race([shot, timeout]).finally(() => clearTimeout(timer))
    if (result === 'timeout') {
      this.shotsGaveUp = true
      return undefined
    }
    return result
  }

  private async assert(
    step: Extract<FlowStep, { action: 'assert' }>,
    deadline: number,
    timeoutMs: number
  ): Promise<PageAnswer | null> {
    const s = this.session
    const expect = step.expect
    const wantUrl = expect.url !== undefined ? this.interp.interpolate(expect.url) : undefined
    const wantText = expect.text !== undefined ? normalize(this.interp.interpolate(expect.text)) : undefined
    // Scrub secrets from raw values *before* quoting, normalising or cutting
    // them: redact() matches exact text, and JSON escaping or a slice would
    // hide a secret from it.
    const shown = (value: string | null, max = 200): string => {
      if (value === null) return 'null'
      const scrubbed = normalize(this.interp.redact(value))
      return JSON.stringify(scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed)
    }
    const sel = step.target?.selectors ?? []

    let problems: string[] = []
    let last: PageAnswer | null = null
    const passed = await until(deadline, this.now, async () => {
      problems = []
      if (wantUrl !== undefined) {
        let url: string | null = null
        try {
          url = await s.evaluate<string>('location.href')
        } catch (error) {
          if (!TRANSIENT.test(String((error as Error).message))) throw error
        }
        if (url !== wantUrl) problems.push(`expected URL ${shown(wantUrl, 500)}, got ${shown(url, 500)}`)
      }
      if (step.target) {
        last = await s.call('state', sel)
        if (!last) {
          problems.push('the page was not ready')
        } else if (!last.found) {
          // An element that is not there is "not visible"; everything else needs it.
          if (expect.visible !== false || expect.enabled !== undefined || wantText !== undefined) {
            problems.push(notFoundMessage(last, sel, timeoutMs))
          }
        } else {
          if (expect.visible !== undefined && last.visible !== expect.visible) {
            problems.push(`expected the element to be ${expect.visible ? 'visible' : 'hidden'}, it is ${last.visible ? 'visible' : 'hidden'}`)
          }
          if (expect.enabled !== undefined && last.enabled !== expect.enabled) {
            problems.push(`expected the element to be ${expect.enabled ? 'enabled' : 'disabled'}, it is ${last.enabled ? 'enabled' : 'disabled'}`)
          }
          if (wantText !== undefined && !normalize(last.text ?? '').includes(wantText)) {
            problems.push(`expected text containing ${shown(wantText)}, got ${shown(last.text ?? '')}`)
          }
        }
      }
      return problems.length === 0 ? true : undefined
    })
    if (!passed) throw new StepFailure(`assertion failed after ${timeoutMs} ms: ${problems.join('; ')}`, last)
    return last
  }

  async navigate(url: string, timeoutMs: number, inStep = false): Promise<void> {
    const s = this.session
    const result = await s.send<{ errorText?: string }>('Page.navigate', { url })
    if (result.errorText) throw new StepFailure(`navigation to ${url} failed: ${result.errorText}`)
    const deadline = this.now() + timeoutMs
    // The load wait starts once the navigation committed; in a step, so does its command limit.
    if (inStep) this.session.limit(deadline, timeoutMs)
    const loaded = await until(deadline, this.now, async () => {
      try {
        const state = await s.evaluate<string>('document.readyState')
        return state === 'complete' ? true : undefined
      } catch (error) {
        if (TRANSIENT.test(String((error as Error).message))) return undefined
        throw error
      }
    })
    if (!loaded) throw new StepFailure(`${url} did not finish loading within ${timeoutMs} ms`)
  }

  private mouse(type: string, x: number, y: number, clickCount = 0): Promise<unknown> {
    return this.session.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount
    })
  }

  private async key(k: KeyPress): Promise<void> {
    const s = this.session
    let held = 0
    for (const mod of k.hold) {
      held |= MODIFIER_BITS[mod]
      const m = parseKey(mod)
      await s.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: m.key,
        code: m.code,
        windowsVirtualKeyCode: m.windowsVirtualKeyCode,
        modifiers: held
      })
    }
    await s.send('Input.dispatchKeyEvent', {
      type: k.text !== undefined ? 'keyDown' : 'rawKeyDown',
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.windowsVirtualKeyCode,
      modifiers: k.modifiers,
      ...(k.text !== undefined ? { text: k.text, unmodifiedText: k.text } : {})
    })
    await s.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.windowsVirtualKeyCode,
      modifiers: k.modifiers
    })
    for (const mod of [...k.hold].reverse()) {
      held &= ~MODIFIER_BITS[mod]
      const m = parseKey(mod)
      await s.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: m.key,
        code: m.code,
        windowsVirtualKeyCode: m.windowsVirtualKeyCode,
        modifiers: held
      })
    }
  }
}
