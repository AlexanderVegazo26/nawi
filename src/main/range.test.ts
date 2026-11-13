import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileResponse, parseRange } from './range'

describe('parseRange', () => {
  it('reads the forms a media element sends', () => {
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=10-19', 1000)).toEqual({ start: 10, end: 19 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('clamps an end past the file', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('reports a range that starts past the end as unsatisfiable', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable')
  })

  it('ignores what it does not serve, so the whole file goes out', () => {
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('bytes=0-1,5-6', 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
    expect(parseRange('bytes=20-10', 1000)).toBeNull()
    expect(parseRange('bytes=-', 1000)).toBeNull()
  })
})

describe('fileResponse', () => {
  let dir = ''
  let file = ''
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)

  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'nawi-range-'))
    file = join(dir, 'clip.mp4')
    await fs.writeFile(file, bytes)
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('answers a Range request with 206 and exactly those bytes', async () => {
    const res = await fileResponse(file, 'video/mp4', 'bytes=100-109')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 100-109/256')
    expect(res.headers.get('content-length')).toBe('10')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes.subarray(100, 110)])
  })

  it('answers an unsatisfiable range with 416 and the size', async () => {
    const res = await fileResponse(file, 'video/mp4', 'bytes=256-')
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */256')
  })

  it('serves the whole file, advertising ranges, when none was asked for', async () => {
    const res = await fileResponse(file, 'video/mp4', null)
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('256')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })
})
