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

/* ------------------------------------------------------------------------- *
 * FR-SEC.2 — the request-body control.
 *
 * The release gate exercises this against a real browser and a real form
 * submission. These cover what a browser fixture cannot make deterministic:
 * layer 1's default-deny, which fires on body types the gate never produces.
 * ------------------------------------------------------------------------- */

const SECRET = 'ZZQUNITSENTINEL "hunter!2"'

/**
 * The renderings one value takes on the wire. Mirrors the release gate's helper
 * deliberately: a sentinel containing a space, a `!` and a `"` makes the
 * urlencoded, form-encoded, JSON-escaped and base64 forms four distinct byte
 * strings, so these assertions cannot pass by accident.
 */
function renderings(value: string): Array<{ label: string; bytes: Buffer }> {
  return [
    { label: 'literal', bytes: Buffer.from(value, 'utf8') },
    { label: 'encodeURIComponent', bytes: Buffer.from(encodeURIComponent(value), 'utf8') },
    {
      label: 'form-urlencoded',
      bytes: Buffer.from(new URLSearchParams([['v', value]]).toString().slice(2), 'utf8')
    },
    { label: 'JSON-escaped', bytes: Buffer.from(JSON.stringify(value).slice(1, -1), 'utf8') },
    { label: 'base64', bytes: Buffer.from(Buffer.from(value, 'utf8').toString('base64'), 'utf8') }
  ]
}

function post(
  id: string,
  contentType: string | null,
  body: string
): Record<string, unknown> {
  return {
    requestId: id,
    timestamp: 1000,
    wallTime: 1787944238.21,
    request: {
      url: 'https://example.test/login',
      method: 'POST',
      headers: contentType === null ? {} : { 'Content-Type': contentType },
      postData: body
    }
  }
}

function harOf(builder: HarBuilder): string {
  return JSON.stringify(builder.build((s) => s).har)
}

describe('FR-SEC.2 — request bodies', () => {
  it('redacts a urlencoded password by field name, whatever its encoding', () => {
    const builder = new HarBuilder()
    builder.requestWillBeSent(
      post('1', 'application/x-www-form-urlencoded', new URLSearchParams({ user: 'alice', password: SECRET }).toString())
    )
    const har = harOf(builder)
    // Every rendering, because redaction is by key and never looks at the value.
    // The form-encoded one is the load-bearing entry here: `URLSearchParams`
    // writes a space as `+`, so a test that only checked the literal and
    // `encodeURIComponent` would pass even with redaction disabled.
    for (const rendering of renderings(SECRET)) {
      expect(har, rendering.label).not.toContain(rendering.bytes.toString('utf8'))
    }
    // Targeted, not blanket: the non-secret field survives.
    expect(har).toContain('alice')
  })

  it('redacts a nested JSON password and a base64 value under a secret-ish key', () => {
    const builder = new HarBuilder()
    builder.requestWillBeSent(
      post('1', 'application/json', JSON.stringify({
        account: { user: 'alice', password: SECRET },
        otp_b64: Buffer.from(SECRET, 'utf8').toString('base64')
      }))
    )
    const har = harOf(builder)
    expect(har).not.toContain(SECRET)
    expect(har).not.toContain(Buffer.from(SECRET, 'utf8').toString('base64'))
    expect(har).toContain('alice')
  })

  it('redacts a field named only by the probe, which no static list would guess', () => {
    const builder = new HarBuilder()
    builder.addSecretFieldNames(['recovery'])
    builder.requestWillBeSent(
      post('1', 'application/x-www-form-urlencoded', new URLSearchParams({ recovery: SECRET }).toString())
    )
    const har = harOf(builder)
    for (const r of renderings(SECRET)) expect(har, r.label).not.toContain(r.bytes.toString('utf8'))
  })

  it('applies probe names learned AFTER the request was observed', () => {
    // The ordering seam the control documents: marking is per document and can
    // land after a request. Without the second pass this leaks.
    const builder = new HarBuilder()
    builder.requestWillBeSent(
      post('1', 'application/x-www-form-urlencoded', new URLSearchParams({ recovery: SECRET }).toString())
    )
    builder.addSecretFieldNames(['recovery'])
    const har = harOf(builder)
    for (const r of renderings(SECRET)) expect(har, r.label).not.toContain(r.bytes.toString('utf8'))
  })

  it('drops a multipart body wholesale, because it cannot be decomposed', () => {
    const builder = new HarBuilder()
    builder.requestWillBeSent(
      post('1', 'multipart/form-data; boundary=xyz', `--xyz\r\nContent-Disposition: form-data; name="password"\r\n\r\n${SECRET}\r\n--xyz--`)
    )
    const har = harOf(builder)
    expect(har).not.toContain(SECRET)
    // Dropped visibly, never silently: the reason and the real size are recorded.
    expect(har).toContain('not field-decomposable')
    expect(har).toContain('"bodySize"')
  })

  it('drops a body with no declared content type', () => {
    const builder = new HarBuilder()
    builder.requestWillBeSent(post('1', null, `password=${SECRET}`))
    const har = harOf(builder)
    expect(har).not.toContain(SECRET)
    expect(har).toContain('(absent)')
  })

  it('drops an oversized body rather than truncating it', () => {
    // A truncated body cannot be parsed into fields, so a kept prefix would be
    // an unredacted prefix.
    const builder = new HarBuilder({ postDataCapBytes: 64 })
    builder.requestWillBeSent(
      post('1', 'application/json', JSON.stringify({ padding: 'x'.repeat(500), password: SECRET }))
    )
    const har = harOf(builder)
    expect(har).not.toContain(SECRET)
    expect(har).toContain('exceeds the 64 byte request-body cap')
  })

  it('drops a body that claims JSON but does not parse', () => {
    const builder = new HarBuilder()
    builder.requestWillBeSent(post('1', 'application/json', `{not json, password=${SECRET}`))
    const har = harOf(builder)
    expect(har).not.toContain(SECRET)
    expect(har).toContain('did not parse')
  })

  it('carries a __proto__ key through as data without polluting anything', () => {
    // Honest about what this does and does not prove: `JSON.parse` already
    // creates `__proto__` as an OWN property rather than performing a prototype
    // write, so this would pass without the null-prototype object in
    // `redactJsonByKey`. That choice is defence in depth for the copy step, and
    // this test is a regression guard on the end-to-end behaviour, not evidence
    // that the guard is what prevents pollution.
    const builder = new HarBuilder()
    builder.requestWillBeSent(post('1', 'application/json', '{"__proto__":{"polluted":true},"a":1}'))
    const har = harOf(builder)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // The body is embedded in the HAR as a JSON *string*, so its own quotes are
    // escaped one level. Asserting the escaped form is asserting what is really
    // on disk rather than what the shape looks like in the abstract.
    expect(har).toContain('\\"a\\":1')
    expect(har).toContain('\\"__proto__\\"')
  })
})
