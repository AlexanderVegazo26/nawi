import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validSidecar } from '@shared/sidecar/__fixtures__/sidecar'
import type { SidecarRead } from '@shared/sidecar/types'
import { carryForwardFiles, referencedPaths } from './revision'

/**
 * The case the MCP E2E structurally cannot produce.
 *
 * Every capture in `e2e/mcp.spec.ts` is an agent capture whose five state-layer
 * sources are all `unsupported_surface`, so there is no side file to lose and
 * the harvested branch is never taken. This exercises a sidecar that *does* have
 * one — which is what the parallel CDP harvester will start producing.
 */

let dir: string

/** A harvested sidecar: real side files, and one unrelated `unavailable` entry. */
function harvested(): SidecarRead {
  return validSidecar({
    kind: 'recording',
    duration_ms: 60_000,
    state_layer: {
      dom_snapshot: { t_ms: 0, path: 'dom/000000.json' },
      accessibility_tree: { t_ms: 0, path: 'ax/000000.json' },
      console_log: { path: 'console.ndjson', count: 2 },
      network_har: null,
      input_events: { path: 'input_events.ndjson', count: 1 },
      agent_trace: [],
      // Deliberately non-empty and unrelated: the earlier implementation only
      // supplied DC-2 reasons when this array was empty, so a sidecar like this
      // one produced `console_log: null` with no matching reason at all.
      unavailable: [{ source: 'network_har', reason: 'capture_failed' }]
    }
  }) as SidecarRead
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'nawi-revision-'))
  await fs.mkdir(join(dir, 'dom'), { recursive: true })
  await fs.mkdir(join(dir, 'ax'), { recursive: true })
  await fs.writeFile(join(dir, 'dom', '000000.json'), '{"nodes":[1,2,3]}')
  await fs.writeFile(join(dir, 'ax', '000000.json'), '{"ax":true}')
  await fs.writeFile(
    join(dir, 'console.ndjson'),
    '{"t_ms":1,"level":"error","message":"boom","stack":null}\n{"t_ms":2,"level":"log","message":"hi","stack":null}\n'
  )
  await fs.writeFile(join(dir, 'input_events.ndjson'), '{"t_ms":3,"type":"click"}\n')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

describe('carrying a state layer into a new revision (DC-6)', () => {
  it('names every referenced side file, and nothing else', () => {
    expect(referencedPaths(harvested()).sort()).toEqual([
      'ax/000000.json',
      'console.ndjson',
      'dom/000000.json',
      'input_events.ndjson'
    ])
  })

  it('does not treat a null source as a file to copy', () => {
    // network_har is null here; asking for it would throw ENOENT on a file that
    // was never supposed to exist.
    expect(referencedPaths(harvested())).not.toContain('network.har')
  })

  it('copies every referenced file byte-for-byte, so the refs stay valid', async () => {
    const files = await carryForwardFiles(dir, harvested())
    expect(files.map((f) => f.path).sort()).toEqual([
      'ax/000000.json',
      'console.ndjson',
      'dom/000000.json',
      'input_events.ndjson'
    ])

    const console = files.find((f) => f.path === 'console.ndjson')!
    expect(Buffer.from(console.contents as Uint8Array).toString('utf8')).toBe(
      await fs.readFile(join(dir, 'console.ndjson'), 'utf8')
    )
    // The point of the whole exercise: the harvested console log survives the
    // revision instead of being nulled away.
    expect(Buffer.from(console.contents as Uint8Array).toString('utf8')).toContain('boom')
  })

  it('leaves the previous revision untouched (DC-6: never edits in place)', async () => {
    const before = await fs.readFile(join(dir, 'console.ndjson'))
    await carryForwardFiles(dir, harvested())
    expect(await fs.readFile(join(dir, 'console.ndjson'))).toEqual(before)
  })

  it('refuses rather than publishing a half-carried revision', async () => {
    await fs.rm(join(dir, 'console.ndjson'))
    // Skipping the missing file would publish a sidecar whose console_log ref
    // dangles, which the caller has no way to detect.
    await expect(carryForwardFiles(dir, harvested())).rejects.toThrow(/carry console\.ndjson/)
  })

  it('refuses a path that would escape the revision directory', async () => {
    const hostile = validSidecar({
      state_layer: {
        ...validSidecar().state_layer,
        // Nulled so the traversal attempt is what this test actually reaches,
        // rather than an unrelated missing-file error from the fixture defaults.
        dom_snapshot: null,
        accessibility_tree: null,
        network_har: null,
        input_events: null,
        console_log: { path: '../../../../etc/passwd', count: 1 }
      }
    }) as SidecarRead
    await expect(carryForwardFiles(dir, hostile)).rejects.toThrow(/unsafe path/)
  })

  it('handles an inline-array state layer (the DC-4 read shape) with no files', async () => {
    // Built as a SidecarRead directly: the inline-array form is legal only on
    // the *read* shape (a sidecar authored by another DC-4 implementation), so
    // the write-shape fixture cannot express it.
    const base = validSidecar()
    const inline: SidecarRead = {
      ...base,
      state_layer: {
        ...base.state_layer,
        dom_snapshot: null,
        accessibility_tree: null,
        network_har: null,
        console_log: [{ t_ms: 1, level: 'error', message: 'x', stack: null }],
        input_events: []
      }
    }
    expect(await carryForwardFiles(dir, inline)).toEqual([])
  })
})
