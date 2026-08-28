import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { formatOf, mediaFormat } from '@shared/types'
import type { AnnotationDoc, CaptureKind, LibraryItem, MediaKind } from '@shared/types'
import type { RecordingContainer } from '@shared/recording'
import type { Sidecar, SidecarRead } from '@shared/sidecar/types'
import {
  listRevisionsOnDisk,
  nextRevision,
  readRevision,
  writeRevisionAtomically,
  type RevisionFile
} from './sidecar/store'
import { parseRevision } from './sidecar/paths'

/**
 * Flat-file library store.
 *
 * Assets live as individual files under userData; a single index.json holds the
 * records. A database would buy us nothing here — the working set is small,
 * writes are user-paced, and a plain JSON index stays inspectable and trivially
 * recoverable if it is ever corrupted. It also keeps us free of native modules.
 */

const root = (): string => join(app.getPath('userData'), 'library')
const assetsDir = (): string => join(root(), 'assets')
const indexPath = (): string => join(root(), 'index.json')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let cache: LibraryItem[] | null = null
/** Serializes index writes so concurrent saves can't interleave and lose records. */
let writeChain: Promise<unknown> = Promise.resolve()

async function ensureDirs(): Promise<void> {
  await fs.mkdir(assetsDir(), { recursive: true })
}

async function readIndex(): Promise<LibraryItem[]> {
  if (cache) return cache
  await ensureDirs()
  try {
    const raw = await fs.readFile(indexPath(), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    cache = Array.isArray(parsed) ? (parsed as LibraryItem[]) : []
  } catch {
    // Missing or unreadable index is the normal first-run case.
    cache = []
  }
  return cache
}

function writeIndex(items: LibraryItem[]): Promise<void> {
  // Chain on a *settled* tail. Chaining on the raw promise would mean one
  // rejected write permanently poisons the queue — every later `.then` would be
  // skipped and no index write would ever be attempted again this process.
  const next = writeChain.catch(() => undefined).then(async () => {
    await ensureDirs()
    const tmp = `${indexPath()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf-8')
    // Atomic-ish replace, so a crash mid-write can't truncate the index.
    await fs.rename(tmp, indexPath())
    // Only publish to the cache once the bytes are actually on disk, so a failed
    // write can never leave the UI reporting state that didn't persist.
    cache = items
  })

  writeChain = next
  return next.catch((err: unknown) => {
    // Drop the cache so the next read re-hydrates from whatever is truly on disk.
    cache = null
    throw err
  })
}

function defaultName(kind: MediaKind, when: Date): string {
  const stamp = when.toISOString().replace(/[:.]/g, '-').replace('T', ' ').slice(0, 19)
  return `${kind === 'video' ? 'Recording' : 'Capture'} ${stamp}`
}

export interface SaveArgs {
  kind: MediaKind
  captureKind: CaptureKind
  /** Bytes to write. Mutually exclusive with `adoptFile`. */
  bytes?: Buffer
  /**
   * An existing file to take ownership of, renamed into the assets directory.
   *
   * Recordings arrive this way: a ten-minute capture already exists on disk in
   * its entirety, and reading it into a Buffer only to write it back out again
   * would cost hundreds of megabytes of resident memory for no benefit.
   */
  adoptFile?: string
  width: number
  height: number
  durationMs?: number
  name?: string
  /** Real container of a video's bytes. Required for video; the extension comes from it. */
  container?: RecordingContainer
  chapters?: number[]
  recovered?: boolean
}

export async function listItems(): Promise<LibraryItem[]> {
  const items = await readIndex()
  // Soft-deleted items are hidden here rather than removed from the index, so
  // the undo window has something to restore. `getItem` deliberately still
  // finds them — restore and the expiry sweep both need to.
  return items
    .filter((i) => !i.deletedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function save(args: SaveArgs): Promise<LibraryItem> {
  await ensureDirs()
  const id = randomUUID()
  const now = new Date()
  // The extension comes from the *real* container, never from the kind alone —
  // that assumption is what wrote MP4 bytes into a `.webm` name.
  const ext = mediaFormat(args.kind, args.container).ext
  const filePath = join(assetsDir(), `${id}.${ext}`)

  let size: number
  if (args.adoptFile) {
    try {
      await fs.rename(args.adoptFile, filePath)
    } catch {
      // A rename across devices fails with EXDEV; copy-then-unlink is the
      // portable fallback, and userData and the recording dir are normally the
      // same volume so this is the rare path.
      await fs.copyFile(args.adoptFile, filePath)
      await fs.rm(args.adoptFile, { force: true }).catch(() => undefined)
    }
    size = (await fs.stat(filePath)).size
  } else if (args.bytes) {
    await fs.writeFile(filePath, args.bytes)
    size = args.bytes.byteLength
  } else {
    throw new Error('library.save needs either bytes or a file to adopt')
  }

  const item: LibraryItem = {
    id,
    name: args.name?.trim() || defaultName(args.kind, now),
    kind: args.kind,
    captureKind: args.captureKind,
    filePath,
    width: args.width,
    height: args.height,
    size,
    durationMs: args.durationMs ?? null,
    createdAt: now.toISOString(),
    annotations: null,
    // Only recorded for video; an image has no container and carrying one would
    // make `formatOf` answer 'mp4' for a PNG.
    ...(args.kind === 'video' && args.container ? { container: args.container } : {}),
    ...(args.chapters?.length ? { chapters: [...args.chapters] } : {}),
    ...(args.recovered ? { recovered: true } : {})
  }

  const items = await readIndex()
  await writeIndex([item, ...items])
  return item
}

/** Ids arrive from the renderer, so they are validated and resolved through the index — never used as a path segment. */
export async function getItem(id: string): Promise<LibraryItem | undefined> {
  if (!UUID_RE.test(id)) return undefined
  const items = await readIndex()
  return items.find((i) => i.id === id)
}

async function requireItem(id: string): Promise<LibraryItem> {
  const item = await getItem(id)
  if (!item) throw new Error('That capture no longer exists')
  return item
}

/* ------------------------------------------------------------------ *
 * Soft delete — PRD-002 §1 P5, "every destructive act is reversible for
 * 30 seconds".
 *
 * The shipped `deleteItem` unlinked the asset immediately, so the previous
 * confirm modal's "This can't be undone" was accurate — and that is precisely
 * what P5 forbids. Restoring a file after `fs.rm` is not possible, so the undo
 * has to be implemented by *not deleting yet*, not by a nicer toast.
 *
 * No separate holding directory: the asset never moves, only an index flag
 * changes. Moving files twice would double the failure surface for a window
 * that usually expires with nothing having happened, and a rename across a
 * device boundary can fail (see EXDEV in `save`).
 *
 * If the app quits inside the undo window the item is **restored** on next
 * launch (`sweepExpiredDeletes` below), not removed. A user who quits during
 * the window has not confirmed anything, and of the two ways to be wrong,
 * keeping a capture the user meant to delete is recoverable and losing one they
 * did not is not.
 * ------------------------------------------------------------------ */

export const UNDO_WINDOW_MS = 30_000

/** Timers for deletes awaiting expiry in this process. */
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Marks an item deleted and schedules the real removal.
 *
 * Returns the marked item so a caller can name it in the undo toast without a
 * second lookup.
 */
export async function deleteItem(id: string): Promise<LibraryItem | null> {
  const target = await getItem(id)
  if (!target || target.deletedAt) return null
  const marked = await update(id, { deletedAt: new Date().toISOString() })

  const timer = setTimeout(() => {
    pendingDeletes.delete(id)
    void purgeItem(id).catch(() => undefined)
  }, UNDO_WINDOW_MS)
  // Nothing should hold the process open just to finish a delete; the sweep on
  // next launch covers a quit inside the window.
  timer.unref?.()
  pendingDeletes.set(id, timer)

  return marked
}

/** Cancels a pending delete (the undo toast's action). */
export async function restoreItem(id: string): Promise<LibraryItem | null> {
  const timer = pendingDeletes.get(id)
  if (timer) {
    clearTimeout(timer)
    pendingDeletes.delete(id)
  }
  const target = await getItem(id)
  if (!target?.deletedAt) return null
  const items = await readIndex()
  const idx = items.findIndex((i) => i.id === id)
  // Delete the key rather than setting it to undefined: `!i.deletedAt` would
  // accept either, but an explicit `"deletedAt": undefined` does not survive
  // JSON and leaves the on-disk record shaped differently from a fresh one.
  const restored = { ...items[idx] }
  delete restored.deletedAt
  const next = [...items]
  next[idx] = restored
  await writeIndex(next)
  return restored
}

/** Irreversible removal. Only reached when the undo window has expired. */
async function purgeItem(id: string): Promise<void> {
  const target = await getItem(id)
  if (!target) return
  const items = await readIndex()
  await writeIndex(items.filter((i) => i.id !== id))
  // Best-effort asset cleanup — a missing file must not fail the delete.
  await fs.rm(target.filePath, { force: true }).catch(() => undefined)
}

/**
 * Called once at launch. Clears any `deletedAt` left behind by a quit inside
 * the undo window, so an unconfirmed delete never survives a restart.
 */
export async function sweepExpiredDeletes(): Promise<number> {
  const items = await readIndex()
  const stale = items.filter((i) => i.deletedAt)
  if (stale.length === 0) return 0
  const next = items.map((i) => {
    if (!i.deletedAt) return i
    const restored = { ...i }
    delete restored.deletedAt
    return restored
  })
  await writeIndex(next)
  return stale.length
}

async function update(id: string, patch: Partial<LibraryItem>): Promise<LibraryItem> {
  await requireItem(id)
  const items = await readIndex()
  const idx = items.findIndex((i) => i.id === id)
  const updated: LibraryItem = { ...items[idx], ...patch }
  const next = [...items]
  next[idx] = updated
  await writeIndex(next)
  return updated
}

export async function renameItem(id: string, name: string): Promise<LibraryItem> {
  const current = await requireItem(id)
  return update(id, { name: name.trim() || current.name })
}

export async function saveAnnotations(id: string, doc: AnnotationDoc): Promise<LibraryItem> {
  return update(id, { annotations: doc })
}

export async function readItemBytes(id: string): Promise<{ bytes: Buffer; mime: string }> {
  const item = await requireItem(id)
  const bytes = await fs.readFile(item.filePath)
  return { bytes, mime: formatOf(item).mime }
}

/* ------------------------------------------------------------------ *
 * Sidecars (DC-3 / DC-6)
 *
 * The state layer lives in `captures/<uuid>/v<N>/`, parallel to `assets/` —
 * not inside the index. `update()` above mutates a record in place, which is
 * exactly what DC-6 forbids for a sidecar: a redaction or a heal must write a
 * *new* revision and leave the previous file byte-identical.
 *
 * The index still holds the pointer, so the whole publish is: rename the
 * revision directory into place, then one `writeIndex` flipping
 * `sidecarRevision`. Both steps run on the existing serialized write chain, so
 * a concurrent capture cannot interleave and lose the pointer.
 * ------------------------------------------------------------------ */

export interface SaveSidecarOptions {
  /** Side files (`dom/…`, `console.ndjson`, …) published in the same transaction. */
  files?: RevisionFile[]
}

export interface SavedSidecar {
  revision: string
  dir: string
  item: LibraryItem
}

/**
 * Serializes sidecar transactions.
 *
 * A *second* chain, not `writeChain`: the unit below ends in `update()`, which
 * chains on `writeChain`, so running it there would make the task await itself
 * and deadlock. `writeChain` never awaits this one, so there is no cycle.
 *
 * Without it, two concurrent revisions of the same capture — a harvest finishing
 * while a redaction fires is the realistic case — both compute `v2` and both
 * stage into the same `.tmp-v2` directory. The second call's staging cleanup
 * deletes the first's files, and the first's `rename` then publishes a mixed
 * revision. That is a silent DC-3 violation, not the loud "already exists"
 * rejection, so the `exists()` check in the store cannot catch it.
 *
 * Chained on a *settled* tail for the same reason `writeChain` is: one rejection
 * must not poison the queue for the rest of the process.
 */
let sidecarChain: Promise<unknown> = Promise.resolve()

/**
 * Writes the next revision for a capture and points the index at it.
 *
 * `supersedes` is set from whatever revision was current, so the chain is
 * recorded in the file itself and not only in the index. Reading it inside the
 * serialized unit means it reflects a *committed* index, not one a queued write
 * is about to change.
 */
export function saveSidecarRevision(
  id: string,
  sidecar: Sidecar,
  options: SaveSidecarOptions = {}
): Promise<SavedSidecar> {
  const task = sidecarChain.catch(() => undefined).then(async (): Promise<SavedSidecar> => {
    const item = await requireItem(id)
    const libraryRoot = root()

    // Fold in what the index believes as well as what is on disk: a revision
    // directory deleted by hand must not cause the number to be reused.
    const indexRevision = item.sidecarRevision ? (parseRevision(item.sidecarRevision) ?? 0) : 0
    const revision = await nextRevision(libraryRoot, id, indexRevision)

    const toWrite: Sidecar = {
      ...sidecar,
      capture_id: id,
      supersedes: item.sidecarRevision ?? null
    }

    await writeRevisionAtomically(libraryRoot, id, revision, toWrite, options.files ?? [])

    // Only now does the revision become "current". A crash before this line leaves
    // a complete but orphaned directory that `readSidecar(id)` will not resolve.
    const updated = await update(id, {
      sidecarDir: join(libraryRoot, 'captures', id),
      sidecarRevision: revision
    })

    return { revision, dir: join(libraryRoot, 'captures', id, revision), item: updated }
  })

  sidecarChain = task
  return task
}

/**
 * Reads a capture's sidecar.
 *
 * With no `revision`, resolves through the index — so a revision orphaned by a
 * crash between the rename and the index write is inert, exactly as DC-3
 * requires. Pass an explicit revision to read a superseded one (which is still
 * on disk, byte-identical to the day it was written).
 */
export async function readSidecar(id: string, revision?: string): Promise<SidecarRead | null> {
  const item = await requireItem(id)
  const target = revision ?? item.sidecarRevision
  if (!target) return null
  if (parseRevision(target) === null) throw new Error(`invalid sidecar revision: ${target}`)
  return readRevision(root(), id, target)
}

/**
 * Every revision genuinely present on disk, ascending.
 *
 * Reports what exists rather than what the index blesses — including an orphan,
 * because a caller auditing the store needs to see one. Interrupted `.tmp-`
 * writes are never revisions and never appear.
 */
export async function listRevisions(id: string): Promise<string[]> {
  if (!UUID_RE.test(id)) return []
  return listRevisionsOnDisk(root(), id)
}
