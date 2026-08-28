import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * FR-REC.3 — crash safety, end to end.
 *
 * Two tests, and they check different halves of the requirement:
 *
 *  1. **The real kill.** Start a recording against a real screen source, let
 *     several chunk intervals elapse, then SIGKILL the Electron process. Relaunch
 *     against the same userData and assert the partial recording is offered and
 *     can be recovered into the library. This exercises the actual failure the
 *     requirement names rather than simulating it. It needs a real display, so it
 *     is skipped when `desktopCapturer` returns no screen source.
 *
 *  2. **The recovery scan in isolation.** A recording directory planted on disk,
 *     so the offer/recover/discard path is covered deterministically even where
 *     screen capture is unavailable.
 *
 * The acceptance's *ten-minute* case is not run here: the suite's timeout is 45s,
 * and a ten-minute test would gate every future run on it. The kill happens a few
 * seconds in instead; what that establishes is that chunks are on disk before any
 * stop and that recovery finds them. The ≥9m55s figure follows from the chunk
 * interval, not from this test — see the report.
 */

const RECORDINGS = ['library', 'recordings']

async function launch(userDataDir: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: process.cwd()
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

interface VideoProbe {
  ok: boolean
  error: string | null
  duration: number
  readyState: number
  seeked: boolean
}

/**
 * Loads a stored item as video two ways and reports what each managed.
 *
 *  - through a blob URL from `readItemBytes`, which isolates the container
 *    itself from how it was served, and
 *  - through `capture://asset/<id>`, which is ARCHITECTURE.md assumption #6 —
 *    an MP4 over a custom protocol previously failed with media error 4 until
 *    range requests were avoided, and that assumption has never been retired.
 *
 * Having both is what makes a failure diagnosable: blob works and `capture://`
 * does not means the protocol; neither works means the container, and no
 * protocol change would help.
 */
async function probeVideo(
  win: Page,
  itemId: string
): Promise<{ blob: VideoProbe | null; protocol: VideoProbe | null; error: string | null }> {
  return win.evaluate(async (id: string) => {
    async function load(src: string): Promise<VideoProbe> {
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.muted = true
      const result: VideoProbe = {
        ok: false,
        error: null,
        duration: 0,
        readyState: 0,
        seeked: false
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('metadata timed out')), 15_000)
          video.onloadedmetadata = () => {
            clearTimeout(timer)
            resolve()
          }
          video.onerror = () => {
            clearTimeout(timer)
            reject(new Error(`media error ${video.error?.code ?? '?'}`))
          }
          video.src = src
        })
        result.readyState = video.readyState
        result.duration = video.duration
        result.ok = true

        const target = Number.isFinite(video.duration) && video.duration > 0 ? video.duration / 2 : 0.5
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10_000)
          video.onseeked = () => {
            clearTimeout(timer)
            result.seeked = true
            resolve()
          }
          video.currentTime = target
        })
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err)
      }
      video.src = ''
      return result
    }

    const bytes = await window.api.readItemBytes(id)
    if (!bytes.ok) return { blob: null, protocol: null, error: bytes.error }
    const url = URL.createObjectURL(new Blob([bytes.value.data], { type: bytes.value.mime }))
    const blob = await load(url)
    URL.revokeObjectURL(url)
    const protocol = await load(`capture://asset/${id}`)
    return { blob, protocol, error: null }
  }, itemId)
}

test.describe('crash recovery', () => {
  let userDataDir: string

  test.beforeEach(async () => {
    userDataDir = await fs.mkdtemp(join(tmpdir(), 'nawi-rec-e2e-'))
  })

  test.afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  })

  test('a killed recording is offered and recoverable on the next launch', async () => {
    test.setTimeout(90_000)
    const first = await launch(userDataDir)

    const sources = await first.win.evaluate(() => window.api.listSources(['screen']))
    if (!sources.ok || sources.value.length === 0) {
      await first.app.close()
      test.skip(true, 'no screen capture source is available in this environment')
      return
    }

    // Start through the real IPC path, exactly as the picker does.
    const started = await first.win.evaluate((sourceId: string) =>
      window.api.startRecording({
        sourceId,
        tracks: { system: false, mic: false, camera: false },
        countdown: false
      })
    , sources.value[0].id)
    expect(started.ok).toBe(true)

    // Wait until the engine says it is really recording, not merely that the
    // request was accepted.
    await expect
      .poll(
        async () => {
          const s = await first.win.evaluate(() => window.api.getRecordingStatus())
          return s.ok ? s.value.phase : 'unknown'
        },
        { timeout: 30_000, intervals: [250] }
      )
      .toBe('recording')

    // Several chunk intervals, so there is genuinely more than one chunk on disk.
    await first.win.waitForTimeout(5_000)

    // The kill. Not `app.close()` — nothing gets to flush, finalize, or write a
    // commit marker, which is the whole point.
    const pid = first.app.process().pid!
    if (process.platform === 'win32') {
      // The whole tree, not just the main process. Killing only the parent
      // leaves the renderer and GPU children orphaned, which then outlive the
      // test run and trip Playwright's worker-teardown timeout.
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'])
    } else {
      process.kill(pid, 'SIGKILL')
    }
    await first.app.waitForEvent('close').catch(() => undefined)

    // Bytes must already be on disk, written as the chunks arrived.
    const dir = join(userDataDir, ...RECORDINGS)
    const ids = await fs.readdir(dir)
    expect(ids.length).toBe(1)
    const files = await fs.readdir(join(dir, ids[0]))
    expect(files).toContain('manifest.json')
    // No commit marker: this is what makes it recoverable rather than adopted.
    expect(files).not.toContain('committed')
    const media = files.find((f) => f.startsWith('media.'))!
    expect((await fs.stat(join(dir, ids[0], media))).size).toBeGreaterThan(0)

    // Relaunch: the user is offered the recording.
    const second = await launch(userDataDir)
    await expect(second.win.getByText('A recording was interrupted.')).toBeVisible({ timeout: 20_000 })
    await second.win.getByRole('button', { name: 'Recover to library' }).click()

    const items = await second.win.evaluate(() => window.api.listLibrary())
    expect(items.ok).toBe(true)
    if (items.ok) {
      expect(items.value).toHaveLength(1)
      expect(items.value[0].kind).toBe('video')
      expect(items.value[0].recovered).toBe(true)
      // The stored file carries the extension of the container that was really
      // negotiated — the end-to-end MP4 property, on the recovery path too.
      expect(items.value[0].filePath.endsWith(`.${items.value[0].container ?? 'webm'}`)).toBe(true)

      /*
       * The acceptance says the recovered file is *playable*, not merely
       * present. A container truncated mid-stream carries no trailing index, so
       * every assertion above can pass against a file that will not open. This
       * loads the real killed artefact two ways:
       *
       *  - through a blob URL, which isolates the container itself, and
       *  - through `capture://asset/<id>`, which is ARCHITECTURE.md assumption
       *    #6 and has never been retired — the custom scheme is where an MP4
       *    previously failed with media error 4 until range requests were
       *    avoided.
       *
       * Scrubbing is checked on the protocol path specifically: play without
       * seek is what a broken range implementation looks like.
       */
      const id = items.value[0].id
      const probe = await probeVideo(second.win, id)

      // The container itself opens and reports a real duration.
      expect(probe.blob?.ok, `blob-URL playback failed: ${probe.blob?.error}`).toBe(true)
      expect(probe.blob?.readyState).toBeGreaterThanOrEqual(1)
      expect(Number.isFinite(probe.blob?.duration ?? NaN) && (probe.blob?.duration ?? 0) > 0).toBe(true)

      /*
       * And it plays through the custom protocol.
       *
       * Seeking is deliberately NOT asserted here. This file was truncated by a
       * SIGKILL, so it has no trailing index — whether a given position is
       * seekable depends on where the kill landed relative to the last fragment,
       * and the assertion was observed to pass on one run and time out on the
       * next. That is a property of the truncated artefact, not of the protocol.
       * The scrub requirement (ARCHITECTURE.md assumption #6) is asserted
       * against a cleanly finalized recording in the test below, which is the
       * artefact the requirement is actually about.
       */
      expect(probe.protocol?.ok, `capture:// playback failed: ${probe.protocol?.error}`).toBe(true)
    }
    await second.app.close()
  })

  test('a normally stopped recording is MP4, and plays and scrubs over capture://', async () => {
    test.setTimeout(90_000)
    const { app, win } = await launch(userDataDir)

    const sources = await win.evaluate(() => window.api.listSources(['screen']))
    if (!sources.ok || sources.value.length === 0) {
      await app.close()
      test.skip(true, 'no screen capture source is available in this environment')
      return
    }

    const started = await win.evaluate(
      (sourceId: string) =>
        window.api.startRecording({
          sourceId,
          tracks: { system: false, mic: false, camera: false },
          countdown: false
        }),
      sources.value[0].id
    )
    expect(started.ok).toBe(true)

    await expect
      .poll(
        async () => {
          const s = await win.evaluate(() => window.api.getRecordingStatus())
          return s.ok ? s.value.phase : 'unknown'
        },
        { timeout: 30_000, intervals: [250] }
      )
      .toBe('recording')

    // FR-REC.2: pause and resume mid-recording, so the finalized file is one
    // that actually went through the pause path rather than a straight run.
    await win.waitForTimeout(2_000)
    await win.evaluate(() => window.api.sendRecordCommand('pause'))
    await win.waitForTimeout(1_000)
    await win.evaluate(() => window.api.sendRecordCommand('resume'))
    // FR-REC.8: a chapter marker, which must survive into the library item.
    await win.evaluate(() => window.api.sendRecordCommand('chapter'))
    await win.waitForTimeout(3_000)

    await win.evaluate(() => window.api.sendRecordCommand('stop'))
    await expect
      .poll(
        async () => {
          const items = await win.evaluate(() => window.api.listLibrary())
          return items.ok ? items.value.length : 0
        },
        { timeout: 30_000, intervals: [250] }
      )
      .toBe(1)

    const items = await win.evaluate(() => window.api.listLibrary())
    expect(items.ok).toBe(true)
    if (items.ok) {
      const item = items.value[0]
      // FR-REC.4 — this build negotiates MP4, and the stored file says so.
      expect(item.container).toBe('mp4')
      expect(item.filePath.endsWith('.mp4')).toBe(true)
      expect(item.kind).toBe('video')
      // Not a recovery: the normal stop path committed and adopted the file.
      expect(item.recovered).toBeUndefined()
      expect(item.chapters?.length).toBe(1)
      expect(item.durationMs).toBeGreaterThan(0)
      // Paused time is excluded, so the duration is the recorded material only.
      expect(item.durationMs!).toBeLessThan(9_000)

      const probe = await probeVideo(win, item.id)
      expect(probe.blob?.ok, `blob-URL playback failed: ${probe.blob?.error}`).toBe(true)
      // ARCHITECTURE.md assumption #6, finally retired: a complete MP4 served
      // over the custom scheme both plays AND seeks.
      expect(probe.protocol?.ok, `capture:// playback failed: ${probe.protocol?.error}`).toBe(true)
      expect(probe.protocol?.seeked, 'capture:// served the file but would not seek').toBe(true)
      expect(Number.isFinite(probe.protocol?.duration ?? NaN)).toBe(true)
    }

    // Nothing is left behind for the recovery path once a recording ended cleanly.
    const recRes = await win.evaluate(() => window.api.listRecoverableRecordings())
    expect(recRes.ok && recRes.value).toEqual([])

    await app.close()
  })

  test('a planted interrupted recording can be recovered, and discarding removes it', async () => {
    // Deterministic version of the same path, with no dependency on a display.
    const id = '11111111-2222-4333-8444-555555555555'
    const dir = join(userDataDir, ...RECORDINGS, id)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        id,
        mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        container: 'mp4',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        width: 1920,
        height: 1080,
        tracks: { system: false, mic: false, camera: false },
        chapters: [1000]
      })
    )
    await fs.writeFile(join(dir, 'media.mp4'), Buffer.alloc(4096, 9))

    const { app, win } = await launch(userDataDir)
    await expect(win.getByText('A recording was interrupted.')).toBeVisible({ timeout: 20_000 })
    // The duration is presented as an estimate, because an interrupted
    // container carries no trailing index to read a real one from.
    await expect(win.getByText(/about \d+m/)).toBeVisible()

    await win.getByRole('button', { name: 'Recover to library' }).click()
    await expect(win.getByText('A recording was interrupted.')).toBeHidden()

    const items = await win.evaluate(() => window.api.listLibrary())
    expect(items.ok).toBe(true)
    if (items.ok) {
      expect(items.value).toHaveLength(1)
      // MP4 end to end: the manifest said MP4, so the stored asset is `.mp4`.
      expect(items.value[0].container).toBe('mp4')
      expect(items.value[0].filePath.endsWith('.mp4')).toBe(true)
      expect(items.value[0].chapters).toEqual([1000])
    }
    // The recording directory is gone once the library owns the bytes.
    await expect(fs.access(dir)).rejects.toThrow()
    await app.close()
  })

  test('discarding an interrupted recording deletes it and does not offer it again', async () => {
    const id = '22222222-3333-4444-8555-666666666666'
    const dir = join(userDataDir, ...RECORDINGS, id)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        id,
        mimeType: 'video/webm;codecs=vp9',
        container: 'webm',
        startedAt: new Date().toISOString(),
        width: 640,
        height: 360,
        tracks: { system: false, mic: false, camera: false },
        chapters: []
      })
    )
    await fs.writeFile(join(dir, 'media.webm'), Buffer.alloc(1024, 1))

    const { app, win } = await launch(userDataDir)
    await expect(win.getByText('A recording was interrupted.')).toBeVisible({ timeout: 20_000 })
    await win.getByRole('button', { name: 'Discard' }).click()
    await expect(win.getByText('A recording was interrupted.')).toBeHidden()

    const items = await win.evaluate(() => window.api.listLibrary())
    expect(items.ok && items.value).toEqual([])
    await expect(fs.access(dir)).rejects.toThrow()
    await app.close()
  })
})

test('the preload exposes the recording surface without a generic invoke escape hatch', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'nawi-rec-api-'))
  const { app, win } = await launch(dir)
  const surface = await win.evaluate(() => ({
    keys: Object.keys((window as unknown as { api: Record<string, unknown> }).api).sort(),
    hasInvoke: 'invoke' in (window as unknown as { api: Record<string, unknown> }).api,
    hasIpcRenderer: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer !== 'undefined'
  }))

  expect(surface.hasInvoke).toBe(false)
  expect(surface.hasIpcRenderer).toBe(false)
  for (const method of [
    'startRecording',
    'sendRecordCommand',
    'getRecordingStatus',
    'appendRecordingChunk',
    'finalizeRecording',
    'listRecoverableRecordings',
    'recoverRecording'
  ]) {
    expect(surface.keys).toContain(method)
  }
  await app.close()
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})
