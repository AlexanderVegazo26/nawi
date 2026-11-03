import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings, defaultSettings, mergeSettings, type AiSettings } from '@shared/settings'
import { providerFor, resolveLlmConfig, type LlmConfig } from './config'
import { anthropicProvider, openAiCompatibleProvider, stubProvider } from './providers'
import { LlmSession } from './session'
import { llmPaths, openLlmSession } from './index'
import type { LlmProvider, LlmRequest } from './types'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const SECRET = 'hunter2-Very-Secret'
// Built at runtime so the fixture is not a key-shaped literal in the repo (push protection).
const API_KEY_IN_PAGE = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_')

function verdictRequest(statement = 'the cart shows 3 items'): LlmRequest {
  return {
    purpose: 'assert.ai',
    system: 'Answer PASS or FAIL.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', mediaType: 'image/png', data: PNG_1PX },
          { type: 'text', text: `Statement: ${statement}. Typed password ${SECRET}.` }
        ]
      }
    ],
    maxOutputTokens: 16
  }
}

function config(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: 'anthropic',
    model: 'configured-model',
    baseUrl: '',
    offline: false,
    apiKey: undefined,
    caps: { maxCalls: 20, maxTokens: 10_000, maxUsd: null },
    prices: null,
    ...over
  }
}

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'nawi-llm-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

function session(provider: LlmProvider | null, over: Partial<LlmConfig> = {}, secrets = [SECRET]): LlmSession {
  return new LlmSession({
    config: config(over),
    provider,
    ...llmPaths(dir),
    redaction: { secrets }
  })
}

async function logLines(): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(llmPaths(dir).logPath, 'utf-8').catch(() => '')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** A fake Anthropic Messages endpoint behind the official SDK's `fetch` option. */
function fakeAnthropic(answer = 'PASS', stop = 'end_turn') {
  const bodies: Array<Record<string, unknown>> = []
  const headers: Headers[] = []
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    headers.push(new Headers(init?.headers))
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'hosted-answered',
        content: [{ type: 'text', text: answer }],
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 2 }
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_1' } }
    )
  })
  return { fetchImpl, bodies, headers }
}

/** A real loopback OpenAI-compatible server, like a local inference server. */
async function localServer(answer = 'PASS'): Promise<{ url: string; requests: Array<{ body: any; auth: string | undefined }>; server: Server }> {
  const requests: Array<{ body: any; auth: string | undefined }> = []
  const server = createServer((req: IncomingMessage, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      requests.push({ body: JSON.parse(data), auth: req.headers.authorization })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'local-answered',
          choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 90, completion_tokens: 1 }
        })
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/v1`, requests, server }
}

/* ------------------------------------------------------------------ *
 * AI13 done-when
 * ------------------------------------------------------------------ */

describe('AI13: the same request against stub, local and hosted backends', () => {
  it('gives the identical cached verdict on every backend after the first answer', async () => {
    const stub = stubProvider(() => 'PASS')
    const first = await session(stub).complete(verdictRequest())
    expect(first, 'stub answers live the first time').toMatchObject({ status: 'ok', text: 'PASS', cached: false })
    expect(stub.calls).toBe(1)

    const local = await localServer('FAIL')
    try {
      const viaLocal = await session(openAiCompatibleProvider({ baseUrl: local.url }), {
        provider: 'openai-compatible'
      }).complete(verdictRequest())
      const hosted = fakeAnthropic('FAIL')
      const viaHosted = await session(anthropicProvider({ apiKey: 'k', fetch: hosted.fetchImpl as never })).complete(
        verdictRequest()
      )
      for (const [name, r] of [
        ['local', viaLocal],
        ['hosted', viaHosted]
      ] as const) {
        expect(r, `${name} must return the cached stub verdict, not its own`).toMatchObject({
          status: 'ok',
          text: 'PASS',
          cached: true,
          inputHash: first.inputHash,
          provider: 'stub'
        })
      }
      expect(local.requests, 'the local server must not be asked for a cached input').toHaveLength(0)
      expect(hosted.fetchImpl, 'the hosted endpoint must not be asked for a cached input').not.toHaveBeenCalled()
    } finally {
      local.server.close()
    }
  })

  it('local and hosted backends each answer live when nothing is cached, in their own wire format', async () => {
    const local = await localServer('PASS')
    try {
      const r = await session(openAiCompatibleProvider({ baseUrl: `${local.url}/`, apiKey: 'local-key' }), {
        provider: 'openai-compatible'
      }).complete(verdictRequest())
      expect(r).toMatchObject({ status: 'ok', text: 'PASS', cached: false, provider: 'openai-compatible', model: 'local-answered' })
      const body = local.requests[0]?.body
      expect(local.requests[0]?.auth).toBe('Bearer local-key')
      expect(body.model, 'model id comes from config').toBe('configured-model')
      expect(body.max_tokens).toBe(16)
      expect(body.messages[0]).toEqual({ role: 'system', content: 'Answer PASS or FAIL.' })
      expect(body.messages[1].content[0]).toEqual({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${PNG_1PX}` }
      })
    } finally {
      local.server.close()
    }

    const hosted = fakeAnthropic('PASS')
    const r2 = await session(anthropicProvider({ apiKey: 'test-key', fetch: hosted.fetchImpl as never })).complete(
      verdictRequest('another statement')
    )
    expect(r2).toMatchObject({ status: 'ok', text: 'PASS', cached: false, provider: 'anthropic', model: 'hosted-answered' })
    expect(r2.status === 'ok' && r2.usage).toEqual({ inputTokens: 120, outputTokens: 2 })
    const sent = hosted.bodies[0] as any
    expect(hosted.headers[0]?.get('authorization')).toBe('Bearer test-key')
    expect(hosted.headers[0]?.get('anthropic-version'), 'the SDK pins the API version').toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(sent.model).toBe('configured-model')
    expect(sent.max_tokens).toBe(16)
    expect(sent.system).toBe('Answer PASS or FAIL.')
    expect(sent.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG_1PX }
    })
    expect('temperature' in sent, 'no sampling parameters are sent').toBe(false)
  })

  it('offline mode never makes a network call, and still serves cached answers', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    const hosted = fakeAnthropic()
    const offline = session(anthropicProvider({ apiKey: 'k', fetch: hosted.fetchImpl as never }), { offline: true })
    const r = await offline.complete(verdictRequest())
    expect(r).toMatchObject({ status: 'not_evaluated', reason: 'offline' })
    expect(hosted.fetchImpl).not.toHaveBeenCalled()
    expect(globalFetch).not.toHaveBeenCalled()
    expect(await logLines(), 'nothing left the machine, so nothing is logged').toEqual([])

    await session(stubProvider(() => 'PASS')).complete(verdictRequest())
    const again = await offline.complete(verdictRequest())
    expect(again).toMatchObject({ status: 'ok', text: 'PASS', cached: true })
    expect(hosted.fetchImpl).not.toHaveBeenCalled()
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('NAWI_LLM_OFFLINE turns offline mode on but can never turn it off', () => {
    const on = { ...defaultAiSettings(), offline: true }
    expect(resolveLlmConfig(on, { NAWI_LLM_OFFLINE: '0' }).offline).toBe(true)
    expect(resolveLlmConfig(defaultAiSettings(), { NAWI_LLM_OFFLINE: '1' }).offline).toBe(true)
    expect(resolveLlmConfig(defaultAiSettings(), {}).offline).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * Redaction and the outbound log
 * ------------------------------------------------------------------ */

describe('redaction before send and the outbound log', () => {
  it('masks run secrets, built-in patterns and workspace rules in what is sent, and logs exactly that', async () => {
    const seen: LlmRequest[] = []
    const stub = stubProvider((req) => {
      seen.push(req)
      return 'PASS'
    })
    const s = new LlmSession({
      config: config(),
      provider: stub,
      ...llmPaths(dir),
      redaction: {
        secrets: [SECRET],
        rules: [{ id: 'order', label: 'Order id', pattern: 'ORD-\\d{6}', enabled: true }]
      }
    })
    const req = verdictRequest(`order ORD-123456 for ana@example.com, key ${API_KEY_IN_PAGE}, pw%20${encodeURIComponent(SECRET)}`)
    const original = JSON.stringify(req)
    await s.complete(req)
    expect(JSON.stringify(req), 'the caller\'s request is not modified').toBe(original)

    const sentText = JSON.stringify(seen[0])
    for (const leaked of [SECRET, encodeURIComponent(SECRET), 'ORD-123456', 'ana@example.com', API_KEY_IN_PAGE]) {
      expect(sentText.includes(leaked), `"${leaked}" must not reach the provider`).toBe(false)
    }
    expect(sentText).toContain('[REDACTED:secret]')
    expect(sentText).toContain('[REDACTED:order]')
    expect(sentText).toContain('[REDACTED:email]')
    expect(sentText, 'images are sent unchanged').toContain(PNG_1PX)

    const lines = await logLines()
    expect(lines.map((l) => l.event)).toEqual(['sent', 'answered'])
    const logged = JSON.stringify(lines)
    for (const leaked of [SECRET, 'ORD-123456', 'ana@example.com', API_KEY_IN_PAGE, PNG_1PX]) {
      expect(logged.includes(leaked), `"${leaked}" must not be in the outbound log`).toBe(false)
    }
    const sentLine = lines[0] as any
    expect(sentLine).toMatchObject({ purpose: 'assert.ai', provider: 'stub', endpoint: 'stub:', model: 'configured-model' })
    expect(sentLine.request.messages[0].content[0]).toMatchObject({ type: 'image', mediaType: 'image/png', bytes: 70 })
    expect(sentLine.request.messages[0].content[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(sentLine.request.messages[0].content[1].text, 'the log holds the redacted text as sent').toBe(
      (seen[0]!.messages[0]!.content as any)[1].text
    )
    expect(sentLine.redactions).toEqual(
      expect.arrayContaining([
        { id: 'secret', count: 2 },
        { id: 'order', count: 1 },
        { id: 'email', count: 1 }
      ])
    )
  })

  it('never logs the API key', async () => {
    const hosted = fakeAnthropic()
    await session(anthropicProvider({ apiKey: 'sk-ant-should-not-appear', fetch: hosted.fetchImpl as never })).complete(
      verdictRequest()
    )
    expect(JSON.stringify(await logLines())).not.toContain('sk-ant-should-not-appear')
  })

  it('sends nothing when the outbound log cannot be written', async () => {
    const stub = stubProvider()
    await fs.writeFile(join(dir, 'ai'), 'a file where the log folder should be')
    const r = await session(stub).complete(verdictRequest())
    expect(r).toMatchObject({ status: 'not_evaluated', reason: 'error' })
    expect(r.status === 'not_evaluated' && r.detail).toMatch(/outbound log/)
    expect(stub.calls, 'no call without a log line').toBe(0)
  })

  it('a different secret value gives the same cache key (the key is the redacted input)', async () => {
    const a = await session(stubProvider(() => 'PASS'), {}, [SECRET]).complete(verdictRequest())
    const req = verdictRequest()
    const text = (req.messages[0]!.content as any)[1]
    text.text = text.text.replace(SECRET, 'other-Secret-Value')
    const b = await session(stubProvider(() => 'FAIL'), {}, ['other-Secret-Value']).complete(req)
    expect(b).toMatchObject({ status: 'ok', cached: true, text: 'PASS', inputHash: a.inputHash })
  })
})

/* ------------------------------------------------------------------ *
 * Caps, failures, cancellation, cache
 * ------------------------------------------------------------------ */

describe('per-run caps', () => {
  it('stops at the call cap with "budget", cached answers still free', async () => {
    const stub = stubProvider(() => 'PASS')
    const s = session(stub, { caps: { maxCalls: 2, maxTokens: 10_000, maxUsd: null } })
    expect((await s.complete(verdictRequest('a'))).status).toBe('ok')
    expect((await s.complete(verdictRequest('b'))).status).toBe('ok')
    expect(await s.complete(verdictRequest('c'))).toMatchObject({ status: 'not_evaluated', reason: 'budget' })
    expect(stub.calls).toBe(2)
    expect(await s.complete(verdictRequest('a'))).toMatchObject({ status: 'ok', cached: true })
    expect(s.spent.calls).toBe(2)
  })

  it('refuses a call that could pass the token cap, counting calls still in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow: LlmProvider = {
      id: 'stub',
      endpoint: 'stub:',
      async complete(_req, call) {
        await gate
        return {
          text: 'PASS',
          model: call.model,
          usage: { inputTokens: 10, outputTokens: 5 },
          refused: false,
          truncated: false
        }
      }
    }
    // One request reserves ~1,600 (image) + text/3 + 16 output tokens: one fits under 2,000, two don't.
    const s = session(slow, { caps: { maxCalls: 20, maxTokens: 2000, maxUsd: null } })
    const first = s.complete(verdictRequest('a'))
    const second = await s.complete(verdictRequest('b'))
    expect(second, 'the call in flight already holds its reservation').toMatchObject({
      status: 'not_evaluated',
      reason: 'budget'
    })
    release()
    expect((await first).status).toBe('ok')
    expect(s.spent).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 5 })
  })

  it('enforces the cost cap only when prices are known', async () => {
    const priced = session(stubProvider(() => 'PASS'), {
      caps: { maxCalls: 20, maxTokens: 10_000, maxUsd: 0.0001 },
      prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 }
    })
    expect(await priced.complete({ ...verdictRequest(), maxOutputTokens: 100 })).toMatchObject({
      status: 'not_evaluated',
      reason: 'budget'
    })
    const settings: AiSettings = { ...defaultAiSettings(), maxCostPerRunUsd: 0.5 }
    expect(resolveLlmConfig(settings, {}).caps.maxUsd, 'no prices, no cost cap').toBeNull()
    expect(resolveLlmConfig({ ...settings, inputUsdPerMTok: 1, outputUsdPerMTok: 2 }, {}).caps.maxUsd).toBe(0.5)
  })

  it('a request bigger than the run cap is "budget", and a cached answer is still served', async () => {
    const r = await session(stubProvider(), { caps: { maxCalls: 5, maxTokens: 10, maxUsd: null } }).complete(verdictRequest())
    expect(r).toMatchObject({ status: 'not_evaluated', reason: 'budget' })
    await session(stubProvider(() => 'PASS')).complete(verdictRequest())
    const tiny = session(stubProvider(), { caps: { maxCalls: 0, maxTokens: 0, maxUsd: null } })
    expect(await tiny.complete(verdictRequest())).toMatchObject({ status: 'ok', cached: true })
  })

  it('parallel calls started together cannot pass the call cap', async () => {
    const stub = stubProvider(() => 'PASS')
    const s = session(stub, { caps: { maxCalls: 1, maxTokens: 100_000, maxUsd: null } })
    const results = await Promise.all([s.complete(verdictRequest('a')), s.complete(verdictRequest('b'))])
    expect(results.map((r) => (r.status === 'ok' ? 'ok' : r.reason)).sort()).toEqual(['budget', 'ok'])
    expect(stub.calls).toBe(1)
  })

  it('counts the input against the token cap before sending', async () => {
    const big: LlmRequest = { ...verdictRequest(), messages: [{ role: 'user', content: 'x'.repeat(30_000) }] }
    const stub = stubProvider()
    const r = await session(stub, { caps: { maxCalls: 5, maxTokens: 5_000, maxUsd: null } }).complete(big)
    expect(r, '~10,000 input tokens cannot fit a 5,000 cap').toMatchObject({ reason: 'budget' })
    expect(stub.calls).toBe(0)
  })
})

describe('failures are "not evaluated", never cached, never leak', () => {
  it('a refusal is not a verdict and is not cached', async () => {
    const hosted = fakeAnthropic('', 'refusal')
    const p = anthropicProvider({ apiKey: 'k', fetch: hosted.fetchImpl as never })
    expect(await session(p).complete(verdictRequest())).toMatchObject({ status: 'not_evaluated', reason: 'refused' })
    expect(await session(stubProvider(() => 'PASS')).complete(verdictRequest())).toMatchObject({ cached: false })
    expect((await logLines()).map((l) => l.event)).toEqual(['sent', 'refused', 'sent', 'answered'])
  })

  it('a cut-off or empty answer is not a verdict and is not cached', async () => {
    const hosted = fakeAnthropic('PA', 'max_tokens')
    const p = anthropicProvider({ apiKey: 'k', fetch: hosted.fetchImpl as never })
    expect(await session(p).complete(verdictRequest())).toMatchObject({ status: 'not_evaluated', reason: 'error' })
    expect((await logLines()).at(-1)).toMatchObject({ event: 'truncated' })
    const lengthCut = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'PA' }, finish_reason: 'length' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    const local = openAiCompatibleProvider({ baseUrl: 'http://127.0.0.1:9/v1', fetch: lengthCut as never })
    expect(await session(local, { provider: 'openai-compatible' }).complete(verdictRequest())).toMatchObject({ reason: 'error' })
    expect(await session(stubProvider(() => '  ')).complete(verdictRequest())).toMatchObject({ reason: 'error' })
    expect(await session(stubProvider(() => 'PASS')).complete(verdictRequest()), 'nothing was cached').toMatchObject({
      cached: false
    })
  })

  it('sends nothing when a workspace redaction rule does not compile', async () => {
    const stub = stubProvider()
    const s = new LlmSession({
      config: config(),
      provider: stub,
      ...llmPaths(dir),
      redaction: { rules: [{ id: 'acct', label: 'Account', pattern: '(acct-\\d+', enabled: true }] }
    })
    const r = await s.complete(verdictRequest())
    expect(r).toMatchObject({ status: 'not_evaluated', reason: 'error' })
    expect(r.status === 'not_evaluated' && r.detail).toContain('"acct"')
    expect(stub.calls).toBe(0)
    expect(await logLines()).toEqual([])
  })

  it('the Anthropic SDK does not retry: one logged send is one HTTP request', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), {
          status: 529,
          headers: { 'content-type': 'application/json' }
        })
    )
    const r = await session(anthropicProvider({ apiKey: 'k', fetch: fetchImpl as never })).complete(verdictRequest())
    expect(r).toMatchObject({ reason: 'error', detail: 'the provider answered HTTP 529' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('an HTTP error names the status only, not the body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(`echo: ${SECRET}`, { status: 500, headers: { 'content-type': 'text/plain' } })
    )
    const r = await session(openAiCompatibleProvider({ baseUrl: 'http://127.0.0.1:9/v1', fetch: fetchImpl as never }), {
      provider: 'openai-compatible'
    }).complete(verdictRequest())
    expect(r).toMatchObject({ status: 'not_evaluated', reason: 'error', detail: 'the provider answered HTTP 500' })
    expect(JSON.stringify(await logLines())).not.toContain(SECRET)
    expect((await logLines()).at(-1)).toMatchObject({ event: 'failed', status: 500 })
  })

  it('an Anthropic API error maps to its status', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
    )
    const r = await session(anthropicProvider({ apiKey: 'k', fetch: fetchImpl as never })).complete(verdictRequest())
    expect(r).toMatchObject({ status: 'not_evaluated', reason: 'error', detail: 'the provider answered HTTP 401' })
  })

  it('a cancelled call is "cancelled"', async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await session(stubProvider()).complete(verdictRequest(), { signal: ac.signal })).toMatchObject({
      reason: 'cancelled'
    })
    const hanging: LlmProvider = {
      id: 'stub',
      endpoint: 'stub:',
      complete: (_r, call) =>
        new Promise((_, reject) =>
          call.signal?.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })))
        )
    }
    const ac2 = new AbortController()
    const pending = session(hanging).complete(verdictRequest(), { signal: ac2.signal })
    await vi.waitFor(async () => expect((await logLines()).length).toBe(1))
    ac2.abort()
    expect(await pending).toMatchObject({ status: 'not_evaluated', reason: 'cancelled' })
  })

  it('reports no provider / no model instead of guessing', async () => {
    const none = openLlmSession({ settings: defaultSettings(), userData: dir, env: {} })
    expect(await none.complete(verdictRequest())).toMatchObject({ reason: 'no_provider' })
    expect(await session(stubProvider(), { model: '' }).complete(verdictRequest())).toMatchObject({ reason: 'no_model' })
    const noUrl = providerFor(resolveLlmConfig({ ...defaultAiSettings(), provider: 'openai-compatible', model: 'm' }, {}))
    expect(noUrl.provider).toBeNull()
  })
})

describe('response cache', () => {
  it('a damaged cache entry is a miss, and refresh asks again and replaces the answer', async () => {
    const first = await session(stubProvider(() => 'PASS')).complete(verdictRequest())
    const file = join(llmPaths(dir).cacheDir, `${first.inputHash}.json`)
    await fs.writeFile(file, '{"version":1,"inputHash":"x","text":"FAIL","provider":"stub"}')
    const stub = stubProvider(() => 'PASS again')
    expect(await session(stub).complete(verdictRequest())).toMatchObject({ cached: false, text: 'PASS again' })
    const refreshed = await session(stubProvider(() => 'FAIL')).complete(verdictRequest(), { refresh: true })
    expect(refreshed).toMatchObject({ cached: false, text: 'FAIL' })
    expect(await session(null).complete(verdictRequest())).toMatchObject({ cached: true, text: 'FAIL' })
  })

  it('the purpose is part of the key', async () => {
    await session(stubProvider(() => 'PASS')).complete(verdictRequest())
    const other = await session(null).complete({ ...verdictRequest(), purpose: 'triage' })
    expect(other).toMatchObject({ status: 'not_evaluated', reason: 'no_provider' })
  })
})

/* ------------------------------------------------------------------ *
 * Settings and config
 * ------------------------------------------------------------------ */

describe('settings.ai', () => {
  it('defaults to no provider and an old settings file without "ai" keeps that', () => {
    expect(defaultSettings().ai).toEqual(defaultAiSettings())
    expect(defaultSettings().ai.provider).toBe('none')
    expect(mergeSettings(defaultSettings(), { theme: 'dark' }).ai).toEqual(defaultAiSettings())
  })

  it('accepts valid values and drops invalid ones field by field', () => {
    const next = mergeSettings(defaultSettings(), {
      ai: {
        provider: 'openai-compatible',
        model: 'local-model:7b',
        baseUrl: 'http://127.0.0.1:8080/v1',
        offline: true,
        maxCallsPerRun: 5.7,
        maxTokensPerRun: -1,
        maxCostPerRunUsd: Number.NaN,
        __proto__: { polluted: true }
      }
    })
    expect(next.ai).toEqual({
      ...defaultAiSettings(),
      provider: 'openai-compatible',
      model: 'local-model:7b',
      baseUrl: 'http://127.0.0.1:8080/v1',
      offline: true,
      maxCallsPerRun: 5
    })
    const bad = mergeSettings(defaultSettings(), {
      ai: { provider: 'gpt', model: 'two words', baseUrl: 'http://user:pw@host/v1', offline: 'yes' }
    })
    expect(bad.ai, 'unknown provider, spaced model, URL with credentials, string boolean all dropped').toEqual(
      defaultAiSettings()
    )
    expect(mergeSettings(defaultSettings(), { ai: { baseUrl: 'file:///etc/passwd' } }).ai.baseUrl).toBe('')
  })

  it('the Anthropic backend never uses the OpenAI-compatible base URL, and logs where it really sends', () => {
    const c = resolveLlmConfig(
      { ...defaultAiSettings(), provider: 'anthropic', model: 'm', baseUrl: 'http://127.0.0.1:8080/v1' },
      { NAWI_LLM_API_KEY: 'k' }
    )
    const choice = providerFor(c)
    expect(choice.provider?.endpoint).not.toContain('127.0.0.1:8080')
    expect(anthropicProvider({ apiKey: 'k', baseUrl: 'https://proxy.example' }).endpoint).toBe('https://proxy.example')
  })

  it('an unsafe NAWI_LLM_BASE_URL is ignored like an unsafe setting', () => {
    for (const bad of ['https://user:tok@llm.internal/v1', 'https://llm.internal/v1?api_key=x', 'file:///tmp/x']) {
      expect(resolveLlmConfig({ ...defaultAiSettings(), baseUrl: 'http://127.0.0.1:1/v1' }, { NAWI_LLM_BASE_URL: bad }).baseUrl, bad).toBe(
        'http://127.0.0.1:1/v1'
      )
    }
  })

  it('a secret shorter than 4 characters is not used to mask text', async () => {
    const seen: LlmRequest[] = []
    await session(
      stubProvider((r) => {
        seen.push(r)
        return 'PASS'
      }),
      {},
      ['a']
    ).complete({ ...verdictRequest(), messages: [{ role: 'user', content: 'a cart has items' }] })
    expect(seen[0]?.messages[0]?.content).toBe('a cart has items')
  })

  it('env picks provider, model, endpoint and key; keys never come from settings', () => {
    const c = resolveLlmConfig(defaultAiSettings(), {
      NAWI_LLM_PROVIDER: 'openai-compatible',
      NAWI_LLM_MODEL: 'm1',
      NAWI_LLM_BASE_URL: 'http://127.0.0.1:1/v1',
      OPENAI_API_KEY: 'from-env'
    })
    expect(c).toMatchObject({ provider: 'openai-compatible', model: 'm1', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'from-env' })
    expect(resolveLlmConfig(defaultAiSettings(), { NAWI_LLM_PROVIDER: 'bogus' }).provider).toBe('none')
    expect(resolveLlmConfig({ ...defaultAiSettings(), provider: 'anthropic' }, { OPENAI_API_KEY: 'x' }).apiKey).toBeUndefined()
    expect(resolveLlmConfig({ ...defaultAiSettings(), provider: 'anthropic' }, { NAWI_LLM_API_KEY: 'n' }).apiKey).toBe('n')
  })
})
