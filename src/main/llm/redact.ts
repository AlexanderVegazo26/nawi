import { createHash } from 'node:crypto'
import type { RedactionRule } from '@shared/settings'
import { secretPattern } from '@shared/flow/interpolate'
import { SEAL_PATTERNS, sentinelFor } from '../sidecar/seal'
import type { LlmContent, LlmMessage, LlmRequest } from './types'

/**
 * Redaction before send: every text that would leave the machine goes through
 * the same built-in patterns the sidecar seal uses (keys, tokens, cards, ids,
 * emails, phones), the workspace's `redactionRules`, and the run's own secret
 * values (as typed, percent-encoded or whitespace-folded: `secretPattern`).
 *
 * Images are not inspected: a screenshot is sent as is. Secret fields are
 * already masked in the run's shots (F4b2), which is where AI images come from.
 */

export interface RedactionPolicy {
  /** Values that must never leave the machine (the flow's `${secret.*}` inputs). */
  secrets?: readonly string[]
  /** Workspace rules from settings. Additive: they can't switch the built-ins off. */
  rules?: readonly RedactionRule[]
}

export interface RedactionHit {
  id: string
  count: number
}

export interface RedactedRequest {
  request: LlmRequest
  hits: RedactionHit[]
  /** Workspace rules that would not compile, reported instead of silently dropped. */
  invalidRules: string[]
}

const SECRET_SENTINEL = sentinelFor('secret')

interface Matcher {
  id: string
  make: () => RegExp
  accept?: (match: string) => boolean
}

function matchers(policy: RedactionPolicy): { list: Matcher[]; invalid: string[] } {
  const list: Matcher[] = []
  const invalid: string[] = []
  // Secrets first: a password that also looks like an API key is still reported as a secret.
  for (const secret of policy.secrets ?? []) {
    // Like the sidecar seal: a value under 4 characters would mask ordinary text everywhere.
    if (secret.trim().length < 4) continue
    list.push({ id: 'secret', make: () => secretPattern(secret) })
  }
  for (const p of SEAL_PATTERNS) {
    list.push({ id: p.id, make: p.make, ...(p.accept ? { accept: p.accept } : {}) })
  }
  for (const rule of policy.rules ?? []) {
    if (!rule.enabled) continue
    try {
      new RegExp(rule.pattern, 'g')
      list.push({ id: rule.id, make: () => new RegExp(rule.pattern, 'g') })
    } catch {
      invalid.push(rule.id)
    }
  }
  return { list, invalid }
}

function redactText(text: string, list: readonly Matcher[], hits: Map<string, number>): string {
  let out = text
  for (const m of list) {
    let count = 0
    out = out.replace(m.make(), (match) => {
      // An empty match (a user rule like `a*`) would loop over every position: leave it.
      if (match.length === 0) return match
      if (m.accept && !m.accept(match)) return match
      count++
      return m.id === 'secret' ? SECRET_SENTINEL : sentinelFor(m.id)
    })
    if (count > 0) hits.set(m.id, (hits.get(m.id) ?? 0) + count)
  }
  return out
}

/** A copy of the request with every text field redacted. The input is not modified. */
export function redactRequest(request: LlmRequest, policy: RedactionPolicy = {}): RedactedRequest {
  const { list, invalid } = matchers(policy)
  const hits = new Map<string, number>()
  const content = (c: LlmMessage['content']): LlmMessage['content'] =>
    typeof c === 'string'
      ? redactText(c, list, hits)
      : c.map((block): LlmContent =>
          block.type === 'text' ? { type: 'text', text: redactText(block.text, list, hits) } : { ...block }
        )
  const out: LlmRequest = {
    purpose: request.purpose,
    ...(request.system !== undefined ? { system: redactText(request.system, list, hits) } : {}),
    messages: request.messages.map((m) => ({ role: m.role, content: content(m.content) })),
    maxOutputTokens: request.maxOutputTokens
  }
  return {
    request: out,
    hits: [...hits].map(([id, count]) => ({ id, count })),
    invalidRules: invalid
  }
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * The request in a fixed, key-ordered form. Used for the cache key and, with
 * images replaced by their hash and size, for the outbound log.
 *
 * Provider and model are deliberately NOT part of it: a verdict cached once is
 * the verdict for that input on every backend, so a flow replays the same way
 * against a stub, a local server or a hosted model (AI13 "identical cached
 * verdicts"). Re-asking after a model change is an explicit cache bypass.
 */
export function canonicalRequest(request: LlmRequest, images: 'inline' | 'digest'): string {
  const content = (c: LlmMessage['content']): unknown =>
    typeof c === 'string'
      ? c
      : c.map((b) =>
          b.type === 'text'
            ? { type: 'text', text: b.text }
            : images === 'inline'
              ? { type: 'image', mediaType: b.mediaType, data: b.data }
              : {
                  type: 'image',
                  mediaType: b.mediaType,
                  sha256: sha256(Buffer.from(b.data, 'base64')),
                  bytes: Buffer.from(b.data, 'base64').length
                }
        )
  return JSON.stringify({
    purpose: request.purpose,
    system: request.system ?? null,
    messages: request.messages.map((m) => ({ role: m.role, content: content(m.content) })),
    maxOutputTokens: request.maxOutputTokens
  })
}

export function inputHash(request: LlmRequest): string {
  return sha256(canonicalRequest(request, 'inline'))
}
