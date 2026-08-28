import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createWriteStream, promises as fs } from 'node:fs'
import { once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validSidecar } from '@shared/sidecar/__fixtures__/sidecar'
import type { SidecarRead } from '@shared/sidecar/types'
import {
  MAX_RESPONSE_BYTES,
  parseCursor,
  project,
  sanitizeQuery,
  serializeResult,
  videoUrl
} from './projection'

/**
 * FR-AGT.2 — the acceptance is stated in *bytes* against a 40 MB state layer, so
 * the fixture is genuinely 40 MB. A small fixture would pass this test while the
 * requirement stayed unsatisfied: the whole point of the clause is that the
 * response size must be independent of the state layer's size.
 *
 * The fixture is generated here and never committed — 40 MB of NDJSON does not
 * belong in git, and generating it proves the streaming reader works on the real
 * shape rather than on a checked-in abbreviation.
 */

const FORTY_MB = 40 * 1024 * 1024

let dir: string
let consoleCount = 0
let errorCount = 0

/**
 * A stack trace long enough to matter. This is the detail that makes a
 * `limit`-based budget fail: twenty of these entries is well past 32 KB, so a
 * projection that paginates by entry count cannot satisfy the acceptance.
 */
function stackOf(i: number): string {
  const frames: string[] = []
  for (let f = 0; f < 12; f++) {
    frames.push(`    at moduleFunction${f} (https://app.example.com/assets/bundle-${i % 7}.js:${1000 + f}:${f * 13})`)
  }
  return `Error: request failed\n${frames.join('\n')}`
}

/** Streams the NDJSON out with backpressure. Concatenating 40 MB of string is O(n²). */
async function writeBigConsoleLog(target: string): Promise<void> {
  const out = createWriteStream(target, { encoding: 'utf8' })
  let written = 0
  let i = 0

  while (written < FORTY_MB) {
    let batch = ''
    for (let n = 0; n < 500; n++) {
      const level = i % 4 === 0 ? 'error' : i % 4 === 1 ? 'warn' : i % 4 === 2 ? 'info' : 'log'
      const entry = {
        t_ms: i * 37,
        level,
        message: `entry ${i}: ${'payload '.repeat(20)}`,
        stack: level === 'error' ? stackOf(i) : null
      }
      batch += `${JSON.stringify(entry)}\n`
      if (level === 'error') errorCount++
      consoleCount++
      i++
    }
    written += Buffer.byteLength(batch, 'utf8')
    if (!out.write(batch)) await once(out, 'drain')
  }

  out.end()
  await once(out, 'finish')
}

function sidecarFor(): SidecarRead {
  return validSidecar({
    kind: 'recording',
    duration_ms: 600_000,
    state_layer: {
      dom_snapshot: { t_ms: 0, path: 'dom/000000.json' },
      accessibility_tree: null,
      console_log: { path: 'console.ndjson', count: consoleCount },
      network_har: { path: 'network.har', truncated: false },
      input_events: { path: 'input_events.ndjson', count: 3 },
      agent_trace: [],
      unavailable: [{ source: 'accessibility_tree', reason: 'capture_failed' }]
    }
  }) as SidecarRead
}

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'nawi-projection-'))
  await writeBigConsoleLog(join(dir, 'console.ndjson'))
  const inputs = [
    { t_ms: 10, type: 'click', coordinates: { x: 1, y: 2 }, target: null, value_redacted: false },
    { t_ms: 20, type: 'keydown', coordinates: null, target: null, value_redacted: true },
    // DC-1: an event with no usable timestamp must be absent from the projection,
    // not emitted with a guessed zero.
    { type: 'scroll', coordinates: null, target: null, value_redacted: false }
  ]
  await fs.writeFile(
    join(dir, 'input_events.ndjson'),
    `${inputs.map((e) => JSON.stringify(e)).join('\n')}\n`
  )
  // 40 MB takes a moment to write; the 5s default would fail as an opaque timeout.
}, 240_000)

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

describe('FR-AGT.2 — filtered query against a 40 MB state layer', () => {
  it('the fixture really is 40 MB', async () => {
    const stat = await fs.stat(join(dir, 'console.ndjson'))
    expect(stat.size).toBeGreaterThanOrEqual(FORTY_MB)
  })

  it('fields=["console_log"] level=error responds under 32768 bytes', async () => {
    const result = await project({
      revisionDir: dir,
      sidecar: sidecarFor(),
      query: { fields: ['console_log'], level: ['error'] }
    })

    const bytes = Buffer.byteLength(serializeResult(result), 'utf8')
    expect(bytes).toBeLessThan(32768)
    expect(bytes).toBeLessThan(MAX_RESPONSE_BYTES)
  }, 240_000)

  it('returns only error-level entries', async () => {
    const result = await project({
      revisionDir: dir,
      sidecar: sidecarFor(),
      query: { fields: ['console_log'], level: ['error'] }
    })

    const entries = result.state_layer.console_log?.entries ?? []
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) expect(e.level).toBe('error')
    // And nothing else leaked into the response.
    expect(Object.keys(result.state_layer)).toEqual(['console_log'])
  }, 240_000)

  it('every entry retains its t_ms and carries a video link', async () => {
    const result = await project({
      revisionDir: dir,
      sidecar: sidecarFor(),
      query: { fields: ['console_log'], level: ['error'] }
    })

    const entries = result.state_layer.console_log?.entries ?? []
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(typeof e.t_ms).toBe('number')
      expect(Number.isFinite(e.t_ms)).toBe(true)
      expect(e.video_url).toBe(
        `capture://asset/${result.capture_id}#t=${(e.t_ms / 1000).toFixed(3)}`
      )
    }
  }, 240_000)

  it('reports truncation and a resumable cursor rather than silently stopping', async () => {
    const result = await project({
      revisionDir: dir,
      sidecar: sidecarFor(),
      query: { fields: ['console_log'], level: ['error'] }
    })

    // 40 MB of errors cannot fit in 32 KB, so this must be honest about it.
    expect(result.truncated).toBe(true)
    expect(result.next_cursor).not.toBeNull()
    expect(parseCursor(result.next_cursor)).toEqual({
      field: 'console_log',
      offset: result.state_layer.console_log?.entries?.length
    })
    // `available` is the ref's own pre-filter total, so an agent can tell how
    // much it has not seen. It is deliberately not the post-filter count, which
    // would require the full scan the byte budget exists to avoid.
    expect(result.state_layer.console_log?.available).toBe(consoleCount)
    expect(errorCount).toBeGreaterThan(0)
  }, 240_000)

  it('a cursor resumes where the previous page stopped, with no overlap', async () => {
    const first = await project({
      revisionDir: dir,
      sidecar: sidecarFor(),
      query: { fields: ['console_log'], level: ['error'] }
    })
    const second = await project({
      revisionDir: dir,
      sidecar: sidecarFor(),
      query: { fields: ['console_log'], level: ['error'], cursor: first.next_cursor }
    })

    const a = first.state_layer.console_log?.entries ?? []
    const b = second.state_layer.console_log?.entries ?? []
    expect(b.length).toBeGreaterThan(0)
    expect(b[0].t_ms).toBeGreaterThan(a[a.length - 1].t_ms)
    expect(Buffer.byteLength(serializeResult(second), 'utf8')).toBeLessThan(32768)
  }, 240_000)
})

describe('projection mechanics', () => {
  it('drops an entry that cannot be timestamped (DC-1) rather than guessing zero', async () => {
    const result = await project({
      revisionDir: dir,
      sidecar: sidecarFor(),
      query: { fields: ['input_events'] }
    })
    const entries = result.state_layer.input_events?.entries ?? []
    expect(entries.map((e) => e.type)).toEqual(['click', 'keydown'])
    expect(entries.some((e) => e.t_ms === 0)).toBe(false)
  })

  it('reports a null source with a DC-2 reason instead of omitting the key', async () => {
    const result = await project({
      revisionDir: dir,
      sidecar: sidecarFor(),
      query: { fields: ['accessibility_tree'] }
    })
    expect(result.state_layer.accessibility_tree).toEqual({
      ref: null,
      unavailable: 'capture_failed'
    })
  })

  it('an oversized single entry still advances the cursor', async () => {
    // One entry far larger than the whole budget. If it were skipped rather than
    // shrunk, next_cursor would point at it forever and a paging agent would loop.
    const huge = join(dir, 'huge.ndjson')
    await fs.writeFile(
      huge,
      `${JSON.stringify({ t_ms: 5, level: 'error', message: 'x'.repeat(80_000), stack: null })}\n` +
        `${JSON.stringify({ t_ms: 6, level: 'error', message: 'small', stack: null })}\n`
    )
    const sidecar = validSidecar({
      state_layer: {
        ...validSidecar().state_layer,
        console_log: { path: 'huge.ndjson', count: 2 }
      }
    }) as SidecarRead

    const result = await project({
      revisionDir: dir,
      sidecar,
      query: { fields: ['console_log'] }
    })
    const entries = result.state_layer.console_log?.entries ?? []
    expect(entries.length).toBe(1)
    expect(entries[0].t_ms).toBe(5)
    expect(String(entries[0].message)).toContain('[truncated]')
    expect(entries[0].truncated_fields).toEqual(['message'])
    // The cursor moved past the oversized entry — this is the anti-livelock claim.
    expect(parseCursor(result.next_cursor)).toEqual({ field: 'console_log', offset: 1 })
    expect(Buffer.byteLength(serializeResult(result), 'utf8')).toBeLessThan(32768)
  })

  it('a missing side file yields an empty page, not a thrown error', async () => {
    const sidecar = validSidecar({
      state_layer: {
        ...validSidecar().state_layer,
        console_log: { path: 'does-not-exist.ndjson', count: 9 }
      }
    }) as SidecarRead
    const result = await project({ revisionDir: dir, sidecar, query: { fields: ['console_log'] } })
    expect(result.state_layer.console_log?.entries).toEqual([])
  })

  it('refuses a path that would escape the revision directory', async () => {
    const sidecar = validSidecar({
      state_layer: {
        ...validSidecar().state_layer,
        console_log: { path: '../../../../etc/passwd', count: 1 }
      }
    }) as SidecarRead
    const result = await project({ revisionDir: dir, sidecar, query: { fields: ['console_log'] } })
    expect(result.state_layer.console_log?.entries).toEqual([])
  })
})

describe('untrusted argument handling', () => {
  it('clamps max_bytes so a client cannot raise the acceptance ceiling', () => {
    expect(sanitizeQuery({ max_bytes: 10_000_000 }).max_bytes).toBe(MAX_RESPONSE_BYTES)
    expect(sanitizeQuery({ max_bytes: -5 }).max_bytes).toBeGreaterThan(0)
    expect(sanitizeQuery({ max_bytes: 'lots' }).max_bytes).toBe(MAX_RESPONSE_BYTES)
  })

  it('drops unknown fields and levels instead of trusting them', () => {
    const q = sanitizeQuery({ fields: ['console_log', '__proto__', 'passwords'], level: ['error', 'nope'] })
    expect(q.fields).toEqual(['console_log'])
    expect(q.level).toEqual(['error'])
  })

  it('treats a malformed cursor as "start from the beginning"', () => {
    expect(parseCursor('nonsense')).toBeNull()
    expect(parseCursor('console_log:-1')).toBeNull()
    expect(parseCursor('secrets:4')).toBeNull()
    expect(parseCursor(null)).toBeNull()
    expect(parseCursor('console_log:4')).toEqual({ field: 'console_log', offset: 4 })
  })

  it('formats a seekable video link', () => {
    expect(videoUrl('abc', 4120)).toBe('capture://asset/abc#t=4.120')
  })
})
