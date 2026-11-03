/**
 * LLM provider layer (roadmap AI13): the one interface every model-driven
 * feature (semantic assertions, healing, triage, exploration) goes through.
 *
 * Electron-free on purpose: the CLI, the MCP server and the tests all use it.
 * Nothing here picks a model. The model id is configuration (`settings.ai.model`
 * or `NAWI_LLM_MODEL`), never a constant in a slice.
 */

/** A block of a user message. Images are base64 so the request can be hashed and logged. */
export type LlmContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; data: string }

export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string | LlmContent[]
}

export interface LlmRequest {
  /**
   * What the call is for (`assert.ai`, `heal`, `triage`...). Part of the cache key
   * and of the outbound log, so a verdict cached for one feature is never served
   * to another.
   */
  purpose: string
  system?: string
  messages: LlmMessage[]
  /** Hard cap on the answer's length. Required: no slice gets an open-ended bill. */
  maxOutputTokens: number
}

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
}

/** What a provider sends back for one call. */
export interface ProviderReply {
  text: string
  /** The model the endpoint says answered (may differ from the configured alias). */
  model: string
  usage: LlmUsage
  /** True when the model declined (a safety stop): never a verdict. */
  refused: boolean
  /** True when the answer stopped at the output limit: never a verdict, never cached. */
  truncated: boolean
}

export interface ProviderCallOptions {
  model: string
  signal?: AbortSignal
}

/**
 * One backend. Providers only translate and transport: redaction, caching, caps,
 * offline mode and the outbound log live in `LlmSession`, so no provider can skip them.
 */
export interface LlmProvider {
  readonly id: ProviderId
  /** Where requests go (`https://api.anthropic.com`, `http://127.0.0.1:8080/v1`, `stub:`). For the log. */
  readonly endpoint: string
  complete(request: LlmRequest, options: ProviderCallOptions): Promise<ProviderReply>
}

export type ProviderId = 'anthropic' | 'openai-compatible' | 'stub'

/** Why a call produced no answer. Callers report these as "not evaluated", never as a pass. */
export type NotEvaluatedReason =
  | 'offline'
  | 'no_provider'
  | 'no_model'
  | 'budget'
  | 'refused'
  | 'cancelled'
  | 'error'

export type LlmResult =
  | {
      status: 'ok'
      text: string
      /** True when the answer came from the response cache (no network call was made). */
      cached: boolean
      /** sha256 of the redacted request: the cache key and the log's request id. */
      inputHash: string
      provider: ProviderId
      model: string
      usage: LlmUsage
    }
  | {
      status: 'not_evaluated'
      reason: NotEvaluatedReason
      /** Human-readable; never contains request text or secrets. */
      detail: string
      inputHash: string
    }
