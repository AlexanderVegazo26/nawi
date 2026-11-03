import { join } from 'node:path'
import type { Settings } from '@shared/settings'
import { providerFor, resolveLlmConfig } from './config'
import { LlmSession } from './session'

export { LlmSession } from './session'
export type { CompleteOptions, LlmSpend } from './session'
export { resolveLlmConfig, providerFor } from './config'
export type { LlmConfig } from './config'
export { anthropicProvider, openAiCompatibleProvider, stubProvider } from './providers'
export type * from './types'

/** Where the shared response cache and the outbound request log live under userData. */
export function llmPaths(userData: string): { cacheDir: string; logPath: string } {
  return { cacheDir: join(userData, 'ai', 'cache'), logPath: join(userData, 'ai', 'outbound.jsonl') }
}

/**
 * A session for one run, from the user's settings and the environment. `secrets`
 * are the run's secret values; they are masked in everything sent.
 */
export function openLlmSession(input: {
  settings: Pick<Settings, 'ai' | 'redactionRules'>
  userData: string
  secrets?: readonly string[]
  env?: Readonly<Record<string, string | undefined>>
}): LlmSession {
  const config = resolveLlmConfig(input.settings.ai, input.env)
  const choice = providerFor(config)
  return new LlmSession({
    config,
    provider: choice.provider,
    ...(choice.provider === null ? { providerDetail: choice.detail } : {}),
    ...llmPaths(input.userData),
    redaction: { secrets: input.secrets ?? [], rules: input.settings.redactionRules }
  })
}
