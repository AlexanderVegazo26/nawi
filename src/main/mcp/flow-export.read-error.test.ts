import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validSidecar } from '@shared/sidecar/__fixtures__/sidecar'
import type { SidecarRead } from '@shared/sidecar/types'
import { parseFlow, formatFlowErrors } from '@shared/flow'

/**
 * A read error part-way through `input_events.ndjson` (a disk error, a file
 * truncated under the reader) must not export a partial flow as if it were the
 * whole recording. A real mid-stream I/O error can't be produced on demand, so
 * `createReadStream` is replaced for one file name with a stream that yields
 * two lines and then fails with EIO; every other path reads the real file.
 */

const FLAKY = 'flaky.ndjson'
const FAIL_FIRST = 'fail-first.ndjson'

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const lines = (n: number): string =>
    Array.from({ length: n }, (_, i) =>
      JSON.stringify({ t_ms: 100 * (i + 1), type: 'click', coordinates: { x: 1, y: 1 }, target: null, value_redacted: false })
    ).join('\n') + '\n'
  const failing = (before: string): Readable => {
    const eio = Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })
    let sent = false
    return new Readable({
      encoding: 'utf8',
      read() {
        if (!sent && before) {
          sent = true
          this.push(before)
          return
        }
        this.destroy(eio)
      }
    })
  }
  const createReadStream = ((path: unknown, options?: unknown) => {
    const p = String(path)
    if (p.endsWith(FLAKY)) return failing(lines(2))
    if (p.endsWith(FAIL_FIRST)) return failing('')
    return real.createReadStream(path as string, options as never)
  }) as typeof real.createReadStream
  return { ...real, default: { ...real, createReadStream }, createReadStream }
})

const { flowFromSidecar, NoInputEventsError } = await import('./flow-export')

let dir: string

function recording(path: string): SidecarRead {
  const base = validSidecar({ kind: 'recording', duration_ms: 1000 })
  return { ...base, state_layer: { ...base.state_layer, input_events: { path, count: 10 } } }
}

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'nawi-flow-export-read-error-'))
  // The files exist (the access check passes); their content comes from the mock.
  await fs.writeFile(join(dir, FLAKY), '')
  await fs.writeFile(join(dir, FAIL_FIRST), '')
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('flowFromSidecar when the events file fails mid-read', () => {
  it('keeps the events read before the error and warns that the flow covers only the start of the recording', async () => {
    const out = await flowFromSidecar({ revisionDir: dir, sidecar: recording(FLAKY), revision: 'v1', name: 'x' })

    expect(out.events, 'the 2 events read before the EIO should be kept').toBe(2)
    expect(
      out.warnings,
      `a partial read must be reported, got warnings ${JSON.stringify(out.warnings)}`
    ).toContain(
      'Reading the input events failed after 2 events (EIO); the flow covers the start of the recording only.'
    )
    const parsed = parseFlow(out.flow_yaml)
    expect(parsed.ok, parsed.ok ? '' : formatFlowErrors(parsed.errors)).toBe(true)
  })

  it('refuses with unreadable when the read fails before any event, instead of returning an empty flow', async () => {
    const err = await flowFromSidecar({ revisionDir: dir, sidecar: recording(FAIL_FIRST), revision: 'v1', name: 'x' }).catch(
      (e: unknown) => e
    )
    expect(err, `expected a NoInputEventsError, got ${String(err)}`).toBeInstanceOf(NoInputEventsError)
    expect((err as InstanceType<typeof NoInputEventsError>).reason).toBe('unreadable')
  })
})
