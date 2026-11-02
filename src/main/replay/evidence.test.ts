import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvidenceCollector, MAX_ENTRIES_PER_STEP, wallClockMs } from './evidence'

type Listener = (event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void

const SESSION = 'S1'
const SECRET = 'hunter2-evidence'

/** A CDP client double: records commands, lets the test emit events on any session. */
class FakeClient {
  readonly sent: string[] = []
  /** What `Runtime.evaluate` answers (the page's location.href); a function may throw or never settle. */
  href: string | (() => Promise<unknown>) | undefined
  private readonly listeners = new Map<string, Set<Listener>>()
  constructor(private readonly frameTree: unknown = { frameTree: { frame: { id: 'MAIN', url: 'about:blank' } } }) {}

  async send<T>(method: string): Promise<T> {
    this.sent.push(method)
    if (method === 'Page.getFrameTree') return this.frameTree as T
    if (method === 'Runtime.evaluate') {
      const value = typeof this.href === 'function' ? await this.href() : this.href
      return { result: { value } } as T
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
    for (const l of this.listeners.get(method) ?? []) l({ method, params, sessionId })
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0)
  }
}

const redact = (text: string): string => text.split(SECRET).join('[secret]')

async function collector(
  client = new FakeClient(),
  clock?: () => number
): Promise<{ client: FakeClient; ev: EvidenceCollector }> {
  const ev = new EvidenceCollector(client, SESSION, redact, clock)
  await ev.start()
  return { client, ev }
}

const consoleError = (...values: unknown[]): Record<string, unknown> => ({
  type: 'error',
  args: values.map((value) => ({ type: typeof value, value }))
})
const request = (id: string, url: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  requestId: id,
  request: { method: 'POST', url },
  type: 'Fetch',
  ...extra
})

describe('EvidenceCollector', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("files late-arriving events by the browser's timestamp: a click's fetch and error stay on the click", async () => {
    let t = 1_000_000
    const { client, ev } = await collector(undefined, () => t)
    ev.beginStep(0) // at 1_000_000
    t = 1_000_050
    ev.beginStep(1) // the click returned; the next step began at 1_000_050
    // ...and only now do the click's events arrive, stamped 1_000_040 (request wallTime is in seconds).
    client.emit('Network.requestWillBeSent', { ...request('late', 'https://app.example/api'), wallTime: 1_000.04 })
    client.emit('Network.responseReceived', { requestId: 'late', response: { status: 500 } })
    client.emit('Runtime.consoleAPICalled', { ...consoleError('late error'), timestamp: 1_000_040 })
    client.emit('Runtime.exceptionThrown', { timestamp: 1_000_060, exceptionDetails: { text: 'thrown in step 1' } })
    client.emit('Log.entryAdded', { entry: { level: 'error', source: 'other', text: 'before any step', timestamp: 999_000 } })
    ev.stop()
    expect(ev.forStep(0)?.failedRequests?.map((r) => r.url), 'request stamped inside step 0').toEqual(['https://app.example/api'])
    expect(ev.forStep(0)?.consoleErrors?.map((c) => c.message), 'console error stamped inside step 0').toEqual(['late error'])
    expect(ev.forStep(1)?.consoleErrors?.map((c) => c.message), 'exception stamped after step 1 began').toEqual(['thrown in step 1'])
    expect(ev.forStep(-1)?.consoleErrors?.map((c) => c.message), 'log entry stamped before the first step').toEqual(['before any step'])
  })

  it("notes the page's own location.href after a step, over a navigation event that has not arrived yet", async () => {
    const { client, ev } = await collector()
    client.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://app.example/list' } })
    ev.beginStep(0)
    client.href = 'https://app.example/list?view=grid&session=abc' // pushState in the click; its event is still in flight
    await ev.endStep()
    client.emit('Page.navigatedWithinDocument', { frameId: 'MAIN', url: 'https://app.example/list?view=grid&session=abc' })
    ev.beginStep(1)
    ev.stop()
    expect(ev.forStep(0)?.url, 'URL after step 0, scrubbed').toBe('https://app.example/list?view=grid')
  })

  it('falls back to the last reported URL when the page cannot answer, and waits at most a second', async () => {
    vi.useFakeTimers()
    const { client, ev } = await collector()
    client.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://app.example/a' } })
    ev.beginStep(0)
    client.href = () => Promise.reject(new Error('Execution context was destroyed'))
    await ev.endStep()
    ev.beginStep(1)
    client.href = () => new Promise(() => undefined) // a page that never answers
    const ended = ev.endStep()
    await vi.advanceTimersByTimeAsync(1_000)
    await ended
    ev.stop()
    expect([ev.forStep(0)?.url, ev.forStep(1)?.url]).toEqual(['https://app.example/a', 'https://app.example/a'])
  })

  it('enables the domains it listens on and reads the main frame', async () => {
    const { client, ev } = await collector()
    expect(client.sent, 'domains enabled by start()').toEqual(
      expect.arrayContaining(['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.getFrameTree'])
    )
    expect(ev.finalUrl(), 'URL from Page.getFrameTree before any navigation').toBe('about:blank')
  })

  it('files console errors and exceptions under the step running when they arrive, and ignores other levels', async () => {
    const { client, ev } = await collector()
    ev.beginStep(0)
    client.emit('Runtime.consoleAPICalled', consoleError('save failed:', { code: 7 }))
    client.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'just a log' }] })
    client.emit('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'a warning' }] })
    ev.beginStep(1)
    client.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is undefined' } } })
    client.emit('Log.entryAdded', { entry: { level: 'error', source: 'security', text: 'Refused to frame' } })
    client.emit('Log.entryAdded', { entry: { level: 'warning', source: 'other', text: 'deprecated' } })
    ev.stop()

    expect(ev.forStep(0)?.consoleErrors, 'step 0: only the console.error').toEqual([
      { source: 'console', message: 'save failed: {"code":7}' }
    ])
    expect(ev.forStep(1)?.consoleErrors, 'step 1: the exception and the error-level log entry').toEqual([
      { source: 'exception', message: 'TypeError: x is undefined' },
      { source: 'log', message: 'Refused to frame' }
    ])
  })

  it('leaves out network log lines, which repeat the failed request', async () => {
    const { client, ev } = await collector()
    ev.beginStep(0)
    client.emit('Log.entryAdded', {
      entry: { level: 'error', source: 'network', text: 'Failed to load resource: the server responded with a status of 500' }
    })
    ev.stop()
    expect(ev.forStep(0)?.consoleErrors, 'network log entry kept as a console error').toBeUndefined()
  })

  it('files a failed request under the step that sent it, even when it fails during a later step', async () => {
    const { client, ev } = await collector()
    ev.beginStep(0)
    client.emit('Network.requestWillBeSent', request('r1', 'https://app.example/api/save'))
    client.emit('Network.requestWillBeSent', request('r2', 'https://app.example/api/ok'))
    ev.beginStep(1)
    client.emit('Network.responseReceived', { requestId: 'r1', response: { status: 503 } })
    client.emit('Network.responseReceived', { requestId: 'r2', response: { status: 204 } })
    client.emit('Network.loadingFinished', { requestId: 'r2' })
    client.emit('Network.requestWillBeSent', { ...request('r3', 'https://nowhere.invalid/x.png'), type: 'Image', request: { method: 'GET', url: 'https://nowhere.invalid/x.png' } })
    client.emit('Network.loadingFailed', { requestId: 'r3', errorText: 'net::ERR_NAME_NOT_RESOLVED' })
    ev.stop()

    expect(ev.forStep(0)?.failedRequests, 'step 0 sent r1 (503); r2 succeeded').toEqual([
      { method: 'POST', url: 'https://app.example/api/save', resource_type: 'Fetch', status: 503 }
    ])
    expect(ev.forStep(1)?.failedRequests, 'step 1 sent r3, which never got a response').toEqual([
      { method: 'GET', url: 'https://nowhere.invalid/x.png', resource_type: 'Image', error: 'net::ERR_NAME_NOT_RESOLVED' }
    ])
  })

  it('leaves out cancelled requests and names a blocked one by its reason', async () => {
    const { client, ev } = await collector()
    ev.beginStep(0)
    client.emit('Network.requestWillBeSent', request('c', 'https://app.example/aborted'))
    client.emit('Network.loadingFailed', { requestId: 'c', errorText: 'net::ERR_ABORTED', canceled: true })
    client.emit('Network.requestWillBeSent', request('b', 'https://tracker.example/t'))
    client.emit('Network.loadingFailed', { requestId: 'b', errorText: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'inspector' })
    ev.stop()
    expect(ev.forStep(0)?.failedRequests).toEqual([
      { method: 'POST', url: 'https://tracker.example/t', resource_type: 'Fetch', error: 'blocked: inspector' }
    ])
  })

  it('keeps what happened while the target was opening under index -1, without a URL', async () => {
    const { client, ev } = await collector()
    client.emit('Network.requestWillBeSent', request('o', 'https://app.example/missing.css'))
    client.emit('Network.responseReceived', { requestId: 'o', response: { status: 404 } })
    client.emit('Runtime.consoleAPICalled', consoleError('boot failed'))
    ev.beginStep(0)
    ev.stop()
    expect(ev.forStep(-1)).toEqual({
      failedRequests: [{ method: 'POST', url: 'https://app.example/missing.css', resource_type: 'Fetch', status: 404 }],
      consoleErrors: [{ source: 'console', message: 'boot failed' }]
    })
  })

  it('scrubs secret values from messages and URLs, and token-like parameters and credentials from URLs', async () => {
    const { client, ev } = await collector()
    ev.beginStep(0)
    client.emit('Runtime.consoleAPICalled', consoleError(`login failed for password ${SECRET}`))
    client.emit('Network.requestWillBeSent', request('s', `https://user:pw@app.example/search?q=${SECRET}&access_token=abc123&page=2`))
    client.emit('Network.responseReceived', { requestId: 's', response: { status: 401 } })
    client.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://app.example/reset?token=t0ps3cret&lang=en' } })
    ev.stop()

    const e = ev.forStep(0)
    const all = JSON.stringify(e)
    expect(all.includes(SECRET), `secret value in ${all}`).toBe(false)
    expect(all.includes('abc123') || all.includes('t0ps3cret') || all.includes('user:pw'), `token or credentials in ${all}`).toBe(false)
    expect(e?.consoleErrors?.[0].message).toBe('login failed for password [secret]')
    expect(e?.failedRequests?.[0].url).toBe('https://app.example/search?q=[secret]&page=2')
    expect(e?.url).toBe('https://app.example/reset?lang=en')
  })

  it('shortens data: URLs to their type and long messages to 1000 characters', async () => {
    const { client, ev } = await collector()
    ev.beginStep(0)
    client.emit('Network.requestWillBeSent', request('d', `data:image/png;base64,${'A'.repeat(5000)}`))
    client.emit('Network.loadingFailed', { requestId: 'd', errorText: 'net::ERR_INVALID_URL' })
    client.emit('Runtime.consoleAPICalled', consoleError('x'.repeat(5000)))
    ev.stop()
    const e = ev.forStep(0)
    expect(e?.failedRequests?.[0].url).toBe('data:image/png,…')
    expect(e?.consoleErrors?.[0].message.length, 'clipped message length (1000 + ellipsis)').toBe(1001)
  })

  it(`keeps at most ${MAX_ENTRIES_PER_STEP} of each kind per step and counts the rest`, async () => {
    const { client, ev } = await collector()
    ev.beginStep(0)
    for (let i = 0; i < MAX_ENTRIES_PER_STEP + 5; i++) {
      client.emit('Runtime.consoleAPICalled', consoleError(`error ${i}`))
      client.emit('Network.requestWillBeSent', request(`r${i}`, `https://app.example/${i}`))
      client.emit('Network.responseReceived', { requestId: `r${i}`, response: { status: 500 } })
    }
    ev.stop()
    const e = ev.forStep(0)
    expect(e?.consoleErrors).toHaveLength(MAX_ENTRIES_PER_STEP)
    expect(e?.consoleErrorsDropped).toBe(5)
    expect(e?.failedRequests).toHaveLength(MAX_ENTRIES_PER_STEP)
    expect(e?.failedRequestsDropped).toBe(5)
  })

  it('records the main-frame URL after each step, following same-document navigations but not iframes', async () => {
    const { client, ev } = await collector()
    client.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://app.example/login' } })
    ev.beginStep(0)
    client.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://app.example/home' } })
    client.emit('Page.frameNavigated', { frame: { id: 'AD', parentId: 'MAIN', url: 'https://ads.example/frame' } })
    ev.beginStep(1)
    client.emit('Page.navigatedWithinDocument', { frameId: 'MAIN', url: 'https://app.example/home#/invoices' })
    client.emit('Page.navigatedWithinDocument', { frameId: 'AD', url: 'https://ads.example/frame#x' })
    ev.beginStep(2)
    ev.stop()
    expect([0, 1, 2].map((i) => ev.forStep(i)?.url)).toEqual([
      'https://app.example/home',
      'https://app.example/home#/invoices',
      'https://app.example/home#/invoices'
    ])
    expect(ev.finalUrl()).toBe('https://app.example/home#/invoices')
  })

  it('after the last step, waits for the requests it sent, but not for ones earlier steps left open', async () => {
    vi.useFakeTimers()
    const { client, ev } = await collector()
    ev.beginStep(0)
    client.emit('Network.requestWillBeSent', request('poll', 'https://app.example/long-poll')) // never finishes
    ev.beginStep(1)
    client.emit('Network.requestWillBeSent', request('submit', 'https://app.example/api/submit'))
    let settled = false
    const done = ev.settle().then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(100)
    expect(settled, "settle returned while the last step's request was still open").toBe(false)
    client.emit('Network.responseReceived', { requestId: 'submit', response: { status: 502 } })
    await vi.advanceTimersByTimeAsync(25)
    await done
    expect(settled).toBe(true)
    ev.stop()
    expect(ev.forStep(1)?.failedRequests?.map((r) => r.status), 'the late 502 is on the last step').toEqual([502])
  })

  it("stops waiting after half a second when the last step's request never finishes", async () => {
    vi.useFakeTimers()
    const { client, ev } = await collector()
    ev.beginStep(0)
    client.emit('Network.requestWillBeSent', request('stream', 'https://app.example/events'))
    let settled = false
    const done = ev.settle().then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(475)
    expect(settled, 'gave up before 500 ms').toBe(false)
    await vi.advanceTimersByTimeAsync(25)
    await done
    expect(settled).toBe(true)
  })

  it('ignores same-document navigations while the main frame is unknown (an iframe could pass for the page)', async () => {
    const { client, ev } = await collector(new FakeClient(null))
    ev.beginStep(0)
    client.emit('Page.navigatedWithinDocument', { frameId: 'AD', url: 'https://ads.example/frame#x' })
    ev.stop()
    expect(ev.forStep(0)?.url).toBeUndefined()
    expect(ev.finalUrl()).toBeUndefined()
  })

  it('keeps the URL fragment of the page it was attached to', async () => {
    const { ev } = await collector(new FakeClient({ frameTree: { frame: { id: 'M', url: 'https://app.example/app', urlFragment: '#/route' } } }))
    expect(ev.finalUrl()).toBe('https://app.example/app#/route')
  })

  it("ignores other sessions' events, survives malformed events, and stops listening on stop()", async () => {
    const { client, ev } = await collector()
    ev.beginStep(0)
    client.emit('Runtime.consoleAPICalled', consoleError('another tab'), 'OTHER')
    expect(() => {
      client.emit('Runtime.consoleAPICalled', { type: 'error', args: [null, 42] })
      client.emit('Network.responseReceived', { requestId: 'never-sent', response: { status: 500 } })
      client.emit('Network.loadingFailed', {})
      client.emit('Page.frameNavigated', {})
      client.emit('Log.entryAdded', {})
    }, 'a malformed event threw into the read loop').not.toThrow()
    ev.stop()
    expect(client.listenerCount(), 'listeners left after stop()').toBe(0)
    client.emit('Runtime.consoleAPICalled', consoleError('after stop'))
    expect(ev.forStep(0)?.consoleErrors, 'only the malformed same-session error is kept').toHaveLength(1)
    expect(ev.forStep(5), 'a step that collected nothing').toBeUndefined()
  })

  it('step times follow the wall clock across a suspend or clock step, with sub-millisecond precision', () => {
    const real = Date.now()
    const spy = vi.spyOn(Date, 'now')
    try {
      spy.mockReturnValue(real)
      expect(Math.abs(wallClockMs() - real), 'close to Date.now()').toBeLessThan(3)
      spy.mockReturnValue(real + 3_600_000) // the laptop slept an hour: the monotonic clock did not move
      expect(Math.abs(wallClockMs() - (real + 3_600_000)), 'follows the jump').toBeLessThan(3)
    } finally {
      spy.mockRestore()
    }
  })

  it('still works when the client cannot subscribe or a domain refuses to enable', async () => {
    const bare = { send: async <T>() => ({}) as T }
    const ev = new EvidenceCollector(bare, SESSION, redact)
    await expect(ev.start()).resolves.toBeUndefined()
    ev.beginStep(0)
    ev.stop()
    expect(ev.forStep(0)).toBeUndefined()

    const refusing = new FakeClient()
    refusing.send = async (method: string) => {
      throw new Error(`${method} not allowed`)
    }
    const ev2 = new EvidenceCollector(refusing, SESSION, redact)
    await expect(ev2.start(), 'a refused Network.enable must not fail the run').resolves.toBeUndefined()
  })
})
