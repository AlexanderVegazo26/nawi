import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validSidecar } from '@shared/sidecar/__fixtures__/sidecar'
import type { LibraryItem } from '@shared/types'

/**
 * `library.ts` resolves userData lazily on every call, so a mutable pointer is
 * enough to give each test its own directory — the same trick `settings.test.ts`
 * relies on.
 */
let userData = ''
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

type LibraryModule = typeof import('./library')

/** Fresh module per test: `cache` and `writeChain` are module singletons. */
async function loadModule(): Promise<LibraryModule> {
  vi.resetModules()
  return import('./library')
}

const libraryRoot = (): string => join(userData, 'library')
const indexPath = (): string => join(libraryRoot(), 'index.json')
const captureDir = (id: string): string => join(libraryRoot(), 'captures', id)

async function seedItem(id: string): Promise<void> {
  const item: LibraryItem = {
    id,
    name: 'Capture',
    kind: 'image',
    captureKind: 'region',
    filePath: join(libraryRoot(), 'assets', `${id}.png`),
    width: 100,
    height: 50,
    size: 3,
    durationMs: null,
    createdAt: '2026-08-28T14:03:11.204Z',
    annotations: null
  }
  await fs.mkdir(join(libraryRoot(), 'assets'), { recursive: true })
  await fs.writeFile(item.filePath, 'png')
  await fs.writeFile(indexPath(), JSON.stringify([item], null, 2))
}

const ID = '11111111-2222-4333-8444-555555555555'

beforeEach(async () => {
  userData = await fs.mkdtemp(join(tmpdir(), 'nawi-library-'))
  await seedItem(ID)
})

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true })
})

describe('DC-3 — the sidecar revision and the index pointer land together', () => {
  it('publishes v1 and points the index at it', async () => {
    const library = await loadModule()
    const saved = await library.saveSidecarRevision(ID, validSidecar())

    expect(saved.revision).toBe('v1')
    const item = await library.getItem(ID)
    expect(item?.sidecarRevision).toBe('v1')
    expect(item?.sidecarDir).toBe(captureDir(ID))

    // …and the pointer is on disk, not just in the cache.
    const onDisk = JSON.parse(await fs.readFile(indexPath(), 'utf-8')) as LibraryItem[]
    expect(onDisk[0].sidecarRevision).toBe('v1')
  })

  it('DC-6 — a second revision supersedes the first and leaves it byte-identical', async () => {
    const library = await loadModule()
    await library.saveSidecarRevision(ID, validSidecar())
    const v1Bytes = await fs.readFile(join(captureDir(ID), 'v1', 'sidecar.v1.json'))

    const second = await library.saveSidecarRevision(
      ID,
      validSidecar({
        redactions: [
          { region: [1, 2, 3, 4], kind: 'solid', reason: 'password', applied_to: ['pixel', 'dom'] }
        ]
      })
    )

    expect(second.revision).toBe('v2')
    expect((await fs.readFile(join(captureDir(ID), 'v1', 'sidecar.v1.json'))).equals(v1Bytes)).toBe(
      true
    )

    const current = await library.readSidecar(ID)
    expect(current?.supersedes).toBe('v1')
    expect(current?.redactions).toHaveLength(1)

    // The superseded revision is still readable by explicit request.
    const previous = await library.readSidecar(ID, 'v1')
    expect(previous?.supersedes).toBeNull()
    expect(previous?.redactions).toHaveLength(0)

    expect(await library.listRevisions(ID)).toEqual(['v1', 'v2'])
  })

  it('a revision orphaned by a crash before the index write is inert', async () => {
    const library = await loadModule()
    await library.saveSidecarRevision(ID, validSidecar())

    // Exactly the on-disk state of a crash after the rename, before writeIndex:
    // a complete v2 directory the index knows nothing about.
    await fs.mkdir(join(captureDir(ID), 'v2'), { recursive: true })
    await fs.writeFile(
      join(captureDir(ID), 'v2', 'sidecar.v2.json'),
      JSON.stringify(validSidecar({ supersedes: 'v1', duration_ms: 999 }))
    )

    // `readSidecar` resolves through the index, so the orphan is not "current".
    const current = await library.readSidecar(ID)
    expect(current?.duration_ms).toBeNull()

    // `listRevisions` is honest about what exists on disk.
    expect(await library.listRevisions(ID)).toEqual(['v1', 'v2'])

    // And the next write cannot collide with it.
    const next = await library.saveSidecarRevision(ID, validSidecar())
    expect(next.revision).toBe('v3')
  })

  it('serializes concurrent revisions instead of letting them share a staging directory', async () => {
    const library = await loadModule()

    // Two writers firing together — a harvest completing while a redaction lands.
    // Unserialized, both compute v2, both stage into `.tmp-v2`, and one publishes
    // the other's bytes: a silently mixed revision, not a loud collision.
    const results = await Promise.all([
      library.saveSidecarRevision(ID, validSidecar({ duration_ms: 111 })),
      library.saveSidecarRevision(ID, validSidecar({ duration_ms: 222 })),
      library.saveSidecarRevision(ID, validSidecar({ duration_ms: 333 }))
    ])

    expect(results.map((r) => r.revision).sort()).toEqual(['v1', 'v2', 'v3'])
    expect(await library.listRevisions(ID)).toEqual(['v1', 'v2', 'v3'])

    // Each revision holds exactly one writer's payload, and the chain is intact.
    const durations = new Set<number | null>()
    for (const revision of ['v1', 'v2', 'v3']) {
      const sidecar = await library.readSidecar(ID, revision)
      durations.add(sidecar?.duration_ms ?? null)
    }
    expect(durations).toEqual(new Set([111, 222, 333]))

    expect((await library.readSidecar(ID, 'v1'))?.supersedes).toBeNull()
    expect((await library.readSidecar(ID, 'v2'))?.supersedes).toBe('v1')
    expect((await library.readSidecar(ID, 'v3'))?.supersedes).toBe('v2')
    expect((await library.getItem(ID))?.sidecarRevision).toBe('v3')
  })

  it('returns null for a capture that has no sidecar, rather than inventing one', async () => {
    const library = await loadModule()
    expect(await library.readSidecar(ID)).toBeNull()
    expect(await library.listRevisions(ID)).toEqual([])
  })

  it('rejects an unknown capture id and a malformed revision from the IPC boundary', async () => {
    const library = await loadModule()
    await expect(library.readSidecar('not-a-uuid')).rejects.toThrow(/no longer exists/)
    await expect(library.readSidecar(ID, '../../etc')).rejects.toThrow(/invalid sidecar revision/)
    expect(await library.listRevisions('../../etc')).toEqual([])
  })
})

describe('LibraryItemKind is read exhaustively', () => {
  it('refuses to hand back a guide as image/png', async () => {
    const library = await loadModule()
    const items = JSON.parse(await fs.readFile(indexPath(), 'utf-8')) as LibraryItem[]
    items[0].kind = 'guide'
    await fs.writeFile(indexPath(), JSON.stringify(items, null, 2))

    // Before the narrowing fix this returned `{ mime: 'image/png' }` — a guide
    // labelled as a PNG, silently, all the way out to the clipboard.
    await expect(library.readItemBytes(ID)).rejects.toThrow(/has no media bytes/)
  })
})
