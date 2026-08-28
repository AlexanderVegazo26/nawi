/**
 * Main-side half of the page probe: installing it, and resolving what it marked.
 *
 * `probe.js` is the single source of the page-side logic and is inlined here as
 * a string via Vite's `?raw` — one file, no stringified copy to drift.
 */

import probeSource from './inject/probe.js?raw'
import { rankCandidates, type RankedSelector, type SelectorDescriptor } from './selectors'

/** Just enough of `CdpClient` to keep this module independently testable. */
export interface ProbeClient {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T>
}

export interface ProbeConfig {
  /** FR-SEC.2 workspace-configured secret selectors. */
  secretSelectors?: string[]
}

/** The attribute `probe.js` stamps on secret elements. Kept in sync by the test suite. */
export const SECRET_MARKER_ATTRIBUTE = 'data-nawi-secret-target'

export function buildProbeSource(config: ProbeConfig = {}): string {
  const payload = JSON.stringify({ secretSelectors: config.secretSelectors ?? [] })
  return `window.__NAWI_PROBE_CONFIG__ = ${payload};\n${probeSource}`
}

/**
 * Install the probe so it is present in every document of this session,
 * including ones created by a navigation, *and* in the document that is already
 * loaded — `addScriptToEvaluateOnNewDocument` alone does nothing for a page
 * that has already parsed, which is the usual "it silently did not run" trap.
 *
 * **Precondition this hands to the caller:** installing the probe does *not*
 * mark anything. It only makes `markSecrets` available. Until
 * `markAndResolveSecrets` has run against a given document, no element carries
 * the marker attribute and any `DOMSnapshot.captureSnapshot` taken in that
 * window is unfiltered — and a raw snapshot demonstrably contains password
 * field values (asserted in `cdp.integration.test.ts`). So the required order
 * per document is: `injectProbe` → navigation settles →
 * `markAndResolveSecrets` → `captureSnapshot`. A navigation resets this: the
 * new document needs its own `markAndResolveSecrets` call.
 */
export async function injectProbe(
  client: ProbeClient,
  config: ProbeConfig = {},
  sessionId?: string
): Promise<void> {
  const source = buildProbeSource(config)
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId)
  await client.send('Runtime.evaluate', { expression: source, returnByValue: true }, sessionId)
}

interface EvaluateResponse {
  result?: { value?: unknown }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

async function evaluate<T>(
  client: ProbeClient,
  expression: string,
  sessionId?: string
): Promise<T> {
  const response = await client.send<EvaluateResponse>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  )
  if (response.exceptionDetails) {
    // A page-side throw returns HTTP-200-shaped success at the protocol level.
    // Not raising here is how a probe failure becomes an empty, quietly wrong
    // harvest.
    const detail =
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text ??
      'unknown page exception'
    throw new Error(`probe evaluation failed: ${detail}`)
  }
  return response.result?.value as T
}

/** Ranked FR-STA.6 selectors for the element matching `selector`, or null if it is gone. */
export async function rankSelectorsFor(
  client: ProbeClient,
  selector: string,
  sessionId?: string
): Promise<RankedSelector[] | null> {
  const descriptors = await evaluate<SelectorDescriptor[] | null>(
    client,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      return el ? window.__nawiProbe.describeSelectors(el) : null })()`,
    sessionId
  )
  if (!descriptors) return null
  return rankCandidates(descriptors)
}

export interface SecretMarking {
  /** Elements newly stamped by this call. */
  marked: number
  /** Elements carrying the marker after this call — the set that must be filtered. */
  total: number
  /** DOM-domain ids for the marked elements. */
  backendNodeIds: number[]
}

interface DomNode {
  backendNodeId?: number
}

/**
 * Mark every secret element page-side, then resolve those elements to
 * `backendNodeId`s so a DOM snapshot can be filtered.
 *
 * Two steps, in this order, and in the round trip that *precedes*
 * `DOMSnapshot.captureSnapshot`: the page cannot see backendNodeIds, and a
 * snapshot taken before the marking has already serialized the secrets.
 *
 * Note this is Tier A defence only — suppression at ingest. It is not a
 * substitute for the write-path scan, which exists to catch the case where this
 * leaked.
 */
export async function markAndResolveSecrets(
  client: ProbeClient,
  sessionId?: string
): Promise<SecretMarking> {
  const marking = await evaluate<{ marked: number; total: number }>(
    client,
    'window.__nawiProbe.markSecrets()',
    sessionId
  )

  const { root } = await client.send<{ root: { nodeId: number } }>(
    'DOM.getDocument',
    { depth: -1, pierce: true },
    sessionId
  )
  const { nodeIds } = await client.send<{ nodeIds: number[] }>(
    'DOM.querySelectorAll',
    { nodeId: root.nodeId, selector: `[${SECRET_MARKER_ATTRIBUTE}]` },
    sessionId
  )

  const backendNodeIds: number[] = []
  for (const nodeId of nodeIds) {
    const described = await client.send<{ node: DomNode }>('DOM.describeNode', { nodeId }, sessionId)
    const backendNodeId = described.node?.backendNodeId
    if (typeof backendNodeId === 'number') backendNodeIds.push(backendNodeId)
  }

  return { marked: marking.marked, total: marking.total, backendNodeIds }
}
