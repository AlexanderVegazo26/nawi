import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LibraryItem } from '@shared/types'

/** Same per-test userData pointer as `library.sidecar.test.ts`. */
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

async function readOnDisk(): Promise<LibraryItem[]> {
  return JSON.parse(await fs.readFile(indexPath(), 'utf-8')) as LibraryItem[]
}

const png = (): Buffer => Buffer.from('png')

beforeEach(async () => {
  userData = await fs.mkdtemp(join(tmpdir(), 'nawi-library-index-'))
})

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true })
})

describe('the index survives concurrent mutations', () => {
  it('keeps every record when saves run in parallel', async () => {
    const library = await loadModule()
    const saved = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        library.save({ kind: 'image', captureKind: 'region', width: 10, height: 10, bytes: png(), name: `c${n}` })
      )
    )

    const onDisk = await readOnDisk()
    expect(onDisk.map((i) => i.id).sort()).toEqual(saved.map((i) => i.id).sort())
    expect((await library.listItems()).length).toBe(8)
  })

  it('keeps a rename and a save that race each other', async () => {
    const library = await loadModule()
    const first = await library.save({ kind: 'image', captureKind: 'region', width: 10, height: 10, bytes: png() })

    const [, second] = await Promise.all([
      library.renameItem(first.id, 'renamed'),
      library.save({ kind: 'image', captureKind: 'region', width: 10, height: 10, bytes: png() })
    ])

    const onDisk = await readOnDisk()
    expect(onDisk.find((i) => i.id === first.id)?.name).toBe('renamed')
    expect(onDisk.some((i) => i.id === second.id)).toBe(true)
  })
})

describe('an index that cannot be parsed is never overwritten in place', () => {
  it('moves a truncated index aside before the next save rewrites it', async () => {
    await fs.mkdir(libraryRoot(), { recursive: true })
    const truncated = '[{"id":"11111111-2222-4333-8444-555555555555","name":"Capt'
    await fs.writeFile(indexPath(), truncated)

    const library = await loadModule()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await library.listItems()).toEqual([])
    await library.save({ kind: 'image', captureKind: 'region', width: 10, height: 10, bytes: png() })
    errors.mockRestore()

    const kept = (await fs.readdir(libraryRoot())).filter((f) => f.startsWith('index.json.corrupt-'))
    expect(kept).toHaveLength(1)
    expect(await fs.readFile(join(libraryRoot(), kept[0]), 'utf-8')).toBe(truncated)
    expect(await readOnDisk()).toHaveLength(1)
  })

  it('treats a missing index as an empty library without leaving a corrupt copy', async () => {
    const library = await loadModule()
    expect(await library.listItems()).toEqual([])
    const files = await fs.readdir(libraryRoot())
    expect(files.some((f) => f.startsWith('index.json.corrupt-'))).toBe(false)
  })
})
