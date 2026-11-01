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
import type { Flow, FlowStep, Selector } from '@shared/flow/schema'
import { MODIFIER_BITS, parseKey, UnknownKeyError, type KeyPress } from './keys'

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

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'not_run'

export interface LocatorMiss {
  index: number
  selector: Selector
  /** Elements it matched: 0 = gone, 2+ = ambiguous. */
  found: number
  /** Set when the selector itself is broken (bad CSS). */
  invalid?: string
}

export interface StepRun {
  id: string
  action: FlowStep['action']
  status: StepStatus
  /** Epoch ms. Absent for steps that never started. */
  startedAt?: number
  durationMs?: number
  /** The locator that resolved the target, by its position in `target.selectors`. */
  matched?: { index: number; selector: Selector }
  /** Locators tried before the match (or all of them, when nothing matched). */
  misses?: LocatorMiss[]
  error?: string
  /** `screenshot` steps: the PNG, base64. */
  screenshotPng?: string
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
  return selector.name === undefined ? `role=${selector.role}` : `role=${selector.role}[name="${selector.name}"]`
}

export function replaySources(): string {
  return `${buildProbeSource()}\n${replaySource}`
}

class Session {
  constructor(
    private readonly client: ReplayClient,
    private readonly sessionId: string | undefined
  ) {}

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.client.send<T>(method, params, this.sessionId)
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
    flow.steps.map((s) => ({ id: s.id, action: s.action, status: s.disabled ? 'skipped' : 'not_run' }))
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

  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const session = new Session(client, options.sessionId)
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

  let uninstall: (() => Promise<void>) | undefined
  try {
    try {
      await session.send('Page.enable')
      uninstall = await installReplayHelpers(client, options.sessionId)
      if (openTarget) {
        await runner.navigate(
          interp.interpolate(flow.target.url),
          options.navigationTimeoutMs ?? Math.max(30_000, defaultTimeoutMs)
        )
      }
    } catch (error) {
      return abort(interp.redact(`could not open the flow's target: ${(error as Error).message ?? error}`))
    }
    return await runSteps(flow, runner, startedAt, now)
  } finally {
    offDialog?.()
    await uninstall?.().catch(() => undefined)
  }
}

async function runSteps(flow: Flow, runner: StepRunner, startedAt: number, now: () => number): Promise<FlowRun> {
  const steps: StepRun[] = []
  let failed: string | undefined
  for (const step of flow.steps) {
    if (step.disabled) {
      steps.push({ id: step.id, action: step.action, status: 'skipped' })
      continue
    }
    if (failed !== undefined) {
      steps.push({ id: step.id, action: step.action, status: 'not_run' })
      continue
    }
    const run = await runner.run(step)
    steps.push(run)
    if (run.status === 'failed') failed = step.id
  }

  return {
    status: failed === undefined ? 'passed' : 'failed',
    startedAt,
    durationMs: now() - startedAt,
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

  private dialogs: Array<{ type: string; message: string }> = []

  noteDialog(dialog: { type: string; message: string }): void {
    this.dialogs.push(dialog)
  }

  async run(step: FlowStep): Promise<StepRun> {
    const startedAt = this.now()
    const record: StepRun = { id: step.id, action: step.action, status: 'passed', startedAt }
    this.dialogs = []
    // `wait` with a target and `ms`: ms is how long to wait for it.
    const waitMs = step.action === 'wait' && step.target && step.ms !== undefined ? step.ms : undefined
    const timeoutMs = step.timeout_ms ?? waitMs ?? this.defaultTimeoutMs
    const deadline = startedAt + timeoutMs
    const selectors = 'target' in step && step.target ? step.target.selectors : []
    let answer: PageAnswer | null = null
    try {
      answer = await this.execute(step, deadline, timeoutMs)
    } catch (error) {
      record.status = 'failed'
      const message = error instanceof Error ? error.message : String(error)
      record.error = this.interp.redact(message)
      if (error instanceof StepFailure) answer = error.answer
    }
    if (answer && selectors.length > 0) {
      if (answer.found && answer.index >= 0) record.matched = { index: answer.index, selector: selectors[answer.index] }
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
        const at = await this.waitFor(deadline, timeoutMs, sel, () => s.call('focusForFill', sel))
        const value = this.interp.interpolate(step.value)
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
        await this.navigate(this.interp.interpolate(step.url), timeoutMs)
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
        const shot = await s.send<{ data: string }>('Page.captureScreenshot', {
          format: 'png',
          ...(clip ? { clip, captureBeyondViewport: true } : {})
        })
        return { ...(at ?? { found: true, index: -1, tried: [] }), png: shot.data } as PageAnswer
      }
    }
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

  async navigate(url: string, timeoutMs: number): Promise<void> {
    const s = this.session
    const result = await s.send<{ errorText?: string }>('Page.navigate', { url })
    if (result.errorText) throw new StepFailure(`navigation to ${url} failed: ${result.errorText}`)
    const deadline = this.now() + timeoutMs
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
