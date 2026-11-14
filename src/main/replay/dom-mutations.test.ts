import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOM_WORLD, DomMutationCounter, observerSource } from './dom-mutations'

type Listener = (event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void

const SESSION = 'S1'
const READ = 'globalThis.__nawiDom?.read()'

/** A CDP client double: records commands with their params, answers reads of the page's totals from a queue. */
class FakeClient {
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = []
  /** What each `__nawiDom.read()` answers, in order; a function may never settle. */
  readonly reads: Array<unknown | (() => Promise<unknown>)> = []
  /** Makes every command hang (a page stuck in a script). */
  hang = false
  /** Holds `Page.addScriptToEvaluateOnNewDocument` until released (a slow page at start). */
  holdAddScript: Promise<void> | undefined
  private readonly listeners = new Map<string, Set<Listener>>()

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.sent.push({ method, params })
    if (this.hang) return new Promise<T>(() => undefined)
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'MAIN' } } } as T
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      await this.holdAddScript
      return { identifier: 'script-1' } as T
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 } as T
    if (method === 'Runtime.evaluate' && params.expression === READ) {
      const next = this.reads.shift()
      const value = typeof next === 'function' ? await (next as () => Promise<unknown>)() : next
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

  /** Context ids the reads went to, in order. */
  readContexts(): unknown[] {
    return this.sent.filter((c) => c.method === 'Runtime.evaluate' && c.params.expression === READ).map((c) => c.params.contextId)
  }
}

/** The page's running totals for document `doc`. */
const totals = (doc: string, added: number, removed = 0, attributes = 0, text = 0, fresh = false) => ({ doc, fresh, added, removed, attributes, text })

async function counter(client = new FakeClient()): Promise<{ client: FakeClient; dom: DomMutationCounter }> {
  const dom = new DomMutationCounter(client, SESSION)
  await dom.start()
  return { client, dom }
}

describe('DomMutationCounter (roadmap DT1c)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('installs the observer in its own isolated world, for new documents and into the current main frame', async () => {
    const { client } = await counter()
    const add = client.sent.find((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument')
    expect(add?.params, 'new documents: isolated world, marked fresh').toEqual({ source: observerSource(true), worldName: DOM_WORLD })
    expect(client.sent.find((c) => c.method === 'Page.createIsolatedWorld')?.params).toEqual({ frameId: 'MAIN', worldName: DOM_WORLD })
    const install = client.sent.find((c) => c.method === 'Runtime.evaluate')
    expect(install?.params, 'the current document: not fresh, in the isolated world (never the page world)').toEqual({
      expression: observerSource(false),
      contextId: 7
    })
  })

  it("files the change since the previous read under the step running then: the opening's under -1, late renders under their step", async () => {
    const { client, dom } = await counter()
    client.reads.push(totals('d1', 120, 0, 3, 0, true), totals('d1', 122, 1, 7, 1, true), totals('d1', 127, 1, 7, 1, true), totals('d1', 127, 1, 7, 3, true))
    await dom.beginStep(0) // reads what the opening did
    await dom.beginStep(1) // reads step 0
    await dom.beginStep(2) // reads step 1
    await dom.finish() // reads step 2
    expect(dom.forStep(-1)).toEqual({ added: 120, removed: 0, attributes: 3, text: 0, navigated: true })
    expect(dom.forStep(0), 'only the first read of a document says it loaded').toEqual({ added: 2, removed: 1, attributes: 4, text: 1 })
    expect(dom.forStep(1)).toEqual({ added: 5, removed: 0, attributes: 0, text: 0 })
    expect(dom.forStep(2)).toEqual({ added: 0, removed: 0, attributes: 0, text: 2 })
  })

  it('a document installed into after it loaded (the one already open) is not reported as navigated', async () => {
    const { client, dom } = await counter()
    client.reads.push(totals('d0', 2, 0, 0, 0, false))
    await dom.beginStep(0)
    expect(dom.forStep(-1)).toEqual({ added: 2, removed: 0, attributes: 0, text: 0 })
  })

  it('counts a new document from zero, not as a difference from the one it left, and marks the step navigated', async () => {
    const { client, dom } = await counter()
    client.reads.push(totals('d1', 500, 0, 0, 0, true), totals('d2', 30, 0, 2, 0, true))
    await dom.beginStep(0)
    await dom.finish()
    expect(dom.forStep(0)).toEqual({ added: 30, removed: 0, attributes: 2, text: 0, navigated: true })
  })

  it('a read that times out loses nothing: the next read includes it (totals are never reset in the page)', async () => {
    const { client, dom } = await counter()
    client.reads.push(totals('d1', 10, 0, 0, 0, true), () => new Promise(() => undefined), totals('d1', 25, 2, 1, 0, true))
    await dom.beginStep(0)
    await dom.beginStep(1) // times out: step 0's read is missed
    await dom.finish()
    expect(dom.forStep(0)).toBeUndefined()
    expect(dom.forStep(1), "step 0's changes arrive with the next read").toEqual({ added: 15, removed: 2, attributes: 1, text: 0 })
  })

  it('adds up several reads of one step and keeps navigated once set', async () => {
    const { client, dom } = await counter()
    client.reads.push(totals('d1', 0), totals('d2', 3, 0, 0, 0, true), totals('d2', 4, 1))
    await dom.beginStep(0)
    await dom.finish()
    await dom.finish()
    expect(dom.forStep(0)).toEqual({ added: 4, removed: 1, attributes: 0, text: 0, navigated: true })
  })

  it("follows the main frame's world to each new document and ignores other worlds, frames and sessions", async () => {
    const { client, dom } = await counter()
    client.emit('Runtime.executionContextCreated', { context: { id: 9, name: DOM_WORLD, auxData: { frameId: 'IFRAME' } } })
    client.emit('Runtime.executionContextCreated', { context: { id: 10, name: '', auxData: { frameId: 'MAIN', isDefault: true } } })
    client.emit('Runtime.executionContextCreated', { context: { id: 11, name: DOM_WORLD, auxData: { frameId: 'MAIN' } } }, 'OTHER-SESSION')
    client.reads.push(totals('d1', 1))
    await dom.beginStep(0)
    client.emit('Runtime.executionContextCreated', { context: { id: 12, name: DOM_WORLD, auxData: { frameId: 'MAIN' } } })
    client.reads.push(totals('d2', 2, 0, 0, 0, true))
    await dom.beginStep(1)
    expect(client.readContexts(), 'reads go to the main frame world of this session only').toEqual([7, 12])
    expect(dom.forStep(0)).toEqual({ added: 2, removed: 0, attributes: 0, text: 0, navigated: true })
  })

  it("waits for the new document's world after a navigation cleared the old one, so its load stays on its step", async () => {
    const { client, dom } = await counter()
    client.reads.push(totals('d1', 1), totals('d2', 40, 0, 0, 0, true))
    await dom.beginStep(0)
    client.emit('Runtime.executionContextsCleared', {})
    vi.useFakeTimers()
    const reading = dom.beginStep(1)
    // The world is reported a moment after the read began waiting for it; the read goes out at once, not at the limit.
    await vi.advanceTimersByTimeAsync(20)
    client.emit('Runtime.executionContextCreated', { context: { id: 12, name: DOM_WORLD, auxData: { frameId: 'MAIN' } } })
    await vi.advanceTimersByTimeAsync(1)
    expect(client.readContexts(), 'read as soon as the world was reported').toEqual([7, 12])
    await vi.advanceTimersByTimeAsync(300)
    await reading
    expect(client.readContexts()).toEqual([7, 12])
    expect(dom.forStep(0)).toEqual({ added: 40, removed: 0, attributes: 0, text: 0, navigated: true })
  })

  it('reads nothing while there is no world (destroyed, never reported), and gives up waiting', async () => {
    const { client, dom } = await counter()
    client.emit('Runtime.executionContextDestroyed', { executionContextId: 7 })
    const started = performance.now()
    await dom.beginStep(0)
    await dom.finish()
    expect(performance.now() - started, 'each read waits READ_MS at most').toBeLessThan(1_500)
    expect(client.readContexts()).toEqual([])
    expect(dom.forStep(-1)).toBeUndefined()
    expect(dom.forStep(0)).toBeUndefined()
  })

  it.each([
    ['no observer in that world', undefined],
    ['a non-object', 'lots'],
    ['a negative count', { ...totals('d1', 1), removed: -1 }],
    ['a fractional count', { ...totals('d1', 1), text: 0.5 }],
    ['a missing count', { doc: 'd1', added: 1, removed: 0, attributes: 0, fresh: false }],
    ['no document id', { added: 1, removed: 0, attributes: 0, text: 0, fresh: false }]
  ])('files nothing for an answer that is not the totals (%s)', async (_label, answer) => {
    const { client, dom } = await counter()
    client.reads.push(answer)
    await dom.beginStep(0)
    expect(dom.forStep(-1)).toBeUndefined()
  })

  it('never holds the run on a page that stopped answering: a read gives up, stop does not wait', async () => {
    const { client, dom } = await counter()
    client.reads.push(() => new Promise(() => undefined))
    const started = performance.now()
    await dom.beginStep(0)
    expect(dom.forStep(-1)).toBeUndefined()
    client.hang = true
    await dom.stop()
    const took = performance.now() - started
    expect(took, `read + stop took ${took} ms on a hung page`).toBeLessThan(1_500)
  })

  it('a start the page never answers gives up instead of holding the run', async () => {
    const client = new FakeClient()
    client.hang = true
    const started = performance.now()
    const dom = new DomMutationCounter(client, SESSION)
    await dom.start()
    const took = performance.now() - started
    expect(took, `start took ${took} ms`).toBeLessThan(2_000)
    await dom.beginStep(0)
    expect(dom.forStep(-1)).toBeUndefined()
  })

  it('an install that finishes after the run stopped removes its script again, so the tab keeps no observer', async () => {
    const client = new FakeClient()
    let release!: () => void
    client.holdAddScript = new Promise<void>((done) => (release = done))
    const dom = new DomMutationCounter(client, SESSION)
    await dom.start() // gives up after START_MS
    await dom.stop()
    release()
    await new Promise((done) => setTimeout(done, 10))
    expect(client.sent.filter((c) => c.method === 'Page.removeScriptToEvaluateOnNewDocument').map((c) => c.params)).toEqual([{ identifier: 'script-1' }])
    expect(client.sent.some((c) => c.method === 'Page.createIsolatedWorld'), 'nothing more is installed').toBe(false)
  })

  it('stop removes the script and the observer, unsubscribes, and reads nothing after', async () => {
    const { client, dom } = await counter()
    await dom.stop()
    expect(client.sent.find((c) => c.method === 'Page.removeScriptToEvaluateOnNewDocument')?.params).toEqual({ identifier: 'script-1' })
    expect(client.sent.some((c) => c.method === 'Runtime.evaluate' && c.params.expression === 'globalThis.__nawiDom?.stop()' && c.params.contextId === 7)).toBe(true)
    expect(client.listenerCount()).toBe(0)
    client.reads.push(totals('d1', 5))
    await dom.finish()
    expect(client.readContexts()).toEqual([])
  })

  it('a client without events (no on()) records nothing and never throws', async () => {
    const plain = { send: async <T>(): Promise<T> => ({}) as T }
    const dom = new DomMutationCounter(plain, SESSION)
    await dom.start()
    await dom.beginStep(0)
    await dom.finish()
    await dom.stop()
    expect(dom.forStep(0)).toBeUndefined()
  })
})
