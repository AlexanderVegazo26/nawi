import { describe, expect, it } from 'vitest'
import { CANCELLED_REASON, InFlightCalls, progressNotification, progressTokenOf, sseEvent, stepProgress } from './progress'

describe('progressTokenOf', () => {
  const params = (progressToken: unknown): unknown => ({ name: 'run_flow', _meta: { progressToken } })
  const SSE = 'application/json, text/event-stream'

  it('returns a string or number token when the caller accepts an event stream', () => {
    expect(progressTokenOf(params('tok-1'), SSE)).toBe('tok-1')
    expect(progressTokenOf(params(7), SSE)).toBe(7)
    expect(progressTokenOf(params(0), 'text/event-stream;q=0.9'), 'zero is a valid token').toBe(0)
  })

  it('returns null without an SSE-capable Accept header, since progress would have nowhere to go', () => {
    for (const accept of [null, 'application/json', 'text/event-streamx', '*/*']) {
      expect(progressTokenOf(params('tok'), accept), `accept=${String(accept)}`).toBeNull()
    }
  })

  it('returns null for a missing or unusable token', () => {
    for (const p of [undefined, null, {}, { _meta: null }, params(undefined), params(''), params(Number.NaN), params({}), params('x'.repeat(201))]) {
      expect(progressTokenOf(p, SSE), `params=${JSON.stringify(p)}`).toBeNull()
    }
  })
})

describe('progress messages', () => {
  it('formats a step as progress n of total, naming only its id, action and status', () => {
    expect(stepProgress({ index: 2, total: 5, id: 'save', action: 'click', status: 'failed' })).toEqual({
      progress: 3,
      total: 5,
      message: 'step 3/5 save (click): failed'
    })
  })

  it('wraps an update as notifications/progress, leaving out absent fields', () => {
    expect(progressNotification('t', { progress: 1 })).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 't', progress: 1 }
    })
    expect(progressNotification(4, { progress: 2, total: 3, message: 'm' })).toMatchObject({
      params: { progressToken: 4, progress: 2, total: 3, message: 'm' }
    })
  })

  it('frames one serialized message as one SSE event', () => {
    expect(sseEvent('{"a":"x\\ny"}')).toBe('event: message\ndata: {"a":"x\\ny"}\n\n')
  })
})

describe('InFlightCalls', () => {
  it('cancels the call with that session and id, with the fixed cancel reason', () => {
    const calls = new InFlightCalls()
    const c = new AbortController()
    calls.add('s1', 5, c)
    expect(calls.cancel('s1', 5), 'known call').toBe(true)
    expect(c.signal.aborted).toBe(true)
    expect(c.signal.reason).toBe(CANCELLED_REASON)
  })

  it('does not let another session, a missing session, or a same-looking id of another type cancel it', () => {
    const calls = new InFlightCalls()
    const c = new AbortController()
    calls.add('s1', 5, c)
    expect(calls.cancel('s2', 5), 'other session').toBe(false)
    expect(calls.cancel(null, 5), 'no session').toBe(false)
    expect(calls.cancel('s1', '5'), 'string "5" is another id than number 5').toBe(false)
    expect(calls.cancel('s1', { id: 5 }), 'not an id').toBe(false)
    expect(c.signal.aborted, 'none of those may abort the call').toBe(false)
  })

  it('forgets a finished call, and never lets a duplicate live id take over the first call', () => {
    const calls = new InFlightCalls()
    const first = new AbortController()
    const dup = new AbortController()
    const done = calls.add('s1', 1, first)
    const dupDone = calls.add('s1', 1, dup)
    dupDone()
    expect(calls.size, 'the duplicate finishing must not unregister the first').toBe(1)
    expect(calls.cancel('s1', 1)).toBe(true)
    expect([first.signal.aborted, dup.signal.aborted], '[first, duplicate] aborted').toEqual([true, false])
    done()
    expect(calls.size).toBe(0)
    expect(calls.cancel('s1', 1), 'finished').toBe(false)
  })

  it('never registers a call without a session or an id: those callers cancel by closing their request', () => {
    const calls = new InFlightCalls()
    const sessionless = new AbortController()
    calls.add(null, 1, sessionless)
    calls.add('', 1, sessionless)
    calls.add('s1', null, sessionless)
    expect(calls.size).toBe(0)
    expect(calls.cancel(null, 1) || calls.cancel('', 1), 'a sessionless cancel matches nothing').toBe(false)
    expect(sessionless.signal.aborted).toBe(false)
  })
})
