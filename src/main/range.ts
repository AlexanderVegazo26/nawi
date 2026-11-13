import { createReadStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'

/**
 * HTTP byte ranges for the `capture://` protocol.
 *
 * `<video>` seeks by asking for a `Range`; a handler that answers every request
 * with the whole file (200) makes the element read from byte 0 again, so seeking
 * in a long recording stalls or restarts. Only a single range is served — the
 * form media elements send. A multi-range or malformed header is ignored and the
 * whole file served, which RFC 9110 §14.2 permits.
 */

export type RangeResult = { start: number; end: number } | 'unsatisfiable' | null

/** Parses a `Range` header against a file of `size` bytes. `end` is inclusive. */
export function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return null
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!m) return null
  const [, first, last] = m
  if (first === '' && last === '') return null

  if (first === '') {
    // Suffix range: the last N bytes.
    const length = Number(last)
    if (length === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - length), end: size - 1 }
  }

  const start = Number(first)
  const end = last === '' ? size - 1 : Number(last)
  if (last !== '' && end < start) return null
  if (start >= size) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

/** A 200, 206 or 416 response for a file on disk, streamed rather than read whole. */
export async function fileResponse(filePath: string, mime: string, rangeHeader: string | null): Promise<Response> {
  const { size } = await fs.stat(filePath)
  const range = parseRange(rangeHeader, size)
  const base = { 'content-type': mime, 'accept-ranges': 'bytes' }

  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } })
  }
  const { start, end } = range ?? { start: 0, end: size - 1 }
  const length = Math.max(0, end - start + 1)
  const body =
    length === 0 ? null : (Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>)
  if (!range) {
    return new Response(body, { status: 200, headers: { ...base, 'content-length': String(size) } })
  }
  return new Response(body, {
    status: 206,
    headers: { ...base, 'content-length': String(length), 'content-range': `bytes ${start}-${end}/${size}` }
  })
}
