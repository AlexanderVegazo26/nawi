/**
 * Roadmap DT1c: how much each step changed the page's DOM.
 *
 * A `MutationObserver` on the main frame's document counts nodes added and removed, attribute changes and text
 * changes. It runs in an isolated world of its own (`DOM_WORLD`), so the page under test cannot see, call or break
 * it, and its counters never show up among the page's globals. It is installed for every new document of the run
 * (`Page.addScriptToEvaluateOnNewDocument`) and once into the document that is already there.
 *
 * The page keeps running totals per document (with a random id for the document); reads are taken when a step
 * begins and once after the last step, and the difference since the previous read belongs to the step that was
 * running then (-1 = while the target was opening). So a change a step causes after it returned but before the next
 * step began (a fetch it sent re-renders a list) still lands on that step; one that lands later, while the next step
 * runs, is counted there (counts go by time, not by cause). Totals are never reset in the page, so a read that times
 * out loses nothing: the next read includes it.
 *
 * Limits, said plainly in the record: only the main frame's document is observed (not iframes, not the inside of
 * shadow roots); when a step loads a new document, the counts are that new document's (parsing included), the
 * document it left is no longer readable, and the step says `navigated`. A `style` attribute change that only adds
 * or removes `-webkit-text-security` is not counted: that is how Nawi masks fields holding a secret for its
 * screenshots, and the run's own screenshots are not the page's doing.
 *
 * Best effort and never into the run's result: a page that refuses the isolated world, or a read that takes longer
 * than `READ_MS`, leaves the step without counts (they go to the next read).
 */

import type { ReplayClient } from './replay'

/** What a step did to the main frame's DOM. */
export interface DomMutations {
  /** Nodes inserted (elements and text nodes alike). */
  added: number
  removed: number
  /** Attribute changes. */
  attributes: number
  /** Text (character data) changes. */
  text: number
  /** A new document loaded during the step: the counts are from it (its parsing included), not the one it left. */
  navigated?: true
}

/** The isolated world's name; the page's own scripts never run in it. */
export const DOM_WORLD = 'nawi-dom-mutations'
/** How long one read may take before it is left to the next one. */
const READ_MS = 300
/** How long installing the observer may take before the run goes on without counts (a page stuck in a script). */
const START_MS = 1_000
/** The style property Nawi's screenshot masking toggles (inject/replay.js `MASK_PROP`). */
export const MASK_PROP = '-webkit-text-security'

/** `promise`'s value, or undefined once `ms` passed (the promise is left to settle on its own). Never rejects. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.catch(() => undefined),
    new Promise<undefined>((done) => (timer = setTimeout(() => done(undefined), ms)))
  ]).finally(() => clearTimeout(timer))
}

type Event = { method: string; params: Record<string, unknown>; sessionId?: string }

/**
 * The observer, as source. `fresh`: the document is new (installed at its start), so a read says so. Top frame only,
 * once per world. `read()` answers the document's running totals and its id; `takeRecords()` first counts mutations
 * whose callback has not run yet.
 */
export function observerSource(fresh: boolean): string {
  return `(() => {
  if (globalThis.__nawiDom || window !== window.top) return
  const c = { added: 0, removed: 0, attributes: 0, text: 0 }
  const doc = Math.random().toString(36).slice(2) + Date.now().toString(36)
  const strip = (s) => (s || '').replace(/-webkit-text-security\\s*:[^;]*;?/gi, '').replace(/\\s+/g, '')
  const count = (records) => {
    for (const r of records) {
      if (r.type === 'childList') { c.added += r.addedNodes.length; c.removed += r.removedNodes.length }
      else if (r.type === 'attributes') {
        // Nawi's own screenshot masking (only ${MASK_PROP} changed) is not the page's doing.
        if (r.attributeName === 'style' && strip(r.oldValue) === strip(r.target.getAttribute('style'))) continue
        c.attributes++
      } else c.text++
    }
  }
  const observer = new MutationObserver(count)
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true })
  Object.defineProperty(globalThis, '__nawiDom', { value: {
    read() {
      count(observer.takeRecords())
      return { doc, fresh: ${fresh ? 'true' : 'false'}, added: c.added, removed: c.removed, attributes: c.attributes, text: c.text }
    },
    stop() { observer.disconnect() }
  } })
})()`
}

/** The page's answer to a read: running totals of one document. */
interface Totals {
  doc: string
  fresh: boolean
  added: number
  removed: number
  attributes: number
  text: number
}

export class DomMutationCounter {
  private readonly offs: Array<() => void> = []
  private scriptId: string | undefined
  private mainFrameId: string | undefined
  /** The isolated world of the main frame's current document. */
  private contextId: number | undefined
  /** Wakes a read waiting for the new document's world. */
  private contextWaiter: (() => void) | undefined
  /** The step running now (-1 = opening the target). */
  private current = -1
  /** The last totals read, to subtract from the next read of the same document. */
  private last: Totals | undefined
  private readonly byStep = new Map<number, DomMutations>()
  private stopped = false

  constructor(
    private readonly client: ReplayClient,
    private readonly sessionId: string | undefined
  ) {}

  /** Installs the observer for every new document and into the current one. Never throws, never waits past START_MS. */
  async start(): Promise<void> {
    await within(this.install(), START_MS)
  }

  private async install(): Promise<void> {
    const on = this.client.on?.bind(this.client)
    if (!on) return
    const mine = (listener: (event: Event) => void) => (event: Event) => {
      if (this.stopped || event.sessionId !== this.sessionId) return
      try {
        listener(event)
      } catch {
        // Never into the CDP read loop.
      }
    }
    this.offs.push(
      on('Runtime.executionContextCreated', mine((e) => this.onContext(e.params))),
      on('Runtime.executionContextDestroyed', mine((e) => this.onContextGone(e.params))),
      on('Runtime.executionContextsCleared', mine(() => (this.contextId = undefined)))
    )
    try {
      const tree = await this.client.send<{ frameTree?: { frame?: { id?: unknown } } }>('Page.getFrameTree', {}, this.sessionId)
      const id = tree?.frameTree?.frame?.id
      if (typeof id === 'string') this.mainFrameId = id
      const added = await this.client.send<{ identifier?: unknown }>(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: observerSource(true), worldName: DOM_WORLD },
        this.sessionId
      )
      if (typeof added?.identifier === 'string') {
        // start() gave up and the run already stopped: never leave the observer on the tab's future documents.
        if (this.stopped) {
          await this.client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier }, this.sessionId)
          return
        }
        this.scriptId = added.identifier
      }
      await this.client.send('Runtime.enable', {}, this.sessionId)
      if (this.mainFrameId === undefined || this.stopped) return
      const world = await this.client.send<{ executionContextId?: unknown }>(
        'Page.createIsolatedWorld',
        { frameId: this.mainFrameId, worldName: DOM_WORLD },
        this.sessionId
      )
      if (typeof world?.executionContextId !== 'number' || this.stopped) return
      this.contextId = world.executionContextId
      await this.client.send('Runtime.evaluate', { expression: observerSource(false), contextId: world.executionContextId }, this.sessionId)
    } catch {
      // A page without counts still replays.
    }
  }

  /** Step `index` begins: what changed since the last read belongs to the step before it. */
  async beginStep(index: number): Promise<void> {
    await this.read()
    this.current = index
  }

  /** After the last step (and its settle): the last read, filed under the last step. */
  async finish(): Promise<void> {
    await this.read()
  }

  /**
   * Removes the observer from future documents and disconnects the current one. Never throws, and never waits on a
   * page that stopped answering (READ_MS at most): the run's result does not depend on it.
   */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.contextWaiter?.()
    for (const off of this.offs) off()
    this.offs.length = 0
    const send = (method: string, params: Record<string, unknown>): Promise<unknown> => this.client.send(method, params, this.sessionId)
    await within(
      Promise.all([
        this.scriptId !== undefined ? send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId }) : undefined,
        this.contextId !== undefined
          ? send('Runtime.evaluate', { expression: 'globalThis.__nawiDom?.stop()', contextId: this.contextId })
          : undefined
      ]),
      READ_MS
    )
  }

  /** What step `index` changed (-1: while the target was opening); undefined when nothing was read for it. */
  forStep(index: number): DomMutations | undefined {
    return this.byStep.get(index)
  }

  /**
   * Reads the page's totals and files the difference under the current step. Right after a navigation the new
   * document's world may not be reported yet: wait for it (within READ_MS) rather than leave its load to a later step.
   */
  private async read(): Promise<void> {
    if (this.stopped) return
    if (this.contextId === undefined) {
      await within(new Promise<void>((done) => (this.contextWaiter = done)), READ_MS)
      this.contextWaiter = undefined
    }
    const contextId = this.contextId
    if (this.stopped || contextId === undefined) return
    const answer = await within(
      this.client.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: 'globalThis.__nawiDom?.read()', contextId, returnByValue: true },
        this.sessionId
      ),
      READ_MS
    )
    const totals = parseTotals(answer?.result?.value)
    if (!totals) return
    const same = this.last?.doc === totals.doc ? this.last : undefined
    const diff = (k: 'added' | 'removed' | 'attributes' | 'text'): number => Math.max(0, totals[k] - (same?.[k] ?? 0))
    this.last = totals
    const prior = this.byStep.get(this.current)
    // A document seen for the first time that was installed at its start loaded during this step.
    const navigated = prior?.navigated === true || (same === undefined && totals.fresh)
    this.byStep.set(this.current, {
      added: (prior?.added ?? 0) + diff('added'),
      removed: (prior?.removed ?? 0) + diff('removed'),
      attributes: (prior?.attributes ?? 0) + diff('attributes'),
      text: (prior?.text ?? 0) + diff('text'),
      ...(navigated ? { navigated: true as const } : {})
    })
  }

  private onContext(p: Record<string, unknown>): void {
    const context = p.context as { id?: unknown; name?: unknown; auxData?: { frameId?: unknown } } | undefined
    if (context?.name !== DOM_WORLD || typeof context.id !== 'number') return
    // The main frame keeps its id across navigations; without a known id, a context naming no frame is not trusted.
    if (this.mainFrameId === undefined || context.auxData?.frameId !== this.mainFrameId) return
    this.contextId = context.id
    this.contextWaiter?.()
  }

  private onContextGone(p: Record<string, unknown>): void {
    if (p.executionContextId === this.contextId) this.contextId = undefined
  }
}

/** The observer's answer, or undefined when it is not one (no observer in that world, a page that tampered). */
function parseTotals(value: unknown): Totals | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const n = (x: unknown): number | undefined => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : undefined)
  const added = n(v.added)
  const removed = n(v.removed)
  const attributes = n(v.attributes)
  const text = n(v.text)
  if (typeof v.doc !== 'string' || added === undefined || removed === undefined || attributes === undefined || text === undefined) return undefined
  return { doc: v.doc, fresh: v.fresh === true, added, removed, attributes, text }
}
