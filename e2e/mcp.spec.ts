import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * FR-AGT.1-3 / UX-AGT.3 against the real, built app.
 *
 * This drives the MCP endpoint the way a client actually does — over loopback
 * HTTP *and* through the spawned stdio bridge — rather than calling the tool
 * modules directly. A unit test of `dispatch` proves the chokepoint's logic; only
 * this proves that the server starts, publishes `mcp.json`, binds where it says
 * it binds, and that the bridge a client spawns can reach it.
 */

let app: ElectronApplication
let win: Page
let userDataDir: string
let endpoint: { url: string; token: string; port: number }

const BRIDGE = join(process.cwd(), 'out', 'mcp', 'stdio-bridge.js')

/** The FR-AGT.1 surface. Named here so the kill-switch test cannot quietly skip one. */
const TOOL_NAMES = [
  'capture_screen',
  'capture_region',
  'capture_element',
  'start_recording',
  'stop_recording',
  'get_capture',
  'get_state_layer',
  'list_captures',
  'search_captures',
  'annotate',
  'redact',
  'export_guide'
]

/* ------------------------------------------------------------------ *
 * HTTP transport
 * ------------------------------------------------------------------ */

interface RpcReply {
  status: number
  body: { result?: unknown; error?: { code: number; message: string; data?: { code?: string } } }
}

let nextId = 1

async function rpc(
  method: string,
  params?: unknown,
  init: { token?: string | null; origin?: string | null } = {}
): Promise<RpcReply> {
  const token = init.token === undefined ? endpoint.token : init.token
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (init.origin) headers.origin = init.origin

  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : {} }
}

/** Calls a tool and returns its structured result, failing loudly on an error reply. */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const reply = await rpc('tools/call', { name, arguments: args })
  if (reply.body.error) throw new Error(`${name} failed: ${JSON.stringify(reply.body.error)}`)
  const result = reply.body.result as { structuredContent: Record<string, unknown> }
  return result.structuredContent
}

/** Calls a tool expecting a refusal, and returns the typed error code. */
async function callToolExpectingError(
  name: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  const reply = await rpc('tools/call', { name, arguments: args })
  if (!reply.body.error) throw new Error(`${name} unexpectedly succeeded`)
  return reply.body.error.data?.code ?? `no-code(${reply.body.error.code})`
}

async function setPaused(paused: boolean): Promise<void> {
  const ok = await win.evaluate(async (p) => {
    const res = await window.api.setAgentAccessPaused(p)
    return res.ok ? res.value.paused : null
  }, paused)
  expect(ok).toBe(paused)
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

test.beforeAll(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'nawi-mcp-e2e-'))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: process.cwd()
  })
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // mcp.json is written asynchronously after the window opens, so this polls
  // rather than reading once and racing the startup.
  const configPath = join(userDataDir, 'mcp.json')
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      const parsed = JSON.parse(await fs.readFile(configPath, 'utf8'))
      if (parsed.url && parsed.token) {
        endpoint = parsed
        break
      }
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) throw new Error('mcp.json never appeared under userData')
    await new Promise((r) => setTimeout(r, 200))
  }
})

test.afterAll(async () => {
  await app?.close()
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
})

/* ------------------------------------------------------------------ *
 * Endpoint and transport
 * ------------------------------------------------------------------ */

test('the endpoint is published on loopback with a random bearer token', async () => {
  expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  expect(endpoint.port).toBeGreaterThan(0)
  // A guessable token would make the loopback listener world-writable in practice.
  expect(endpoint.token.length).toBeGreaterThanOrEqual(32)
})

test('FR-SEC.1 — the endpoint declares itself as non-egress', async () => {
  const parsed = JSON.parse(await fs.readFile(join(userDataDir, 'mcp.json'), 'utf8'))
  // A listening loopback socket is not outbound traffic; a local-only indicator
  // must be able to tell the difference without inferring it.
  expect(parsed.egress).toBe(false)
})

test('initialize and tools/list expose exactly the twelve FR-AGT.1 tools', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' })
  expect(init.status).toBe(200)
  expect((init.body.result as { serverInfo: { name: string } }).serverInfo.name).toBe('nawi')

  const listed = await rpc('tools/list')
  const tools = (listed.body.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> })
    .tools
  expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
  // Every tool publishes a schema, so an agent never has to guess at arguments.
  for (const t of tools) expect(t.inputSchema).toMatchObject({ type: 'object' })
})

test('unavailable capabilities say so in their description rather than lying at call time', async () => {
  const listed = await rpc('tools/list')
  const tools = (listed.body.result as { tools: Array<{ name: string; description: string }> }).tools
  const byName = new Map(tools.map((t) => [t.name, t.description]))
  for (const name of ['capture_element', 'start_recording', 'stop_recording', 'redact', 'export_guide']) {
    expect(byName.get(name), name).toMatch(/NOT AVAILABLE/)
  }
})

/* ------------------------------------------------------------------ *
 * Loopback is not a trust boundary
 * ------------------------------------------------------------------ */

test('a request with no token is refused with 401', async () => {
  const reply = await rpc('tools/list', undefined, { token: null })
  expect(reply.status).toBe(401)
  expect(reply.body.error?.data?.code).toBe('UNAUTHORIZED')
})

test('a request with the wrong token is refused with 401', async () => {
  const reply = await rpc('tools/list', undefined, { token: 'x'.repeat(endpoint.token.length) })
  expect(reply.status).toBe(401)
})

test('a cross-origin request is rejected (DNS-rebinding defence)', async () => {
  // A malicious page resolving a name to 127.0.0.1 still cannot suppress Origin.
  const reply = await rpc('tools/list', undefined, { origin: 'http://evil.example' })
  expect(reply.status).toBe(403)
  expect(reply.body.error?.data?.code).toBe('FORBIDDEN_ORIGIN')
})

/* ------------------------------------------------------------------ *
 * Real capture behaviour
 * ------------------------------------------------------------------ */

test('capture_screen produces a real capture with a DC-2 complete sidecar', async () => {
  const result = await callTool('capture_screen', { name: 'mcp probe' })
  expect(typeof result.capture_id).toBe('string')
  expect(result.width as number).toBeGreaterThan(100)
  expect(result.sidecar_error).toBeNull()
  expect(result.sidecar_revision).toBe('v1')

  // DC-2: a desktop grab has no DOM, and the sidecar must *say* so rather than
  // omit the key — this is the clause a "just leave it out" implementation fails.
  const state = await callTool('get_state_layer', {
    capture_id: result.capture_id,
    fields: ['dom_snapshot', 'unavailable']
  })
  const layer = state.state_layer as Record<string, { ref: unknown; unavailable?: string }>
  expect(layer.dom_snapshot.ref).toBeNull()
  expect(layer.dom_snapshot.unavailable).toBe('unsupported_surface')
  expect(layer.unavailable.ref).toEqual(
    expect.arrayContaining([{ source: 'dom_snapshot', reason: 'unsupported_surface' }])
  )
})

test('capture_element refuses without a browser instead of grabbing the whole screen', async () => {
  const before = (await callTool('list_captures')).total as number
  const code = await callToolExpectingError('capture_element', { selector: '#checkout-submit' })
  expect(code).toBe('NO_BROWSER_ATTACHED')
  // The point of the assertion: no silent full-screen fallback was taken.
  expect((await callTool('list_captures')).total).toBe(before)
})

// The t_ms / video-link clause is asserted in the projection unit test against a
// real 40 MB fixture: an agent capture's state layer is empty, so there are no
// entries here to check and a title claiming otherwise would overstate this test.
test('get_state_layer stays under the 32 KB cap', async () => {
  const created = await callTool('capture_screen')
  const reply = await rpc('tools/call', {
    name: 'get_state_layer',
    arguments: { capture_id: created.capture_id }
  })
  const text = (reply.body.result as { content: Array<{ text: string }> }).content[0].text
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(32768)
})

/* ------------------------------------------------------------------ *
 * FR-AGT.3 — idempotency
 * ------------------------------------------------------------------ */

test('FR-AGT.3 — the same idempotency_key returns the same capture_id and one asset', async () => {
  const before = (await callTool('list_captures')).total as number
  const key = `e2e-${Date.now()}`

  const first = await callTool('capture_screen', { idempotency_key: key })
  const second = await callTool('capture_screen', { idempotency_key: key })
  expect(second.capture_id).toBe(first.capture_id)

  // Concurrent retries too — the case a result-only cache lets through.
  const concurrent = await Promise.all([
    callTool('capture_screen', { idempotency_key: key }),
    callTool('capture_screen', { idempotency_key: key })
  ])
  for (const r of concurrent) expect(r.capture_id).toBe(first.capture_id)

  // Exactly one new library row...
  expect((await callTool('list_captures')).total).toBe(before + 1)
  // ...and exactly one new asset genuinely on disk.
  const assets = await fs.readdir(join(userDataDir, 'library', 'assets'))
  expect(assets.filter((f) => f.startsWith(String(first.capture_id)))).toHaveLength(1)

  // A different key must still capture.
  const other = await callTool('capture_screen', { idempotency_key: `${key}-other` })
  expect(other.capture_id).not.toBe(first.capture_id)
})

/* ------------------------------------------------------------------ *
 * UX-AGT.3 — the kill switch
 * ------------------------------------------------------------------ */

test('UX-AGT.3 — while paused, every one of the twelve tools returns AGENT_ACCESS_PAUSED', async () => {
  const before = (await callTool('list_captures')).total as number
  await setPaused(true)
  try {
    for (const name of TOOL_NAMES) {
      // Arguments are deliberately valid-shaped: the switch must fire before
      // validation, so a tool cannot be reached by sending a well-formed call.
      const code = await callToolExpectingError(name, {
        capture_id: '11111111-2222-4333-8444-555555555555',
        selector: '#x',
        query: 'x',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        region: { x: 0, y: 0, width: 10, height: 10 },
        shapes: [{ kind: 'rect', x: 0, y: 0, width: 5, height: 5, color: '#ff0000', strokeWidth: 2 }]
      })
      expect(code, `${name} should be refused while paused`).toBe('AGENT_ACCESS_PAUSED')
    }
  } finally {
    await setPaused(false)
  }

  // "AND no capture is created" — the acceptance's second clause.
  expect((await callTool('list_captures')).total).toBe(before)
})

test('UX-AGT.3 — toggling mid-session affects the next call, not the next session', async () => {
  expect((await callTool('list_captures')).total).toBeGreaterThanOrEqual(0)

  await setPaused(true)
  expect(await callToolExpectingError('list_captures')).toBe('AGENT_ACCESS_PAUSED')

  await setPaused(false)
  // No restart, no reconnect: the very next call works again.
  expect((await callTool('list_captures')).total).toBeGreaterThanOrEqual(0)
})

test('UX-AGT.3 — the renderer control reflects the state', async () => {
  const toggle = win.getByTestId('agent-access-toggle')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('data-agent-access', 'active')

  await setPaused(true)
  await expect(toggle).toHaveAttribute('data-agent-access', 'paused')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  // And the control itself resumes, not just the IPC call behind it.
  await toggle.click()
  await expect(toggle).toHaveAttribute('data-agent-access', 'active')
  expect((await callTool('list_captures')).total).toBeGreaterThanOrEqual(0)
})

/* ------------------------------------------------------------------ *
 * The stdio bridge
 * ------------------------------------------------------------------ */

/** Drives the bridge exactly as an MCP client does: newline-delimited JSON on stdio. */
class Bridge {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, (v: Record<string, unknown>) => void>()
  readonly stderr: string[] = []

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams

    createInterface({ input: this.child.stdout }).on('line', (line) => {
      if (!line.trim()) return
      const msg = JSON.parse(line) as { id?: number }
      const resolve = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
      if (resolve) {
        this.pending.delete(msg.id as number)
        resolve(msg as Record<string, unknown>)
      }
    })
    this.child.stderr.on('data', (d: Buffer) => this.stderr.push(d.toString()))
  }

  send(id: number, method: string, params?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`bridge timed out on ${method}`)), 20_000)
      this.pending.set(id, (v) => {
        clearTimeout(timer)
        resolve(v)
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  kill(): void {
    this.child.kill()
  }
}

test('the stdio bridge proxies to the running app with no duplicated tool logic', async () => {
  const bridge = new Bridge({ NAWI_MCP_CONFIG: join(userDataDir, 'mcp.json') })
  try {
    const init = (await bridge.send(1, 'initialize', { protocolVersion: '2025-06-18' })) as {
      result: { serverInfo: { name: string } }
    }
    expect(init.result.serverInfo.name).toBe('nawi')

    const listed = (await bridge.send(2, 'tools/list')) as { result: { tools: Array<{ name: string }> } }
    expect(listed.result.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())

    // A real capture, driven end-to-end through stdio → HTTP → main.
    const key = `bridge-${Date.now()}`
    const call = (id: number): Promise<Record<string, unknown>> =>
      bridge.send(id, 'tools/call', {
        name: 'capture_screen',
        arguments: { idempotency_key: key }
      })
    const a = (await call(3)) as { result: { structuredContent: { capture_id: string } } }
    const b = (await call(4)) as { result: { structuredContent: { capture_id: string } } }
    // FR-AGT.3 holds across the bridge too — the bridge is stateless, so this is
    // proof the dedupe lives in main and not in the client-facing half.
    expect(b.result.structuredContent.capture_id).toBe(a.result.structuredContent.capture_id)
  } finally {
    bridge.kill()
  }
})

test('the bridge enforces the kill switch it does not itself implement', async () => {
  const bridge = new Bridge({ NAWI_MCP_CONFIG: join(userDataDir, 'mcp.json') })
  try {
    await setPaused(true)
    const reply = (await bridge.send(1, 'tools/call', {
      name: 'capture_screen',
      arguments: {}
    })) as { error?: { data?: { code?: string } } }
    expect(reply.error?.data?.code).toBe('AGENT_ACCESS_PAUSED')
  } finally {
    await setPaused(false)
    bridge.kill()
  }
})

test('the bridge fails fast when Nawi is not running, and never launches it', async () => {
  const bridge = new Bridge({ NAWI_MCP_CONFIG: join(userDataDir, 'does-not-exist.json') })
  try {
    const reply = (await bridge.send(1, 'tools/list')) as { error?: { message?: string } }
    expect(reply.error?.message).toMatch(/not running/i)
  } finally {
    bridge.kill()
  }
})
