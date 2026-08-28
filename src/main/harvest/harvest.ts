/**
 * FR-STA.1-5 — subscribes to a CDP session and fills a `SidecarDraft`.
 *
 * ## Ordering, which is a precondition and not a suggestion
 *
 * Per document: `injectProbe` → navigation settles → `markAndResolveSecrets` →
 * `DOMSnapshot.captureSnapshot`. `injectProbe` only makes `markSecrets`
 * *available*; it does not mark. A snapshot taken before marking genuinely
 * contains password values — `cdp.integration.test.ts` asserts that leak
 * directly. Every navigation resets it, so each new document needs its own
 * marking pass. `captureDom()` below does the marking and the snapshot together
 * so the two cannot drift apart, and it re-marks on every call.
 *
 * ## Clocks — a correction to the handover, measured rather than assumed
 *
 * The brief handed over said `Runtime.consoleAPICalled.timestamp` is CDP
 * `MonotonicTime` in seconds and must go through `monotonicToTMs`. **That is not
 * what this Chromium sends.** Measured against a live browser
 * (Chromium via the project's Playwright devDependency):
 *
 * ```
 * Date.now()                                 = 1787944238527
 * Runtime.consoleAPICalled.timestamp         = 1787944238151.106   ← epoch ms
 * Runtime.exceptionThrown.timestamp          = 1787944238530.468   ← epoch ms
 * Log.entryAdded.entry.timestamp             = 1787944238533.457   ← epoch ms
 * Network.requestWillBeSent.timestamp        =      280537.547401  ← monotonic s
 * Network.requestWillBeSent.wallTime         = 1787944238.210474   ← epoch s
 * ```
 *
 * This agrees with the CDP spec, where those three fields are typed
 * `Runtime.Timestamp` ("milliseconds since epoch") and only the `Network.*`
 * fields are `Network.MonotonicTime`. So:
 *
 *  - `consoleAPICalled` / `exceptionThrown` / `Log.entryAdded` → `browserToTMs`
 *  - `Network.*` → `monotonicToTMs`
 *
 * The handover's *warning* still stands — mixing the two is a ~54-year error —
 * it was simply attached to the wrong events. Do not "fix" this back.
 *
 * ## Resolution is deferred to `finish()`
 *
 * `browserToTMs` returns null until the clock has been calibrated. Resolving at
 * receipt would therefore silently drop every entry that arrived before the
 * first calibration round trip — exactly the FR-STA.3 preamble the ring buffer
 * exists to preserve. Raw timestamps are buffered and converted once, at the
 * end, so a late calibration retroactively rescues early events and DC-1 drops
 * only what genuinely cannot be placed.
 */

import { randomBytes } from 'node:crypto'
import { markUnavailable, setSource, type SidecarDraft } from '@shared/sidecar/draft'
import type {
  ConsoleLevel,
  InputEvent,
  InputTarget,
  SelectorCandidate,
  SelectorStrategy,
  UnavailableReason,
  UnavailableSource
} from '@shared/sidecar/types'
import type { RevisionFile } from '../sidecar/store'
import type { CaptureClock } from '../cdp/clock'
import { calibrateBrowserClock } from '../cdp/clock'
import { injectProbe, markAndResolveSecrets, type ProbeConfig } from '../cdp/probe'
import { rankCandidates, type SelectorDescriptor } from '../cdp/selectors'
import { HarBuilder } from './har'
import { RingBuffer } from './ring'
import { buildAxTree, filterSecretsFromSnapshot, type CapturedSnapshot } from './snapshot'
import listenerSource from './inject/listener.js?raw'

/** Just enough of `CdpClient` to keep this module testable without a socket. */
export interface HarvestClient {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T>
  on(method: string, listener: (event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void): () => void
}

/**
 * The binding the page-side listener calls, and the nonce every payload must
 * carry.
 *
 * **What this defends against, and what it does not.** `Runtime.addBinding`
 * installs a real function on the page's `window`, so the page can always call
 * it — that is the mechanism, not a flaw in it. The risk is not disclosure (the
 * page already has its own secrets); it is **agent-context poisoning**: the
 * state layer is built to be fed to an agent, so a page that can write
 * `input_events.ndjson` has an indirect prompt-injection channel into whatever
 * later reads `get_state_layer`.
 *
 * With a fixed name, forging an entry was a one-liner against a constant any
 * page author could read out of this repository. A per-session random name and
 * nonce mean a page must first *discover* both by scraping its own injected
 * script — still possible, and honestly so. This is blast-radius reduction, not
 * closure. **Anything downstream must keep treating the state layer as
 * untrusted input**; the nonce raises the cost of forgery, it does not
 * authenticate the source.
 */
function randomToken(): string {
  return randomBytes(16).toString('hex')
}

export const FILE_PATHS = Object.freeze({
  dom: 'dom/snapshot.json',
  ax: 'ax/tree.json',
  har: 'network.har',
  console: 'console.ndjson',
  input: 'input_events.ndjson'
})

/**
 * FR-SEC.2's acceptance names `{type: "input", …}`, but DC-4's `InputEventType`
 * union does not include `input`. Widening the shared union would ripple into
 * the schema, its compile-time equality assertion, and existing tests — a shared
 * contract this milestone does not own. The NDJSON side files are not validated
 * by `parseSidecarStrict` (only the `{path, count}` ref is), so the line shape
 * is widened locally instead. Recorded in the handover, not fudged.
 */
export type HarvestedInputEvent = Omit<InputEvent, 'type'> & {
  type: InputEvent['type'] | 'input'
  key?: string
}

export interface HarvestOptions {
  client: HarvestClient
  sessionId: string
  clock: CaptureClock
  draft: SidecarDraft
  probe?: ProbeConfig
  bodyCapBytes?: number
  /** FR-STA.3's preamble window. */
  preambleMs?: number
  maxConsoleEntries?: number
  maxInputEntries?: number
}

export interface HarvestResult {
  files: RevisionFile[]
  /** Counts of entries dropped for want of a resolvable timestamp (DC-1). */
  droppedForTimestamp: { console: number; input: number; network: number }
  secretBackendNodeIds: number[]
  domFilter: { redirected: number; blanked: number; unmatched: number[] } | null
}

/** CDP `Log.LogEntry.level` and console types, mapped onto DC-4's narrower set. */
function toConsoleLevel(raw: unknown): ConsoleLevel {
  switch (raw) {
    case 'error':
    case 'assert':
      return 'error'
    case 'warning':
    case 'warn':
      return 'warn'
    case 'debug':
    case 'verbose':
      return 'debug'
    case 'info':
      return 'info'
    default:
      return 'log'
  }
}

/**
 * `selectors.ts` ranks with hyphenated strategy names; DC-4's `SelectorStrategy`
 * uses underscores. This is a conversion, not a cast — leaving it out makes
 * `parseSidecarStrict` reject the sidecar at the writer, which is a good place
 * to fail and a baffling one to debug.
 */
const STRATEGY_MAP: Record<string, SelectorStrategy> = {
  testid: 'testid',
  id: 'id',
  'role-name': 'role_name',
  css: 'css',
  'nth-child': 'nth_child'
}

function toSelectorCandidates(descriptors: unknown): SelectorCandidate[] {
  if (!Array.isArray(descriptors)) return []
  const ranked = rankCandidates(descriptors as SelectorDescriptor[])
  const out: SelectorCandidate[] = []
  for (const candidate of ranked) {
    const strategy = STRATEGY_MAP[candidate.strategy]
    if (!strategy) continue
    out.push({ strategy, value: candidate.selector, stability: candidate.stability })
  }
  return out
}

interface RawConsole {
  /** Browser epoch ms. */
  at: number
  level: ConsoleLevel
  message: string
  stack: string | null
}

interface RawInput {
  /** Browser epoch ms. */
  at: number
  payload: Record<string, unknown>
}

function argsToMessage(args: unknown): string {
  if (!Array.isArray(args)) return ''
  return args
    .map((arg) => {
      const obj = arg as { value?: unknown; description?: string; type?: string }
      if (obj?.description !== undefined) return obj.description
      if (obj?.value !== undefined) return typeof obj.value === 'string' ? obj.value : JSON.stringify(obj.value)
      return obj?.type ?? ''
    })
    .join(' ')
}

/**
 * Subscribes on construction. Nothing here throws into an event handler: a CDP
 * event is delivered on the socket's read loop, and an exception there takes the
 * whole harvest down silently.
 */
export class Harvester {
  private readonly unsubscribes: Array<() => void> = []
  private readonly console: RingBuffer<RawConsole>
  private readonly input: RingBuffer<RawInput>
  private readonly har: HarBuilder
  private readonly bodyFetches: Array<Promise<void>> = []
  private secretBackendNodeIds: number[] = []
  private domSnapshot: CapturedSnapshot | null = null
  private axNodes: unknown[] | null = null
  private domFilter: HarvestResult['domFilter'] = null
  private domCaptureTMs = 0
  private axCaptureTMs = 0
  private stopped = false
  /** Per-session, unguessable before injection. See `randomToken`. */
  readonly bindingName = `__nawiEmit_${randomToken()}`
  readonly bindingNonce = randomToken()

  private constructor(private readonly options: HarvestOptions) {
    const preambleMs = options.preambleMs ?? 30_000
    this.console = new RingBuffer<RawConsole>({
      windowMs: preambleMs,
      maxEntries: options.maxConsoleEntries ?? 20_000
    })
    this.input = new RingBuffer<RawInput>({
      windowMs: preambleMs,
      maxEntries: options.maxInputEntries ?? 50_000
    })
    const cap = options.bodyCapBytes
    this.har = new HarBuilder(cap === undefined ? {} : { bodyCapBytes: cap })
  }

  /**
   * Enables the domains, installs the probe and the input listener, and takes a
   * first clock calibration *before* subscribing — otherwise the earliest events
   * have no fit to resolve against and DC-1 drops them.
   */
  static async start(options: HarvestOptions): Promise<Harvester> {
    const { client, sessionId } = options
    const harvester = new Harvester(options)

    for (const domain of ['Runtime', 'Page', 'DOM', 'DOMSnapshot', 'Network', 'Accessibility', 'Log']) {
      await client.send(`${domain}.enable`, {}, sessionId)
    }

    await injectProbe(client, options.probe ?? {}, sessionId)
    await client.send('Runtime.addBinding', { name: harvester.bindingName }, sessionId)

    const source = listenerSource
      .replace('__NAWI_BINDING__', harvester.bindingName)
      .replace('__NAWI_NONCE__', harvester.bindingNonce)
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId)
    // `addScriptToEvaluateOnNewDocument` does nothing for the document that is
    // already parsed — the classic "it silently did not run" trap.
    await client.send('Runtime.evaluate', { expression: source, returnByValue: true }, sessionId)

    await calibrateBrowserClock(options.clock, client, sessionId)
    harvester.subscribe()
    return harvester
  }

  private subscribe(): void {
    const { client, clock } = this.options

    this.unsubscribes.push(
      client.on('Runtime.consoleAPICalled', (event) => {
        const p = event.params
        // Epoch ms — see the clock note at the top of this file.
        if (typeof p.timestamp !== 'number') return
        const stack = p.stackTrace as { callFrames?: unknown[] } | undefined
        this.console.push(clock.nowTMs(), {
          at: p.timestamp,
          level: toConsoleLevel(p.type),
          message: argsToMessage(p.args),
          stack: stack?.callFrames ? JSON.stringify(stack.callFrames) : null
        })
      })
    )

    this.unsubscribes.push(
      client.on('Runtime.exceptionThrown', (event) => {
        const p = event.params
        if (typeof p.timestamp !== 'number') return
        const details = p.exceptionDetails as
          | { text?: string; exception?: { description?: string }; stackTrace?: unknown }
          | undefined
        this.console.push(clock.nowTMs(), {
          at: p.timestamp,
          level: 'error',
          message: details?.exception?.description ?? details?.text ?? 'uncaught exception',
          stack: details?.stackTrace ? JSON.stringify(details.stackTrace) : null
        })
      })
    )

    this.unsubscribes.push(
      client.on('Log.entryAdded', (event) => {
        const entry = event.params.entry as
          | { timestamp?: number; level?: string; text?: string; stackTrace?: unknown }
          | undefined
        if (!entry || typeof entry.timestamp !== 'number') return
        this.console.push(clock.nowTMs(), {
          at: entry.timestamp,
          level: toConsoleLevel(entry.level),
          message: entry.text ?? '',
          stack: entry.stackTrace ? JSON.stringify(entry.stackTrace) : null
        })
      })
    )

    this.unsubscribes.push(
      client.on('Runtime.bindingCalled', (event) => {
        if (event.params.name !== this.bindingName) return
        const payload = event.params.payload
        if (typeof payload !== 'string') return
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(payload) as Record<string, unknown>
        } catch {
          // A page can call the binding with anything at all. Ignore junk;
          // never let it reach the read loop as a throw.
          return
        }
        // F8: a payload that does not carry this session's nonce did not come
        // from our injected listener. Rejected rather than recorded — see
        // `randomToken` for what this does and does not prove.
        if (parsed.nonce !== this.bindingNonce) return
        delete parsed.nonce
        const at = parsed.at
        if (typeof at !== 'number') return
        this.input.push(clock.nowTMs(), { at, payload: parsed })
      })
    )

    this.unsubscribes.push(
      client.on('Network.requestWillBeSent', (event) => {
        const p = event.params
        this.har.requestWillBeSent(p)
        // The free clock bridge: this one event carries both clocks.
        if (typeof p.timestamp === 'number' && typeof p.wallTime === 'number') {
          clock.addMonotonicBridge(p.timestamp, p.wallTime)
        }
      })
    )
    this.unsubscribes.push(
      client.on('Network.responseReceived', (event) => this.har.responseReceived(event.params))
    )
    this.unsubscribes.push(
      client.on('Network.loadingFailed', (event) => this.har.loadingFailed(event.params))
    )
    this.unsubscribes.push(
      client.on('Network.loadingFinished', (event) => {
        this.har.loadingFinished(event.params)
        this.fetchBody(event.params.requestId)
      })
    )
  }

  /**
   * Bodies are only retrievable for a short window after `loadingFinished` — a
   * navigation or an eviction makes the call reject with "No resource with given
   * identifier found". So fetch eagerly, and treat a rejection as an absent body
   * rather than a harvest failure. The absence is visible in the HAR (no `text`
   * on the content), which is the observable a reader needs.
   */
  private fetchBody(requestId: unknown): void {
    if (typeof requestId !== 'string' || this.stopped) return
    const promise = this.options.client
      .send<{ body?: string; base64Encoded?: boolean }>(
        'Network.getResponseBody',
        { requestId },
        this.options.sessionId
      )
      .then((response) => {
        if (typeof response.body !== 'string') return
        const text = response.base64Encoded
          ? Buffer.from(response.body, 'base64').toString('utf8')
          : response.body
        this.har.setResponseBody(requestId, text)
      })
      .catch(() => {
        // Expected for evicted/redirected/opaque resources. Recorded as a
        // missing body, never as a thrown harvest.
      })
    this.bodyFetches.push(promise)
  }

  /** FR-STA.3: stop rolling the preamble window; from here everything is kept. */
  markRecordingStarted(): void {
    this.console.closeWindow()
    this.input.closeWindow()
  }

  /** Re-samples the browser clock. Call periodically for FR-STA.7's drift fit. */
  async calibrate(): Promise<void> {
    await calibrateBrowserClock(this.options.clock, this.options.client, this.options.sessionId)
  }

  /**
   * FR-STA.1 / FR-STA.2, in the mandated order.
   *
   * Marking and snapshotting live in one method precisely so a caller cannot do
   * them out of order or forget to re-mark after a navigation. Safe to call
   * again; each call re-marks the current document.
   */
  async captureDom(): Promise<void> {
    const { client, sessionId, clock } = this.options

    const marking = await markAndResolveSecrets(client, sessionId)
    this.secretBackendNodeIds = marking.backendNodeIds
    // FR-SEC.2: the parameter names of the fields we just marked become
    // redaction keys for the HAR request-body control. Names, never values.
    this.har.addSecretFieldNames(marking.fieldNames)

    this.domCaptureTMs = clock.nowTMs()
    const raw = await client.send<CapturedSnapshot>(
      'DOMSnapshot.captureSnapshot',
      {
        computedStyles: ['display', 'position', 'visibility', 'opacity', 'overflow'],
        includeDOMRects: true,
        includePaintOrder: false
      },
      sessionId
    )

    // Tier A: filtered *before* it enters the draft, never after.
    const filtered = filterSecretsFromSnapshot(raw, this.secretBackendNodeIds)
    this.domSnapshot = filtered.snapshot
    this.domFilter = {
      redirected: filtered.redirected,
      blanked: filtered.blanked,
      unmatched: filtered.unmatched
    }

    this.axCaptureTMs = clock.nowTMs()
    const ax = await client.send<{ nodes?: unknown[] }>('Accessibility.getFullAXTree', {}, sessionId)
    this.axNodes = ax.nodes ?? []
  }

  /** Mirrors `markUnavailable` so a caller can record a source it could not attempt. */
  markUnavailable(source: UnavailableSource, reason: UnavailableReason): void {
    markUnavailable(this.options.draft, source, reason)
  }

  /**
   * Stops listening, resolves every buffered timestamp, and materializes the
   * side files. Every source ends either with a `setSource` or a
   * `markUnavailable` — never as an unexplained null, which `finalize` would
   * reject anyway (DC-2).
   */
  async finish(): Promise<HarvestResult> {
    this.stopped = true
    for (const off of this.unsubscribes) off()
    this.unsubscribes.length = 0
    await Promise.allSettled(this.bodyFetches)

    const { draft, clock } = this.options
    const files: RevisionFile[] = []
    const dropped = { console: 0, input: 0, network: 0 }

    // ---- FR-STA.1 DOM snapshot -------------------------------------------
    if (this.domSnapshot) {
      files.push({ path: FILE_PATHS.dom, contents: JSON.stringify(this.domSnapshot) })
      setSource(draft, 'dom_snapshot', { t_ms: this.domCaptureTMs, path: FILE_PATHS.dom })
    } else {
      markUnavailable(draft, 'dom_snapshot', 'capture_failed')
    }

    // ---- FR-STA.2 accessibility tree -------------------------------------
    if (this.axNodes) {
      const tree = buildAxTree(this.axNodes, this.domSnapshot, this.secretBackendNodeIds)
      files.push({ path: FILE_PATHS.ax, contents: JSON.stringify(tree) })
      setSource(draft, 'accessibility_tree', { t_ms: this.axCaptureTMs, path: FILE_PATHS.ax })
    } else {
      markUnavailable(draft, 'accessibility_tree', 'capture_failed')
    }

    // ---- FR-STA.3 console -------------------------------------------------
    const consoleLines: string[] = []
    for (const entry of this.console.values()) {
      // Epoch ms → T. Null means DC-1 says drop it, never zero it.
      const tMs = clock.browserToTMs(entry.at)
      if (tMs === null) {
        dropped.console++
        continue
      }
      consoleLines.push(
        JSON.stringify({
          t_ms: tMs,
          level: entry.level,
          message: entry.message,
          stack: entry.stack
        })
      )
    }
    files.push({
      path: FILE_PATHS.console,
      contents: consoleLines.length > 0 ? `${consoleLines.join('\n')}\n` : ''
    })
    setSource(draft, 'console_log', { path: FILE_PATHS.console, count: consoleLines.length })

    // ---- FR-STA.4 input events -------------------------------------------
    const inputLines: string[] = []
    for (const entry of this.input.values()) {
      const tMs = clock.browserToTMs(entry.at)
      if (tMs === null) {
        dropped.input++
        continue
      }
      inputLines.push(JSON.stringify(this.toInputEvent(tMs, entry.payload)))
    }
    files.push({
      path: FILE_PATHS.input,
      contents: inputLines.length > 0 ? `${inputLines.join('\n')}\n` : ''
    })
    setSource(draft, 'input_events', { path: FILE_PATHS.input, count: inputLines.length })

    // ---- FR-STA.5 network HAR --------------------------------------------
    // Monotonic seconds here, unlike everything above. See the clock note.
    const built = this.har.build((seconds) => clock.monotonicToTMs(seconds))
    dropped.network = built.dropped
    files.push({ path: FILE_PATHS.har, contents: JSON.stringify(built.har) })
    setSource(draft, 'network_har', { path: FILE_PATHS.har, truncated: built.truncated })

    return {
      files,
      droppedForTimestamp: dropped,
      secretBackendNodeIds: [...this.secretBackendNodeIds],
      domFilter: this.domFilter
    }
  }

  /**
   * Convert one probe payload into a sidecar input event.
   *
   * Note what is *not* here: a `value` fallback. If `value_redacted` is true the
   * probe never put a value in the payload, and this must not invent one — the
   * absence is the requirement.
   */
  private toInputEvent(tMs: number, payload: Record<string, unknown>): HarvestedInputEvent {
    const redacted = payload.value_redacted === true
    const role = typeof payload.target_role === 'string' ? payload.target_role : null
    const name = typeof payload.target_name === 'string' ? payload.target_name : null
    const selectors = toSelectorCandidates(payload.selectors)

    const coordinates = payload.coordinates as { x?: unknown; y?: unknown } | null | undefined
    const hasCoordinates =
      coordinates != null && typeof coordinates.x === 'number' && typeof coordinates.y === 'number'

    const target: InputTarget | null =
      role === null && name === null && selectors.length === 0
        ? null
        : {
            role,
            accessible_name: name,
            text: redacted ? null : typeof payload.value === 'string' ? payload.value : null,
            bounds: null,
            selectors
          }

    const type = payload.type
    const event: HarvestedInputEvent = {
      t_ms: tMs,
      type: (typeof type === 'string' ? type : 'click') as HarvestedInputEvent['type'],
      coordinates: hasCoordinates
        ? { x: coordinates.x as number, y: coordinates.y as number }
        : null,
      target,
      value_redacted: redacted
    }
    if (typeof payload.key === 'string') event.key = payload.key
    return event
  }
}
