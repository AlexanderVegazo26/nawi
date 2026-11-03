import Anthropic from '@anthropic-ai/sdk'
import type {
  LlmContent,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  ProviderCallOptions,
  ProviderReply
} from './types'

/**
 * The three backends. Each only translates an `LlmRequest` to its wire format
 * and back; the session around it does redaction, caching, caps and logging.
 */

type FetchLike = typeof fetch

export interface AnthropicProviderOptions {
  /** Omitted: the SDK resolves credentials itself (ANTHROPIC_API_KEY, a CLI login profile...). */
  apiKey?: string
  /** Omitted: the SDK's default endpoint. */
  baseUrl?: string
  /** Tests inject a fake transport here; nothing else should. */
  fetch?: FetchLike
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000

function anthropicContent(content: LlmMessage['content']): Anthropic.MessageParam['content'] {
  if (typeof content === 'string') return content
  return content.map((b: LlmContent): Anthropic.ContentBlockParam =>
    b.type === 'text'
      ? { type: 'text', text: b.text }
      : { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } }
  )
}

export function anthropicProvider(options: AnthropicProviderOptions = {}): LlmProvider {
  const client = new Anthropic({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // One logged send is one HTTP request: no silent re-sends of the prompt.
    maxRetries: 0
  })
  return {
    id: 'anthropic',
    // What the SDK will really use (an explicit URL, else ANTHROPIC_BASE_URL, else its default).
    endpoint: client.baseURL,
    async complete(request: LlmRequest, call: ProviderCallOptions): Promise<ProviderReply> {
      const message = await client.messages.create(
        {
          model: call.model,
          max_tokens: request.maxOutputTokens,
          ...(request.system !== undefined ? { system: request.system } : {}),
          messages: request.messages.map((m) => ({ role: m.role, content: anthropicContent(m.content) }))
        },
        call.signal ? { signal: call.signal } : undefined
      )
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      return {
        text,
        model: message.model,
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
        refused: message.stop_reason === 'refusal',
        truncated: message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded'
      }
    }
  }
}

export interface OpenAiCompatibleOptions {
  /** e.g. `http://127.0.0.1:8080/v1` for a local server. Required: there is no default host. */
  baseUrl: string
  /** Optional: local servers usually take none. Sent as a bearer token. */
  apiKey?: string
  fetch?: FetchLike
  timeoutMs?: number
}

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'ProviderHttpError'
  }
}

function openAiContent(content: LlmMessage['content']): unknown {
  if (typeof content === 'string') return content
  return content.map((b) =>
    b.type === 'text'
      ? { type: 'text', text: b.text }
      : { type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } }
  )
}

interface ChatCompletion {
  model?: unknown
  choices?: Array<{ message?: { content?: unknown; refusal?: unknown }; finish_reason?: unknown }>
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** Any `/chat/completions` endpoint: hosted services and local inference servers alike. */
export function openAiCompatibleProvider(options: OpenAiCompatibleOptions): LlmProvider {
  const base = options.baseUrl.replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch
  return {
    id: 'openai-compatible',
    endpoint: base,
    async complete(request: LlmRequest, call: ProviderCallOptions): Promise<ProviderReply> {
      const messages: unknown[] = []
      if (request.system !== undefined) messages.push({ role: 'system', content: request.system })
      for (const m of request.messages) messages.push({ role: m.role, content: openAiContent(m.content) })
      const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const res = await doFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {})
        },
        body: JSON.stringify({ model: call.model, max_tokens: request.maxOutputTokens, messages }),
        signal: call.signal ? AbortSignal.any([call.signal, timeout]) : timeout
      })
      if (!res.ok) {
        // The body may echo the request: only the status goes into the message.
        throw new ProviderHttpError(res.status, `the endpoint answered HTTP ${res.status}`)
      }
      const body = (await res.json()) as ChatCompletion
      const choice = body.choices?.[0]
      const content = choice?.message?.content
      const refusal = choice?.message?.refusal
      return {
        text: typeof content === 'string' ? content : '',
        model: typeof body.model === 'string' ? body.model : call.model,
        usage: {
          inputTokens: num(body.usage?.prompt_tokens),
          outputTokens: num(body.usage?.completion_tokens)
        },
        refused: (typeof refusal === 'string' && refusal.length > 0) || choice?.finish_reason === 'content_filter',
        truncated: choice?.finish_reason === 'length'
      }
    }
  }
}

/**
 * Deterministic in-process backend for tests and offline demos: answers with
 * `answer(request)`, counts its calls, never touches the network.
 */
export function stubProvider(
  answer: (request: LlmRequest) => string = () => 'stub'
): LlmProvider & { calls: number } {
  const provider = {
    id: 'stub' as const,
    endpoint: 'stub:',
    calls: 0,
    async complete(request: LlmRequest, call: ProviderCallOptions): Promise<ProviderReply> {
      provider.calls++
      call.signal?.throwIfAborted()
      const text = answer(request)
      return {
        text,
        model: call.model,
        usage: { inputTokens: JSON.stringify(request.messages).length, outputTokens: text.length },
        refused: false,
        truncated: false
      }
    }
  }
  return provider
}
