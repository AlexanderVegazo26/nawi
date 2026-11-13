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
import { EvidenceCollector, type AppCrash, type StepEvidence } from './evidence'
import { decodePng, type RgbImage } from '../mobile/png'
import { anchorCandidates } from './anchor-candidates'
import { pickSuggestion, stepQuery, type Suggestion } from './suggest'
import { anchorMissText, findAnchor, scaleImage, type AnchorResult } from './visual-anchor'

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

/**
 * The visual-anchor layer (roadmap AI1) in run records: the step's reference
 * crop (`target.image`), tried after every locator in `target.selectors`, at
 * index `selectors.length`.
 */
export interface AnchorLocator {
  image: string
}

/** Layers a run record reports: the flow's locator kinds plus the visual anchor. */
export type MatchedLayer = LocatorLayer | 'visual'

export interface LocatorMiss {
  index: number
  selector: Selector | AnchorLocator
  /** Elements it matched: 0 = gone, 2+ = ambiguous (visual: places the crop matched). */
  found: number
  /** Set when the selector itself is broken (bad CSS, an unreadable crop). */
  invalid?: string
  /** Visual anchor: how close the best place came (1 = identical). */
  score?: number
  /** Visual anchor: where the crop was found (CSS px) when no element was there. */
  at?: [number, number]
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
  matched?: {
    index: number
    selector: Selector | AnchorLocator
    layer: MatchedLayer
    fallback: boolean
    score?: number
    /**
     * Visual matches only (roadmap F6c): locators of the element the crop
     * found, best first, each of which matched exactly that element when it
     * was found (anchorCandidates). A heal proposal puts them in front.
     */
    candidates?: Selector[]
  }
  /**
   * Failed steps nothing found (roadmap F6c-2): the visible control whose
   * accessible name best matches the step's intent or its locators' names,
   * from the page's accessibility snapshot when the step failed, with that
   * control's own locators (each unique on the page then, best first). Unverified:
   * a guess from names, which only a replay of the healed flow can confirm.
   */
  suggested?: {
    role: string
    name: string
    score: number
    basis: Suggestion['basis']
    candidates: Selector[]
  }
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
  /** Android runs (roadmap M5d-1): the app crashed or stopped responding in this step, which failed it. */
  crash?: AppCrash
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
   * Reads an asset the flow points at (`target.image`, relative to the flow
   * file), confined to the flow's folder. Without it the visual-anchor layer
   * reports the crop as unreadable instead of reading any path.
   */
  loadAsset?: (path: string) => Promise<Uint8Array>
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
  /** Set on the main side by waitFor: the locator list this answer came from. */
  locators?: PageLocator[]
}

/** What the page helpers resolve: the flow's locators, plus the internal visual-anchor point. */
type PageLocator = Selector | { __anchor: [number, number]; pin: number }

/** How often a step whose locators all miss looks for its reference crop again (a screenshot + match each time). */
export const VISUAL_EVERY_MS = 250
/** A viewport capture for the anchor layer that takes longer than this turns the layer off for the run. */
export const ANCHOR_SHOT_TIMEOUT_MS = 1_500
/**
 * How long a failed step may spend reading the page's accessibility snapshot
 * for a suggestion (roadmap F6c-2), on top of its own timeout: a page that
 * does not answer by then gets no suggestion, never a longer run.
 */
export const SUGGEST_TIMEOUT_MS = 1_500
/** The suggested control's name as the run record keeps it (scrubbed first, then cut). */
const MAX_SUGGESTED_NAME_CHARS = 200
/**
 * Pins each anchor lookup to the element it first resolved to (replay.js
 * anchorMatches). Process-wide, so runs replayed one after another on one
 * long-lived page never reuse a token the page still remembers.
 */
let anchorPins = 0
/** Largest reference crop read from disk. */
export const MAX_ANCHOR_BYTES = 8 * 1024 * 1024

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
  if ('desc' in selector) return `desc=${JSON.stringify(selector.desc)}`
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

/** The step's latest look for its reference crop (visual-anchor layer). */
interface AnchorTry {
  image: string
  result: AnchorResult
  /** The crop was found, but the page had no element at its centre. */
  noElement?: boolean
  /** The anchor pin `candidates` describes, and that element's locators (anchorCandidates). */
  candidatesPin?: number
  candidates?: Selector[]
}

/** The locator at `index` in a step's layers: a flow locator, or the visual anchor just past them. */
function locatorAt(selectors: Selector[], index: number, image: string | undefined): Selector | AnchorLocator {
  return index === selectors.length && image !== undefined ? { image } : selectors[index]
}

function describeLocator(locator: Selector | AnchorLocator): string {
  return 'image' in locator ? `image=${locator.image}` : describeSelector(locator)
}

function missesOf(answer: PageAnswer | null, selectors: Selector[], visual?: AnchorTry): LocatorMiss[] {
  const misses: LocatorMiss[] = (answer?.tried ?? []).map((t) => ({
    index: t.index,
    selector: selectors[t.index],
    found: t.found,
    ...(t.invalid !== undefined ? { invalid: t.invalid } : {})
  }))
  // The anchor is a miss unless the answer came through it (then it is `matched`, even when blocked).
  if (visual && !(answer?.found && answer.index === selectors.length)) {
    const r = visual.result
    if (r.found !== 1 || visual.noElement) {
      misses.push({
        index: selectors.length,
        selector: { image: visual.image },
        found: r.found === 1 ? 0 : r.found,
        ...('invalid' in r ? { invalid: r.invalid } : {}),
        ...(r.found === 1 ? { at: [r.x, r.y] as [number, number] } : {}),
        ...('score' in r && r.score !== undefined ? { score: r.score } : {})
      })
    }
  }
  return misses
}

function missText(m: LocatorMiss): string {
  const what = describeLocator(m.selector)
  if (m.invalid !== undefined) return `${what}: invalid (${m.invalid})`
  if ('image' in m.selector) return `${what}: ${anchorMissText(m)}`
  return `${what}: ${m.found === 0 ? 'no element' : `${m.found} elements (ambiguous)`}`
}

function notFoundMessage(answer: PageAnswer | null, selectors: Selector[], timeoutMs: number, visual?: AnchorTry): string {
  if (!answer) return `the page never became ready for the step within ${timeoutMs} ms`
  if (!answer.found) {
    const parts = missesOf(answer, selectors, visual).map(missText)
    return `no locator matched exactly one element within ${timeoutMs} ms — ${parts.join('; ')}`
  }
  return `${describeLocator(locatorAt(selectors, answer.index, visual?.image))} matched but ${answer.blocked ?? 'it never became ready'} (waited ${timeoutMs} ms)`
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

  if (flow.target.kind === 'desktop') {
    return abort('desktop targets need computer-use replay, which this build does not have yet (roadmap F7)')
  }
  if (flow.target.kind === 'android') {
    return abort('android flows are replayed on a device by the Android replayer (src/main/mobile/flow-replay.ts), not in a browser')
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
  const runner = new StepRunner(session, interp, now, defaultTimeoutMs, options.loadAsset)

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
    private readonly defaultTimeoutMs: number,
    private readonly loadAsset?: (path: string) => Promise<Uint8Array>
  ) {}

  /** Reference crops read this run, by path (a flow often reuses one; a bad one is reported once per step, read once). */
  private readonly crops = new Map<string, Promise<RgbImage | { invalid: string }>>()
  /** The current step's latest look for its reference crop, for its record and failure text. */
  private visual: AnchorTry | undefined
  /** Set once the viewport could not be captured for the anchor layer in time: later steps don't wait on it again. */
  private anchorsGaveUp = false
  /** The current step already asked the page for an anchored element's candidates (it may reuse that answer). */
  private describedThisStep = false

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
    this.visual = undefined
    this.describedThisStep = false
    // `wait` with a target and `ms`: ms is how long to wait for it.
    const waitMs = step.action === 'wait' && step.target && step.ms !== undefined ? step.ms : undefined
    const timeoutMs = step.timeout_ms ?? waitMs ?? this.defaultTimeoutMs
    const deadline = startedAt + timeoutMs
    const selectors = 'target' in step && step.target ? step.target.selectors : []
    const image = 'target' in step && step.target ? step.target.image : undefined
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
    // Set by anchoredPoll (waitFor, assert) while the step ran (TS can't see that through the awaits).
    const visual = this.visual as AnchorTry | undefined
    if (answer && selectors.length > 0) {
      if (answer.found && answer.index >= 0 && answer.index < selectors.length) {
        const selector = selectors[answer.index]
        record.matched = { index: answer.index, selector, layer: locatorLayer(selector), fallback: isFallback(answer) }
      } else if (answer.found && answer.index === selectors.length && image !== undefined && visual?.result.found === 1) {
        record.matched = { index: answer.index, selector: { image }, layer: 'visual', fallback: isFallback(answer), score: visual.result.score }
        if (visual.candidates && visual.candidates.length > 0) record.matched.candidates = visual.candidates
      }
      // A crop looked for while the page was still loading is not a miss once a locator matched after all.
      const misses = missesOf(answer, selectors, answer.found && answer.index < selectors.length ? undefined : visual)
      if (misses.length > 0) record.misses = misses
    }
    if (this.dialogs.length > 0) record.dialogs = this.dialogs
    if (step.action === 'screenshot' && answer && 'png' in answer) {
      record.screenshotPng = (answer as PageAnswer & { png: string }).png
    }
    // The step's own time: looking for a suggestion afterwards is not part of it.
    record.durationMs = this.now() - startedAt
    if (record.status === 'failed' && !record.matched && (record.misses?.length ?? 0) > 0) {
      const suggested = await this.suggest(step, selectors)
      if (suggested) record.suggested = suggested
    }
    return record
  }

  /**
   * A suggestion for a step nothing found (roadmap F6c-2): the page's
   * accessibility snapshot, the control whose name best matches the step
   * (suggest.ts), and that control's own locators, each unique on the page
   * now (anchorCandidates: the rules a crop-only match is healed with). Null
   * when no control is close enough, the control has no usable locator, or
   * the page does not answer within SUGGEST_TIMEOUT_MS. Never throws: a
   * suggestion is extra, the step's failure is the result. Once the time is
   * up nothing more is sent to the page (a snapshot already running there
   * finishes on its own; its answer is ignored), so the next step is not
   * competing with a describe call.
   */
  private async suggest(step: FlowStep, selectors: Selector[]): Promise<StepRun['suggested'] | null> {
    const query = stepQuery(step, selectors)
    if (query.intent.size === 0 && query.locators.size === 0) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    let late = false
    const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => ((late = true), resolve(null)), SUGGEST_TIMEOUT_MS)))
    const look = (async (): Promise<StepRun['suggested'] | null> => {
      const snapshot = await this.session.call('snapshot')
      const picked = late ? null : pickSuggestion(snapshot, step.action, query)
      if (!picked) return null
      const described = await this.session.call('describeSnapshot', picked.entry.i)
      const candidates = late ? [] : anchorCandidates(described, this.redact)
      if (candidates.length === 0) return null
      // Scrubbed whole, then cut: a cut first could hide a secret's tail from the scrubber.
      const name = this.redact(picked.entry.name).slice(0, MAX_SUGGESTED_NAME_CHARS)
      return { role: picked.entry.role, name, score: picked.score, basis: picked.basis, candidates }
    })().catch(() => null)
    try {
      return await Promise.race([look, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Poll the step's target (anchoredPoll: its locators, then its reference
   * crop) until `ready` accepts the answer; fail at the deadline with the last
   * answer, or at once when the element can never take the action. The answer
   * carries the locator list it came from (`locators`), for follow-up calls on
   * the same element.
   */
  private async waitFor(
    deadline: number,
    timeoutMs: number,
    selectors: Selector[],
    ask: (locators: PageLocator[]) => Promise<PageAnswer | null>,
    ready: (a: PageAnswer) => boolean = (a) => a.found && a.blocked === undefined,
    image?: string
  ): Promise<PageAnswer> {
    let last: PageAnswer | null = null
    const poll = this.anchoredPoll(selectors, ask, image)
    const ok = await until(deadline, this.now, async () => {
      const a = await poll()
      last = a
      if (!a) return undefined
      // Ready, or (thrown) never going to be.
      if (a.found && a.permanent) {
        throw new StepFailure(`${describeLocator(locatorAt(selectors, a.index, image))} matched but ${a.blocked}`, a)
      }
      return ready(a) ? a : undefined
    })
    if (ok) return ok
    throw new StepFailure(notFoundMessage(last, selectors, timeoutMs, this.visual), last)
  }

  /**
   * One step's page lookups with the visual-anchor layer (roadmap AI1), for
   * steps that poll (waitFor, assert). Each call asks about the step's own
   * locators; when none of them finds exactly one element and the step has a
   * reference crop, it looks for the crop on screen (at most every
   * VISUAL_EVERY_MS) and, when found, asks again through the point it was
   * found at. Between looks it keeps asking about the element that point
   * resolved to (pinned), so a match that is covered or disabled keeps
   * reporting that. The answer carries the locator list it came from
   * (`locators`); null = the page helpers are not installed yet. A call with
   * `look` false asks only the locators and the pinned point: no screenshot
   * (an assert whose URL doesn't match yet can't pass whatever the crop shows).
   */
  private anchoredPoll(
    selectors: Selector[],
    ask: (locators: PageLocator[]) => Promise<PageAnswer | null>,
    image: string | undefined
  ): (look?: boolean) => Promise<PageAnswer | null> {
    let nextLook = -Infinity
    let anchored: PageLocator[] | undefined
    return async (look = true) => {
      const own = await ask(selectors)
      if (own) own.locators = selectors
      if (!own || own.found || image === undefined || this.anchorsGaveUp) return own
      // Every locator missed: look at the screen again when due (wall clock: the run's clock may be a test's fake).
      if (look && performance.now() >= nextLook) {
        nextLook = performance.now() + VISUAL_EVERY_MS
        const result = await this.findOnScreen(image)
        this.visual = { image, result }
        anchored = result.found === 1 ? [...selectors, { __anchor: [result.x, result.y], pin: ++anchorPins }] : undefined
      }
      if (!anchored) return own
      const viaAnchor = await ask(anchored)
      // Only the anchor's own answer counts: a locator that appeared meanwhile is picked up by the next poll.
      if (!viaAnchor || !viaAnchor.found || viaAnchor.index !== selectors.length) {
        if (this.visual?.result.found === 1) this.visual.noElement = true
        return own
      }
      if (this.visual) {
        this.visual.noElement = false
        const pin = (anchored[selectors.length] as { pin: number }).pin
        if (this.visual.candidatesPin !== pin) {
          // Described per pin, before the step acts on the element (a click may navigate away); the page side
          // reuses its answer while a new pin resolves to the same element. No answer (the document is being
          // replaced, a timeout) is asked again on the next poll instead of being recorded as "no locators".
          const raw = await this.session.call('candidates', pin, this.describedThisStep).catch(() => null)
          this.describedThisStep = true
          if (Array.isArray(raw)) {
            this.visual.candidatesPin = pin
            this.visual.candidates = anchorCandidates(raw, this.redact)
          }
        }
      }
      viaAnchor.locators = anchored
      return viaAnchor
    }
  }

  /** The crop at `path`, decoded once per run; `invalid` says why it can't be used. */
  private crop(path: string): Promise<RgbImage | { invalid: string }> {
    let pending = this.crops.get(path)
    if (!pending) {
      pending = (async () => {
        if (!this.loadAsset) return { invalid: 'this run cannot read files next to the flow' }
        let bytes: Uint8Array
        try {
          bytes = await this.loadAsset(path)
        } catch (error) {
          return { invalid: `could not read it: ${(error as Error).message ?? error}` }
        }
        if (bytes.length > MAX_ANCHOR_BYTES) return { invalid: `it is larger than ${MAX_ANCHOR_BYTES} bytes` }
        const png = decodePng(bytes)
        return png.ok ? png.image : { invalid: `not a usable PNG (${png.error})` }
      })()
      this.crops.set(path, pending)
    }
    return pending
  }

  /**
   * Look for the crop in the viewport, in CSS px: a lossless screenshot,
   * scaled down by the device pixel ratio to the layout viewport's size.
   * A page that can't be captured right now (mid-navigation) is "no match":
   * the step keeps polling its locators. One that takes longer than
   * ANCHOR_SHOT_TIMEOUT_MS (a minimised window) turns the layer off for the
   * rest of the run, so it never holds up locator polling again.
   */
  private async findOnScreen(path: string): Promise<AnchorResult> {
    const crop = await this.crop(path)
    if ('invalid' in crop) return { found: 0, invalid: crop.invalid }
    const look = (async (): Promise<{ size: unknown; data: unknown } | undefined> => {
      try {
        const size = await this.session.evaluate<unknown>('[window.innerWidth, window.innerHeight]')
        const shot = await this.session.send<{ data?: unknown }>('Page.captureScreenshot', { format: 'png' })
        return { size, data: shot?.data }
      } catch {
        return undefined
      }
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((done) => (timer = setTimeout(() => done('timeout'), ANCHOR_SHOT_TIMEOUT_MS)))
    const got = await Promise.race([look, timeout]).finally(() => clearTimeout(timer))
    if (got === 'timeout') {
      this.anchorsGaveUp = true
      return { found: 0, invalid: `the page could not be captured within ${ANCHOR_SHOT_TIMEOUT_MS} ms, so reference crops are not looked for in this run` }
    }
    if (!got || typeof got.data !== 'string' || !Array.isArray(got.size)) return { found: 0 }
    const png = decodePng(Buffer.from(got.data, 'base64'))
    if (!png.ok) return { found: 0 }
    const [width, height] = got.size as unknown[]
    const css =
      typeof width === 'number' && typeof height === 'number' && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    return findAnchor(css ? scaleImage(png.image, width, height) : png.image, crop)
  }

  private async execute(step: FlowStep, deadline: number, timeoutMs: number): Promise<PageAnswer | null> {
    const s = this.session
    switch (step.action) {
      case 'click':
      case 'hover': {
        const sel = step.target.selectors
        const at = await this.waitFor(deadline, timeoutMs, sel, (l) => s.call('point', l, step.action === 'click'), undefined, step.target.image)
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
        const at = await this.waitFor(deadline, timeoutMs, sel, (l) => s.call('focusForFill', l, secret), undefined, step.target.image)
        if (at.setValue) {
          // date/time-like inputs ignore typed text: set the value and check it took.
          const set = await s.call('setValue', at.locators ?? sel, value)
          if (!set || set.blocked) {
            throw new StepFailure(
              `${describeLocator(locatorAt(sel, at.index, step.target.image))} matched but ${set?.blocked ?? 'the page changed before the value was set'}`,
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
        return this.waitFor(deadline, timeoutMs, sel, (l) => s.call('selectOption', l, value), undefined, step.target.image)
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
          at = await this.waitFor(deadline, timeoutMs, sel, (l) => s.call('focus', l), undefined, step.target.image)
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
        return this.waitFor(deadline, timeoutMs, sel, (l) => s.call('scroll', l, dx, dy), undefined, step.target.image)
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
        return this.waitFor(
          deadline,
          timeoutMs,
          sel,
          async (l) => {
            const a = await s.call('state', l)
            if (a?.found && !a.visible) a.blocked = 'it is not visible'
            return a
          },
          undefined,
          step.target!.image
        )
      }
      case 'assert':
        return this.assert(step, deadline, timeoutMs)
      case 'screenshot': {
        let clip: Record<string, unknown> | undefined
        let at: PageAnswer | null = null
        if (step.target) {
          const sel = step.target.selectors
          at = await this.waitFor(deadline, timeoutMs, sel, (l) => s.call('box', l), undefined, step.target.image)
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
      case 'rotate':
        // parseFlow refuses it in browser flows; a flow built in code still fails the step rather than skipping it.
        throw new StepFailure('rotate (turning the device) is only for android flows')
      case 'background':
        throw new StepFailure('background (sending the app to the background and back) is only for android flows')
      case 'permission':
        throw new StepFailure("permission (answering Android's permission prompt) is only for android flows")
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
    // The element is looked up like any step's target, crop included: an assert whose locators drifted checks
    // the element its reference crop shows (and a `visible: false` holds only while the crop is not on screen).
    const lookup = this.anchoredPoll(sel, (l) => s.call('state', l), step.target?.image)

    let problems: string[] = []
    let last: PageAnswer | null = null
    const passed = await until(deadline, this.now, async () => {
      problems = []
      let urlMatches = true
      if (wantUrl !== undefined) {
        let url: string | null = null
        try {
          url = await s.evaluate<string>('location.href')
        } catch (error) {
          if (!TRANSIENT.test(String((error as Error).message))) throw error
        }
        if (url !== wantUrl) {
          urlMatches = false
          problems.push(`expected URL ${shown(wantUrl, 500)}, got ${shown(url, 500)}`)
        }
      }
      if (step.target) {
        // Still the wrong URL: the step can't pass yet, so don't screenshot the page for its crop on every poll.
        last = await lookup(urlMatches)
        if (!last) {
          problems.push('the page was not ready')
        } else if (!last.found) {
          // An element that is not there is "not visible"; everything else needs it.
          if (expect.visible !== false || expect.enabled !== undefined || wantText !== undefined) {
            problems.push(notFoundMessage(last, sel, timeoutMs, this.visual))
          } else {
            const shows = this.cropStillShows(step.target.image)
            if (shows) problems.push(`expected the element to be hidden, but ${shows}`)
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

  /**
   * Why a target no locator found may still be on screen (for `visible:
   * false`): its reference crop was last seen there (once, without an element
   * the point resolves to, or in several places), or the crop could not be
   * looked for at all (unreadable, or page captures gave up). Undefined when
   * the step has no crop or the last look did not find it.
   */
  private cropStillShows(image: string | undefined): string | undefined {
    if (image === undefined) return undefined
    const what = `its reference crop image=${image}`
    if (this.anchorsGaveUp) return `${what} could not be looked for (the page could not be captured in time earlier in this run)`
    const r = this.visual?.result
    if (!r) return `${what} was not looked for yet`
    if ('invalid' in r && r.invalid !== undefined) return `${what} could not be looked for (${r.invalid})`
    if (r.found === 1) return `${what} is still on screen at (${r.x}, ${r.y})`
    if (r.found > 1) return `${what} is still on screen in ${r.found}+ places`
    return undefined
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
