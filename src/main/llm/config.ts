import { AI_PROVIDERS, isSafeBaseUrl, type AiProviderSetting, type AiSettings } from '@shared/settings'
import { anthropicProvider, openAiCompatibleProvider } from './providers'
import type { LlmProvider } from './types'

/**
 * Settings + environment -> the effective model config for one process.
 *
 * Environment variables let the CLI and CI choose a backend without touching the
 * settings file. They can pick a provider, model and endpoint; `NAWI_LLM_OFFLINE`
 * can only make things stricter (a set variable turns offline mode on, never off).
 * Keys are read from the environment only, never from settings.
 */

export interface LlmConfig {
  provider: AiProviderSetting
  model: string
  /** The OpenAI-compatible endpoint. The Anthropic backend never uses it (its key must not go elsewhere). */
  baseUrl: string
  offline: boolean
  apiKey: string | undefined
  caps: {
    maxCalls: number
    maxTokens: number
    /** null = no cost cap (prices unknown). */
    maxUsd: number | null
  }
  prices: { inputUsdPerMTok: number; outputUsdPerMTok: number } | null
}

type Env = Readonly<Record<string, string | undefined>>

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim())

export function resolveLlmConfig(ai: AiSettings, env: Env = process.env): LlmConfig {
  const envProvider = env.NAWI_LLM_PROVIDER?.trim()
  const provider =
    envProvider && AI_PROVIDERS.includes(envProvider as AiProviderSetting)
      ? (envProvider as AiProviderSetting)
      : ai.provider
  const model = env.NAWI_LLM_MODEL?.trim() || ai.model
  const envUrl = env.NAWI_LLM_BASE_URL?.trim()
  // Same rule as the settings file: an unsafe URL (credentials, query, other scheme) is ignored.
  const baseUrl = envUrl && isSafeBaseUrl(envUrl) ? envUrl : ai.baseUrl
  const apiKey =
    env.NAWI_LLM_API_KEY?.trim() ||
    (provider === 'openai-compatible' ? env.OPENAI_API_KEY?.trim() : undefined) ||
    undefined
  const priced = ai.inputUsdPerMTok > 0 && ai.outputUsdPerMTok > 0
  return {
    provider,
    model,
    baseUrl,
    offline: ai.offline || truthy(env.NAWI_LLM_OFFLINE),
    apiKey,
    caps: {
      maxCalls: ai.maxCallsPerRun,
      maxTokens: ai.maxTokensPerRun,
      maxUsd: priced ? ai.maxCostPerRunUsd : null
    },
    prices: priced ? { inputUsdPerMTok: ai.inputUsdPerMTok, outputUsdPerMTok: ai.outputUsdPerMTok } : null
  }
}

export type ProviderChoice = { provider: LlmProvider } | { provider: null; detail: string }

/**
 * Builds the configured backend. Building one makes no network call; offline
 * mode is enforced by the session, which never calls `complete` while offline.
 */
export function providerFor(config: LlmConfig, transport: { fetch?: typeof fetch } = {}): ProviderChoice {
  switch (config.provider) {
    case 'none':
      return { provider: null, detail: 'no AI provider is configured (settings.ai.provider is "none")' }
    case 'anthropic':
      // No baseUrl here on purpose: it is the OpenAI-compatible server's address, and
      // switching providers must not send the Anthropic key there. A proxy for the
      // Anthropic API is set the SDK's way (ANTHROPIC_BASE_URL) and shows in the log.
      return {
        provider: anthropicProvider({
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          ...(transport.fetch ? { fetch: transport.fetch } : {})
        })
      }
    case 'openai-compatible':
      if (!config.baseUrl) {
        return { provider: null, detail: 'the openai-compatible provider needs a base URL (settings.ai.baseUrl)' }
      }
      return {
        provider: openAiCompatibleProvider({
          baseUrl: config.baseUrl,
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          ...(transport.fetch ? { fetch: transport.fetch } : {})
        })
      }
  }
}
