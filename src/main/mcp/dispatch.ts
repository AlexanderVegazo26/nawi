import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { ToolError, agentAccessPaused, toToolError } from './errors'

/**
 * The single chokepoint through which every MCP tool body is invoked.
 *
 * **Why one function and not twelve checks.** UX-AGT.3 requires that pausing
 * agent access takes effect immediately, for every tool. Twelve scattered guards
 * is twelve chances for the thirteenth tool to be added without one — and the
 * failure mode is silent: the tool works, and the user believes it is blocked.
 * Here, a tool body is unreachable except through `dispatch`, so a new tool
 * inherits the switch, the auth check, the origin check and the validation by
 * construction.
 *
 * Every check is evaluated **per call**, and the pause state is *read* per call
 * rather than captured at startup, so flipping the switch kills the very next
 * call rather than the next session.
 *
 * Dependencies are injected rather than imported. `settings` and `library` both
 * pull in `electron`, and a module that imports them cannot be unit-tested; this
 * way the chokepoint's security behaviour is testable without an app.
 */

/* ------------------------------------------------------------------ *
 * Tool definitions
 * ------------------------------------------------------------------ */

export interface ToolContext {
  /** Correlates a call with the log line and any capture it produces. */
  callId: string
  /** Present only when the caller supplied one. */
  idempotencyKey: string | null
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string
  /**
   * Shown to the agent verbatim. Where a capability is unavailable in this
   * build, the description **says so** — an agent that discovers the limit from
   * a runtime error has already wasted a turn on it.
   */
  description: string
  schema: S
  /**
   * FR-AGT.3 — whether repeating this call with the same `idempotency_key` must
   * return the first call's result instead of acting again. False for tools that
   * are already naturally idempotent (reads) or for which replay is meaningless.
   */
  idempotent: boolean
  run(args: z.output<S>, ctx: ToolContext): Promise<unknown>
}

export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition<z.ZodType> {
  return def as unknown as ToolDefinition<z.ZodType>
}

/** The `tools/list` payload for one tool. */
export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export function describeTools(tools: ToolDefinition[]): ToolDescriptor[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>
  }))
}

/* ------------------------------------------------------------------ *
 * Idempotency (FR-AGT.3)
 * ------------------------------------------------------------------ */

/**
 * Bounded LRU of in-flight-or-settled tool results, keyed by tool + client key.
 *
 * **It stores the promise, not the value.** Storing only the finished result
 * leaves a window in which a retry arriving before the first call settles takes
 * a *second* capture — precisely the duplicate FR-AGT.3 exists to prevent, and
 * the hardest kind to notice because it only happens under retry pressure. This
 * is the same in-flight dedupe `settings.ts` uses for its cold read.
 *
 * A rejected call is evicted, so a transient failure can be legitimately
 * retried; only a success is replayed.
 */
export class IdempotencyCache {
  private readonly entries = new Map<string, Promise<unknown>>()

  constructor(private readonly limit = 256) {}

  get size(): number {
    return this.entries.size
  }

  run(key: string, factory: () => Promise<unknown>): Promise<unknown> {
    const existing = this.entries.get(key)
    if (existing) {
      // Refresh recency so a key under active retry is not the one evicted.
      this.entries.delete(key)
      this.entries.set(key, existing)
      return existing
    }

    const promise = factory()
    this.entries.set(key, promise)

    // Bounded, so a client that invents a new key per call cannot grow this
    // without limit. Map preserves insertion order, so the first key is the
    // least recently used.
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }

    return promise.catch((err: unknown) => {
      // Never replay a failure. Only drop it if it is still the entry we stored —
      // an eviction plus a fresh call must not be clobbered by this cleanup.
      if (this.entries.get(key) === promise) this.entries.delete(key)
      throw err
    })
  }
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

export interface DispatchDeps {
  /** Read per call, so the kill switch takes effect on the next call. */
  isPaused(): Promise<boolean>
  /** The random bearer token from `mcp.json`. */
  token: string
  tools: ToolDefinition[]
  idempotency?: IdempotencyCache
  /** Called for every settled call. Feeds the UX-AGT.4 tool-call log. */
  onCall?(record: CallRecord): void
}

export interface CallRequest {
  name: string
  args: unknown
  /** Raw `Authorization` header, or null. */
  authorization: string | null
  /** Raw `Origin` header, or null. Non-null is rejected. */
  origin: string | null
  callId: string
}

export interface CallRecord {
  callId: string
  tool: string
  ok: boolean
  code: string | null
  startedAt: string
  durationMs: number
}

/**
 * Constant-time bearer comparison.
 *
 * `===` on a secret leaks its length and prefix through timing. The lengths are
 * compared first because `timingSafeEqual` throws on a mismatch — that check is
 * safe to make early since the token length is fixed and not secret.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function bearerOf(header: string | null): string | null {
  if (typeof header !== 'string') return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1].trim() : null
}

/**
 * The loopback trust checks, exported so the HTTP layer can apply them to
 * `initialize` and `tools/list` too — not only to `tools/call`.
 *
 * One implementation, two call sites: the transport needs it early enough to
 * answer 401/403 with the right status code, and `dispatch` re-applies it so a
 * future transport that forgets cannot reach a tool body. Throws `ToolError`.
 */
export function assertLoopbackTrust(
  token: string,
  authorization: string | null,
  origin: string | null
): void {
  const presented = bearerOf(authorization)
  if (presented === null || !tokenMatches(presented, token)) {
    throw new ToolError('UNAUTHORIZED', 'A valid bearer token from userData/mcp.json is required.')
  }
  if (origin !== null && origin !== '') {
    throw new ToolError('FORBIDDEN_ORIGIN', 'Cross-origin requests are not accepted.', { origin })
  }
}

/**
 * Runs one tool call, applying every guard in order.
 *
 * **Order, and why it deviates slightly from the milestone note.** Auth and
 * origin are checked *before* the kill switch: an unauthenticated peer should
 * learn nothing about this app's state, not even whether agent access is paused,
 * and we should not run any logic on its behalf. UX-AGT.3 is unaffected — an
 * authenticated MCP client calling `capture_screen` while paused still gets
 * `AGENT_ACCESS_PAUSED` and no capture, which is exactly what its acceptance
 * block requires.
 *
 * Throws `ToolError`. The transport turns it into a JSON-RPC error; nothing else
 * is allowed to escape.
 */
export async function dispatch(deps: DispatchDeps, req: CallRequest): Promise<unknown> {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  let code: string | null = null
  let ok = false

  try {
    /* 1+2. Bearer auth and Origin rejection. Loopback is not a trust boundary —
       any local process, and any web page's fetch(), can reach 127.0.0.1. A
       browser attaches `Origin` to cross-origin fetches and cannot suppress it,
       so rejecting every non-null value is the DNS-rebinding defence. */
    assertLoopbackTrust(deps.token, req.authorization, req.origin)

    /* 3. UX-AGT.3 kill switch — read now, not at startup. */
    if (await deps.isPaused()) throw agentAccessPaused()

    /* 4. The tool must exist before its arguments mean anything. */
    const tool = deps.tools.find((t) => t.name === req.name)
    if (!tool) throw new ToolError('UNKNOWN_TOOL', `No such tool: ${req.name}`, { tool: req.name })

    /* 5. Validation. Every MCP argument is hostile input; a tool body never sees
       an unvalidated value. */
    const parsed = tool.schema.safeParse(req.args ?? {})
    if (!parsed.success) {
      throw new ToolError('INVALID_ARGUMENTS', `Invalid arguments for ${tool.name}`, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      })
    }

    /* 6. FR-AGT.3 idempotency. */
    const argsRecord = parsed.data as Record<string, unknown>
    const rawKey = argsRecord['idempotency_key']
    const idempotencyKey = typeof rawKey === 'string' && rawKey.length > 0 ? rawKey : null
    const ctx: ToolContext = { callId: req.callId, idempotencyKey }

    const invoke = (): Promise<unknown> => tool.run(parsed.data, ctx)

    const value =
      tool.idempotent && idempotencyKey !== null && deps.idempotency
        ? await deps.idempotency.run(`${tool.name}:${idempotencyKey}`, invoke)
        : await invoke()

    ok = true
    return value
  } catch (err) {
    const te = toToolError(err)
    code = te.code
    throw te
  } finally {
    deps.onCall?.({
      callId: req.callId,
      tool: req.name,
      ok,
      code,
      startedAt,
      durationMs: Date.now() - started
    })
  }
}
