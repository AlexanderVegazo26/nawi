import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NOT_RUNNING } from './endpoint'
import { APP_ERROR, forward } from './forward'
import { postJson } from './post'

/**
 * The stdio bridge's transport against a real loopback server. Time is faked
 * (undici's and node:http's timers both run on it), so "the app answers after
 * ten minutes" takes milliseconds and never depends on the host clock.
 */

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void

let server: Server
let dir: string
let url: string
let handler: Handler
const received: Array<{ headers: IncomingMessage['headers']; body: string }> = []

beforeEach(async () => {
  received.length = 0
  handler = (_req, _body, res) => res.end()
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      received.push({ headers: req.headers, body })
      handler(req, body, res)
    })
  })
  // node:http's own server timeouts would cut the held request under fake time.
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.keepAliveTimeout = 0
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as { port: number }
  url = `http://127.0.0.1:${port}/mcp`
  dir = mkdtempSync(join(tmpdir(), 'nawi-forward-'))
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ url, token: 'tok-123', pid: 1 }))
  vi.stubEnv('NAWI_MCP_CONFIG', join(dir, 'mcp.json'))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

/** Advances fake time in 1 s steps (undici checks its timeouts on a 1 s tick), yielding to real I/O between steps. */
async function advance(seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    await vi.advanceTimersByTimeAsync(1000)
    await new Promise((r) => setImmediate(r))
  }
}

function fakeTime(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
}

/** Resolves once the server has the request, so the held reply is really in flight before time moves. */
async function untilReceived(n: number): Promise<void> {
  await vi.waitFor(() => expect(received.length, 'requests the fake app has received').toBe(n), { timeout: 5000 })
}

const RUN_REPLY = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'passed' }] } })

describe('stdio bridge forward()', () => {
  test('relays a run_flow reply that arrives after 10 minutes without response headers (fetch drops it at 300 s)', async () => {
    let release: (() => void) | undefined
    handler = (_req, _body, res) => {
      release = () => res.writeHead(200, { 'content-type': 'application/json' }).end(RUN_REPLY)
    }
    const out: string[] = []
    fakeTime()
    const done = forward({ jsonrpc: '2.0', id: 7, method: 'tools/call' }, (l) => out.push(l))
    await untilReceived(1)
    await advance(600)
    expect(out, 'nothing may be written while the app is still running the flow').toEqual([])
    release?.()
    await done
    expect(out, 'the late reply should be forwarded verbatim, not replaced by a not-running error').toEqual([RUN_REPLY])
  }, 60_000)

  test('forwards the frame with the bearer token and no Origin header', async () => {
    handler = (_req, _body, res) => res.writeHead(200).end(RUN_REPLY)
    const out: string[] = []
    const frame = { jsonrpc: '2.0', id: 7, method: 'tools/call' }
    await forward(frame, (l) => out.push(l))
    expect(received[0]?.headers.authorization, 'bearer token from mcp.json').toBe('Bearer tok-123')
    expect(received[0]?.headers.origin, 'main rejects any Origin; the bridge must not send one').toBeUndefined()
    expect(JSON.parse(received[0]?.body ?? 'null'), 'frame body forwarded unchanged').toEqual(frame)
    expect(out).toEqual([RUN_REPLY])
  })

  test('writes nothing for a notification answered with 202', async () => {
    handler = (_req, _body, res) => res.writeHead(202, { 'content-length': '0' }).end()
    const out: string[] = []
    await forward({ jsonrpc: '2.0', method: 'notifications/initialized' }, (l) => out.push(l))
    expect(out, 'a notification gets no reply').toEqual([])
  })

  test('answers an empty reply with an app error naming the HTTP status', async () => {
    handler = (_req, _body, res) => res.writeHead(500).end()
    const out: string[] = []
    await forward({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, (l) => out.push(l))
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: '2.0', id: 3, error: { code: APP_ERROR, message: 'Nawi returned an empty response (HTTP 500).' } }
    ])
  })

  test('answers a refused connection at once with the not-running error', async () => {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    const out: string[] = []
    await forward({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, (l) => out.push(l))
    const reply = JSON.parse(out[0] ?? 'null') as { id: number; error: { code: number; message: string } }
    expect(reply.id).toBe(4)
    expect(reply.error.code).toBe(APP_ERROR)
    expect(reply.error.message, 'refused connection message').toContain(NOT_RUNNING)
    expect(reply.error.message).toContain('ECONNREFUSED')
    // afterEach closes it again; reopen so that is a no-op rather than an error.
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  })

  test('answers with not-running when mcp.json is missing', async () => {
    vi.stubEnv('NAWI_MCP_CONFIG', join(dir, 'absent.json'))
    const out: string[] = []
    await forward({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, (l) => out.push(l))
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: '2.0', id: 5, error: { code: APP_ERROR, message: NOT_RUNNING } }
    ])
    expect(received, 'no request is sent without an endpoint').toEqual([])
  })
})

describe('postJson (CLI + bridge transport)', () => {
  test('waits past 300 s for response headers', async () => {
    let release: (() => void) | undefined
    handler = (_req, _body, res) => {
      release = () => res.writeHead(200).end('late')
    }
    fakeTime()
    const done = postJson(url, { 'content-type': 'application/json' }, '{}')
    await untilReceived(1)
    await advance(400)
    release?.()
    await expect(done, 'a reply after 400 s of silence').resolves.toMatchObject({ status: 200, text: 'late' })
  }, 60_000)

  test('sends a content-length that counts bytes, not UTF-16 units', async () => {
    handler = (_req, _body, res) => res.end('ok')
    const body = JSON.stringify({ name: 'Facturación ✓' })
    await postJson(url, {}, body)
    expect(received[0]?.headers['content-length']).toBe(String(Buffer.byteLength(body)))
    expect(received[0]?.body).toBe(body)
  })
})
