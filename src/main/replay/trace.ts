/**
 * Roadmap DT1b: a performance trace of a browser run, as a file the browser's own Performance panel opens
 * (`trace.json`: `{ traceEvents, metadata }`), with each step as a measure on the panel's Timings track.
 *
 * Recorded over the run's page session with the Tracing domain (events streamed with `ReportEvents`). What the file
 * keeps, and why:
 * - **Only this run's processes.** The browser reports its own process, the GPU process and *every* renderer it
 *   has (other tabs of an attached browser, its own UI pages, whose process name is the full command line with the
 *   profile path). Kept: the browser and GPU processes, and the renderers that hosted this page's frames
 *   (`TracingStartedInBrowser`, then `FrameCommittedInBrowser` for those frames and their children; a renderer
 *   still launching at commit time is named by a pseudo id that `ProcessReadyInBrowser` maps to its pid).
 * - **Scrubbed like the run HAR** (see evidence.ts): every string through the flow's secret redaction, every URL in
 *   it loses token-like parameters and `user:pass@`, credential and token-named headers (`ResourceReceiveResponse`
 *   carries response headers) are dropped, data: payloads are cut, then the Tier B pattern scan plus the
 *   workspace's rules (`sealValue`), and only then long strings are cut (a cut first could hide a token from Tier B).
 *   No screenshot category is recorded: a frame of the page could show what a step typed.
 * - **Steps on the trace's clock.** Trace timestamps are the browser's monotonic clock; a `clock_sync` marker
 *   recorded right after the start, timed on this process's monotonic clock (`performance.now()`, which a system
 *   clock change does not move), bridges the two (within the command's round trip, about a millisecond locally).
 *   Each step becomes a `blink.user_timing` measure, the same events `performance.measure()` produces, on the main
 *   thread of the renderer that hosted the page then.
 * - **Bounded.** At most `MAX_TRACE_EVENTS` of the run's own events are kept (process and thread names always),
 *   and the raw stream is held to `MAX_RAW_TRACE_EVENTS`; the rest are counted in `metadata.nawi`. The file is built
 *   in chunks that yield to the event loop, so a large trace does not freeze the app.
 *
 * Best effort and never into the run's result: a browser that refuses tracing (already tracing in another tab, a
 * session that does not support it) leaves the run without a trace and says why (`RunTrace.error`).
 */

import { scrubStartUrl } from '@shared/flow/from-recording'
import { isSecretHeader } from '../harvest/har'
import { sealValue } from '../sidecar/seal'
import { URL_IN_TEXT } from './evidence'
import type { RedactionRule } from '@shared/settings'
import type { ReplayClient } from './replay'

/** What a run trace records: the Performance panel's own set (timeline, JS samples and stacks), minus screenshots. */
export const TRACE_CATEGORIES = Object.freeze([
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'v8.execute',
  'disabled-by-default-v8.cpu_profiler',
  'blink.user_timing',
  'toplevel',
  'latencyInfo'
])
/** The run's own events a trace keeps (a busy minute of a page is a few hundred thousand). */
export const MAX_TRACE_EVENTS = 300_000
/** Events held from the browser's stream before other processes are filtered out (other tabs can be busy). */
export const MAX_RAW_TRACE_EVENTS = 1_000_000
/** How long the browser may take to hand over the rest of the trace after `Tracing.end`. */
export const TRACE_END_TIMEOUT_MS = 15_000
/** A string in the trace is cut at this many characters (after the Tier B scan). */
export const MAX_TRACE_STRING_CHARS = 16_000
/** Events scrubbed between two yields to the event loop. */
const CHUNK = 2_000
/** Prefix of the `id2.local` of the step measures, so they never share an id with the page's own measures. */
const MEASURE_ID_PREFIX = '0x6e617769'

export type TraceEvent = Record<string, unknown> & {
  name?: unknown
  cat?: unknown
  ph?: unknown
  pid?: unknown
  tid?: unknown
  ts?: unknown
  args?: unknown
}

/** The trace file: Chrome's JSON trace format, which the Performance panel loads. */
export interface TraceFile {
  traceEvents: TraceEvent[]
  metadata: {
    nawi: {
      /** Events of this run not kept: past MAX_TRACE_EVENTS, or past MAX_RAW_TRACE_EVENTS in the raw stream. */
      dropped_events: number
      /** Events of processes that were not this run's (other tabs, the browser's own pages), left out. */
      other_process_events: number
      /** Why the steps are not marked, when they are not. */
      note?: string
    }
  }
}

export interface RunTrace {
  trace?: TraceFile
  /** Why there is no trace, when there is none. */
  error?: string
}

type Event = { method: string; params: Record<string, unknown>; sessionId?: string }

interface StepMark {
  index: number
  id: string
  action: string
  /** On the recorder's clock, ms. */
  begin: number
  end?: number
}

interface Scope {
  pids: Set<unknown>
  /** When the page's main frame committed in which renderer, in trace order. */
  mainCommits: Array<{ ts: number; pid: unknown }>
  /** Renderer pid -> its main thread's tid. */
  mainThread: Map<unknown, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const dataOf = (event: TraceEvent): Record<string, unknown> | undefined => {
  const data = isRecord(event.args) ? event.args.data : undefined
  return isRecord(data) ? data : undefined
}

const yieldToLoop = (): Promise<void> => new Promise((done) => setImmediate(done))

/** A copy of `value` with every string longer than MAX_TRACE_STRING_CHARS cut. */
function clipDeep(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_TRACE_STRING_CHARS ? `${value.slice(0, MAX_TRACE_STRING_CHARS)}…` : value
  if (Array.isArray(value)) return value.map(clipDeep)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = clipDeep(v)
  return out
}

export class TraceRecorder {
  private readonly events: TraceEvent[] = []
  private rawDropped = 0
  private readonly offs: Array<() => void> = []
  private started = false
  private failure: string | undefined
  /** The clock_sync marker's id and the recorder's clock when it was recorded, in µs. */
  private sync: { id: string; atUs: number } | undefined
  private readonly marks: StepMark[] = []
  private complete: (() => void) | undefined
  private finished = false

  constructor(
    private readonly client: ReplayClient,
    private readonly sessionId: string | undefined,
    private readonly redact: (text: string) => string,
    private readonly rules: readonly RedactionRule[] = [],
    /** Monotonic ms; injected for tests. */
    private readonly clock: () => number = () => performance.now()
  ) {}

  /** Starts tracing the page. Never throws: a browser that refuses leaves `stop()` to report why. */
  async start(): Promise<void> {
    const on = this.client.on?.bind(this.client)
    if (!on) {
      this.failure = 'this connection cannot receive the browser’s trace events'
      return
    }
    const mine = (listener: (event: Event) => void) => (event: Event) => {
      if (event.sessionId !== this.sessionId) return
      try {
        listener(event)
      } catch {
        // Never into the CDP read loop.
      }
    }
    this.offs.push(
      on('Tracing.dataCollected', mine((e) => this.onData(e.params.value))),
      on(
        'Tracing.tracingComplete',
        mine(() => {
          this.finished = true
          this.complete?.()
        })
      )
    )
    try {
      await this.client.send(
        'Tracing.start',
        {
          transferMode: 'ReportEvents',
          traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: [...TRACE_CATEGORIES], excludedCategories: ['*'] }
        },
        this.sessionId
      )
    } catch (error) {
      this.failure = `the browser would not start a trace: ${this.redact(String((error as Error).message ?? error))}`
      this.unsubscribe()
      return
    }
    this.started = true
    const id = `nawi-${Date.now().toString(36)}`
    const before = this.clock()
    const synced = await this.client
      .send('Tracing.recordClockSyncMarker', { syncId: id }, this.sessionId)
      .then(() => true)
      .catch(() => false)
    if (synced) this.sync = { id, atUs: ((before + this.clock()) / 2) * 1000 }
  }

  /** Step `index` (the flow's step `id`, doing `action`) starts now. */
  beginStep(index: number, id: string, action: string): void {
    if (!this.started) return
    this.endStep()
    this.marks.push({ index, id, action, begin: this.clock() })
  }

  /** The current step is over. */
  endStep(): void {
    const last = this.marks.at(-1)
    if (last && last.end === undefined) last.end = this.clock()
  }

  /**
   * Ends the trace and builds the file. Waits at most TRACE_END_TIMEOUT_MS for the browser to hand the rest over.
   * Never throws.
   */
  async stop(): Promise<RunTrace> {
    if (!this.started) {
      this.unsubscribe()
      return { error: this.failure ?? 'the trace did not start' }
    }
    this.started = false
    this.endStep()
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = this.finished
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => {
          this.complete = () => resolve(true)
          timer = setTimeout(() => resolve(false), TRACE_END_TIMEOUT_MS)
        })
    const ended = await this.client
      .send('Tracing.end', {}, this.sessionId)
      .then(() => true)
      .catch(() => false)
    const completed = ended ? await done : false
    clearTimeout(timer)
    this.unsubscribe()
    if (!ended) return { error: 'the browser would not end the trace (the page or its connection went away)' }
    if (!completed) return { error: `the browser did not finish the trace within ${TRACE_END_TIMEOUT_MS / 1000} s` }
    try {
      return await this.build()
    } catch (error) {
      return { error: `the trace could not be read: ${this.redact(String((error as Error).message ?? error))}` }
    } finally {
      this.events.length = 0
    }
  }

  private unsubscribe(): void {
    for (const off of this.offs) off()
    this.offs.length = 0
  }

  private onData(value: unknown): void {
    if (!Array.isArray(value)) return
    for (const event of value) {
      if (!isRecord(event)) continue
      if (this.events.length < MAX_RAW_TRACE_EVENTS) this.events.push(event)
      else this.rawDropped++
    }
  }

  private async build(): Promise<RunTrace> {
    const started = this.events.find((e) => e.name === 'TracingStartedInBrowser')
    const startedData = started ? dataOf(started) : undefined
    if (!started || !startedData || !Array.isArray(startedData.frames)) {
      return { error: 'the browser’s trace did not say which page it traced (no TracingStartedInBrowser event)' }
    }
    const scope = this.scope(started, startedData.frames)
    let other = 0
    let dropped = this.rawDropped
    const own: TraceEvent[] = []
    for (const event of this.events) {
      if (!scope.pids.has(event.pid)) other++
      // Process and thread names always: without them the panel cannot lay out the tracks.
      else if (own.length < MAX_TRACE_EVENTS || event.ph === 'M') own.push(event)
      else dropped++
    }
    const kept: TraceEvent[] = []
    for (let at = 0; at < own.length; at += CHUNK) {
      const scrubbed = own.slice(at, at + CHUNK).map((event) => this.scrub(event))
      kept.push(...(clipDeep(sealValue(scrubbed, this.rules).value) as TraceEvent[]))
      await yieldToLoop()
    }
    const nawi: TraceFile['metadata']['nawi'] = { dropped_events: dropped, other_process_events: other }
    const offsetUs = this.clockOffsetUs()
    if (offsetUs === undefined) {
      if (this.marks.length > 0) nawi.note = 'steps are not marked: the browser recorded no clock sync marker'
    } else {
      const measures = this.stepMeasures(offsetUs, scope)
      if (this.marks.length > 0 && measures.length === 0) {
        nawi.note = 'steps are not marked: the trace did not say which renderer showed the page'
      }
      // Names are the flow's step ids and actions: scrubbed and sealed like the rest.
      kept.push(...(sealValue(measures.map((m) => this.scrub(m)), this.rules).value as TraceEvent[]))
    }
    return { trace: { traceEvents: kept, metadata: { nawi } } }
  }

  /**
   * The processes that are this run's: the browser (which sent TracingStartedInBrowser), the GPU process, and the
   * renderers that hosted the traced page's frames, in commit order (a navigation can move the page to another one).
   */
  private scope(started: TraceEvent, frames: unknown[]): Scope {
    // A renderer still launching when its frame commits is named by a pseudo id; ProcessReadyInBrowser maps it.
    const ready = new Map<unknown, unknown>()
    for (const e of this.events) {
      const data = e.name === 'ProcessReadyInBrowser' ? dataOf(e) : undefined
      if (data && data.processPseudoId !== undefined && data.processId !== undefined) ready.set(data.processPseudoId, data.processId)
    }
    const pidOf = (data: Record<string, unknown>): unknown =>
      data.processId ?? (data.processPseudoId !== undefined ? ready.get(data.processPseudoId) : undefined)
    // The outermost main frame; an older browser that does not say so: the frame without a parent.
    const isMain = (data: Record<string, unknown>): boolean =>
      data.isOutermostMainFrame === true || (data.isOutermostMainFrame === undefined && data.parent === undefined)

    const pids = new Set<unknown>([started.pid])
    const known = new Set<unknown>()
    const mainCommits: Scope['mainCommits'] = []
    const startTs = typeof started.ts === 'number' ? started.ts : 0
    for (const frame of frames) {
      if (!isRecord(frame) || frame.frame === undefined) continue
      known.add(frame.frame)
      const pid = pidOf(frame)
      if (pid === undefined) continue
      pids.add(pid)
      if (isMain(frame)) mainCommits.push({ ts: startTs, pid })
    }
    const commits = this.events
      .filter((e) => e.name === 'FrameCommittedInBrowser')
      .sort((a, b) => Number(a.ts) - Number(b.ts))
    for (const commit of commits) {
      const data = dataOf(commit)
      if (!data || (!known.has(data.frame) && !known.has(data.parent))) continue
      known.add(data.frame)
      const pid = pidOf(data)
      if (pid === undefined) continue
      pids.add(pid)
      if (data.parent === undefined && typeof commit.ts === 'number') mainCommits.push({ ts: commit.ts, pid })
    }
    const mainThread = new Map<unknown, unknown>()
    for (const e of this.events) {
      if (e.ph === 'M' && e.name === 'process_name' && isRecord(e.args) && e.args.name === 'GPU Process') pids.add(e.pid)
      if (e.ph === 'M' && e.name === 'thread_name' && isRecord(e.args) && e.args.name === 'CrRendererMain') mainThread.set(e.pid, e.tid)
    }
    return { pids, mainCommits, mainThread }
  }

  /** µs to subtract from the recorder's clock (µs) to get the trace's clock, from the clock_sync marker. */
  private clockOffsetUs(): number | undefined {
    if (!this.sync) return undefined
    const id = this.sync.id
    const marker = this.events.find((e) => e.name === 'clock_sync' && isRecord(e.args) && e.args.sync_id === id)
    return typeof marker?.ts === 'number' ? this.sync.atUs - marker.ts : undefined
  }

  /** Each step as a `blink.user_timing` measure (begin/end pair), on the main thread of the page's renderer then. */
  private stepMeasures(offsetUs: number, scope: Scope): TraceEvent[] {
    const out: TraceEvent[] = []
    for (const mark of this.marks) {
      const begin = Math.round(mark.begin * 1000 - offsetUs)
      const end = Math.max(begin, Math.round((mark.end ?? mark.begin) * 1000 - offsetUs))
      let pid: unknown
      for (const commit of scope.mainCommits) if (commit.ts <= begin) pid = commit.pid
      pid ??= scope.mainCommits[0]?.pid
      if (pid === undefined) continue
      // Linux names a process's main thread after the process; elsewhere the thread_name metadata says.
      const tid = scope.mainThread.get(pid) ?? pid
      const name = `Step ${mark.index + 1}: ${mark.id} (${mark.action})`
      const id2 = { local: `${MEASURE_ID_PREFIX}${mark.index.toString(16).padStart(4, '0')}` }
      out.push(
        { cat: 'blink.user_timing', name, ph: 'b', id2, pid, tid, ts: begin, args: { nawi_step: { index: mark.index, id: mark.id } } },
        { cat: 'blink.user_timing', name, ph: 'e', id2, pid, tid, ts: end, args: {} }
      )
    }
    return out
  }

  /** A copy of `event` with secrets and token-like URL parts scrubbed from every string, credential headers dropped. */
  private scrub(value: unknown, key?: string): TraceEvent {
    return this.scrubValue(value, key) as TraceEvent
  }

  private scrubValue(value: unknown, key?: string): unknown {
    if (typeof value === 'string') return this.scrubString(value)
    const headers = key?.toLowerCase() === 'headers'
    if (Array.isArray(value)) {
      const list = headers ? value.filter((h) => !(isRecord(h) && typeof h.name === 'string' && isSecretHeader(h.name))) : value
      return list.map((item) => this.scrubValue(item))
    }
    if (!isRecord(value)) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (headers && isSecretHeader(k)) continue
      out[k] = this.scrubValue(v, k)
    }
    return out
  }

  private scrubString(text: string): string {
    // Secrets first (a URL scrub could split one), then the URLs in it; data: URLs can be megabytes, the type is
    // what matters. Long strings are cut later, after the Tier B scan.
    return this.redact(text)
      .replace(URL_IN_TEXT, (url) => scrubStartUrl(url).url)
      .replace(/\bdata:([^,\s"']{0,100}),[^\s"']*/gi, 'data:$1,…')
  }
}
