// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentAccessState, IpcResult } from '@shared/types'
import { AgentAccessToggle } from './AgentAccessToggle'

/**
 * UX-AGT.3 — the agent kill switch, rendered in a DOM and clicked like a user.
 *
 * The control makes a security claim ("agent access paused"), so the cases here
 * are the ones where a wrong paint would make the user believe agents are cut
 * off while they are not: the claim before main has answered, a failed write, a
 * double click, a pause made in another window, and "paused" vs "no endpoint".
 *
 * Main is a fake whose replies the test releases one at a time, so every
 * in-between state is asserted rather than raced.
 */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const ENDPOINT = { port: 47123, url: 'http://127.0.0.1:47123/mcp' }
const ON: AgentAccessState = { paused: false, endpoint: ENDPOINT }
const PAUSED: AgentAccessState = { paused: true, endpoint: ENDPOINT }
const DOWN: AgentAccessState = { paused: false, endpoint: null }

const ok = (value: AgentAccessState): IpcResult<AgentAccessState> =>
  ({ ok: true, value }) as IpcResult<AgentAccessState>
const failed = (): IpcResult<AgentAccessState> =>
  ({ ok: false, error: { code: 'INTERNAL', message: 'settings write failed' } }) as unknown as IpcResult<AgentAccessState>

let read: Deferred<IpcResult<AgentAccessState>>
let writes: { paused: unknown; reply: Deferred<IpcResult<AgentAccessState>> }[]
let listeners: Set<(s: AgentAccessState) => void>
let unsubscribed: number

beforeEach(() => {
  read = deferred()
  writes = []
  listeners = new Set()
  unsubscribed = 0
  ;(window as unknown as { api: unknown }).api = {
    getAgentAccess: () => read.promise,
    setAgentAccessPaused: (paused: unknown) => {
      const reply = deferred<IpcResult<AgentAccessState>>()
      writes.push({ paused, reply })
      return reply.promise
    },
    onAgentAccessChanged: (cb: (s: AgentAccessState) => void) => {
      listeners.add(cb)
      return () => {
        unsubscribed++
        listeners.delete(cb)
      }
    }
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

const toggle = (): HTMLElement => screen.getByTestId('agent-access-toggle')

/** What the control claims, in every channel a user or AT reads it from. */
function claim(): { mode: string | null; pressed: string | null; disabled: boolean; text: string; title: string } {
  const el = toggle()
  return {
    mode: el.getAttribute('data-agent-access'),
    pressed: el.getAttribute('aria-pressed'),
    disabled: (el as HTMLButtonElement).disabled,
    text: el.textContent ?? '',
    title: el.getAttribute('title') ?? ''
  }
}

async function answer<T>(d: Deferred<T>, value: T): Promise<void> {
  await act(async () => {
    d.resolve(value)
    await d.promise
  })
}

function broadcast(state: AgentAccessState): void {
  act(() => {
    for (const cb of listeners) cb(state)
  })
}

async function mountWith(state: AgentAccessState): Promise<void> {
  render(<AgentAccessToggle />)
  await answer(read, ok(state))
}

describe('AgentAccessToggle (UX-AGT.3 kill switch)', () => {
  it('claims nothing and cannot be clicked until main has answered the first read', () => {
    render(<AgentAccessToggle />)
    const c = claim()
    expect(c.disabled, `button should stay disabled before the first read, claim: ${JSON.stringify(c)}`).toBe(true)
    expect(c.mode, 'no state yet must render as "unavailable", never as "on"').toBe('unavailable')
    expect(c.text).toContain('Agent endpoint down')
    expect(c.text).not.toContain('Agent access on')
  })

  it('stays disabled and "endpoint down" when the first read fails', async () => {
    render(<AgentAccessToggle />)
    await answer(read, failed())
    const c = claim()
    expect(c.disabled, `a failed read must not enable the switch, claim: ${JSON.stringify(c)}`).toBe(true)
    expect(c.mode).toBe('unavailable')
  })

  it('shows "on", not pressed, with a pause hint when agents can reach the endpoint', async () => {
    await mountWith(ON)
    const c = claim()
    expect(c.mode).toBe('active')
    expect(c.pressed, 'aria-pressed is the paused state').toBe('false')
    expect(c.disabled).toBe(false)
    expect(c.text).toContain('Agent access on. Agents can capture through MCP.')
    expect(c.title).toMatch(/Click to pause\.$/)
    expect(screen.getByRole('button', { name: /Agent access on/ })).toBe(toggle())
  })

  it('does not paint "paused" until main confirms the pause (no optimistic security claim)', async () => {
    const user = userEvent.setup()
    await mountWith(ON)

    await user.click(toggle())
    expect(writes.map((w) => w.paused), 'one write asking main to pause').toEqual([true])
    const pending = claim()
    expect(pending.mode, `while the write is in flight the switch must still say "on", claim: ${JSON.stringify(pending)}`).toBe('active')
    expect(pending.pressed).toBe('false')
    expect(pending.disabled, 'disabled while the write is in flight').toBe(true)

    await answer(writes[0].reply, ok(PAUSED))
    const done = claim()
    expect(done.mode).toBe('paused')
    expect(done.pressed).toBe('true')
    expect(done.disabled).toBe(false)
    expect(done.text).toContain('Agent access paused. Every MCP tool call is being refused.')
    expect(done.title).toMatch(/Click to resume\.$/)
  })

  it('keeps showing "on" when the pause write fails, and can be retried', async () => {
    const user = userEvent.setup()
    await mountWith(ON)
    await user.click(toggle())
    await answer(writes[0].reply, failed())

    const c = claim()
    expect(c.mode, `a failed write must not claim agents are paused, claim: ${JSON.stringify(c)}`).toBe('active')
    expect(c.pressed).toBe('false')
    expect(c.disabled, 'the switch is usable again after a failure').toBe(false)

    await user.click(toggle())
    expect(writes.map((w) => w.paused), 'the retry asks for the pause again').toEqual([true, true])
  })

  it('sends one write for a double click while the first is in flight', async () => {
    const user = userEvent.setup()
    await mountWith(ON)
    await user.dblClick(toggle())
    expect(writes.length, `writes sent: ${JSON.stringify(writes.map((w) => w.paused))}`).toBe(1)
  })

  it('resumes from paused by asking main for paused=false', async () => {
    const user = userEvent.setup()
    await mountWith(PAUSED)
    expect(claim().mode).toBe('paused')

    await user.click(toggle())
    expect(writes.map((w) => w.paused)).toEqual([false])
    expect(claim().mode, 'still paused until main confirms the resume').toBe('paused')

    await answer(writes[0].reply, ok(ON))
    expect(claim().mode).toBe('active')
  })

  it('reflects a pause made elsewhere (main broadcast) without a click', async () => {
    await mountWith(ON)
    broadcast(PAUSED)
    expect(claim().mode).toBe('paused')
    broadcast(ON)
    expect(claim().mode).toBe('active')
    expect(writes, 'a broadcast must never cause a write back').toEqual([])
  })

  it('says "endpoint down", not "on", when the MCP server is not listening', async () => {
    await mountWith(DOWN)
    const c = claim()
    expect(c.mode).toBe('unavailable')
    expect(c.pressed).toBe('false')
    expect(c.text).toContain('Agent endpoint down. The local MCP endpoint is not listening')
    expect(c.title, 'no "click to pause/resume" promise when resuming would not fix it').not.toMatch(/Click to/)
  })

  it('says "paused" when paused even if the endpoint is also down', async () => {
    await mountWith({ paused: true, endpoint: null })
    const c = claim()
    expect(c.mode, 'the pause is the user’s own choice and must stay visible').toBe('paused')
    expect(c.pressed).toBe('true')
  })

  it('unsubscribes from main broadcasts when it unmounts', async () => {
    const { unmount } = render(<AgentAccessToggle />)
    expect(listeners.size).toBe(1)
    unmount()
    expect(unsubscribed).toBe(1)
    expect(listeners.size).toBe(0)
    // A first read answering after unmount must not throw or warn.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await answer(read, ok(PAUSED))
    expect(errors, 'no React warnings after unmount').not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
