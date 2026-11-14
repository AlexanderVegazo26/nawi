import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_RAW_TRACE_EVENTS,
  MAX_TRACE_EVENTS,
  MAX_TRACE_STRING_CHARS,
  TRACE_CATEGORIES,
  TRACE_END_TIMEOUT_MS,
  TraceRecorder,
  type TraceEvent,
  type TraceFile
} from './trace'

type Listener = (event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void

const SESSION = 'S1'
const SECRET = 'hunter2-trace'
const BROWSER = 100
const GPU = 200
const RENDERER = 300
/** The renderer the page moves to after a cross-site navigation. */
const RENDERER_2 = 301
/** An out-of-process iframe of the page. */
const IFRAME_RENDERER = 302
/** Another tab of the same browser. */
const OTHER_TAB = 400
/** The browser's own UI page, whose process name is its command line. */
const WEBUI = 500
const MAIN_TID = 3001
/** The trace clock (µs) at the moment the run's wall clock read T0. */
const SYNC_TS = 50_000_000
const T0 = 1_800_000_000_000

/**
 * A CDP client double for the Tracing domain: records commands, and on `Tracing.end` hands over `trace` in two
 * chunks followed by `tracingComplete` (unless told otherwise).
 */
class FakeClient {
  readonly sent: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = []
  trace: TraceEvent[] = []
  refuseStart: string | undefined
  refuseEnd = false
  neverComplete = false
  noSyncMarker = false
  private readonly listeners = new Map<string, Set<Listener>>()

  async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    this.sent.push({ method, params, sessionId })
    if (method === 'Tracing.start' && this.refuseStart) throw new Error(this.refuseStart)
    if (method === 'Tracing.recordClockSyncMarker' && this.noSyncMarker) throw new Error("'Tracing.recordClockSyncMarker' wasn't found")
    if (method === 'Tracing.end') {
      if (this.refuseEnd) throw new Error('Target closed')
      const syncId = this.sent.find((c) => c.method === 'Tracing.recordClockSyncMarker')?.params.syncId
      const events = this.trace.map((e) => (e.name === 'clock_sync' ? { ...e, args: { sync_id: syncId } } : e))
      queueMicrotask(() => {
        const half = Math.ceil(events.length / 2)
        this.emit('Tracing.dataCollected', { value: events.slice(0, half) })
        this.emit('Tracing.dataCollected', { value: events.slice(half) })
        if (!this.neverComplete) this.emit('Tracing.tracingComplete', { dataLossOccurred: false })
      })
    }
    return {} as T
  }

  on(method: string, listener: Listener): () => void {
    let set = this.listeners.get(method)
    if (!set) this.listeners.set(method, (set = new Set()))
    set.add(listener)
    return () => set.delete(listener)
  }

  emit(method: string, params: Record<string, unknown>, sessionId: string = SESSION): void {
    for (const l of [...(this.listeners.get(method) ?? [])]) l({ method, params, sessionId })
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0)
  }
}

const redact = (text: string): string => text.split(SECRET).join('[secret]')

const meta = (pid: number, tid: number, kind: 'process_name' | 'thread_name', name: string): TraceEvent => ({
  ph: 'M', cat: '__metadata', name: kind, pid, tid, ts: 0, args: { name }
})

/** What a browser hands over for a page that navigated cross-site and has an out-of-process iframe. */
function browserTrace(): TraceEvent[] {
  return [
    meta(BROWSER, BROWSER, 'process_name', 'Browser'),
    meta(GPU, GPU, 'process_name', 'GPU Process'),
    meta(RENDERER, MAIN_TID, 'thread_name', 'CrRendererMain'),
    meta(RENDERER_2, RENDERER_2, 'thread_name', 'CrRendererMain'),
    meta(OTHER_TAB, OTHER_TAB, 'process_name', 'Renderer'),
    meta(WEBUI, WEBUI, 'process_name', '/opt/chrome --type=renderer --user-data-dir=/home/someone/.profile'),
    {
      name: 'TracingStartedInBrowser', cat: 'disabled-by-default-devtools.timeline', ph: 'I', pid: BROWSER, tid: BROWSER, ts: SYNC_TS - 3_000,
      args: { data: { frameTreeNodeId: 2, frames: [{ frame: 'MAIN', isOutermostMainFrame: true, processId: RENDERER, url: 'about:blank' }] } }
    },
    { name: 'clock_sync', cat: '__metadata', ph: 'c', pid: BROWSER, tid: BROWSER, ts: SYNC_TS, args: {} },
    // Another tab navigates while the run traces: not this page's frame, so its renderer stays out.
    {
      name: 'FrameCommittedInBrowser', cat: 'devtools.timeline', ph: 'I', pid: BROWSER, tid: BROWSER, ts: SYNC_TS + 1_000,
      args: { data: { frame: 'OTHER', processId: OTHER_TAB, url: 'https://mail.example/inbox/private-thread' } }
    },
    // The page navigates cross-site 15 ms after the sync marker (its main frame moves to RENDERER_2)...
    {
      name: 'FrameCommittedInBrowser', cat: 'devtools.timeline', ph: 'I', pid: BROWSER, tid: BROWSER, ts: SYNC_TS + 15_000,
      args: { data: { frame: 'MAIN', isOutermostMainFrame: true, processId: RENDERER_2, url: `https://app.example/home?token=t0k3n&tab=1` } }
    },
    // ...and gets an out-of-process iframe.
    {
      name: 'FrameCommittedInBrowser', cat: 'devtools.timeline', ph: 'I', pid: BROWSER, tid: BROWSER, ts: SYNC_TS + 16_000,
      args: { data: { frame: 'CHILD', parent: 'MAIN', processId: IFRAME_RENDERER, url: 'https://ads.example/frame' } }
    },
    { name: 'RunTask', cat: 'toplevel', ph: 'X', pid: GPU, tid: GPU, ts: SYNC_TS + 2_000, dur: 10 },
    { name: 'RunTask', cat: 'toplevel', ph: 'X', pid: OTHER_TAB, tid: OTHER_TAB, ts: SYNC_TS + 2_000, dur: 10 },
    { name: 'RunTask', cat: 'toplevel', ph: 'X', pid: WEBUI, tid: WEBUI, ts: SYNC_TS + 2_000, dur: 10 },
    {
      name: 'ResourceSendRequest', cat: 'devtools.timeline', ph: 'I', pid: RENDERER_2, tid: RENDERER_2, ts: SYNC_TS + 20_000,
      args: {
        data: {
          url: `https://api.example/login?who=${SECRET}&session=s3ss10n&n=1`,
          requestMethod: 'POST',
          headers: { Authorization: 'Bearer abc-auth', 'X-Api-Key': 'k3y', Accept: 'application/json' }
        }
      }
    },
    {
      name: 'ResourceReceiveResponse', cat: 'devtools.timeline', ph: 'I', pid: RENDERER_2, tid: RENDERER_2, ts: SYNC_TS + 25_000,
      args: {
        data: {
          statusCode: 200,
          headers: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Set-Cookie', value: 'sid=c00k1e' },
            { name: 'X-Session-Id', value: 'abc-session' },
            { name: 'Link', value: '<https://cdn.example/next?access_token=t0k3n2&x=1>; rel=preload' }
          ]
        }
      }
    },
    {
      name: 'FunctionCall', cat: 'devtools.timeline', ph: 'X', pid: IFRAME_RENDERER, tid: IFRAME_RENDERER, ts: SYNC_TS + 26_000, dur: 5,
      args: { data: { url: `data:text/javascript;base64,${'A'.repeat(5_000)}`, functionName: `typed ${SECRET} in a name` } }
    },
    {
      name: 'EventDispatch', cat: 'devtools.timeline', ph: 'X', pid: RENDERER_2, tid: RENDERER_2, ts: SYNC_TS + 27_000, dur: 5,
      args: { data: { type: 'click', note: 'contact owner@example.com', long: 'x'.repeat(20_000) } }
    }
  ]
}

const sessionsOf = (client: FakeClient, method: string): Array<string | undefined> =>
  client.sent.filter((c) => c.method === method).map((c) => c.sessionId)

async function recorded(
  client: FakeClient,
  steps: Array<{ id: string; action: string; begin: number; end: number }> = [],
  rules: ConstructorParameters<typeof TraceRecorder>[3] = []
): Promise<{ trace?: TraceFile; error?: string }> {
  let now = T0
  const rec = new TraceRecorder(client, SESSION, redact, rules, () => now)
  await rec.start()
  steps.forEach((s, index) => {
    now = s.begin
    rec.beginStep(index, s.id, s.action)
    now = s.end
    rec.endStep()
  })
  return rec.stop()
}

const named = (trace: TraceFile | undefined, name: string): TraceEvent[] =>
  (trace?.traceEvents ?? []).filter((e) => e.name === name)

afterEach(() => vi.useRealTimers())

describe('TraceRecorder (roadmap DT1b)', () => {
  it('traces the page session with the Performance panel categories and no screenshots, then marks the clock', async () => {
    const client = new FakeClient()
    client.trace = browserTrace()
    await recorded(client)
    const start = client.sent.find((c) => c.method === 'Tracing.start')
    expect(start?.sessionId, 'tracing must run on the page session, not the browser').toBe(SESSION)
    expect(start?.params, 'events are streamed (ReportEvents), only the listed categories').toMatchObject({
      transferMode: 'ReportEvents',
      traceConfig: { includedCategories: [...TRACE_CATEGORIES], excludedCategories: ['*'] }
    })
    expect(
      TRACE_CATEGORIES.filter((c) => /screenshot/i.test(c)),
      'a screenshot category would put frames of the page (typed secrets included) into the trace'
    ).toEqual([])
    const methods = client.sent.map((c) => c.method)
    expect(methods, 'the sync marker right after the start, then the end').toEqual(['Tracing.start', 'Tracing.recordClockSyncMarker', 'Tracing.end'])
    expect(sessionsOf(client, 'Tracing.end')).toEqual([SESSION])
    expect(client.listenerCount(), 'listeners must be removed once the trace is in').toBe(0)
  })

  it("keeps the browser, the GPU process and the page's renderers (after a navigation, its iframes), never other tabs or the browser's own pages", async () => {
    const client = new FakeClient()
    client.trace = browserTrace()
    const { trace, error } = await recorded(client)
    expect(error, 'a complete trace has no error').toBeUndefined()
    const pids = new Set(trace?.traceEvents.map((e) => e.pid))
    expect([...pids].sort(), `kept processes: ${JSON.stringify([...pids])}`).toEqual(
      [BROWSER, GPU, RENDERER, RENDERER_2, IFRAME_RENDERER].sort()
    )
    const json = JSON.stringify(trace)
    expect(json, 'the profile path in a WebUI process name must not reach the file').not.toContain('user-data-dir')
    expect(trace?.metadata.nawi.other_process_events, 'events of other processes are counted').toBe(4)
  })

  it('scrubs every string: secret values, token-like URL parameters, credential and token-named headers, data: payloads, long text', async () => {
    const client = new FakeClient()
    client.trace = browserTrace()
    const { trace } = await recorded(client)
    const json = JSON.stringify(trace)
    expect(json.includes(SECRET), `the typed secret leaked into the trace: ${json.slice(0, 2000)}`).toBe(false)
    expect(json, 'token-like URL parameters must be scrubbed, in URLs and inside header values').not.toMatch(/t0k3n|s3ss10n|t0k3n2/)
    expect(json, 'Set-Cookie and token-named headers are dropped like in the run HAR').not.toMatch(/c00k1e|abc-session|Set-Cookie|X-Session-Id/i)
    const [response] = named(trace, 'ResourceReceiveResponse')
    const headers = ((response.args as { data: { headers: Array<{ name: string }> } }).data.headers).map((h) => h.name)
    expect(headers, 'harmless headers stay').toEqual(['Content-Type', 'Link'])
    const [sent] = named(trace, 'ResourceSendRequest')
    expect((sent.args as { data: { headers: unknown } }).data.headers, 'headers as an object lose the same names').toEqual({ Accept: 'application/json' })
    const [call] = named(trace, 'FunctionCall')
    const callData = (call.args as { data: { url: string; functionName: string } }).data
    expect(callData.url, 'a data: URL keeps its type, not its payload').toBe('data:text/javascript;base64,…')
    expect(callData.functionName).toBe('typed [secret] in a name')
    const [dispatch] = named(trace, 'EventDispatch')
    const long = (dispatch.args as { data: { long: string } }).data.long
    expect(long.length, 'one string is cut at 16,000 characters').toBe(MAX_TRACE_STRING_CHARS + 1)
  })

  it("applies Tier B's patterns and the workspace's rules to the trace", async () => {
    const client = new FakeClient()
    client.trace = browserTrace()
    const { trace } = await recorded(client, [], [{ id: 'r1', label: 'Ad host', pattern: 'ads\\.example', enabled: true }])
    const json = JSON.stringify(trace)
    expect(json, 'an email in page text is caught by the built-in Tier B patterns').not.toContain('owner@example.com')
    expect(json, "the workspace's own rule applies too").not.toContain('ads.example')
    expect(json, 'text no pattern matches is untouched').toContain('https://cdn.example/next')
  })

  it('marks each step as a user timing measure on the trace clock, on the main thread of the renderer showing the page then', async () => {
    const client = new FakeClient()
    client.trace = browserTrace()
    const { trace } = await recorded(client, [
      // Before the cross-site navigation (sync + 15 ms): on the first renderer.
      { id: 'open-menu', action: 'click', begin: T0 + 2, end: T0 + 9.5 },
      // After it: on the second renderer, whose main thread is its pid.
      { id: 'fill-name', action: 'fill', begin: T0 + 20, end: T0 + 30 }
    ])
    const measures = (trace?.traceEvents ?? []).filter((e) => e.cat === 'blink.user_timing')
    expect(measures, JSON.stringify(measures)).toEqual([
      {
        cat: 'blink.user_timing', name: 'Step 1: open-menu (click)', ph: 'b', id2: { local: '0x6e6177690000' },
        pid: RENDERER, tid: MAIN_TID, ts: SYNC_TS + 2_000, args: { nawi_step: { index: 0, id: 'open-menu' } }
      },
      { cat: 'blink.user_timing', name: 'Step 1: open-menu (click)', ph: 'e', id2: { local: '0x6e6177690000' }, pid: RENDERER, tid: MAIN_TID, ts: SYNC_TS + 9_500, args: {} },
      {
        cat: 'blink.user_timing', name: 'Step 2: fill-name (fill)', ph: 'b', id2: { local: '0x6e6177690001' },
        pid: RENDERER_2, tid: RENDERER_2, ts: SYNC_TS + 20_000, args: { nawi_step: { index: 1, id: 'fill-name' } }
      },
      { cat: 'blink.user_timing', name: 'Step 2: fill-name (fill)', ph: 'e', id2: { local: '0x6e6177690001' }, pid: RENDERER_2, tid: RENDERER_2, ts: SYNC_TS + 30_000, args: {} }
    ])
  })

  it("puts the step names through the workspace's rules too", async () => {
    const client = new FakeClient()
    client.trace = browserTrace()
    const { trace } = await recorded(client, [{ id: 'pay-acme-corp', action: 'click', begin: T0 + 1, end: T0 + 2 }], [
      { id: 'r1', label: 'Client', pattern: 'acme', enabled: true }
    ])
    const names = (trace?.traceEvents ?? []).filter((e) => e.cat === 'blink.user_timing').map((e) => String(e.name))
    expect(names.length).toBe(2)
    expect(names.join(' '), 'a client name in a step id is redacted').not.toContain('acme')
  })

  it('closes a step left open (a run that stopped mid-step) when the trace stops', async () => {
    const client = new FakeClient()
    client.trace = browserTrace()
    let now = T0
    const rec = new TraceRecorder(client, SESSION, redact, [], () => now)
    await rec.start()
    now = T0 + 1
    rec.beginStep(0, 'save', 'click')
    now = T0 + 4
    const { trace } = await rec.stop()
    const ends = (trace?.traceEvents ?? []).filter((e) => e.cat === 'blink.user_timing' && e.ph === 'e')
    expect(ends.map((e) => e.ts), 'the open step ends when the trace stops').toEqual([SYNC_TS + 4_000])
  })

  it('keeps the trace without step marks, and says so, when the browser records no clock sync marker', async () => {
    const client = new FakeClient()
    client.trace = browserTrace()
    client.noSyncMarker = true
    const { trace, error } = await recorded(client, [{ id: 'a', action: 'click', begin: T0 + 1, end: T0 + 2 }])
    expect(error).toBeUndefined()
    expect(trace?.traceEvents.filter((e) => e.cat === 'blink.user_timing'), 'no guessed marks').toEqual([])
    expect(trace?.metadata.nawi.note).toBe('steps are not marked: the browser recorded no clock sync marker')
  })

  it('says why when the browser will not trace (already tracing elsewhere), and sends nothing more', async () => {
    const client = new FakeClient()
    client.refuseStart = `Tracing has already been started (possibly in another tab). ${SECRET}`
    const result = await recorded(client, [{ id: 'a', action: 'click', begin: T0 + 1, end: T0 + 2 }])
    expect(result).toEqual({
      error: 'the browser would not start a trace: Tracing has already been started (possibly in another tab). [secret]'
    })
    expect(client.sent.map((c) => c.method)).toEqual(['Tracing.start'])
    expect(client.listenerCount()).toBe(0)
  })

  it('says why when the trace cannot be ended (the page went away)', async () => {
    const client = new FakeClient()
    client.refuseEnd = true
    expect(await recorded(client)).toEqual({ error: 'the browser would not end the trace (the page or its connection went away)' })
    expect(client.listenerCount()).toBe(0)
  })

  it(`gives up after ${TRACE_END_TIMEOUT_MS / 1000} s when the browser never finishes the trace`, async () => {
    vi.useFakeTimers()
    const client = new FakeClient()
    client.trace = browserTrace()
    client.neverComplete = true
    const pending = recorded(client)
    await vi.advanceTimersByTimeAsync(TRACE_END_TIMEOUT_MS - 1)
    let settled = false
    void pending.then(() => (settled = true))
    await Promise.resolve()
    expect(settled, 'still waiting just before the limit').toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ error: `the browser did not finish the trace within ${TRACE_END_TIMEOUT_MS / 1000} s` })
  })

  it('says so when the trace does not name the traced page (no TracingStartedInBrowser)', async () => {
    const client = new FakeClient()
    client.trace = browserTrace().filter((e) => e.name !== 'TracingStartedInBrowser')
    expect(await recorded(client)).toEqual({
      error: 'the browser’s trace did not say which page it traced (no TracingStartedInBrowser event)'
    })
  })

  it('ignores trace events of other sessions', async () => {
    const client = new FakeClient()
    client.trace = browserTrace()
    let now = T0
    const rec = new TraceRecorder(client, SESSION, redact, [], () => now)
    await rec.start()
    client.emit('Tracing.dataCollected', { value: [{ name: 'Intruder', ph: 'I', pid: BROWSER, tid: BROWSER, ts: 1 }] }, 'OTHER')
    now = T0 + 1
    const { trace } = await rec.stop()
    expect(named(trace, 'Intruder')).toEqual([])
  })

  it('follows a renderer that was still launching at commit time (pseudo id, then ProcessReadyInBrowser)', async () => {
    const client = new FakeClient()
    client.trace = browserTrace().map((e) => {
      const data = (e.args as { data?: Record<string, unknown> } | undefined)?.data
      if (e.name !== 'FrameCommittedInBrowser' || data?.processId !== RENDERER_2) return e
      const { processId: _pid, ...rest } = data
      return { ...e, args: { data: { ...rest, processPseudoId: '0x7f01' } } }
    })
    client.trace.push({
      name: 'ProcessReadyInBrowser', cat: 'devtools.timeline', ph: 'I', pid: BROWSER, tid: BROWSER, ts: SYNC_TS + 15_500,
      args: { data: { processPseudoId: '0x7f01', processId: RENDERER_2 } }
    })
    const { trace } = await recorded(client, [{ id: 'fill-name', action: 'fill', begin: T0 + 20, end: T0 + 30 }])
    expect(new Set(trace?.traceEvents.map((e) => e.pid)).has(RENDERER_2), "the new renderer's events are the page's").toBe(true)
    expect(named(trace, 'ResourceSendRequest'), 'its events are kept').toHaveLength(1)
    const [begin] = (trace?.traceEvents ?? []).filter((e) => e.cat === 'blink.user_timing' && e.ph === 'b')
    expect(begin?.pid, 'the step is marked on it').toBe(RENDERER_2)
  })

  it('takes a frame without a parent as the main frame when an older browser does not say isOutermostMainFrame', async () => {
    const client = new FakeClient()
    client.trace = browserTrace()
      .filter((e) => e.name !== 'FrameCommittedInBrowser' || (e.args as { data: { frame: string } }).data.frame !== 'MAIN')
      .map((e) =>
        e.name === 'TracingStartedInBrowser'
          ? { ...e, args: { data: { frames: [{ frame: 'MAIN', processId: RENDERER, url: 'about:blank' }] } } }
          : e
      )
    const { trace } = await recorded(client, [{ id: 'a', action: 'click', begin: T0 + 1, end: T0 + 2 }])
    const measures = (trace?.traceEvents ?? []).filter((e) => e.cat === 'blink.user_timing')
    expect(measures.map((m) => m.pid), 'marked on the first renderer').toEqual([RENDERER, RENDERER])
    expect(trace?.metadata.nawi.note).toBeUndefined()
  })

  it('says so when the steps cannot be placed on any renderer', async () => {
    const client = new FakeClient()
    client.trace = browserTrace()
      .filter((e) => e.name !== 'FrameCommittedInBrowser')
      .map((e) =>
        e.name === 'TracingStartedInBrowser' ? { ...e, args: { data: { frames: [{ frame: 'MAIN', parent: 'X', processId: RENDERER }] } } } : e
      )
    const { trace } = await recorded(client, [{ id: 'a', action: 'click', begin: T0 + 1, end: T0 + 2 }])
    expect(trace?.traceEvents.filter((e) => e.cat === 'blink.user_timing')).toEqual([])
    expect(trace?.metadata.nawi.note).toBe('steps are not marked: the trace did not say which renderer showed the page')
  })

  it('runs the Tier B scan before cutting long strings, so a token across the cut is still caught', async () => {
    const client = new FakeClient()
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTQyIn0.${'s'.repeat(40)}`
    const text = `${'x'.repeat(MAX_TRACE_STRING_CHARS - 30)} ${jwt}`
    client.trace = [
      ...browserTrace(),
      { name: 'FunctionCall', cat: 'devtools.timeline', ph: 'X', pid: RENDERER, tid: MAIN_TID, ts: SYNC_TS + 3_000, dur: 1, args: { data: { stack: text } } }
    ]
    const { trace } = await recorded(client)
    const call = named(trace, 'FunctionCall').find((e) => (e.args as { data: { stack?: string } }).data.stack !== undefined)
    const stack = (call?.args as { data: { stack: string } }).data.stack
    expect(stack.includes('eyJhbGciOiJIUzI1NiJ9'), `the JWT's start before the cut leaked: …${stack.slice(-80)}`).toBe(false)
    expect(stack.length).toBeLessThanOrEqual(MAX_TRACE_STRING_CHARS + 1)
  })

  it("counts other tabs' events apart, so they never use up the run's own budget", async () => {
    const client = new FakeClient()
    const busyTab = Array.from({ length: MAX_TRACE_EVENTS }, (_, i) => ({ name: 'RunTask', ph: 'X', pid: OTHER_TAB, tid: OTHER_TAB, ts: SYNC_TS + i, dur: 1 }))
    client.trace = [...busyTab, ...browserTrace()]
    const { trace } = await recorded(client)
    expect(trace?.metadata.nawi.dropped_events, "none of the run's own events dropped").toBe(0)
    expect(named(trace, 'ResourceSendRequest'), "the run's events after the busy tab's are kept").toHaveLength(1)
  })

  it('yields to the event loop while it builds a large trace', async () => {
    const client = new FakeClient()
    const filler = Array.from({ length: 10_000 }, (_, i) => ({ name: 'RunTask', ph: 'X', pid: GPU, tid: GPU, ts: SYNC_TS + i, dur: 1 }))
    client.trace = [...browserTrace(), ...filler]
    let now = T0
    const rec = new TraceRecorder(client, SESSION, redact, [], () => now)
    await rec.start()
    now = T0 + 1
    const ticks: number[] = []
    const tick = (): void => {
      ticks.push(1)
      if (ticks.length < 50) setImmediate(tick)
    }
    setImmediate(tick)
    const stopped = rec.stop()
    await stopped
    expect(ticks.length, 'other work ran while the trace was built').toBeGreaterThan(2)
  })

  it(`keeps at most ${MAX_TRACE_EVENTS} events and counts the rest`, async () => {
    const client = new FakeClient()
    const filler = Array.from({ length: MAX_TRACE_EVENTS }, (_, i) => ({ name: 'RunTask', ph: 'X', pid: GPU, tid: GPU, ts: SYNC_TS + i, dur: 1 }))
    // The filler first: the run's own events after it are past the cap.
    client.trace = [...filler, ...browserTrace()]
    const { trace } = await recorded(client)
    // browserTrace() has 18 events: 4 of other processes (counted apart), 4 process/thread names of the run's, 10 more.
    expect(trace?.metadata.nawi.other_process_events).toBe(4)
    expect(trace?.metadata.nawi.dropped_events, 'events past the cap are counted').toBe(10)
    const meta = (trace?.traceEvents ?? []).filter((e) => e.ph === 'M')
    expect(meta.map((e) => e.pid).sort(), 'process and thread names are kept even past the cap').toEqual([BROWSER, GPU, RENDERER, RENDERER_2].sort())
    expect((trace?.traceEvents ?? []).filter((e) => e.ph !== 'M')).toHaveLength(MAX_TRACE_EVENTS)
  })

  it(`holds at most ${MAX_RAW_TRACE_EVENTS} events of the raw stream and counts the rest as dropped`, async () => {
    const client = new FakeClient()
    const busyTab = Array.from({ length: MAX_RAW_TRACE_EVENTS }, (_, i) => ({ name: 'RunTask', ph: 'X', pid: OTHER_TAB, tid: OTHER_TAB, ts: i, dur: 1 }))
    client.trace = [...browserTrace().slice(0, 7), ...busyTab, { name: 'Late', ph: 'I', pid: BROWSER, tid: BROWSER, ts: SYNC_TS + 5 }]
    const { trace, error } = await recorded(client)
    expect(error, 'TracingStartedInBrowser came early, so the trace is readable').toBeUndefined()
    // 7 + MAX_RAW + 1 events arrive; the last 8 (7 of the busy tab's and the late one) do not fit.
    expect(trace?.metadata.nawi.dropped_events, 'events past the raw cap are counted').toBe(8)
    expect(named(trace, 'Late')).toEqual([])
  })
})
