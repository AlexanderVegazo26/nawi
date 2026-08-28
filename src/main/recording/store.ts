/**
 * FR-REC.3 — crash-safe recording storage.
 *
 * Chunks are appended to an open write stream as they arrive from the recorder
 * window, so a SIGKILL loses at most one chunk interval (1 s) rather than the
 * whole recording, which is what the previous in-memory `chunks: Blob[]` array
 * did.
 *
 * On-disk shape, one directory per in-flight recording:
 *
 *   userData/library/recordings/<uuid>/
 *     manifest.json     written BEFORE the first chunk
 *     media.mp4|.webm   appended to, chunk by chunk
 *     committed         marker file; present only once the recording finished
 *                       cleanly and was handed to the library
 *
 * The manifest is written first on purpose: bytes on disk with no metadata are
 * not recoverable — recovery could neither name, size, nor label the container
 * of what it found. A directory with a manifest and no `committed` marker is
 * exactly the definition of "an interrupted recording", which is what the
 * recovery scan looks for.
 *
 * A note on durability: SIGKILL is process death, not a power cut. The OS page
 * cache outlives the process, so a plain `write()` per chunk already satisfies
 * the ≤5 s bar. We deliberately do not `fsync` per chunk — that would cost real
 * throughput during recording to defend against a failure mode (power loss) the
 * requirement does not name.
 */

import { app } from 'electron'
import { createWriteStream, type WriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { containerOf, type RecordingContainer, type TrackSelection } from '@shared/recording'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const root = (): string => join(app.getPath('userData'), 'library', 'recordings')

/** Ids arrive from the renderer. Never use one as a path segment without this. */
function dirOf(id: string): string {
  if (!UUID_RE.test(id)) throw new Error('invalid recording id')
  return join(root(), id)
}

export interface RecordingManifest {
  version: 1
  id: string
  /** Full MediaRecorder mime string, e.g. `video/mp4;codecs=avc1.42E01E,mp4a.40.2`. */
  mimeType: string
  container: RecordingContainer
  /** ISO-8601, when the first frame was requested. */
  startedAt: string
  width: number
  height: number
  tracks: TrackSelection
  /** Milliseconds from recording start, one per FR-REC.8 marker. */
  chapters: number[]
}

/** A recording found on disk that was never committed — offered to the user on launch. */
export interface RecoverableRecording {
  id: string
  manifest: RecordingManifest
  mediaPath: string
  /** Bytes actually written before the process died. */
  size: number
  /**
   * Duration inferred from the file's last-modified time minus `startedAt`.
   *
   * An interrupted container carries no trailing index, so its own header
   * cannot be trusted for duration. This is an estimate and is labelled as one
   * everywhere it surfaces.
   */
  estimatedDurationMs: number
}

/** State for a recording currently being written. */
interface OpenRecording {
  id: string
  manifest: RecordingManifest
  stream: WriteStream
  mediaPath: string
  bytes: number
  /** Set when a write failed; every later call rejects rather than pretending. */
  failure: Error | null
  /** Resolves when the stream has flushed and closed. */
  closed: Promise<void> | null
}

const open = new Map<string, OpenRecording>()

function manifestPath(dir: string): string {
  return join(dir, 'manifest.json')
}
function committedPath(dir: string): string {
  return join(dir, 'committed')
}
function mediaPathFor(dir: string, container: RecordingContainer): string {
  return join(dir, `media.${container}`)
}

export interface BeginArgs {
  mimeType: string
  width: number
  height: number
  tracks: TrackSelection
}

/**
 * Creates the directory, writes the manifest, and opens the media stream.
 *
 * Everything that can fail happens here, before the recorder is told it may
 * start — a recording that cannot be persisted must never appear to be running.
 */
export async function begin(args: BeginArgs): Promise<{ id: string; manifest: RecordingManifest }> {
  const container = containerOf(args.mimeType)
  if (!container) {
    // Refusing beats guessing: writing MP4 bytes into a `.webm` is a file that
    // nothing downstream can open, and nothing would report a problem.
    throw new Error(`unrecognised recording container for mime type: ${args.mimeType}`)
  }

  const id = randomUUID()
  const dir = join(root(), id)
  await fs.mkdir(dir, { recursive: true })

  const manifest: RecordingManifest = {
    version: 1,
    id,
    mimeType: args.mimeType,
    container,
    startedAt: new Date().toISOString(),
    width: Math.max(0, Math.round(args.width)) || 0,
    height: Math.max(0, Math.round(args.height)) || 0,
    tracks: {
      system: args.tracks.system === true,
      mic: args.tracks.mic === true,
      camera: args.tracks.camera === true
    },
    chapters: []
  }
  await fs.writeFile(manifestPath(dir), JSON.stringify(manifest, null, 2), 'utf-8')

  const mediaPath = mediaPathFor(dir, container)
  const stream = createWriteStream(mediaPath, { flags: 'a' })
  const entry: OpenRecording = {
    id,
    manifest,
    stream,
    mediaPath,
    bytes: 0,
    failure: null,
    closed: null
  }
  // A stream error after `begin` returns has nowhere to be thrown, so it is
  // latched here and surfaced on the next append/finalize instead of being lost.
  stream.on('error', (err) => {
    entry.failure = err instanceof Error ? err : new Error(String(err))
    console.error('[recording] write stream failed', err)
  })
  open.set(id, entry)
  return { id, manifest }
}

function require_(id: string): OpenRecording {
  const entry = open.get(id)
  if (!entry) throw new Error('no such recording is in progress')
  if (entry.failure) throw entry.failure
  return entry
}

/** Appends one chunk. Resolves only once the bytes have been handed to the OS. */
export async function appendChunk(id: string, chunk: Uint8Array): Promise<number> {
  const entry = require_(id)
  if (!(chunk instanceof Uint8Array)) throw new Error('recording chunk must be a byte array')
  if (chunk.byteLength === 0) return entry.bytes

  await new Promise<void>((resolve, reject) => {
    entry.stream.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
  entry.bytes += chunk.byteLength
  return entry.bytes
}

/** Records a FR-REC.8 chapter marker into the manifest so it survives a crash too. */
export async function addChapter(id: string, atMs: number): Promise<number[]> {
  const entry = require_(id)
  if (!Number.isFinite(atMs) || atMs < 0) throw new Error('chapter position must be a positive number')
  entry.manifest.chapters.push(Math.round(atMs))
  await fs.writeFile(
    manifestPath(dirOf(id)),
    JSON.stringify(entry.manifest, null, 2),
    'utf-8'
  )
  return [...entry.manifest.chapters]
}

/** Flushes and closes the stream, leaving the directory in place and uncommitted. */
export async function close(id: string): Promise<{ mediaPath: string; bytes: number; manifest: RecordingManifest }> {
  const entry = open.get(id)
  if (!entry) throw new Error('no such recording is in progress')
  entry.closed ??= new Promise<void>((resolve) => entry.stream.end(() => resolve()))
  await entry.closed
  open.delete(id)
  if (entry.failure) throw entry.failure
  return { mediaPath: entry.mediaPath, bytes: entry.bytes, manifest: entry.manifest }
}

/**
 * Marks a recording as no longer recoverable.
 *
 * Called once the bytes have been handed to the library — writing the marker
 * only after the library owns the file means a crash in between leaves the
 * recording recoverable rather than silently gone.
 */
export async function commit(id: string): Promise<void> {
  const dir = dirOf(id)
  await fs.writeFile(committedPath(dir), new Date().toISOString(), 'utf-8')
}

/** Removes a recording directory entirely. Used after a successful hand-off, or on discard. */
export async function discard(id: string): Promise<void> {
  if (open.has(id)) await close(id).catch(() => undefined)
  await fs.rm(dirOf(id), { recursive: true, force: true }).catch(() => undefined)
}

/** Ends every open stream. Called on quit so a shutdown mid-recording still flushes. */
export async function closeAll(): Promise<void> {
  await Promise.all([...open.keys()].map((id) => close(id).catch(() => undefined)))
}

function parseManifest(raw: unknown, id: string): RecordingManifest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const container = typeof m.container === 'string' ? containerOf(`video/${m.container}`) : null
  if (!container) return null
  if (m.id !== id) return null
  const tracks = (typeof m.tracks === 'object' && m.tracks !== null ? m.tracks : {}) as Record<string, unknown>
  return {
    version: 1,
    id,
    mimeType: typeof m.mimeType === 'string' ? m.mimeType : `video/${container}`,
    container,
    startedAt: typeof m.startedAt === 'string' ? m.startedAt : new Date(0).toISOString(),
    width: typeof m.width === 'number' ? m.width : 0,
    height: typeof m.height === 'number' ? m.height : 0,
    tracks: {
      system: tracks.system === true,
      mic: tracks.mic === true,
      camera: tracks.camera === true
    },
    chapters: Array.isArray(m.chapters) ? m.chapters.filter((c): c is number => typeof c === 'number') : []
  }
}

/**
 * Every recording directory with a manifest, some bytes, and no commit marker.
 *
 * Directories currently open in this process are excluded — an in-flight
 * recording is not an orphan, and offering the user "recover" for the thing
 * they are recording right now would be a bug, not a feature.
 */
export async function findRecoverable(): Promise<RecoverableRecording[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(root())
  } catch {
    return []
  }

  const found: RecoverableRecording[] = []
  for (const id of entries) {
    if (!UUID_RE.test(id)) continue
    if (open.has(id)) continue
    const dir = join(root(), id)
    try {
      // A commit marker means the library already owns these bytes.
      await fs.access(committedPath(dir))
      continue
    } catch {
      /* uncommitted — keep going */
    }
    try {
      const manifest = parseManifest(
        JSON.parse(await fs.readFile(manifestPath(dir), 'utf-8')) as unknown,
        id
      )
      if (!manifest) continue
      const mediaPath = mediaPathFor(dir, manifest.container)
      const stat = await fs.stat(mediaPath)
      // Zero bytes is not a recording; offering it would waste the user's time.
      if (stat.size === 0) continue
      const started = Date.parse(manifest.startedAt)
      const estimatedDurationMs = Number.isFinite(started)
        ? Math.max(0, stat.mtimeMs - started)
        : 0
      found.push({ id, manifest, mediaPath, size: stat.size, estimatedDurationMs })
    } catch {
      // A half-written manifest is not recoverable; skip it rather than failing
      // the whole scan and denying the user every other recording that is.
      continue
    }
  }
  return found.sort((a, b) => b.manifest.startedAt.localeCompare(a.manifest.startedAt))
}

/** Test seam: forget in-process state without touching disk. */
export function _resetForTests(): void {
  open.clear()
}
