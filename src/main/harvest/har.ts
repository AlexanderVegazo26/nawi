/**
 * FR-STA.5 — `Network.*` events accumulated into a HAR 1.2 log.
 *
 * Pure state machine over CDP event params, with no client and no clock of its
 * own, so the 256 KB body cap and the Tier A header stripping are unit-testable
 * without a browser.
 *
 * **Tier A lives here, at ingest.** `Authorization`, `Cookie` and `Set-Cookie`
 * are dropped while the entry is being *built*, not in a later pass over
 * finished entries — the same reasoning `probe.js` applies to a secret field's
 * value. A header that reaches a completed entry object has already been
 * retained somewhere, and "we deleted it afterwards" is not what FR-SEC.2 asks
 * for. Tier B still scans the serialized HAR afterwards, and a hit there means
 * this stripping missed something.
 */

/** FR-STA.5's default cap. Bodies larger than this are recorded as truncated. */
export const DEFAULT_BODY_CAP_BYTES = 256 * 1024

/**
 * Stripped unconditionally, case-insensitively. Not configurable: these three
 * are credentials by definition, and making the list a setting would make the
 * requirement a preference.
 */
export const STRIPPED_HEADERS = Object.freeze([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie'
])

const STRIPPED = new Set(STRIPPED_HEADERS)

export interface HarHeader {
  name: string
  value: string
}

/**
 * CDP hands headers back as an object with the wire casing preserved. Matching
 * lowercase means `AUTHORIZATION` and `Authorization` are both caught — a
 * case-sensitive compare here is a real, silent leak.
 */
export function toHarHeaders(headers: Record<string, unknown> | undefined): HarHeader[] {
  if (!headers) return []
  const out: HarHeader[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (STRIPPED.has(name.toLowerCase())) continue
    out.push({ name, value: typeof value === 'string' ? value : String(value) })
  }
  return out
}

export interface HarBody {
  size: number
  mimeType: string
  text?: string
  /** Present when the cap bit: HAR's own field for "we kept less than we saw". */
  comment?: string
}

/** Applies the byte cap. Truncation is recorded, never silent. */
export function capBody(
  text: string | undefined,
  mimeType: string,
  capBytes: number
): { body: HarBody; truncated: boolean } {
  if (text === undefined) return { body: { size: 0, mimeType }, truncated: false }
  const full = Buffer.from(text, 'utf8')
  if (full.byteLength <= capBytes) {
    return { body: { size: full.byteLength, mimeType, text }, truncated: false }
  }
  // Back the cut off to a UTF-8 character boundary first. Slicing at an
  // arbitrary byte and decoding non-fatally appends a U+FFFD for the split
  // sequence, which corrupts the tail of every capped body.
  let end = capBytes
  while (end > 0 && (full[end]! & 0b1100_0000) === 0b1000_0000) end--
  const kept = new TextDecoder('utf-8', { fatal: false }).decode(full.subarray(0, end))
  return {
    body: {
      size: full.byteLength,
      mimeType,
      text: kept,
      comment: `truncated to ${capBytes} of ${full.byteLength} bytes (FR-STA.5 cap)`
    },
    truncated: true
  }
}

interface PendingRequest {
  requestId: string
  url: string
  method: string
  requestHeaders: HarHeader[]
  postData?: string
  /** CDP MonotonicTime, seconds. Resolved to `t_ms` by the caller's clock. */
  monotonicSeconds: number
  wallTimeSeconds?: number
  status?: number
  statusText?: string
  responseHeaders?: HarHeader[]
  mimeType?: string
  responseBody?: string
  encodedDataLength?: number
  failed?: string
  finished?: boolean
}

export interface HarEntry {
  startedDateTime: string
  time: number
  _t_ms: number
  request: {
    method: string
    url: string
    httpVersion: string
    headers: HarHeader[]
    queryString: never[]
    cookies: never[]
    headersSize: number
    bodySize: number
    postData?: { mimeType: string; text: string }
  }
  response: {
    status: number
    statusText: string
    httpVersion: string
    headers: HarHeader[]
    cookies: never[]
    content: HarBody
    redirectURL: string
    headersSize: number
    bodySize: number
    _error?: string
  }
  cache: Record<string, never>
  timings: { send: number; wait: number; receive: number }
}

export interface HarLog {
  log: {
    version: '1.2'
    creator: { name: string; version: string }
    pages: never[]
    entries: HarEntry[]
    comment?: string
  }
}

export interface HarBuilderOptions {
  bodyCapBytes?: number
  creator?: { name: string; version: string }
}

/**
 * Accumulates `Network.*` events. Feed it raw CDP params; it holds no client, so
 * body fetching (which is a race — see `harvest.ts`) stays the caller's job.
 */
export class HarBuilder {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly order: string[] = []
  private readonly bodyCapBytes: number
  private readonly creator: { name: string; version: string }
  private truncatedAny = false

  constructor(options: HarBuilderOptions = {}) {
    this.bodyCapBytes = options.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES
    this.creator = options.creator ?? { name: 'Nawi', version: '0.1.0' }
  }

  requestWillBeSent(params: Record<string, unknown>): void {
    const requestId = params.requestId
    const request = params.request as Record<string, unknown> | undefined
    if (typeof requestId !== 'string' || !request) return

    if (!this.pending.has(requestId)) this.order.push(requestId)
    const postData = typeof request.postData === 'string' ? request.postData : undefined
    this.pending.set(requestId, {
      requestId,
      url: typeof request.url === 'string' ? request.url : '',
      method: typeof request.method === 'string' ? request.method : 'GET',
      requestHeaders: toHarHeaders(request.headers as Record<string, unknown> | undefined),
      ...(postData !== undefined ? { postData } : {}),
      monotonicSeconds: typeof params.timestamp === 'number' ? params.timestamp : Number.NaN,
      ...(typeof params.wallTime === 'number' ? { wallTimeSeconds: params.wallTime } : {})
    })
  }

  responseReceived(params: Record<string, unknown>): void {
    const requestId = params.requestId
    const response = params.response as Record<string, unknown> | undefined
    if (typeof requestId !== 'string' || !response) return
    const entry = this.pending.get(requestId)
    if (!entry) return
    entry.status = typeof response.status === 'number' ? response.status : 0
    entry.statusText = typeof response.statusText === 'string' ? response.statusText : ''
    entry.responseHeaders = toHarHeaders(response.headers as Record<string, unknown> | undefined)
    entry.mimeType = typeof response.mimeType === 'string' ? response.mimeType : ''
  }

  loadingFinished(params: Record<string, unknown>): void {
    const requestId = params.requestId
    if (typeof requestId !== 'string') return
    const entry = this.pending.get(requestId)
    if (!entry) return
    entry.finished = true
    if (typeof params.encodedDataLength === 'number') {
      entry.encodedDataLength = params.encodedDataLength
    }
  }

  /**
   * A failure is an outcome, not an absence. Recording it keeps a request that
   * died visible in the HAR instead of vanishing — the difference between "the
   * call was never made" and "the call failed" is usually the whole question.
   */
  loadingFailed(params: Record<string, unknown>): void {
    const requestId = params.requestId
    if (typeof requestId !== 'string') return
    const entry = this.pending.get(requestId)
    if (!entry) return
    entry.finished = true
    entry.failed = typeof params.errorText === 'string' ? params.errorText : 'unknown error'
  }

  /** Request ids that are complete and whose body is worth trying to fetch. */
  finishedRequestIds(): string[] {
    return this.order.filter((id) => this.pending.get(id)?.finished === true)
  }

  /** Attach a body fetched by the caller. Ignored for an unknown id. */
  setResponseBody(requestId: string, body: string): void {
    const entry = this.pending.get(requestId)
    if (entry) entry.responseBody = body
  }

  /** The monotonic timestamp / wallTime pair, for feeding the clock's free bridge. */
  clockBridges(): Array<{ monotonicSeconds: number; wallTimeSeconds: number }> {
    const out: Array<{ monotonicSeconds: number; wallTimeSeconds: number }> = []
    for (const id of this.order) {
      const e = this.pending.get(id)
      if (e && Number.isFinite(e.monotonicSeconds) && e.wallTimeSeconds !== undefined) {
        out.push({ monotonicSeconds: e.monotonicSeconds, wallTimeSeconds: e.wallTimeSeconds })
      }
    }
    return out
  }

  /**
   * Serialize.
   *
   * `resolveTMs` converts CDP MonotonicTime seconds to the capture timeline and
   * returns `null` for an entry that cannot be placed — DC-1, so that entry is
   * **dropped**, not emitted with a zero.
   */
  build(resolveTMs: (monotonicSeconds: number) => number | null): {
    har: HarLog
    truncated: boolean
    dropped: number
  } {
    const entries: HarEntry[] = []
    let dropped = 0

    for (const id of this.order) {
      const p = this.pending.get(id)
      if (!p) continue
      const tMs = resolveTMs(p.monotonicSeconds)
      if (tMs === null) {
        // DC-1: no timestamp, no entry. Never a guessed or zeroed one.
        dropped++
        continue
      }

      const { body, truncated } = capBody(p.responseBody, p.mimeType ?? '', this.bodyCapBytes)
      if (truncated) this.truncatedAny = true

      const postCapped =
        p.postData === undefined ? undefined : capBody(p.postData, '', this.bodyCapBytes)
      if (postCapped?.truncated) this.truncatedAny = true

      entries.push({
        startedDateTime:
          p.wallTimeSeconds !== undefined
            ? new Date(p.wallTimeSeconds * 1000).toISOString()
            : new Date(0).toISOString(),
        time: 0,
        _t_ms: tMs,
        request: {
          method: p.method,
          url: p.url,
          httpVersion: 'HTTP/1.1',
          headers: p.requestHeaders,
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: p.postData === undefined ? 0 : Buffer.byteLength(p.postData, 'utf8'),
          ...(postCapped?.body.text !== undefined
            ? { postData: { mimeType: '', text: postCapped.body.text } }
            : {})
        },
        response: {
          status: p.status ?? 0,
          statusText: p.statusText ?? '',
          httpVersion: 'HTTP/1.1',
          headers: p.responseHeaders ?? [],
          cookies: [],
          content: body,
          redirectURL: '',
          headersSize: -1,
          bodySize: p.encodedDataLength ?? -1,
          ...(p.failed ? { _error: p.failed } : {})
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 }
      })
    }

    return {
      har: {
        log: {
          version: '1.2',
          creator: this.creator,
          pages: [],
          entries,
          ...(dropped > 0
            ? { comment: `${dropped} entries dropped: no resolvable timestamp (DC-1)` }
            : {})
        }
      },
      truncated: this.truncatedAny,
      dropped
    }
  }
}
