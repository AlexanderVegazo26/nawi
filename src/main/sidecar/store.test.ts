import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validSidecar } from '@shared/sidecar/__fixtures__/sidecar'
import { isSafeRelPath, parseRevision } from './paths'
import {
  listRevisionsOnDisk,
  nextRevision,
  readRevision,
  writeRevisionAtomically
} from './store'

const ID = '11111111-2222-4333-8444-555555555555'

let libraryRoot = ''

beforeEach(async () => {
  libraryRoot = await fs.mkdtemp(join(tmpdir(), 'nawi-sidecar-'))
})

afterEach(async () => {
  await fs.rm(libraryRoot, { recursive: true, force: true })
})

const captureDirPath = (): string => join(libraryRoot, 'captures', ID)

describe('DC-6 — a revision write never edits its predecessor', () => {
  it('leaves the prior sidecar file byte-identical after a redaction writes v2', async () => {
    await writeRevisionAtomically(libraryRoot, ID, 'v1', validSidecar(), [
      { path: 'console.ndjson', contents: '{"t_ms":1,"level":"log","message":"hi","stack":null}\n' }
    ])

    const v1Path = join(captureDirPath(), 'v1', 'sidecar.v1.json')
    const before = await fs.readFile(v1Path)

    await writeRevisionAtomically(
      libraryRoot,
      ID,
      'v2',
      validSidecar({
        supersedes: 'v1',
        redactions: [
          { region: [10, 20, 30, 40], kind: 'solid', reason: 'password', applied_to: ['pixel', 'dom'] }
        ]
      })
    )

    const after = await fs.readFile(v1Path)
    expect(after.equals(before)).toBe(true)

    const v2 = await readRevision(libraryRoot, ID, 'v2')
    expect(v2.supersedes).toBe('v1')
    expect(v2.redactions).toHaveLength(1)

    // Both remain readable; the superseded one is history, not garbage.
    expect(await listRevisionsOnDisk(libraryRoot, ID)).toEqual(['v1', 'v2'])
  })

  it('refuses to overwrite an existing revision', async () => {
    await writeRevisionAtomically(libraryRoot, ID, 'v1', validSidecar())
    await expect(writeRevisionAtomically(libraryRoot, ID, 'v1', validSidecar())).rejects.toThrow(
      /already exists/
    )
  })

  it('preserves unknown fields written by a newer build when reading back', async () => {
    // Simulates a sidecar authored by a future minor: written directly, read by us.
    const future = {
      ...validSidecar(),
      schema_version: '1.9',
      future_root_field: 'kept',
      state_layer: { ...validSidecar().state_layer, future_state_field: 42 }
    }
    await fs.mkdir(join(captureDirPath(), 'v1'), { recursive: true })
    await fs.writeFile(join(captureDirPath(), 'v1', 'sidecar.v1.json'), JSON.stringify(future))

    const read = (await readRevision(libraryRoot, ID, 'v1')) as unknown as Record<string, any>
    expect(read.future_root_field).toBe('kept')
    expect(read.state_layer.future_state_field).toBe(42)
  })

  it('refuses to read a sidecar from an incompatible major', async () => {
    await fs.mkdir(join(captureDirPath(), 'v1'), { recursive: true })
    await fs.writeFile(
      join(captureDirPath(), 'v1', 'sidecar.v1.json'),
      JSON.stringify({ ...validSidecar(), schema_version: '2.0' })
    )
    await expect(readRevision(libraryRoot, ID, 'v1')).rejects.toThrow(/different major/)
  })
})

describe('DC-3 — a revision is published by one rename or not at all', () => {
  it('leaves no revision behind when the write fails partway', async () => {
    await writeRevisionAtomically(libraryRoot, ID, 'v1', validSidecar())
    const v1Before = await fs.readFile(join(captureDirPath(), 'v1', 'sidecar.v1.json'))

    // A traversal attempt in a side file aborts the transaction after the
    // staging directory already exists and some bytes may have been written.
    await expect(
      writeRevisionAtomically(libraryRoot, ID, 'v2', validSidecar(), [
        { path: 'dom/ok.json', contents: '{}' },
        { path: '../escape.json', contents: 'nope' }
      ])
    ).rejects.toThrow(/unsafe sidecar file path/)

    // Nothing published, nothing leaked, nothing damaged.
    expect(await listRevisionsOnDisk(libraryRoot, ID)).toEqual(['v1'])
    expect((await fs.readFile(join(captureDirPath(), 'v1', 'sidecar.v1.json'))).equals(v1Before)).toBe(
      true
    )
    await expect(fs.access(join(captureDirPath(), 'v2'))).rejects.toThrow()
    await expect(fs.access(join(libraryRoot, 'captures', 'escape.json'))).rejects.toThrow()
  })

  it('ignores a staging directory left by a crash, however complete it looks', async () => {
    await writeRevisionAtomically(libraryRoot, ID, 'v1', validSidecar())

    // Exactly what a SIGKILL between the last write and the rename would leave:
    // a fully-formed revision under `.tmp-v2/`.
    const staging = join(captureDirPath(), '.tmp-v2')
    await fs.mkdir(staging, { recursive: true })
    await fs.writeFile(
      join(staging, 'sidecar.v2.json'),
      JSON.stringify(validSidecar({ supersedes: 'v1' }))
    )

    expect(await listRevisionsOnDisk(libraryRoot, ID)).toEqual(['v1'])
    expect(parseRevision('.tmp-v2')).toBeNull()
    await expect(readRevision(libraryRoot, ID, '.tmp-v2')).rejects.toThrow(/invalid revision/)

    // And the next write reclaims v2 cleanly, replacing the debris.
    expect(await nextRevision(libraryRoot, ID)).toBe('v2')
    await writeRevisionAtomically(libraryRoot, ID, 'v2', validSidecar({ supersedes: 'v1' }))
    expect(await listRevisionsOnDisk(libraryRoot, ID)).toEqual(['v1', 'v2'])
  })

  it('does not treat a directory without a sidecar file as a revision', async () => {
    await fs.mkdir(join(captureDirPath(), 'v3'), { recursive: true })
    expect(await listRevisionsOnDisk(libraryRoot, ID)).toEqual([])
  })

  it('never reuses a revision number, even against an index that is ahead of the disk', async () => {
    await writeRevisionAtomically(libraryRoot, ID, 'v1', validSidecar())
    expect(await nextRevision(libraryRoot, ID)).toBe('v2')
    // The index says v4 is current though only v1 survives on disk.
    expect(await nextRevision(libraryRoot, ID, 4)).toBe('v5')
  })
})

describe('untrusted input at the storage boundary', () => {
  it('rejects a capture id that is not a UUID rather than treating it as a path segment', async () => {
    await expect(
      writeRevisionAtomically(libraryRoot, '../../etc', 'v1', validSidecar())
    ).rejects.toThrow(/invalid capture id/)
    expect(await listRevisionsOnDisk(libraryRoot, '../../etc')).toEqual([])
  })

  it('rejects a sidecar filed under a different capture id than the directory it is written to', async () => {
    await expect(
      writeRevisionAtomically(libraryRoot, ID, 'v1', validSidecar({ capture_id: 'someone-else' }))
    ).rejects.toThrow(/does not match/)
  })

  it('rejects a sidecar that fails DC-4 validation before any bytes are written', async () => {
    await expect(
      writeRevisionAtomically(
        libraryRoot,
        ID,
        'v1',
        validSidecar({ kind: 'nonsense' as unknown as 'screenshot' })
      )
    ).rejects.toThrow(/DC-4 validation/)
    await expect(fs.access(captureDirPath())).rejects.toThrow()
  })

  it('classifies relative paths that escape or resolve differently across platforms', () => {
    expect(isSafeRelPath('dom/000000.json')).toBe(true)
    expect(isSafeRelPath('console.ndjson')).toBe(true)
    expect(isSafeRelPath('../escape')).toBe(false)
    expect(isSafeRelPath('/absolute')).toBe(false)
    expect(isSafeRelPath('C:\\windows')).toBe(false)
    expect(isSafeRelPath('a//b')).toBe(false)
    expect(isSafeRelPath('')).toBe(false)
  })
})
