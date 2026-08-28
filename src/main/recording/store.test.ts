import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * FR-REC.3 — chunk-to-disk and the recovery scan.
 *
 * `store.ts` resolves its root through `app.getPath('userData')` on every call,
 * so a mutable pointer here gives each test its own directory.
 */
let userData = ''
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

type StoreModule = typeof import('./store')

/** Fresh module instance per test: the open-recording map is a module singleton. */
async function loadModule(): Promise<StoreModule> {
  vi.resetModules()
  return import('./store')
}

const recordingsDir = (): string => join(userData, 'library', 'recordings')

const MP4 = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2'
const TRACKS = { system: true, mic: false, camera: false }

beforeEach(async () => {
  userData = await fs.mkdtemp(join(tmpdir(), 'nawi-rec-'))
})

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true })
})

describe('begin', () => {
  it('writes the manifest before any chunk arrives', async () => {
    const store = await loadModule()
    const { id, manifest } = await store.begin({ mimeType: MP4, width: 1920, height: 1080, tracks: TRACKS })

    // The whole point: metadata exists on disk before the first byte of media,
    // so a crash one second in still leaves something recovery can describe.
    const raw = JSON.parse(await fs.readFile(join(recordingsDir(), id, 'manifest.json'), 'utf-8'))
    expect(raw.container).toBe('mp4')
    expect(raw.mimeType).toBe(MP4)
    expect(raw.width).toBe(1920)
    expect(raw.tracks).toEqual(TRACKS)
    expect(manifest.container).toBe('mp4')
  })

  it('names the media file after the real container', async () => {
    const store = await loadModule()
    const { id } = await store.begin({ mimeType: 'video/webm;codecs=vp9', width: 1, height: 1, tracks: TRACKS })
    await store.appendChunk(id, new Uint8Array([1]))
    await store.close(id)
    expect(await fs.readdir(join(recordingsDir(), id))).toContain('media.webm')
  })

  it('refuses a mime type whose container it cannot identify', async () => {
    const store = await loadModule()
    // Guessing here would write MP4 bytes into a `.webm` name, which nothing
    // downstream could open and nothing would report.
    await expect(
      store.begin({ mimeType: 'video/x-matroska', width: 1, height: 1, tracks: TRACKS })
    ).rejects.toThrow(/container/)
  })
})

describe('appendChunk', () => {
  it('lands bytes on disk as they arrive, not at stop', async () => {
    const store = await loadModule()
    const { id } = await store.begin({ mimeType: MP4, width: 1, height: 1, tracks: TRACKS })
    const media = join(recordingsDir(), id, 'media.mp4')

    await store.appendChunk(id, new Uint8Array([1, 2, 3]))
    // Read *without* closing: this is the SIGKILL scenario, where nothing gets
    // a chance to flush at stop.
    expect((await fs.readFile(media)).length).toBe(3)

    await store.appendChunk(id, new Uint8Array([4, 5]))
    expect([...(await fs.readFile(media))]).toEqual([1, 2, 3, 4, 5])
  })

  it('appends in the order it was called', async () => {
    const store = await loadModule()
    const { id } = await store.begin({ mimeType: MP4, width: 1, height: 1, tracks: TRACKS })
    for (let i = 0; i < 50; i++) await store.appendChunk(id, new Uint8Array([i]))
    const bytes = [...(await fs.readFile(join(recordingsDir(), id, 'media.mp4')))]
    expect(bytes).toEqual([...Array(50).keys()])
  })

  it('rejects a payload that is not a byte array', async () => {
    const store = await loadModule()
    const { id } = await store.begin({ mimeType: MP4, width: 1, height: 1, tracks: TRACKS })
    await expect(store.appendChunk(id, 'not bytes' as unknown as Uint8Array)).rejects.toThrow()
  })

  it('rejects an unknown recording id rather than creating one', async () => {
    const store = await loadModule()
    await expect(
      store.appendChunk('11111111-2222-3333-4444-555555555555', new Uint8Array([1]))
    ).rejects.toThrow(/in progress/)
  })

  it('refuses an id that is not a uuid, so it can never be used as a path segment', async () => {
    const store = await loadModule()
    await expect(store.addChapter('../../etc', 0)).rejects.toThrow()
  })
})

describe('findRecoverable', () => {
  /**
   * Simulates process death: the module is discarded with the write stream
   * still open and no `close()`, `commit()` or cleanup, then a *fresh* module
   * instance scans the same directory — which is exactly what happens on the
   * next launch after a SIGKILL.
   */
  async function abandonRecording(bytes: number, mimeType = MP4): Promise<string> {
    const store = await loadModule()
    const { id } = await store.begin({ mimeType, width: 1280, height: 720, tracks: TRACKS })
    await store.appendChunk(id, new Uint8Array(bytes).fill(7))
    await store.addChapter(id, 4000)
    // No close, no commit. The next `loadModule()` has an empty open-map, the
    // same state a new process starts in.
    return id
  }

  it('offers a recording that was never committed', async () => {
    const id = await abandonRecording(2048)

    const next = await loadModule()
    const found = await next.findRecoverable()
    expect(found).toHaveLength(1)
    expect(found[0].id).toBe(id)
    expect(found[0].size).toBe(2048)
    expect(found[0].manifest.container).toBe('mp4')
    // The chapter marker was written to the manifest as it happened, so it
    // survived the crash too.
    expect(found[0].manifest.chapters).toEqual([4000])
  })

  it('does not offer a recording that was committed', async () => {
    const id = await abandonRecording(1024)
    const next = await loadModule()
    await next.commit(id)
    expect(await next.findRecoverable()).toHaveLength(0)
  })

  it('does not offer a recording that is currently open in this process', async () => {
    const store = await loadModule()
    const { id } = await store.begin({ mimeType: MP4, width: 1, height: 1, tracks: TRACKS })
    await store.appendChunk(id, new Uint8Array([1, 2, 3]))
    // Offering "recover" for the recording the user is making right now would
    // be a bug, not a feature.
    expect(await store.findRecoverable()).toHaveLength(0)
  })

  it('skips a directory with a manifest but no bytes', async () => {
    const store = await loadModule()
    await store.begin({ mimeType: MP4, width: 1, height: 1, tracks: TRACKS })
    const next = await loadModule()
    expect(await next.findRecoverable()).toHaveLength(0)
  })

  it('skips a half-written manifest without failing the whole scan', async () => {
    const good = await abandonRecording(512)
    const broken = join(recordingsDir(), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    await fs.mkdir(broken, { recursive: true })
    await fs.writeFile(join(broken, 'manifest.json'), '{ this is not json')
    await fs.writeFile(join(broken, 'media.mp4'), 'xx')

    const next = await loadModule()
    const found = await next.findRecoverable()
    // One bad directory must not deny the user every other recoverable file.
    expect(found.map((f) => f.id)).toEqual([good])
  })

  it('ignores directories whose name is not a uuid', async () => {
    await fs.mkdir(join(recordingsDir(), '..hostile'), { recursive: true })
    const store = await loadModule()
    expect(await store.findRecoverable()).toEqual([])
  })

  it('returns nothing when no recordings directory exists at all', async () => {
    const store = await loadModule()
    expect(await store.findRecoverable()).toEqual([])
  })

  it('discards a recovered recording completely', async () => {
    const id = await abandonRecording(256)
    const next = await loadModule()
    await next.discard(id)
    expect(await next.findRecoverable()).toHaveLength(0)
    await expect(fs.access(join(recordingsDir(), id))).rejects.toThrow()
  })
})

describe('close', () => {
  it('reports the bytes written and the container, and leaves the file in place', async () => {
    const store = await loadModule()
    const { id } = await store.begin({ mimeType: MP4, width: 1920, height: 1080, tracks: TRACKS })
    await store.appendChunk(id, new Uint8Array(10))
    const closed = await store.close(id)

    expect(closed.bytes).toBe(10)
    expect(closed.manifest.container).toBe('mp4')
    expect(closed.mediaPath.endsWith('media.mp4')).toBe(true)
    // Still on disk: the library adopts this file, and deleting it here would
    // lose the recording between close and adopt.
    expect((await fs.stat(closed.mediaPath)).size).toBe(10)
  })

  it('is not resolvable twice, so a double stop cannot adopt the same file twice', async () => {
    const store = await loadModule()
    const { id } = await store.begin({ mimeType: MP4, width: 1, height: 1, tracks: TRACKS })
    await store.appendChunk(id, new Uint8Array(1))
    await store.close(id)
    await expect(store.close(id)).rejects.toThrow(/in progress/)
  })
})
