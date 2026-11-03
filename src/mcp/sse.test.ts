import { describe, expect, it } from 'vitest'
import { SseParser } from './post'

/** Feeds the chunks in order, closes the stream, returns the delivered data. */
function parse(...chunks: string[]): string[] {
  const out: string[] = []
  const p = new SseParser((d) => out.push(d))
  for (const c of chunks) p.push(c)
  p.end()
  return out
}

describe('SseParser', () => {
  it('delivers each event\'s data once its blank line arrives', () => {
    expect(parse('event: message\ndata: {"a":1}\n\nevent: message\ndata: {"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('reassembles events and lines split across chunks, including a CRLF split between chunks', () => {
    expect(parse('da', 'ta: {"a"', ':1}\r', '\n\r\n', 'data: x\r\n\r\n')).toEqual(['{"a":1}', 'x'])
  })

  it('joins multi-line data with newlines, drops one leading space only, and ignores comments and other fields', () => {
    expect(parse(': keep-alive\nid: 3\nretry: 10\ndata:  two spaces\ndata:tight\n\n')).toEqual([' two spaces\ntight'])
  })

  it('delivers a final event the stream ended without a blank line for, and nothing for events without data', () => {
    expect(parse('event: ping\n\n', 'data: last')).toEqual(['last'])
  })

  it('treats a lone CR as a line end', () => {
    expect(parse('data: a\r\rdata: b\r\r')).toEqual(['a', 'b'])
  })
})
