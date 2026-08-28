import { describe, expect, it } from 'vitest'
import { capBody, HarBuilder, toHarHeaders } from './har'

describe('toHarHeaders — Tier A header stripping', () => {
  it('strips credential headers regardless of case', () => {
    const headers = toHarHeaders({
      'Content-Type': 'application/json',
      Authorization: 'Bearer supersecrettoken',
      COOKIE: 'session=abc123',
      'set-cookie': 'session=def456',
      'Proxy-Authorization': 'Basic Zm9vOmJhcg=='
    })
    expect(headers.map((h) => h.name)).toEqual(['Content-Type'])
    expect(JSON.stringify(headers)).not.toContain('supersecrettoken')
    expect(JSON.stringify(headers)).not.toContain('abc123')
    expect(JSON.stringify(headers)).not.toContain('def456')
  })

  it('keeps ordinary headers', () => {
    expect(toHarHeaders({ Accept: 'text/html' })).toEqual([{ name: 'Accept', value: 'text/html' }])
  })

  it('handles absent headers without inventing an entry', () => {
    expect(toHarHeaders(undefined)).toEqual([])
  })
})

describe('capBody — FR-STA.5 256 KB cap', () => {
  it('keeps a body under the cap intact', () => {
    const { body, truncated } = capBody('hello', 'text/plain', 1024)
    expect(truncated).toBe(false)
    expect(body.text).toBe('hello')
    expect(body.size).toBe(5)
  })

  it('truncates over the cap and records that it did', () => {
    const big = 'x'.repeat(5000)
    const { body, truncated } = capBody(big, 'text/plain', 1000)
    expect(truncated).toBe(true)
    expect(body.text!.length).toBe(1000)
    // `size` reports what was seen, not what was kept — otherwise a reader
    // cannot tell a small body from a truncated one.
    expect(body.size).toBe(5000)
    expect(body.comment).toContain('truncated')
  })

  it('reports an absent body as absent rather than empty', () => {
    const { body } = capBody(undefined, 'text/plain', 1000)
    expect(body.text).toBeUndefined()
    expect(body.size).toBe(0)
  })

  it('does not split a multi-byte character into a replacement char', () => {
    // 3 bytes each; a 1000-byte cap lands mid-character.
    const { body } = capBody('€'.repeat(500), 'text/plain', 1000)
    expect(body.text).not.toContain('�')
  })
})

describe('HarBuilder', () => {
  const request = (id: string, ts: number): Record<string, unknown> => ({
    requestId: id,
    timestamp: ts,
    wallTime: 1787944238.21,
    request: {
      url: 'https://example.test/api',
      method: 'POST',
      headers: { Authorization: 'Bearer leaked-token-value', Accept: '*/*' },
      postData: '{"q":1}'
    }
  })

  it('builds an entry and never carries the Authorization header into it', () => {
    const builder = new HarBuilder()
    builder.requestWillBeSent(request('1', 100))
    builder.responseReceived({
      requestId: '1',
      response: { status: 200, statusText: 'OK', headers: { 'Set-Cookie': 'a=b' }, mimeType: 'application/json' }
    })
    builder.loadingFinished({ requestId: '1', encodedDataLength: 42 })
    builder.setResponseBody('1', '{"ok":true}')

    const { har } = builder.build((s) => s * 1000)
    expect(har.log.entries).toHaveLength(1)
    const entry = har.log.entries[0]!
    expect(entry._t_ms).toBe(100_000)
    expect(entry.response.content.text).toBe('{"ok":true}')
    expect(JSON.stringify(har)).not.toContain('leaked-token-value')
    expect(JSON.stringify(har)).not.toContain('Set-Cookie')
  })

  it('DC-1: drops an entry whose timestamp cannot be resolved instead of zeroing it', () => {
    const builder = new HarBuilder()
    builder.requestWillBeSent(request('1', 100))
    builder.requestWillBeSent(request('2', 200))
    builder.loadingFinished({ requestId: '1' })

    const { har, dropped } = builder.build((s) => (s === 200 ? null : s * 1000))
    expect(dropped).toBe(1)
    expect(har.log.entries).toHaveLength(1)
    expect(har.log.entries[0]!._t_ms).toBe(100_000)
    // Nothing was emitted at t=0 as a stand-in.
    expect(har.log.entries.some((e) => e._t_ms === 0)).toBe(false)
    expect(har.log.comment).toContain('DC-1')
  })

  it('records a failed request as an outcome rather than dropping it', () => {
    const builder = new HarBuilder()
    builder.requestWillBeSent(request('1', 100))
    builder.loadingFailed({ requestId: '1', errorText: 'net::ERR_FAILED' })
    const { har } = builder.build((s) => s * 1000)
    expect(har.log.entries[0]!.response._error).toBe('net::ERR_FAILED')
  })

  it('flags truncation on the log when any body hit the cap', () => {
    const builder = new HarBuilder({ bodyCapBytes: 10 })
    builder.requestWillBeSent(request('1', 100))
    builder.loadingFinished({ requestId: '1' })
    builder.setResponseBody('1', 'y'.repeat(500))
    const { truncated } = builder.build((s) => s * 1000)
    expect(truncated).toBe(true)
  })

  it('exposes the monotonic/wallTime pairs the clock bridge needs', () => {
    const builder = new HarBuilder()
    builder.requestWillBeSent(request('1', 280537.5474))
    expect(builder.clockBridges()).toEqual([
      { monotonicSeconds: 280537.5474, wallTimeSeconds: 1787944238.21 }
    ])
  })

  it('ignores events for an unknown request id instead of inventing an entry', () => {
    const builder = new HarBuilder()
    builder.responseReceived({ requestId: 'ghost', response: { status: 200 } })
    builder.loadingFinished({ requestId: 'ghost' })
    expect(builder.build((s) => s).har.log.entries).toHaveLength(0)
  })
})
