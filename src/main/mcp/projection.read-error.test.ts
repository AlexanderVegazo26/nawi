import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validSidecar } from '@shared/sidecar/__fixtures__/sidecar'
import type { SidecarRead } from '@shared/sidecar/types'

/**
 * get_state_layer over a side file that can't be read to the end. Before
 * `read_error`, a disk error part-way through `console.ndjson` produced a
 * field that looked complete (no truncated flag, no cursor), so an agent took
 * the first N entries for the whole log. A real mid-stream I/O error can't be
 * produced on demand, so `createReadStream` is replaced for one file name with
 * a stream that yields two lines and then fails with EIO (or with a code-less
 * error); every other path reads the real file.
 */

const FLAKY = 'flaky.ndjson'
const NO_CODE = 'no-code.ndjson'

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const twoLines =
    [1, 2].map((i) => JSON.stringify({ t_ms: 100 * i, level: 'error', message: `entry ${i}` })).join('\n') + '\n'
  const failing = (error: Error): Readable => {
    let sent = false
    return new Readable({
      encoding: 'utf8',
      read() {
        if (!sent) {
          sent = true
          this.push(twoLines)
          return
        }
        this.destroy(error)
      }
    })
  }
  const createReadStream = ((path: unknown, options?: unknown) => {
    const p = String(path)
    if (p.endsWith(FLAKY)) {
      return failing(Object.assign(new Error(`EIO: i/o error, read '${p}'`), { code: 'EIO' }))
    }
    if (p.endsWith(NO_CODE)) return failing(new Error(`something odd at ${p}`))
    return real.createReadStream(path as string, options as never)
  }) as typeof real.createReadStream
  return { ...real, default: { ...real, createReadStream }, createReadStream }
})

const { project, readErrorCode, serializeResult } = await import('./projection')

let dir: string

const INPUTS = [
  { t_ms: 10, type: 'click', coordinates: { x: 1, y: 2 }, target: null, value_redacted: false },
  { t_ms: 20, type: 'keydown', coordinates: null, target: null, value_redacted: true }
]

function sidecarWith(consolePath: string): SidecarRead {
  const base = validSidecar({ kind: 'recording', duration_ms: 1000 })
  return {
    ...base,
    state_layer: {
      ...base.state_layer,
      console_log: { path: consolePath, count: 10 },
      input_events: { path: 'input_events.ndjson', count: INPUTS.length },
      agent_trace: []
    }
  } as SidecarRead
}

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'nawi-projection-read-error-'))
  // The flaky files exist; their content comes from the mock.
  await fs.writeFile(join(dir, FLAKY), '')
  await fs.writeFile(join(dir, NO_CODE), '')
  await fs.mkdir(join(dir, 'console-dir.ndjson'))
  await fs.writeFile(
    join(dir, 'complete.ndjson'),
    `${JSON.stringify({ t_ms: 5, level: 'log', message: 'only one' })}\n`
  )
  await fs.writeFile(join(dir, 'input_events.ndjson'), `${INPUTS.map((e) => JSON.stringify(e)).join('\n')}\n`)
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('get_state_layer projection when a side file fails to read', () => {
  it('keeps the entries read before a mid-scan EIO and reports read_error "EIO" on that field', async () => {
    const result = await project({ revisionDir: dir, sidecar: sidecarWith(FLAKY) })
    const field = result.state_layer.console_log

    expect(field?.entries?.map((e) => e.message), 'the 2 entries before the EIO should be kept').toEqual([
      'entry 1',
      'entry 2'
    ])
    expect(field?.read_error, `console_log should say why it stopped, got ${JSON.stringify(field)}`).toBe('EIO')
    expect(result.next_cursor, 'no cursor may point past a read failure: a retry hits the same file').toBeNull()
  })

  it('still delivers the fields after the one that failed', async () => {
    const result = await project({ revisionDir: dir, sidecar: sidecarWith(FLAKY) })
    const inputs = result.state_layer.input_events

    expect(inputs?.entries?.map((e) => e.t_ms), 'input_events should be read in full after console_log failed').toEqual([
      10, 20
    ])
    expect(inputs?.read_error, 'input_events read fine and must not carry a read_error').toBeUndefined()
  })

  it('reports ENOENT for a side file that is missing instead of an empty, complete-looking field', async () => {
    const result = await project({ revisionDir: dir, sidecar: sidecarWith('gone.ndjson'), query: { fields: ['console_log'] } })
    const field = result.state_layer.console_log

    expect(field?.entries, 'a missing file has no entries').toEqual([])
    expect(field?.read_error, `a missing console.ndjson should be reported, got ${JSON.stringify(field)}`).toBe('ENOENT')
  })

  it('reports EISDIR when the side file path is a directory', async () => {
    const result = await project({ revisionDir: dir, sidecar: sidecarWith('console-dir.ndjson'), query: { fields: ['console_log'] } })

    expect(result.state_layer.console_log?.read_error, 'a directory where the NDJSON should be').toBe('EISDIR')
  })

  it('reports "read_failed" for an error without a code and never leaks the error message or path', async () => {
    const result = await project({ revisionDir: dir, sidecar: sidecarWith(NO_CODE), query: { fields: ['console_log'] } })
    const body = serializeResult(result)

    expect(result.state_layer.console_log?.read_error).toBe('read_failed')
    expect(body, 'the response must not carry the data directory path from the error message').not.toContain(dir)
    expect(body).not.toContain('something odd')
  })

  it('sets no read_error on a file read to the end', async () => {
    const result = await project({ revisionDir: dir, sidecar: sidecarWith('complete.ndjson'), query: { fields: ['console_log'] } })

    expect(result.state_layer.console_log?.entries).toHaveLength(1)
    expect('read_error' in (result.state_layer.console_log ?? {}), 'a complete read has no read_error key').toBe(false)
  })

  it('stays under max_bytes with read errors on both file-backed paginated fields', async () => {
    const base = sidecarWith(FLAKY)
    const sidecar = {
      ...base,
      state_layer: { ...base.state_layer, input_events: { path: 'gone.ndjson', count: 3 } }
    } as SidecarRead
    for (const max of [1024, 1100, 1500, 4096]) {
      const result = await project({ revisionDir: dir, sidecar, query: { max_bytes: max } })
      const bytes = Buffer.byteLength(serializeResult(result))
      expect(bytes, `max_bytes ${max}: response was ${bytes} bytes`).toBeLessThanOrEqual(max)
    }
  })
})

describe('readErrorCode', () => {
  it.each([
    [{ code: 'EIO' }, 'EIO'],
    [{ code: 'ERR_STREAM_PREMATURE_CLOSE' }, 'ERR_STREAM_PREMATURE_CLOSE'],
    [{ code: '/home/user/secret' }, 'read_failed'],
    [{ code: 42 }, 'read_failed'],
    [new Error('boom'), 'read_failed'],
    [null, 'read_failed'],
    ['EIO', 'read_failed']
  ])('maps %j to %s', (err, want) => {
    expect(readErrorCode(err)).toBe(want)
  })
})
