/**
 * Roadmap F4b: what the page did while each step ran.
 *
 * Listens on the replay's page session and files three things per step:
 * - **console errors**: `console.error`/`console.assert`, uncaught exceptions
 *   and browser log entries at error level, filed under the step that was
 *   running when they happened;
 * - **failed requests**: an HTTP status of 400 or more, or a request that
 *   never completed (DNS, refused, blocked...). Filed under the step that
 *   *sent* the request, so a fetch a click starts that fails a moment later
 *   still lands on the click. Cancelled requests are left out (navigations
 *   cancel requests all the time);
 * - **the page URL** once the step was over: `location.href` read from the
 *   page right after the step, or, when the page cannot answer (a navigation
 *   is landing), the main frame's URL as the browser last reported it.
 *
 * "When" is the browser's own timestamp on the event (`wallTime` for a
 * request, `timestamp` for console, exception and log events), compared with
 * the wall-clock time each step started. Network events reach us a few
 * milliseconds after the step that caused them has already returned, so filing
 * by arrival would put a click's fetch on the next step. An event without a
 * usable timestamp is filed under the step running when it arrives. Events
 * from before the first step (opening the flow's target) are kept under
 * index -1.
 *
 * Everything that leaves this module is scrubbed: secret values through the
 * flow's interpolator (`redact`), and token/session-like URL parameters and
 * `user:pass@` through `scrubStartUrl`. Each step keeps at most
 * `MAX_ENTRIES_PER_STEP` of each kind and counts the rest, so a page that logs
 * in a loop cannot grow the run record without bound.
 *
 * Nothing here throws into an event handler: CDP events are delivered on the
 * socket's read loop, and an exception there would take the client down.
 */

import { scrubStartUrl } from '@shared/flow/from-recording'
import type { ReplayClient } from './replay'

export const MAX_ENTRIES_PER_STEP = 20
const MAX_MESSAGE_CHARS = 1_000
const MAX_URL_CHARS = 2_000
/** Requests in flight we remember the step of; beyond this the oldest are forgotten. */
const MAX_PENDING_REQUESTS = 2_000
/** How long reading the page's URL after a step may take before the last reported one is used. */
const URL_READ_MS = 300
/** After the last step: how long to wait for requests it sent to finish, and how often to look. */
const SETTLE_MS = 500
const SETTLE_POLL_MS = 25

export interface ConsoleError {
  /** `console` = console.error/assert, `exception` = uncaught, `log` = a browser log entry. */
  source: 'console' | 'exception' | 'log'
  message: string
}

export interface FailedRequest {
  method: string
  url: string
  /** CDP resource type (Document, XHR, Fetch, Image...), when known. */
  resource_type?: string
  /** HTTP status, for a response of 400 or more. */
  status?: number
  /** Why it never completed (`net::ERR_NAME_NOT_RESOLVED`...), for a request without a response. */
  error?: string
}

/**
 * A warning or error the Android device logged during a step (roadmap M5b-2): from the flow's app (its uid), or naming
 * its package (the system's "ANR in <package>"). Secrets scrubbed, message cut at MAX_LOGCAT_MESSAGE.
 */
export interface DeviceLogLine {
  /** ISO time on the device's clock. */
  at: string
  /** W warning, E error, F fatal, A assert. */
  level: 'W' | 'E' | 'F' | 'A'
  tag: string
  message: string
}

/**
 * The flow's app crashed or stopped responding during an Android step (roadmap M5d-1); the step fails with it, and
 * what the device logged about it leads the step's `logcat`. Secrets scrubbed.
 */
export interface AppCrash {
  /** `crash` = an uncaught Java/Kotlin exception, `native_crash` = a fatal signal, `anr` = Application Not Responding. */
  kind: 'crash' | 'native_crash' | 'anr'
  /** ISO time on the device's clock. */
  at: string
  /** The app's process (`<package>` or `<package>:<name>`). */
  process: string
  pid?: number
  /** The exception, the signal, or the ANR's reason, in one line. */
  summary: string
}

export interface StepEvidence {
  /** Android runs: the device log of the step (see DeviceLogLine), in order. */
  logcat?: DeviceLogLine[]
  /** Log lines beyond the per-step cap. */
  logcatDropped?: number
  consoleErrors?: ConsoleError[]
  /** Console errors beyond the per-step cap. */
  consoleErrorsDropped?: number
  failedRequests?: FailedRequest[]
  failedRequestsDropped?: number
  /** Main-frame URL after the step, scrubbed. */
  url?: string
}

type Event = { method: string; params: Record<string, unknown>; sessionId?: string }

/**
 * Wall-clock epoch milliseconds with sub-millisecond precision, comparable
 * with the browser's event timestamps (which are wall clock too). Built from
 * the monotonic clock for precision, re-anchored to `Date.now()` whenever the
 * two disagree by more than 2 ms: a long-lived app sees suspends and NTP
 * steps, and the monotonic clock alone would drift away from the browser's.
 */
let anchor = Date.now() - performance.now()
export function wallClockMs(): number {
  const mono = performance.now()
  const offset = Date.now() - mono
  if (Math.abs(offset - anchor) > 2) anchor = offset
  return anchor + mono
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

/** Console arguments as one line, like DevTools prints them. */
function argsToMessage(args: unknown): string {
  if (!Array.isArray(args)) return ''
  return args
    .map((arg) => {
      const obj = arg as { value?: unknown; description?: string; type?: string } | null
      if (obj?.value !== undefined) return typeof obj.value === 'string' ? obj.value : JSON.stringify(obj.value)
      if (obj?.description !== undefined) return obj.description
      return obj?.type ?? ''
    })
    .join(' ')
}

export class EvidenceCollector {
  /** Index of the step running now; -1 before the first step (opening the target). */
  private current = -1
  /** When each step began, in order: the step running at time t is the last one that began at or before t. */
  private readonly starts: Array<{ index: number; at: number }> = []
  private readonly byStep = new Map<number, StepEvidence>()
  private readonly pending = new Map<string, { step: number; method: string; url: string; type?: string }>()
  private readonly offs: Array<() => void> = []
  private mainFrameId: string | undefined
  private pageUrl: string | undefined
  /** The current step's URL is already noted (endStep ran). */
  private urlTaken = false
  private stopped = false

  constructor(
    private readonly client: ReplayClient,
    private readonly sessionId: string | undefined,
    private readonly redact: (text: string) => string,
    private readonly clock: () => number = wallClockMs
  ) {}

  /**
   * Subscribes and enables the domains it needs. Best effort: a page that
   * refuses `Network.enable` still replays, just without failed requests.
   */
  async start(): Promise<void> {
    const on = this.client.on?.bind(this.client)
    if (!on) return
    const mine = (listener: (event: Event) => void) => (event: Event) => {
      if (this.stopped || event.sessionId !== this.sessionId) return
      try {
        listener(event)
      } catch {
        // Never into the read loop; a malformed event is dropped.
      }
    }
    this.offs.push(
      on('Runtime.consoleAPICalled', mine((e) => this.onConsole(e.params))),
      on('Runtime.exceptionThrown', mine((e) => this.onException(e.params))),
      on('Log.entryAdded', mine((e) => this.onLog(e.params))),
      on('Network.requestWillBeSent', mine((e) => this.onRequest(e.params))),
      on('Network.responseReceived', mine((e) => this.onResponse(e.params))),
      on('Network.loadingFinished', mine((e) => this.forget(e.params.requestId))),
      on('Network.loadingFailed', mine((e) => this.onFailed(e.params))),
      on('Page.frameNavigated', mine((e) => this.onFrameNavigated(e.params))),
      on('Page.navigatedWithinDocument', mine((e) => this.onSameDocument(e.params)))
    )
    const send = (method: string): Promise<unknown> =>
      this.client.send(method, {}, this.sessionId).catch(() => undefined)
    await Promise.all([send('Runtime.enable'), send('Log.enable'), send('Network.enable')])
    const tree = (await this.client
      .send<{ frameTree?: { frame?: { id?: unknown; url?: unknown } } }>('Page.getFrameTree', {}, this.sessionId)
      .catch(() => undefined)) as { frameTree?: { frame?: { id?: unknown; url?: unknown } } } | undefined
    const frame = tree?.frameTree?.frame
    if (frame && typeof frame === 'object' && this.pageUrl === undefined) this.onFrameNavigated({ frame })
  }

  /** Step `index` starts. */
  beginStep(index: number): void {
    this.closeCurrent()
    this.current = index
    this.urlTaken = false
    this.starts.push({ index, at: this.clock() })
  }

  /** The step running at epoch ms `at`; the current one when `at` is not a usable time. */
  private stepAt(at: unknown): number {
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return this.current
    for (let i = this.starts.length - 1; i >= 0; i--) if (this.starts[i].at <= at) return this.starts[i].index
    return -1
  }

  /**
   * After the last step: wait (at most `SETTLE_MS`) until the requests the
   * current step sent have finished, so a submit whose response fails a moment
   * later is still filed under it. Requests earlier steps left open (long
   * polling, streams) don't hold the run up.
   */
  async settle(): Promise<void> {
    const step = this.current
    if (step < 0 || this.stopped) return
    for (let polls = SETTLE_MS / SETTLE_POLL_MS; polls > 0; polls--) {
      // Network events arrive a few milliseconds after the step returns, so look only after a pause.
      await new Promise((done) => setTimeout(done, SETTLE_POLL_MS))
      if (this.stopped || ![...this.pending.values()].some((r) => r.step === step)) return
    }
  }

  /** Stops listening and closes the last step. */
  stop(): void {
    if (this.stopped) return
    this.closeCurrent()
    this.stopped = true
    for (const off of this.offs) off()
    this.offs.length = 0
    this.pending.clear()
  }

  /** What step `index` collected (-1: while the target was opening); undefined when nothing. */
  forStep(index: number): StepEvidence | undefined {
    const e = this.byStep.get(index)
    return e && Object.keys(e).length > 0 ? e : undefined
  }

  /** The page's URL as last reported, scrubbed. */
  finalUrl(): string | undefined {
    return this.pageUrl === undefined ? undefined : this.scrubUrl(this.pageUrl)
  }

  /**
   * The current step is over: note the page's URL. Asks the page itself, since
   * navigation events can arrive after the step returned; never throws and
   * never waits more than `URL_READ_MS`.
   */
  async endStep(): Promise<void> {
    if (this.current < 0 || this.stopped) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = this.client
      .send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: 'location.href', returnByValue: true },
        this.sessionId
      )
      .then((r) => r?.result?.value)
      .catch(() => undefined)
    const href = await Promise.race([
      read,
      new Promise<undefined>((done) => (timer = setTimeout(() => done(undefined), URL_READ_MS)))
    ]).finally(() => clearTimeout(timer))
    if (typeof href === 'string' && href !== '') this.pageUrl = href
    this.closeCurrent()
  }

  private closeCurrent(): void {
    if (this.current < 0 || this.urlTaken || this.pageUrl === undefined) return
    this.bucket(this.current).url = this.scrubUrl(this.pageUrl)
    this.urlTaken = true
  }

  private bucket(index: number): StepEvidence {
    let e = this.byStep.get(index)
    if (!e) {
      e = {}
      this.byStep.set(index, e)
    }
    return e
  }

  /** Scrub secrets from the raw text first: a slice could cut a secret in half and hide it from redact(). */
  private scrubText(text: string): string {
    return clip(this.redact(text), MAX_MESSAGE_CHARS)
  }

  private scrubUrl(url: string): string {
    // data: URLs can be megabytes of payload; the type is what matters.
    if (/^data:/i.test(url)) return `${url.slice(0, Math.max(5, url.search(/[,;]/)))},…`
    return clip(scrubStartUrl(this.redact(url)).url, MAX_URL_CHARS)
  }

  /**
   * Adds an entry to a step's capped list, or counts it as dropped. `make` is
   * called only when there is room, so a page logging in a loop costs no
   * scrubbing for entries that are not kept.
   */
  private push<K extends 'consoleErrors' | 'failedRequests'>(
    step: number,
    key: K,
    make: () => NonNullable<StepEvidence[K]>[number]
  ): void {
    const e = this.bucket(step)
    const list = (e[key] ??= []) as Array<NonNullable<StepEvidence[K]>[number]>
    if (list.length < MAX_ENTRIES_PER_STEP) list.push(make())
    else if (key === 'consoleErrors') e.consoleErrorsDropped = (e.consoleErrorsDropped ?? 0) + 1
    else e.failedRequestsDropped = (e.failedRequestsDropped ?? 0) + 1
  }

  private addConsole(at: unknown, source: ConsoleError['source'], message: () => string): void {
    this.push(this.stepAt(at), 'consoleErrors', () => ({ source, message: this.scrubText(message()) }))
  }

  private onConsole(p: Record<string, unknown>): void {
    if (p.type !== 'error' && p.type !== 'assert') return
    this.addConsole(p.timestamp, 'console', () => {
      const message = argsToMessage(p.args)
      return p.type === 'assert' && !message ? 'console.assert' : message
    })
  }

  private onException(p: Record<string, unknown>): void {
    const d = p.exceptionDetails as { text?: unknown; exception?: { description?: unknown } } | undefined
    this.addConsole(p.timestamp, 'exception', () =>
      typeof d?.exception?.description === 'string'
        ? d.exception.description
        : typeof d?.text === 'string'
          ? d.text
          : 'uncaught exception'
    )
  }

  private onLog(p: Record<string, unknown>): void {
    const entry = p.entry as { level?: unknown; source?: unknown; text?: unknown; timestamp?: unknown } | undefined
    // Network log lines ("Failed to load resource: ... 404") repeat what failedRequests already says.
    if (!entry || entry.level !== 'error' || entry.source === 'network') return
    this.addConsole(entry.timestamp, 'log', () => (typeof entry.text === 'string' ? entry.text : ''))
  }

  private onRequest(p: Record<string, unknown>): void {
    const id = p.requestId
    const request = p.request as { method?: unknown; url?: unknown } | undefined
    if (typeof id !== 'string' || typeof request?.url !== 'string') return
    // A redirect reuses the request id: the hop that failed is the latest one.
    this.pending.delete(id)
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      const oldest = this.pending.keys().next().value
      if (oldest !== undefined) this.pending.delete(oldest)
    }
    this.pending.set(id, {
      // wallTime is in seconds.
      step: this.stepAt(typeof p.wallTime === 'number' ? p.wallTime * 1000 : undefined),
      method: typeof request.method === 'string' ? request.method : 'GET',
      url: request.url,
      ...(typeof p.type === 'string' ? { type: p.type } : {})
    })
  }

  private onResponse(p: Record<string, unknown>): void {
    const id = p.requestId
    const status = (p.response as { status?: unknown } | undefined)?.status
    if (typeof id !== 'string' || typeof status !== 'number' || status < 400) return
    const r = this.pending.get(id)
    if (!r) return
    this.pending.delete(id)
    this.push(r.step, 'failedRequests', () => ({
      method: r.method,
      url: this.scrubUrl(r.url),
      ...(r.type !== undefined ? { resource_type: r.type } : {}),
      status
    }))
  }

  private onFailed(p: Record<string, unknown>): void {
    const id = p.requestId
    if (typeof id !== 'string') return
    const r = this.pending.get(id)
    this.pending.delete(id)
    if (!r || p.canceled === true) return
    const reason = typeof p.blockedReason === 'string' ? `blocked: ${p.blockedReason}` : p.errorText
    this.push(r.step, 'failedRequests', () => ({
      method: r.method,
      url: this.scrubUrl(r.url),
      ...(r.type !== undefined ? { resource_type: r.type } : {}),
      error: this.scrubText(typeof reason === 'string' && reason ? reason : 'the request failed')
    }))
  }

  private forget(id: unknown): void {
    if (typeof id === 'string') this.pending.delete(id)
  }

  private onFrameNavigated(p: Record<string, unknown>): void {
    const frame = p.frame as { id?: unknown; parentId?: unknown; url?: unknown; urlFragment?: unknown } | undefined
    if (!frame || frame.parentId !== undefined || typeof frame.url !== 'string') return
    if (typeof frame.id === 'string') this.mainFrameId = frame.id
    this.pageUrl = frame.url + (typeof frame.urlFragment === 'string' ? frame.urlFragment : '')
  }

  private onSameDocument(p: Record<string, unknown>): void {
    // Without a known main frame, an iframe's pushState could pass for the page's; the URL read after the step covers it.
    if (typeof p.url !== 'string' || this.mainFrameId === undefined || p.frameId !== this.mainFrameId) return
    this.pageUrl = p.url
  }
}
