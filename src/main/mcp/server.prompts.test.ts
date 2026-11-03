import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { postJson } from '../../mcp/post'

/**
 * Roadmap AI12 against the real loopback server: a generic MCP client sees the
 * prompts capability, lists the prompts, gets one filled in, and gets -32602
 * with Nawi's typed code in `data.code` for an unknown prompt or bad arguments.
 */

let userData = tmpdir()
vi.mock('electron', () => ({ app: { getPath: () => userData, getVersion: () => '9.9.9' } }))

const { startMcpServer } = await import('./server')

let paused = false
const calls: string[] = []
let handle: Awaited<ReturnType<typeof startMcpServer>>

beforeEach(async () => {
  paused = false
  calls.length = 0
  userData = await fs.mkdtemp(join(tmpdir(), 'nawi-mcp-prompts-'))
  handle = await startMcpServer({ tools: [], isPaused: async () => paused, onCall: (c) => calls.push(c.tool) })
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
    JSON.stringify({ jsonrpc: '2.0', id: 9, method, params })
  )
  return { status: res.status, body: JSON.parse(res.text) }
}

describe('MCP prompts over the loopback endpoint', () => {
  it('advertises the prompts capability on initialize, next to tools and resources', async () => {
    const { body } = await rpc('initialize')
    expect(body.result?.capabilities, JSON.stringify(body)).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      prompts: { listChanged: false }
    })
  })

  it('lists the prompts and returns one filled in as a user message', async () => {
    const list = await rpc('prompts/list')
    expect(list.body.result?.prompts?.map((p: { name: string }) => p.name), JSON.stringify(list.body)).toEqual(['run_and_triage', 'heal_flow'])

    const got = await rpc('prompts/get', { name: 'run_and_triage', arguments: { file: '/home/u/login.nawi.yaml' } })
    expect(got.body.result?.messages, JSON.stringify(got.body)).toHaveLength(1)
    expect(got.body.result.messages[0]).toMatchObject({ role: 'user', content: { type: 'text' } })
    expect(got.body.result.messages[0].content.text).toContain('{"file": "/home/u/login.nawi.yaml"}')
    expect(got.body.result.description, 'the prompt description comes back with the messages').toMatch(/run_flow/)
  })

  it.each([
    { label: 'an unknown prompt', params: { name: 'nope' }, typed: 'NOT_FOUND' },
    { label: 'a missing required argument', params: { name: 'heal_flow' }, typed: 'INVALID_ARGUMENTS' },
    { label: 'a malformed run id', params: { name: 'heal_flow', arguments: { run_id: 'latest' } }, typed: 'INVALID_ARGUMENTS' },
    { label: 'no name at all', params: {}, typed: 'NOT_FOUND' }
  ])('answers $label with JSON-RPC -32602 and data.code $typed', async ({ params, typed }) => {
    const { status, body } = await rpc('prompts/get', params)
    expect(status, 'a refusal is still HTTP 200').toBe(200)
    expect(body.error, JSON.stringify(body)).toMatchObject({ code: -32602, data: { code: typed } })
    expect(body.result, 'no result next to an error').toBeUndefined()
  })

  it('still lists and gets prompts while agent access is paused: they read nothing and run nothing', async () => {
    paused = true
    const list = await rpc('prompts/list')
    expect(list.body.result?.prompts, JSON.stringify(list.body)).toHaveLength(2)
    const got = await rpc('prompts/get', { name: 'heal_flow', arguments: { run_id: '20261103T080000000Z-d4e5f6' } })
    expect(got.body.result?.messages, JSON.stringify(got.body)).toHaveLength(1)
    expect(calls, 'prompts are not agent activity: nothing logged').toEqual([])
  })

  it('answers a prompts/get sent as a notification (no id) with 202 and no body', async () => {
    const res = await postJson(
      handle!.info.url,
      { 'content-type': 'application/json', authorization: `Bearer ${handle!.info.token}` },
      JSON.stringify({ jsonrpc: '2.0', method: 'prompts/get', params: { name: 'nope' } })
    )
    expect({ status: res.status, text: res.text }).toEqual({ status: 202, text: '' })
  })

  it('refuses a caller without the bearer token', async () => {
    for (const method of ['prompts/list', 'prompts/get']) {
      const { status, body } = await rpc(method, { name: 'run_and_triage' }, 'wrong')
      expect(status, method).toBe(401)
      expect(body.error?.data, `${method}: ${JSON.stringify(body)}`).toEqual({ code: 'UNAUTHORIZED' })
    }
  })
})
