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

/* ------------------------------------------------------------------ *
 * FR-SEC.2 — the request-body control
 * ------------------------------------------------------------------ */

/**
 * ## Why the request body needs its own Tier A control
 *
 * This is FR-SEC.2's hardest case and the design is not obvious, so: the
 * reasoning, for whoever reads this next.
 *
 * A submitted login form puts the typed password in `request.postData`. Header
 * stripping never sees it. Neither does Tier B's pattern set in `seal.ts`,
 * which matches structured secret *shapes* — JWTs, card numbers, PEM blocks. An
 * arbitrary password like `hunter2` has no shape. It matches nothing, and it
 * lands in `network.har` in plaintext.
 *
 * **Literal matching cannot fix this, which is the whole point.** Handing the
 * typed value to `seal()` as a `suppressedValue` and searching for it fails the
 * moment the body encodes it: `hunter!2` is `hunter%212` in a urlencoded body,
 * `hunter!2` after a JSON escape, `aHVudGVyITI=` if the page base64s it
 * before posting. One value, unboundedly many renderings, and a scanner that
 * has to guess which. So the control cannot be a scan over the finished body.
 *
 * **What we do instead: never hold the raw serialization.** Three layers, all
 * at ingest, all conjunctive:
 *
 *  1. **Default-deny on type and size.** A body is eligible only if it is
 *     `application/x-www-form-urlencoded` or `application/json` and under
 *     `postDataCapBytes`. Everything else — `multipart/form-data`, an absent
 *     content type, anything oversized, anything that fails to parse — is
 *     dropped whole, with the reason recorded in the HAR comment. We keep only
 *     what we can take apart, because a body we cannot decompose is a body we
 *     cannot redact field-wise.
 *  2. **Structural decomposition, at `requestWillBeSent`.** An eligible body is
 *     parsed into fields immediately and the raw string is discarded. From that
 *     moment no serialized body exists in memory — only key/value pairs, each
 *     independently suppressible regardless of how it was encoded on the wire.
 *     This is what makes the control encoding-agnostic: we redact by *key* and
 *     never look at the value at all.
 *  3. **Field-name redaction**, against the static set below ∪ the names the
 *     probe reports for elements it actually marked on the page. The static set
 *     is the common case; the probe set is what catches a workspace-configured
 *     secret whose parameter is called something like `recovery`, which no
 *     static list would ever guess.
 *
 * **The one seam, stated rather than papered over.** Layer 3 runs twice: once
 * at ingest with the static set, and again at `build()` with the probe set.
 * That second pass exists because the probe's names are discovered per document
 * by `markSecrets`, which can run *after* a request was observed — a request
 * that beat the marking pass would otherwise be judged against an empty set.
 * Between the two passes the value sits in a parsed field in memory. That is
 * the same exposure class as every other harvested value awaiting `finish()`,
 * and FR-SEC.2 is a statement about what is recorded in the state layer, not
 * about process memory. It is not a scan: the second pass matches keys, never
 * values, so it inherits none of the encoding weakness above.
 *
 * **Residual, deliberately not closed.** A page that posts a secret under a
 * harmless-looking key in an allowlisted type — `{"blob": btoa(password)}` —
 * is not caught, because nothing in the body or the page identifies that key as
 * secret. Closing it would mean dropping request bodies entirely and giving up
 * FR-STA.5. Recorded as a known limit rather than implied away.
 */
export const DEFAULT_POST_DATA_CAP_BYTES = 64 * 1024

/** What replaces a redacted field's value. Distinct from `seal.ts`'s Tier B sentinel. */
export const POST_DATA_REDACTED = '[REDACTED:secret-field]'

/**
 * The only two body types we retain. Not configurable, for the same reason
 * `STRIPPED_HEADERS` is not: widening it is a decision about the requirement,
 * not about a preference.
 */
export const POST_DATA_ALLOWED_TYPES = Object.freeze([
  'application/x-www-form-urlencoded',
  'application/json'
])

/**
 * Parameter names that are secret by convention, matched case-insensitively as
 * a substring so `user_password`, `newPassword` and `otpCode` are all caught.
 *
 * This is a floor, not the mechanism. The probe-reported set is what makes the
 * control correct for a page whose fields we could not have guessed.
 */
export const SECRET_FIELD_NAME_PATTERN =
  /pass(?:word|wd|phrase)?|\bpwd\b|otp|one[-_]?time|token|secret|credential|auth|api[-_]?key|session[-_]?id|cvv|cvc|\bpin\b/i

function isSecretFieldName(name: string, dynamic: ReadonlySet<string>): boolean {
  if (dynamic.has(name)) return true
  for (const known of dynamic) {
    // The probe reports `name` and `id`; a body may send either, or a nested
    // JSON key of the same spelling. Exact match on a bounded set — no substring
    // search here, which would let a one-character configured name match
    // everything.
    if (known.length >= 2 && name.toLowerCase() === known.toLowerCase()) return true
  }
  return SECRET_FIELD_NAME_PATTERN.test(name)
}

/** The parsed, raw-string-free form a retained body is held in. */
type ParsedPostData =
  | { kind: 'form'; fields: Array<[string, string]> }
  | { kind: 'json'; value: unknown }

interface PostDataState {
  /** Present only when the body survived the type/size gate and parsed. */
  parsed?: ParsedPostData
  mimeType: string
  /** Byte length of what arrived, recorded even when nothing was retained. */
  originalSize: number
  /** Set when nothing is retained. The HAR says why, rather than going silent. */
  dropped?: string
}

function contentTypeOf(headers: Record<string, unknown> | undefined): string {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === 'content-type' && typeof value === 'string') {
      return value.split(';')[0]!.trim().toLowerCase()
    }
  }
  return ''
}

/**
 * Redact a parsed JSON value by key, recursively.
 *
 * Built on a null-prototype object: a body is attacker-controlled, and copying a
 * `__proto__` key onto an object literal would set the prototype rather than a
 * property. `JSON.stringify` treats a null-prototype object identically.
 */
function redactJsonByKey(value: unknown, dynamic: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => redactJsonByKey(v, dynamic))
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretFieldName(key, dynamic) ? POST_DATA_REDACTED : redactJsonByKey(v, dynamic)
    }
    return out
  }
  return value
}

function redactParsed(parsed: ParsedPostData, dynamic: ReadonlySet<string>): ParsedPostData {
  if (parsed.kind === 'form') {
    return {
      kind: 'form',
      fields: parsed.fields.map(([k, v]) =>
        isSecretFieldName(k, dynamic) ? ([k, POST_DATA_REDACTED] as [string, string]) : [k, v]
      )
    }
  }
  return { kind: 'json', value: redactJsonByKey(parsed.value, dynamic) }
}

function serializeParsed(parsed: ParsedPostData): string {
  if (parsed.kind === 'form') {
    // Re-serialized from the parsed pairs, so the emitted body is a normalized
    // rendering rather than the bytes that arrived. That is intentional: the
    // point of the control is that no original serialization is kept.
    const params = new URLSearchParams()
    for (const [k, v] of parsed.fields) params.append(k, v)
    return params.toString()
  }
  return JSON.stringify(parsed.value)
}

/**
 * The layer-1 and layer-2 gate. Returns the state to store; never returns the
 * raw string, by construction.
 */
export function ingestPostData(
  postData: string,
  headers: Record<string, unknown> | undefined,
  capBytes: number,
  staticOnly: ReadonlySet<string>
): PostDataState {
  const mimeType = contentTypeOf(headers)
  const originalSize = Buffer.byteLength(postData, 'utf8')

  if (!POST_DATA_ALLOWED_TYPES.includes(mimeType)) {
    return {
      mimeType,
      originalSize,
      dropped: `body not retained: content type ${
        mimeType === '' ? '(absent)' : mimeType
      } is not field-decomposable (FR-SEC.2)`
    }
  }
  if (originalSize > capBytes) {
    // Not truncated — dropped. A truncated body cannot be parsed into fields,
    // so it could not be redacted, so keeping a prefix of it would be keeping
    // an unredacted prefix.
    return {
      mimeType,
      originalSize,
      dropped: `body not retained: ${originalSize} bytes exceeds the ${capBytes} byte request-body cap (FR-SEC.2)`
    }
  }

  let parsed: ParsedPostData
  if (mimeType === 'application/x-www-form-urlencoded') {
    const fields: Array<[string, string]> = []
    for (const [k, v] of new URLSearchParams(postData)) fields.push([k, v])
    parsed = { kind: 'form', fields }
  } else {
    try {
      parsed = { kind: 'json', value: JSON.parse(postData) as unknown }
    } catch {
      return {
        mimeType,
        originalSize,
        dropped: 'body not retained: declared application/json but did not parse (FR-SEC.2)'
      }
    }
  }

  // Layer 3, first pass. The raw `postData` argument goes out of scope here and
  // is never stored.
  return { mimeType, originalSize, parsed: redactParsed(parsed, staticOnly) }
}

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
  /** Never the raw body — see the request-body control above. */
  postData?: PostDataState
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
    /** Why no `postData` is present, when a body was seen but not retained. */
    comment?: string
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
  /** FR-SEC.2's request-body cap. Deliberately far smaller than the response cap. */
  postDataCapBytes?: number
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
  private readonly postDataCapBytes: number
  private readonly creator: { name: string; version: string }
  private truncatedAny = false
  /** Probe-reported secret parameter names, accumulated across documents. */
  private readonly secretFieldNames = new Set<string>()

  constructor(options: HarBuilderOptions = {}) {
    this.bodyCapBytes = options.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES
    this.postDataCapBytes = options.postDataCapBytes ?? DEFAULT_POST_DATA_CAP_BYTES
    this.creator = options.creator ?? { name: 'Nawi', version: '0.1.0' }
  }

  /**
   * Add the parameter names `markSecrets` found on the current document.
   *
   * Accumulated rather than replaced: a navigation gives a fresh marking pass,
   * but requests from the previous document may still be pending in this
   * builder, and forgetting the old document's names would un-redact them.
   */
  addSecretFieldNames(names: readonly string[]): void {
    for (const name of names) {
      const trimmed = name.trim()
      if (trimmed.length >= 2 && trimmed.length <= 128) this.secretFieldNames.add(trimmed)
    }
  }

  requestWillBeSent(params: Record<string, unknown>): void {
    const requestId = params.requestId
    const request = params.request as Record<string, unknown> | undefined
    if (typeof requestId !== 'string' || !request) return

    if (!this.pending.has(requestId)) this.order.push(requestId)
    // FR-SEC.2, layers 1 and 2: gated and decomposed here, at ingest. What gets
    // stored is never the string CDP handed us.
    const raw = request.postData
    const postData =
      typeof raw === 'string'
        ? ingestPostData(
            raw,
            request.headers as Record<string, unknown> | undefined,
            this.postDataCapBytes,
            this.secretFieldNames
          )
        : undefined
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

      // FR-SEC.2, layer 3's second pass. Keys only, against the full accumulated
      // probe set — see the request-body control's note on why this runs twice.
      const post = p.postData
      const postText =
        post?.parsed === undefined
          ? undefined
          : serializeParsed(redactParsed(post.parsed, this.secretFieldNames))

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
          // The size that was *sent*, which stays truthful even when nothing was
          // retained — the difference between "no body" and "a body we did not
          // keep" is exactly what a reader needs.
          bodySize: post?.originalSize ?? 0,
          ...(postText !== undefined
            ? { postData: { mimeType: post!.mimeType, text: postText } }
            : {}),
          ...(post?.dropped ? { comment: post.dropped } : {})
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
