import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { IdempotencyCache, defineTool, describeTools, dispatch, type DispatchDeps } from './dispatch'
import { ToolError } from './errors'

/**
 * The chokepoint's own behaviour, without an Electron app.
 *
 * `dispatch` takes its dependencies as arguments precisely so this is possible —
 * the security properties it enforces are the ones most worth testing directly,
 * and they would otherwise only be reachable through a launched app.
 */

const TOKEN = 'test-token-value-0123456789'

function makeDeps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    isPaused: async () => false,
    token: TOKEN,
    tools: [],
    idempotency: new IdempotencyCache(),
    ...over
  }
}

function req(over: Partial<Parameters<typeof dispatch>[1]> = {}): Parameters<typeof dispatch>[1] {
  return {
    name: 'noop',
    args: {},
    authorization: `Bearer ${TOKEN}`,
    origin: null,
    callId: 'call-1',
    ...over
  }
}

const noop = defineTool({
  name: 'noop',
  description: 'test',
  idempotent: false,
  schema: z.object({ n: z.number().optional() }),
  run: async (args) => ({ echoed: args.n ?? null })
})

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'NO_ERROR'
  } catch (err) {
    return err instanceof ToolError ? err.code : 'NOT_A_TOOL_ERROR'
  }
}

describe('UX-AGT.3 — the kill switch', () => {
  it('rejects with AGENT_ACCESS_PAUSED and never reaches the tool body', async () => {
    const run = vi.fn(async () => ({ ok: true }))
    const tool = defineTool({
      name: 'capture_screen',
      description: 'test',
      idempotent: true,
      schema: z.object({}),
      run
    })
    const deps = makeDeps({ isPaused: async () => true, tools: [tool] })

    await expect(dispatch(deps, req({ name: 'capture_screen' }))).rejects.toMatchObject({
      code: 'AGENT_ACCESS_PAUSED'
    })
    // "AND no capture is created" — the acceptance's second clause. Returning the
    // error after running the body would satisfy the first clause and violate this.
    expect(run).not.toHaveBeenCalled()
  })

  it('carries a human-readable message, as the acceptance requires', async () => {
    const deps = makeDeps({ isPaused: async () => true, tools: [noop] })
    await expect(dispatch(deps, req())).rejects.toThrow(/paused/i)
  })

  it('is evaluated per call, so flipping it affects the very next call', async () => {
    let paused = false
    const deps = makeDeps({ isPaused: async () => paused, tools: [noop] })

    expect(await dispatch(deps, req())).toEqual({ echoed: null })
    paused = true
    expect(await codeOf(dispatch(deps, req()))).toBe('AGENT_ACCESS_PAUSED')
    paused = false
    expect(await dispatch(deps, req())).toEqual({ echoed: null })
  })

  it('applies to every tool, because there is only one way in', async () => {
    const tools = ['a', 'b', 'c'].map((n) =>
      defineTool({ name: n, description: 't', idempotent: false, schema: z.object({}), run: async () => ({}) })
    )
    const deps = makeDeps({ isPaused: async () => true, tools })
    for (const t of tools) {
      expect(await codeOf(dispatch(deps, req({ name: t.name })))).toBe('AGENT_ACCESS_PAUSED')
    }
  })
})

describe('loopback is not a trust boundary', () => {
  it('refuses a call with no bearer token', async () => {
    const deps = makeDeps({ tools: [noop] })
    expect(await codeOf(dispatch(deps, req({ authorization: null })))).toBe('UNAUTHORIZED')
  })

  it('refuses a wrong or truncated token', async () => {
    const deps = makeDeps({ tools: [noop] })
    expect(await codeOf(dispatch(deps, req({ authorization: 'Bearer nope' })))).toBe('UNAUTHORIZED')
    expect(await codeOf(dispatch(deps, req({ authorization: `Bearer ${TOKEN.slice(0, -1)}` })))).toBe(
      'UNAUTHORIZED'
    )
    expect(await codeOf(dispatch(deps, req({ authorization: TOKEN })))).toBe('UNAUTHORIZED')
  })

  it('rejects any non-null Origin (DNS-rebinding defence)', async () => {
    const deps = makeDeps({ tools: [noop] })
    expect(await codeOf(dispatch(deps, req({ origin: 'http://evil.example' })))).toBe(
      'FORBIDDEN_ORIGIN'
    )
    expect(await codeOf(dispatch(deps, req({ origin: 'http://127.0.0.1:1234' })))).toBe(
      'FORBIDDEN_ORIGIN'
    )
  })

  it('checks auth before it checks the kill switch, so an unauthenticated peer learns nothing', async () => {
    const deps = makeDeps({ isPaused: async () => true, tools: [noop] })
    expect(await codeOf(dispatch(deps, req({ authorization: null })))).toBe('UNAUTHORIZED')
  })
})

describe('argument validation', () => {
  it('rejects arguments that fail the tool schema', async () => {
    const deps = makeDeps({ tools: [noop] })
    expect(await codeOf(dispatch(deps, req({ args: { n: 'not a number' } })))).toBe(
      'INVALID_ARGUMENTS'
    )
  })

  it('rejects an unknown tool name', async () => {
    const deps = makeDeps({ tools: [noop] })
    expect(await codeOf(dispatch(deps, req({ name: 'rm_rf' })))).toBe('UNKNOWN_TOOL')
  })

  it('publishes a JSON Schema for every tool', () => {
    const described = describeTools([noop])
    expect(described[0].name).toBe('noop')
    expect(described[0].inputSchema).toMatchObject({ type: 'object' })
  })
})

describe('FR-AGT.3 — idempotency', () => {
  const counting = (): { tool: ReturnType<typeof defineTool>; calls: () => number } => {
    let calls = 0
    const tool = defineTool({
      name: 'capture_screen',
      description: 't',
      idempotent: true,
      schema: z.object({ idempotency_key: z.string().optional() }),
      run: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 10))
        return { capture_id: `id-${calls}` }
      }
    })
    return { tool, calls: () => calls }
  }

  it('the same key returns the same capture_id and captures once', async () => {
    const { tool, calls } = counting()
    const deps = makeDeps({ tools: [tool] })
    const args = { idempotency_key: 'k1' }

    const a = await dispatch(deps, req({ name: 'capture_screen', args }))
    const b = await dispatch(deps, req({ name: 'capture_screen', args }))
    expect(a).toEqual(b)
    expect(calls()).toBe(1)
  })

  it('deduplicates *concurrent* retries, not just sequential ones', async () => {
    const { tool, calls } = counting()
    const deps = makeDeps({ tools: [tool] })
    const args = { idempotency_key: 'k2' }

    // The failure this guards: a cache that stores only the settled result lets
    // both of these through, and two captures land on disk.
    const [a, b, c] = await Promise.all([
      dispatch(deps, req({ name: 'capture_screen', args })),
      dispatch(deps, req({ name: 'capture_screen', args })),
      dispatch(deps, req({ name: 'capture_screen', args }))
    ])
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(calls()).toBe(1)
  })

  it('a different key captures again', async () => {
    const { tool, calls } = counting()
    const deps = makeDeps({ tools: [tool] })
    await dispatch(deps, req({ name: 'capture_screen', args: { idempotency_key: 'a' } }))
    await dispatch(deps, req({ name: 'capture_screen', args: { idempotency_key: 'b' } }))
    expect(calls()).toBe(2)
  })

  it('no key means no dedupe — the client did not ask for it', async () => {
    const { tool, calls } = counting()
    const deps = makeDeps({ tools: [tool] })
    await dispatch(deps, req({ name: 'capture_screen', args: {} }))
    await dispatch(deps, req({ name: 'capture_screen', args: {} }))
    expect(calls()).toBe(2)
  })

  it('never replays a failure, so a transient error stays retryable', async () => {
    let calls = 0
    const tool = defineTool({
      name: 'flaky',
      description: 't',
      idempotent: true,
      schema: z.object({ idempotency_key: z.string().optional() }),
      run: async () => {
        calls++
        if (calls === 1) throw new Error('transient')
        return { capture_id: 'ok' }
      }
    })
    const deps = makeDeps({ tools: [tool] })
    const args = { idempotency_key: 'retry' }
    await expect(dispatch(deps, req({ name: 'flaky', args }))).rejects.toThrow()
    expect(await dispatch(deps, req({ name: 'flaky', args }))).toEqual({ capture_id: 'ok' })
  })

  it('is bounded, so an invented key per call cannot grow it without limit', async () => {
    const cache = new IdempotencyCache(4)
    for (let i = 0; i < 50; i++) await cache.run(`k${i}`, async () => i)
    expect(cache.size).toBeLessThanOrEqual(4)
  })
})

describe('call log (UX-AGT.4 groundwork)', () => {
  it('records every call, including refused ones', async () => {
    const seen: string[] = []
    const deps = makeDeps({
      isPaused: async () => true,
      tools: [noop],
      onCall: (r) => seen.push(`${r.tool}:${r.ok}:${r.code}`)
    })
    await codeOf(dispatch(deps, req()))
    expect(seen).toEqual(['noop:false:AGENT_ACCESS_PAUSED'])
  })
})
