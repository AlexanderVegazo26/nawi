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
import { HarBuilder, type HarEntry, type HarHeader, type HarLog } from '../harvest/har'
import { sealValue } from '../sidecar/seal'
import type { RedactionRule } from '@shared/settings'
import type { ReplayClient } from './replay'

export const MAX_ENTRIES_PER_STEP = 20
/** Requests a run's `network.har` keeps (roadmap DT1); the rest are counted in the log's comment. */
export const MAX_HAR_REQUESTS = 2_000
const MAX_MESSAGE_CHARS = 1_000
/** A header value in the run HAR (a Content-Security-Policy can be long). */
const MAX_HEADER_CHARS = 16_000
/** An absolute URL inside a header value (`Location`, `Link: <...>`, `Refresh: 0; url=...`). */
export const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"',;]+/gi
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
  /** Browser runs (roadmap DT1): requests the step sent, all of them in the run's `network.har` under its id. */
  requests?: number
  /** Main-frame URL after the step, scrubbed. */
  url?: string
}

/**
 * Roadmap DT1: every request of a browser run as a HAR 1.2 log, each entry tagged with the step that sent it
 * (`_step_id`; `_opening: true` while the target was opening) and placed on the run's clock (`_t_ms` = ms since the
 * run started). No bodies: responses are not read and request bodies are left out. URLs and header values are
 * scrubbed like the rest of the evidence (secret values, token-like URL parameters), credential headers are not
 * kept, and every string has had the Tier B pattern scan (`sealValue`).
 */
export interface RunNetwork {
  har: HarLog
  /** Requests per step index (-1: while opening the target). */
  perStep: Map<number, number>
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
  /**
   * Requests not finished yet, with the step that sent them. `reported`: already filed as failed (an HTTP error); it
   * stays here until its body is in, so settle() waits for its end and the run HAR has its time.
   */
  private readonly pending = new Map<string, { step: number; method: string; url: string; type?: string; reported?: boolean }>()
  private readonly offs: Array<() => void> = []
  private mainFrameId: string | undefined
  private pageUrl: string | undefined
  /** The current step's URL is already noted (endStep ran). */
  private urlTaken = false
  private stopped = false
  /** Roadmap DT1: every request of the run, for `network.har`; bodies never kept (see HarBuilderOptions). */
  private readonly har = new HarBuilder({ requestBodies: 'drop' })
  /** The step that sent each request the HAR holds (the first hop's step for a redirect chain). */
  private readonly harStep = new Map<string, number>()
  private harDropped = 0

  constructor(
    private readonly client: ReplayClient,
    private readonly sessionId: string | undefined,
    private readonly redact: (text: string) => string,
    private readonly clock: () => number = wallClockMs,
    /** The workspace's redaction rules, added to Tier B's built-in patterns for the run HAR. */
    private readonly rules: readonly RedactionRule[] = []
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
      on('Network.loadingFinished', mine((e) => this.onFinished(e.params))),
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
   * polling, streams) don't hold the run up; the run HAR marks them `_unfinished`.
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
    // wallTime is in seconds.
    const step = this.stepAt(typeof p.wallTime === 'number' ? p.wallTime * 1000 : undefined)
    this.harRequest(id, step, p)
    // A redirect reuses the request id: the hop that failed is the latest one.
    this.pending.delete(id)
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      const oldest = this.pending.keys().next().value
      if (oldest !== undefined) this.pending.delete(oldest)
    }
    this.pending.set(id, {
      step,
      method: typeof request.method === 'string' ? request.method : 'GET',
      url: request.url,
      ...(typeof p.type === 'string' ? { type: p.type } : {})
    })
  }

  private onResponse(p: Record<string, unknown>): void {
    this.har.responseReceived(p)
    const id = p.requestId
    const status = (p.response as { status?: unknown } | undefined)?.status
    if (typeof id !== 'string' || typeof status !== 'number' || status < 400) return
    const r = this.pending.get(id)
    if (!r || r.reported) return
    r.reported = true
    this.push(r.step, 'failedRequests', () => ({
      method: r.method,
      url: this.scrubUrl(r.url),
      ...(r.type !== undefined ? { resource_type: r.type } : {}),
      status
    }))
  }

  private onFailed(p: Record<string, unknown>): void {
    this.har.loadingFailed(p)
    const id = p.requestId
    if (typeof id !== 'string') return
    const r = this.pending.get(id)
    this.pending.delete(id)
    if (!r || r.reported || p.canceled === true) return
    const reason = typeof p.blockedReason === 'string' ? `blocked: ${p.blockedReason}` : p.errorText
    this.push(r.step, 'failedRequests', () => ({
      method: r.method,
      url: this.scrubUrl(r.url),
      ...(r.type !== undefined ? { resource_type: r.type } : {}),
      error: this.scrubText(typeof reason === 'string' && reason ? reason : 'the request failed')
    }))
  }

  private onFinished(p: Record<string, unknown>): void {
    this.har.loadingFinished(p)
    if (typeof p.requestId === 'string') this.pending.delete(p.requestId)
  }

  /**
   * Hands a request to the run's HAR (which keeps no body: `requestBodies: 'drop'`). Past MAX_HAR_REQUESTS new
   * requests are only counted.
   */
  private harRequest(id: string, step: number, p: Record<string, unknown>): void {
    if (!this.harStep.has(id)) {
      if (this.harStep.size >= MAX_HAR_REQUESTS) {
        this.harDropped++
        return
      }
      this.harStep.set(id, step)
    }
    this.har.requestWillBeSent(p)
  }

  /**
   * Roadmap DT1: the run's requests as a HAR, with the number each step sent (see RunNetwork). `stepIds` are the
   * flow's step ids by index; `runStartedAt` (epoch ms) is `_t_ms`'s zero. Undefined when the run sent no request
   * the HAR could place on the clock. Call after `stop()`.
   */
  network(stepIds: readonly string[], runStartedAt: number): RunNetwork | undefined {
    // CDP stamps requests with a monotonic clock and, on requestWillBeSent only, the wall clock too: their offset
    // (median, against one odd stamp) places responses and ends on the run's wall clock.
    const offsets = this.har
      .clockBridges()
      .map((b) => b.wallTimeSeconds - b.monotonicSeconds)
      .sort((a, b) => a - b)
    if (offsets.length === 0) return undefined
    const offset = offsets[Math.floor(offsets.length / 2)]
    const perStep = new Map<number, number>()
    const built = this.har.build(
      (seconds) => Math.round(((seconds + offset) * 1000 - runStartedAt) * 1000) / 1000,
      (id) => {
        const step = this.harStep.get(id)
        if (step === undefined) return undefined
        perStep.set(step, (perStep.get(step) ?? 0) + 1)
        const stepId = stepIds[step]
        return step < 0 || stepId === undefined ? { _opening: true } : { _step_id: stepId }
      }
    )
    if (built.har.log.entries.length === 0) return undefined
    const notes = [
      built.har.log.comment,
      this.harDropped > 0 ? `${this.harDropped} more requests not kept (the run HAR keeps ${MAX_HAR_REQUESTS})` : undefined
    ].filter((n): n is string => n !== undefined)
    const har: HarLog = {
      log: {
        ...built.har.log,
        entries: built.har.log.entries.map((entry) => this.scrubEntry(entry)),
        ...(notes.length > 0 ? { comment: notes.join('; ') } : {})
      }
    }
    return { har: sealValue(har, this.rules).value, perStep }
  }

  /** One HAR entry with secret values and token-like URL parts scrubbed (the builder kept no body or credential header). */
  private scrubEntry(entry: HarEntry): HarEntry {
    const headers = (list: HarHeader[]): HarHeader[] =>
      list.map((h) => ({
        name: h.name,
        // Secrets first (a URL scrub could split one), then every URL inside the value loses its token parameters.
        value: clip(this.redact(h.value).replace(URL_IN_TEXT, (url) => scrubStartUrl(url).url), MAX_HEADER_CHARS)
      }))
    return {
      ...entry,
      request: { ...entry.request, url: this.scrubUrl(entry.request.url), headers: headers(entry.request.headers) },
      response: {
        ...entry.response,
        statusText: this.scrubText(entry.response.statusText),
        headers: headers(entry.response.headers),
        ...(entry.response.redirectURL ? { redirectURL: this.scrubUrl(entry.response.redirectURL) } : {}),
        ...(entry.response._error !== undefined ? { _error: this.scrubText(entry.response._error) } : {})
      }
    }
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
