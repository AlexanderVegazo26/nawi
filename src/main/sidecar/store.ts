import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseSidecar, parseSidecarStrict } from '@shared/sidecar/schema'
import { checkCompatibility } from '@shared/sidecar/version'
import type { Sidecar, SidecarRead } from '@shared/sidecar/types'
import {
  captureDir,
  formatRevision,
  isCaptureId,
  isSafeRelPath,
  parseRevision,
  revisionDir,
  sidecarFileName,
  sidecarPath,
  tmpRevisionDir
} from './paths'

/**
 * Revisioned, transactional sidecar storage (DC-3 / DC-6).
 *
 * Layout:
 *
 * ```
 * userData/library/captures/<uuid>/
 *   v1/  sidecar.v1.json  dom/  ax/  network.har  console.ndjson  input_events.ndjson
 *   v2/  sidecar.v2.json  …          # supersedes "v1"; v1 is never touched again
 *   .tmp-v3/                          # a crashed write; invisible to both readers
 * ```
 *
 * **Why a revision owns a directory** (ADR-001): DC-3 demands the whole revision
 * appear at once, and a single `fs.rename` is the only primitive that gives that.
 * A sidecar file at the capture root *plus* sibling asset directories cannot be
 * published by one rename — it would take several, and a crash between them
 * leaves a sidecar pointing at files that are not there yet. Directory-per-
 * revision keeps the atomicity and keeps the `sidecar.v<N>.json` filename.
 *
 * **Crash safety.** Everything is assembled under `.tmp-v<N>/` and fsynced, then
 * published by one rename. A crash before the rename leaves only a `.tmp-`
 * directory, which neither `listRevisions` nor `readSidecar` will look at. A
 * crash after the rename but before the index write leaves a complete but
 * *orphaned* revision: it is visible to `listRevisions` (which reports what is
 * genuinely on disk) and inert to `readSidecar()` (which resolves the current
 * revision through the library index). Nothing is ever overwritten, so neither
 * case can damage the previous revision.
 *
 * This module takes `libraryRoot` as an argument and never imports `electron`,
 * so it is testable against a temp directory. `library.ts` supplies the real one
 * and owns the index write.
 */

export interface RevisionFile {
  /** Relative to the revision directory, e.g. `dom/000000.json`. Validated. */
  path: string
  contents: string | Uint8Array
}

/** Writes a file and flushes it, so the rename cannot publish empty bytes. */
async function writeFileSynced(target: string, contents: string | Uint8Array): Promise<void> {
  await fs.mkdir(dirname(target), { recursive: true })
  const handle = await fs.open(target, 'w')
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Best-effort directory flush. Windows has no fsync-a-directory equivalent and
 * fails with EPERM/EISDIR; on POSIX it is what makes the rename durable. Failing
 * the write over it would break the platform we actually ship on.
 */
async function syncDirectory(target: string): Promise<void> {
  try {
    const handle = await fs.open(target, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Not supported here. The rename is still ordered after the file syncs.
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Revisions that are genuinely on disk, ascending.
 *
 * Reports what exists, including a revision orphaned by a crash between the
 * rename and the index write — a reader that needs "the current revision"
 * resolves it through the index instead (see `library.readSidecar`).
 */
export async function listRevisionsOnDisk(
  libraryRoot: string,
  captureId: string
): Promise<string[]> {
  if (!isCaptureId(captureId)) return []
  let entries: string[]
  try {
    entries = await fs.readdir(captureDir(libraryRoot, captureId))
  } catch {
    // No capture directory yet is the normal case, not an error.
    return []
  }

  const found: Array<{ n: number; name: string }> = []
  for (const name of entries) {
    const n = parseRevision(name)
    // A `.tmp-v3` entry parses as null and is skipped here — that is the whole
    // point of the naming: an interrupted write is not a revision.
    if (n === null) continue
    if (await exists(sidecarPath(libraryRoot, captureId, name))) found.push({ n, name })
  }
  return found.sort((a, b) => a.n - b.n).map((f) => f.name)
}

/**
 * The next free revision.
 *
 * `atLeast` lets the caller fold in what the *index* believes, so a revision can
 * never be reused even if the on-disk directory was manually removed while the
 * index still points at it.
 */
export async function nextRevision(
  libraryRoot: string,
  captureId: string,
  atLeast = 0
): Promise<string> {
  const onDisk = await listRevisionsOnDisk(libraryRoot, captureId)
  const highest = onDisk.reduce((max, r) => Math.max(max, parseRevision(r) ?? 0), 0)
  return formatRevision(Math.max(highest, atLeast) + 1)
}

/**
 * Assembles a revision in a staging directory and publishes it with one rename.
 *
 * Validated with the *strict* parser: this is the last point at which we control
 * the bytes, so an unknown or mistyped field is a failure here rather than a
 * surprise for every future reader.
 */
export async function writeRevisionAtomically(
  libraryRoot: string,
  captureId: string,
  revision: string,
  sidecar: Sidecar,
  files: RevisionFile[] = []
): Promise<string> {
  if (!isCaptureId(captureId)) throw new Error('invalid capture id')
  if (parseRevision(revision) === null) throw new Error(`invalid revision: ${revision}`)

  if (sidecar.capture_id !== captureId) {
    // A sidecar filed under someone else's id is how a redaction silently ends
    // up attached to the wrong capture.
    throw new Error(
      `sidecar.capture_id (${sidecar.capture_id}) does not match the capture it is being written to (${captureId})`
    )
  }

  const validated = parseSidecarStrict(sidecar)
  if (!validated.ok) throw new Error(`sidecar failed DC-4 validation: ${validated.error}`)

  const target = revisionDir(libraryRoot, captureId, revision)
  if (await exists(target)) {
    // DC-6: a revision is written once. Overwriting one would be exactly the
    // in-place mutation the contract forbids.
    throw new Error(`revision ${revision} already exists for capture ${captureId}`)
  }

  const staging = tmpRevisionDir(libraryRoot, captureId, revision)
  // A leftover staging directory is debris from an earlier crash, and it was
  // never visible to any reader — clearing it is safe.
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })

  try {
    const seen = new Set<string>()
    for (const file of files) {
      if (!isSafeRelPath(file.path)) throw new Error(`unsafe sidecar file path: ${file.path}`)
      if (seen.has(file.path)) throw new Error(`duplicate sidecar file path: ${file.path}`)
      seen.add(file.path)
      await writeFileSynced(join(staging, file.path), file.contents)
    }

    await writeFileSynced(
      join(staging, sidecarFileName(revision)),
      `${JSON.stringify(validated.value, null, 2)}\n`
    )
    await syncDirectory(staging)

    // The publish. Everything above this line is invisible; everything below it
    // is complete.
    await fs.rename(staging, target)
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }

  return revision
}

/**
 * Reads one revision.
 *
 * Returns the raw parsed JSON after validation rather than the parser's output,
 * so unknown fields (DC-6) survive by construction and not by trusting zod's
 * catchall to stay enabled at every nesting level.
 */
export async function readRevision(
  libraryRoot: string,
  captureId: string,
  revision: string
): Promise<SidecarRead> {
  const path = sidecarPath(libraryRoot, captureId, revision)
  const raw = await fs.readFile(path, 'utf-8')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`sidecar ${captureId}/${revision} is not valid JSON`)
  }

  const version = (parsed as { schema_version?: unknown } | null)?.schema_version
  const compat = checkCompatibility(version)
  if (compat.status === 'incompatible' || compat.status === 'unparseable') {
    throw new Error(`cannot read sidecar ${captureId}/${revision}: ${compat.reason}`)
  }

  const result = parseSidecar(parsed)
  if (!result.ok) {
    throw new Error(`sidecar ${captureId}/${revision} failed DC-4 validation: ${result.error}`)
  }
  return result.value
}
