import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { postJson } from '../../mcp/post'

/**
 * Roadmap AI12 against the real loopback server: a client that asks for
 * progress gets it as an event stream, and `notifications/cancelled` stops
 * exactly the call it names, for the session that sent it.
 */

let userData = tmpdir()
vi.mock('electron', () => ({ app: { getPath: () => userData, getVersion: () => '9.9.9' } }))

const { startMcpServer } = await import('./server')
const { defineTool } = await import('./dispatch')
const { CANCELLED_REASON } = await import('./progress')

/** Resolves when the `wait` tool is running, so a cancel is sent to a call that is really in flight. */
let started: () => void = () => undefined
/** Why each `wait` call ended, in order. */
const stoppedWith: unknown[] = []
const tools = [
  defineTool({
    name: 'count',
    description: 'reports two progress updates, then answers',
    idempotent: false,
    schema: z.object({}),
    async run(_args, ctx) {
      ctx.progress?.({ progress: 1, total: 2, message: 'step 1/2 a (click): passed' })
      ctx.progress?.({ progress: 2, total: 2, message: 'step 2/2 b (click): passed' })
      return { done: true }
    }
  }),
  defineTool({
    name: 'wait',
    description: 'runs until its call is stopped, then answers with the reason',
    idempotent: false,
    schema: z.object({}),
    async run(_args, ctx) {
      const signal = ctx.signal as AbortSignal
      started()
      if (!signal.aborted) await new Promise((r) => signal.addEventListener('abort', r, { once: true }))
      stoppedWith.push(signal.reason)
      return { stopped: signal.reason }
    }
  })
]

let handle: Awaited<ReturnType<typeof startMcpServer>>

beforeEach(async () => {
  userData = await fs.mkdtemp(join(tmpdir(), 'nawi-mcp-progress-'))
  handle = await startMcpServer({ tools, isPaused: async () => false })
  expect(handle, 'the server should start on loopback').not.toBeNull()
})

afterEach(async () => {
  await handle?.close()
  await fs.rm(userData, { recursive: true, force: true })
})

interface Sent {
  status: number
  sessionId: string | null
  streamed: boolean
  /** Parsed JSON-RPC messages: every event of a stream, or the one JSON body. */
  messages: Array<Record<string, unknown>>
}

async function rpc(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Sent> {
  const info = handle!.info
  const events: string[] = []
  const res = await postJson(
    info.url,
    { 'content-type': 'application/json', authorization: `Bearer ${info.token}`, ...headers },
    JSON.stringify({ jsonrpc: '2.0', ...body }),
    { onEvent: (d) => events.push(d) }
  )
  const raw = res.streamed ? events : res.text ? [res.text] : []
  return { status: res.status, sessionId: res.sessionId, streamed: res.streamed, messages: raw.map((t) => JSON.parse(t)) }
}

const SSE = { accept: 'application/json, text/event-stream' }

describe('MCP progress over the loopback endpoint', () => {
  it('issues a session id on initialize', async () => {
    const res = await rpc({ id: 1, method: 'initialize', params: {} })
    expect(res.sessionId, 'initialize should issue Mcp-Session-Id').toMatch(/^[0-9a-f-]{36}$/)
    const again = await rpc({ id: 1, method: 'initialize', params: {} })
    expect(again.sessionId, 'every initialize gets its own session').not.toBe(res.sessionId)
  })

  it('streams notifications/progress and then the answer when the call sends a progressToken and accepts SSE', async () => {
    const res = await rpc({ id: 4, method: 'tools/call', params: { name: 'count', arguments: {}, _meta: { progressToken: 'p1' } } }, SSE)
    expect(res.streamed, 'answer should be an event stream').toBe(true)
    expect(res.messages).toEqual([
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p1', progress: 1, total: 2, message: 'step 1/2 a (click): passed' } },
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p1', progress: 2, total: 2, message: 'step 2/2 b (click): passed' } },
      expect.objectContaining({ id: 4, result: expect.objectContaining({ structuredContent: { done: true }, isError: false }) })
    ])
  })

  it('answers with plain JSON and no progress when the caller cannot take a stream or sent no token', async () => {
    const noAccept = await rpc({ id: 5, method: 'tools/call', params: { name: 'count', arguments: {}, _meta: { progressToken: 'p1' } } })
    const noToken = await rpc({ id: 6, method: 'tools/call', params: { name: 'count', arguments: {} } }, SSE)
    for (const [label, res] of [['no Accept', noAccept], ['no token', noToken]] as const) {
      expect(res.streamed, `${label}: plain JSON`).toBe(false)
      expect(res.messages, `${label}: only the answer`).toEqual([
        expect.objectContaining({ result: expect.objectContaining({ structuredContent: { done: true } }) })
      ])
    }
  })

  it('stops a running call on notifications/cancelled from its own session only', async () => {
    const mine = (await rpc({ id: 1, method: 'initialize', params: {} })).sessionId as string
    const other = (await rpc({ id: 1, method: 'initialize', params: {} })).sessionId as string
    const running = new Promise<void>((r) => (started = r))
    const call = rpc({ id: 9, method: 'tools/call', params: { name: 'wait', arguments: {} } }, { 'mcp-session-id': mine })
    await running

    const cancel = (session: string | null, requestId: unknown): Promise<Sent> =>
      rpc({ method: 'notifications/cancelled', params: { requestId, reason: 'user pressed stop' } }, session ? { 'mcp-session-id': session } : {})
    for (const [label, res] of [
      ['other session', await cancel(other, 9)],
      ['no session', await cancel(null, 9)],
      ['other id', await cancel(mine, 10)],
      ['string id', await cancel(mine, '9')]
    ] as const) {
      expect(res.status, `${label}: a notification is answered 202`).toBe(202)
    }
    const stillRunning = await Promise.race([call.then(() => 'answered'), new Promise((r) => setImmediate(() => r('running')))])
    expect(stillRunning, 'a cancel for another session or id must not stop the call').toBe('running')

    expect((await cancel(mine, 9)).status).toBe(202)
    const res = await call
    expect(res.messages[0], 'the stopped call still answers, saying why').toMatchObject({
      id: 9,
      result: { structuredContent: { stopped: CANCELLED_REASON } }
    })
  })

  it('cannot cancel a call made without a session by id (any sessionless caller could), but its disconnect stops it', async () => {
    stoppedWith.length = 0
    const running = new Promise<void>((r) => (started = r))
    const info = handle!.info
    const hangUp = new AbortController()
    const call = postJson(
      info.url,
      { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait', arguments: {} } }),
      { signal: hangUp.signal }
    ).then(
      () => 'answered',
      (e: Error) => e.message
    )
    await running
    expect((await rpc({ method: 'notifications/cancelled', params: { requestId: 1 } })).status).toBe(202)
    const raced = await Promise.race([call, new Promise((r) => setImmediate(() => r('running')))])
    expect(raced, 'a sessionless cancel must not stop a sessionless call').toBe('running')
    expect(stoppedWith, 'nothing stopped yet').toEqual([])

    hangUp.abort()
    expect(await call, 'the client closed its request').toBe('aborted')
    await vi.waitFor(() =>
      expect(stoppedWith, 'the disconnect is the call\'s stop signal').toEqual([
        'the caller disconnected, so the remaining steps were not run'
      ])
    )
  })
})
