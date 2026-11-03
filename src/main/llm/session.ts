import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import type { LlmConfig } from './config'
import { ProviderHttpError } from './providers'
import { canonicalRequest, inputHash, redactRequest, type RedactionPolicy } from './redact'
import type { LlmProvider, LlmRequest, LlmResult, LlmUsage, NotEvaluatedReason, ProviderId } from './types'

/**
 * One run's model access (roadmap AI13). Every model call a feature makes goes
 * through `complete`, which in this order:
 *
 *  1. validates and redacts the request (secrets, built-in patterns, workspace rules);
 *  2. answers from the response cache when the redacted input was answered before
 *     (also in offline mode: a cache hit makes no network call);
 *  3. refuses with "not evaluated" when offline, unconfigured or over a cap;
 *  4. calls the provider, appends one line to the outbound log (exactly what was
 *     sent, images as digest + size), and caches a usable answer.
 *
 * It never throws for expected conditions: callers get `not_evaluated` and must
 * report it as such, never as a pass.
 */

export interface LlmSessionOptions {
  config: LlmConfig
  /** The backend, or null with the reason none is available (from `providerFor`). */
  provider: LlmProvider | null
  providerDetail?: string
  /** Response cache folder (shared across runs). */
  cacheDir: string
  /** Outbound request log, JSON lines (shared across runs, appended). */
  logPath: string
  redaction?: RedactionPolicy
  now?: () => Date
}

export interface CompleteOptions {
  signal?: AbortSignal
  /** Ask the model again even when the input is cached (the new answer replaces the old). */
  refresh?: boolean
}

export interface LlmSpend {
  calls: number
  inputTokens: number
  outputTokens: number
  usd: number
}

interface CacheEntry {
  version: 1
  inputHash: string
  purpose: string
  text: string
  provider: ProviderId
  model: string
  usage: LlmUsage
  createdAt: string
}

const HASH_RE = /^[0-9a-f]{64}$/

/**
 * A deliberately high guess of the request's input tokens, for the caps: about
 * one token per 3 characters of text and a flat 1,600 per image. Reserved
 * before the call so a big prompt can't slip past a cap it would break.
 */
export function estimateInputTokens(request: LlmRequest): number {
  let chars = request.system?.length ?? 0
  let images = 0
  for (const m of request.messages) {
    if (typeof m.content === 'string') chars += m.content.length
    else for (const b of m.content) b.type === 'text' ? (chars += b.text.length) : images++
  }
  return Math.ceil(chars / 3) + images * 1600
}

function invalidRequest(request: LlmRequest): string | null {
  if (typeof request.purpose !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(request.purpose)) {
    return 'purpose must be a short lowercase id'
  }
  if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) {
    return 'maxOutputTokens must be a positive integer'
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) return 'messages is empty'
  if (request.messages[0]?.role !== 'user') return 'the first message must be from the user'
  return null
}

function errorDetail(err: unknown): { reason: NotEvaluatedReason; detail: string; status?: number } {
  if (err instanceof Anthropic.APIUserAbortError || (err instanceof Error && err.name === 'AbortError')) {
    return { reason: 'cancelled', detail: 'the call was cancelled' }
  }
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return { reason: 'error', detail: `the provider answered HTTP ${err.status}`, status: err.status }
  }
  if (err instanceof ProviderHttpError) {
    return { reason: 'error', detail: `the provider answered HTTP ${err.status}`, status: err.status }
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError || (err instanceof Error && err.name === 'TimeoutError')) {
    return { reason: 'error', detail: 'the provider did not answer in time' }
  }
  // Only the error's class: a message may quote the request or the endpoint's body.
  return { reason: 'error', detail: `the call failed (${err instanceof Error ? err.name : typeof err})` }
}

export class LlmSession {
  private readonly spend: LlmSpend = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 }
  /** Tokens and cost reserved by calls in flight, so parallel calls can't overrun a cap together. */
  private reservedTokens = 0
  private reservedUsd = 0
  private logChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: LlmSessionOptions) {}

  get spent(): Readonly<LlmSpend> {
    return { ...this.spend }
  }

  async complete(request: LlmRequest, call: CompleteOptions = {}): Promise<LlmResult> {
    const { config } = this.options
    const bad = invalidRequest(request)
    if (bad) return { status: 'not_evaluated', reason: 'error', detail: `invalid request: ${bad}`, inputHash: '' }

    const redacted = redactRequest(request, this.options.redaction)
    const hash = inputHash(redacted.request)
    const notEvaluated = (reason: NotEvaluatedReason, detail: string): LlmResult => ({
      status: 'not_evaluated',
      reason,
      detail,
      inputHash: hash
    })

    if (!call.refresh) {
      const hit = await this.readCache(hash)
      if (hit) {
        return {
          status: 'ok',
          text: hit.text,
          cached: true,
          inputHash: hash,
          provider: hit.provider,
          model: hit.model,
          usage: hit.usage
        }
      }
    }

    // A workspace rule that doesn't compile would let what it was meant to hide through.
    if (redacted.invalidRules.length > 0) {
      return notEvaluated(
        'error',
        `redaction rule ${redacted.invalidRules.map((id) => `"${id}"`).join(', ')} does not compile, so nothing was sent`
      )
    }
    if (config.offline) return notEvaluated('offline', 'offline mode: no model call was made and nothing was cached')
    const provider = this.options.provider
    if (!provider) return notEvaluated('no_provider', this.options.providerDetail ?? 'no AI provider is configured')
    if (!config.model) return notEvaluated('no_model', 'no model is configured (settings.ai.model)')
    if (call.signal?.aborted) return notEvaluated('cancelled', 'the call was cancelled')

    const inputGuess = estimateInputTokens(redacted.request)
    const reserveTokens = inputGuess + request.maxOutputTokens
    const reserveUsd = config.prices
      ? (inputGuess * config.prices.inputUsdPerMTok + request.maxOutputTokens * config.prices.outputUsdPerMTok) / 1e6
      : 0
    const capHit = this.capExceeded(reserveTokens, reserveUsd)
    if (capHit) return notEvaluated('budget', capHit)
    // Reserve before the first await: a parallel call must already see this one.
    this.spend.calls++
    this.reservedTokens += reserveTokens
    this.reservedUsd += reserveUsd
    const release = (): void => {
      this.reservedTokens -= reserveTokens
      this.reservedUsd -= reserveUsd
    }

    const sent = JSON.parse(canonicalRequest(redacted.request, 'digest')) as unknown
    const base = {
      purpose: request.purpose,
      inputHash: hash,
      provider: provider.id,
      endpoint: provider.endpoint,
      model: config.model
    }
    // The log line goes first and must land: nothing leaves the machine unlogged.
    try {
      await this.log({ ...base, event: 'sent', request: sent, redactions: redacted.hits })
    } catch {
      this.spend.calls--
      release()
      return notEvaluated('error', 'the outbound log could not be written, so nothing was sent')
    }

    try {
      const reply = await provider.complete(redacted.request, {
        model: config.model,
        ...(call.signal ? { signal: call.signal } : {})
      })
      this.charge(reply.usage)
      await this.log({
        ...base,
        event: reply.refused ? 'refused' : reply.truncated ? 'truncated' : 'answered',
        answeredBy: reply.model,
        usage: reply.usage
      }).catch(() => undefined)
      if (reply.refused) return notEvaluated('refused', 'the model declined to answer')
      // A cut-off or empty answer is not a verdict, and caching it would repeat it forever.
      if (reply.truncated) return notEvaluated('error', 'the answer was cut off (output token limit)')
      if (reply.text.trim() === '') return notEvaluated('error', 'the model returned an empty answer')
      await this.writeCache({
        version: 1,
        inputHash: hash,
        purpose: request.purpose,
        text: reply.text,
        provider: provider.id,
        model: reply.model,
        usage: reply.usage,
        createdAt: (this.options.now?.() ?? new Date()).toISOString()
      })
      return {
        status: 'ok',
        text: reply.text,
        cached: false,
        inputHash: hash,
        provider: provider.id,
        model: reply.model,
        usage: reply.usage
      }
    } catch (err) {
      const e = errorDetail(err)
      await this.log({
        ...base,
        event: e.reason === 'cancelled' ? 'cancelled' : 'failed',
        ...(e.status !== undefined ? { status: e.status } : {})
      }).catch(() => undefined)
      return notEvaluated(e.reason, e.detail)
    } finally {
      release()
    }
  }

  private capExceeded(tokens: number, usd: number): string | null {
    const { caps } = this.options.config
    if (this.spend.calls >= caps.maxCalls) return `the run reached its cap of ${caps.maxCalls} model calls`
    const used = this.spend.inputTokens + this.spend.outputTokens + this.reservedTokens
    if (used + tokens > caps.maxTokens) {
      return `the run would pass its cap of ${caps.maxTokens} tokens`
    }
    if (caps.maxUsd !== null && this.spend.usd + this.reservedUsd + usd > caps.maxUsd) {
      return `the run would pass its cost cap of US$${caps.maxUsd}`
    }
    return null
  }

  private charge(usage: LlmUsage): void {
    this.spend.inputTokens += usage.inputTokens
    this.spend.outputTokens += usage.outputTokens
    const prices = this.options.config.prices
    if (prices) {
      this.spend.usd +=
        (usage.inputTokens * prices.inputUsdPerMTok + usage.outputTokens * prices.outputUsdPerMTok) / 1e6
    }
  }

  private async readCache(hash: string): Promise<CacheEntry | null> {
    try {
      const raw = JSON.parse(await fs.readFile(join(this.options.cacheDir, `${hash}.json`), 'utf-8')) as unknown
      if (typeof raw !== 'object' || raw === null) return null
      const e = raw as Partial<CacheEntry>
      // A damaged or foreign entry is a miss, never an answer.
      if (e.version !== 1 || e.inputHash !== hash || typeof e.text !== 'string') return null
      if (e.provider !== 'anthropic' && e.provider !== 'openai-compatible' && e.provider !== 'stub') return null
      return {
        version: 1,
        inputHash: hash,
        purpose: typeof e.purpose === 'string' ? e.purpose : '',
        text: e.text,
        provider: e.provider,
        model: typeof e.model === 'string' ? e.model : '',
        usage: {
          inputTokens: Number(e.usage?.inputTokens) || 0,
          outputTokens: Number(e.usage?.outputTokens) || 0
        },
        createdAt: typeof e.createdAt === 'string' ? e.createdAt : ''
      }
    } catch {
      return null
    }
  }

  private async writeCache(entry: CacheEntry): Promise<void> {
    if (!HASH_RE.test(entry.inputHash)) return
    const dir = this.options.cacheDir
    const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`)
    try {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(tmp, JSON.stringify(entry), { mode: 0o600 })
      await fs.rename(tmp, join(dir, `${entry.inputHash}.json`))
    } catch {
      // A cache that can't be written costs a repeat call later, not this answer.
      await fs.rm(tmp, { force: true }).catch(() => undefined)
    }
  }

  /**
   * Appends one JSON line; rejects when it can't. Serialized so concurrent calls
   * never interleave lines.
   */
  private log(entry: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify({ at: (this.options.now?.() ?? new Date()).toISOString(), ...entry })}\n`
    const path = this.options.logPath
    const next = this.logChain.then(async () => {
      await fs.mkdir(dirname(path), { recursive: true })
      await fs.appendFile(path, line, { mode: 0o600 })
    })
    this.logChain = next.catch(() => undefined)
    return next
  }
}
