import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { postJson } from '../../mcp/post'
import { RUN_RECORD_VERSION } from '../run-record'

/**
 * Roadmap AI12 against the real loopback server: a generic MCP client sees that
 * the server has resources, lists the saved runs, reads one, and gets MCP's
 * error codes (with Nawi's typed code in `data.code`) for everything else.
 */

let userData = tmpdir()
vi.mock('electron', () => ({ app: { getPath: () => userData, getVersion: () => '9.9.9' } }))

const { startMcpServer } = await import('./server')

const RUN = '20261103T080000000Z-d4e5f6'
let paused = false
const calls: Array<{ tool: string; ok: boolean; code: string | null }> = []
let handle: Awaited<ReturnType<typeof startMcpServer>>

beforeEach(async () => {
  paused = false
  calls.length = 0
  userData = await fs.mkdtemp(join(tmpdir(), 'nawi-mcp-resources-'))
  const dir = join(userData, 'runs', RUN)
  await fs.mkdir(join(dir, 'steps'), { recursive: true })
  await fs.writeFile(
    join(dir, 'run.json'),
    JSON.stringify({
      version: RUN_RECORD_VERSION,
      run_id: RUN,
      flow: { name: 'Login', file: '/home/u/login.nawi.yaml', sha256: '00'.repeat(32) },
      status: 'failed',
      started_at: '2026-11-03T08:00:00.000Z',
      duration_ms: 900,
      totals: { passed: 1, failed: 1, skipped: 0, not_run: 0 },
      environment: { os: { platform: 'linux', release: '6', arch: 'x64' } },
      steps: []
    })
  )
  await fs.writeFile(join(dir, 'report.html'), '<!doctype html><title>Login</title>')
  // The default runs folder (userData/runs) is what the app serves.
  handle = await startMcpServer({ tools: [], isPaused: async () => paused, onCall: (c) => calls.push({ tool: c.tool, ok: c.ok, code: c.code }) })
  expect(handle, 'the server should start on loopback').not.toBeNull()
})

afterEach(async () => {
  await handle?.close()
  await fs.rm(userData, { recursive: true, force: true })
})

async function rpc(method: string, params: Record<string, unknown> = {}, token = handle!.info.token): Promise<{ status: number; body: Record<string, any> }> {
  const res = await postJson(
    handle!.info.url,
    { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    JSON.stringify({ jsonrpc: '2.0', id: 7, method, params })
  )
  return { status: res.status, body: JSON.parse(res.text) }
}

describe('MCP resources over the loopback endpoint', () => {
  it('advertises the resources capability on initialize', async () => {
    const { body } = await rpc('initialize')
    expect(body.result?.capabilities, JSON.stringify(body)).toMatchObject({ resources: { listChanged: false, subscribe: false } })
  })

  it('lists the saved run, gives the templates, and reads the record and report', async () => {
    const list = await rpc('resources/list')
    expect(list.body.result?.resources?.map((r: { uri: string }) => r.uri), JSON.stringify(list.body)).toEqual([
      `nawi://runs/${RUN}/run.json`,
      `nawi://runs/${RUN}/report.html`
    ])

    const templates = await rpc('resources/templates/list')
    expect(templates.body.result?.resourceTemplates, JSON.stringify(templates.body)).toHaveLength(6)

    const read = await rpc('resources/read', { uri: `nawi://runs/${RUN}/run.json` })
    const [contents] = read.body.result?.contents ?? []
    expect(contents?.mimeType, JSON.stringify(read.body)).toBe('application/json')
    expect(JSON.parse(contents.text), 'run.json should round-trip').toMatchObject({ run_id: RUN, status: 'failed' })

    const report = await rpc('resources/read', { uri: `nawi://runs/${RUN}/report.html` })
    expect(report.body.result?.contents?.[0], JSON.stringify(report.body)).toEqual({
      uri: `nawi://runs/${RUN}/report.html`,
      mimeType: 'text/html',
      text: '<!doctype html><title>Login</title>'
    })
  })

  it.each([
    { label: 'a missing file', params: { uri: `nawi://runs/${RUN}/junit.xml` }, code: -32002, typed: 'NOT_FOUND' },
    { label: 'a uri that is not a run resource', params: { uri: 'file:///etc/passwd' }, code: -32602, typed: 'INVALID_ARGUMENTS' },
    { label: 'no uri at all', params: {}, code: -32602, typed: 'INVALID_ARGUMENTS' }
  ])('answers $label with JSON-RPC $code and data.code $typed', async ({ params, code, typed }) => {
    const { status, body } = await rpc('resources/read', params)
    expect(status, 'a refusal is still HTTP 200').toBe(200)
    expect(body.error, JSON.stringify(body)).toMatchObject({ code, data: { code: typed } })
    expect(body.result, 'no result next to an error').toBeUndefined()
  })

  it('refuses list and read while agent access is paused (kill switch), saying nothing was read', async () => {
    paused = true
    for (const method of ['resources/list', 'resources/read']) {
      const { body } = await rpc(method, { uri: `nawi://runs/${RUN}/run.json` })
      expect(body.error, `${method}: ${JSON.stringify(body)}`).toMatchObject({ code: -32000, data: { code: 'AGENT_ACCESS_PAUSED' } })
      expect(body.error.message, method).toMatch(/paused.*Nothing was read/)
    }
    const templates = await rpc('resources/templates/list')
    expect(templates.body.result?.resourceTemplates, 'templates are static discovery, like tools/list').toHaveLength(6)
  })

  it('logs every list and read in the agent activity log, with the refusal code', async () => {
    await rpc('resources/list')
    await rpc('resources/read', { uri: `nawi://runs/${RUN}/junit.xml` })
    expect(calls).toEqual([
      { tool: 'resources/list', ok: true, code: null },
      { tool: 'resources/read', ok: false, code: 'NOT_FOUND' }
    ])
  })

  it('answers a resources/read sent as a notification (no id) with 202 and no body', async () => {
    const res = await postJson(
      handle!.info.url,
      { 'content-type': 'application/json', authorization: `Bearer ${handle!.info.token}` },
      JSON.stringify({ jsonrpc: '2.0', method: 'resources/read', params: { uri: `nawi://runs/${RUN}/run.json` } })
    )
    expect({ status: res.status, text: res.text }).toEqual({ status: 202, text: '' })
  })

  it('refuses a caller without the bearer token before reading anything', async () => {
    const { status, body } = await rpc('resources/read', { uri: `nawi://runs/${RUN}/run.json` }, 'wrong')
    expect(status).toBe(401)
    expect(body.error?.data, JSON.stringify(body)).toEqual({ code: 'UNAUTHORIZED' })
  })
})
