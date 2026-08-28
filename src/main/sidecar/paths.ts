import { join } from 'node:path'

/**
 * Path construction for the revisioned sidecar store — pure, so the rules can be
 * unit-tested without touching a disk or booting Electron.
 *
 * Everything here treats its inputs as hostile. A capture id reaches this module
 * from the renderer over IPC and a revision string can come from an index file a
 * user hand-edited; both end up as path segments, so both are matched against an
 * anchored allowlist before they are joined to anything.
 */

/** Same control as `library.ts`'s `UUID_RE`. Deliberately not widened — see ADR-001. */
export const CAPTURE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `v1`, `v2`, … Never `v0`, never `v01`, never anything with a separator in it. */
export const REVISION_RE = /^v([1-9]\d*)$/

/** Control characters: not filenames, and several of them truncate a path outright. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 32 || code === 127) return true
  }
  return false
}

export function isCaptureId(value: string): boolean {
  return CAPTURE_ID_RE.test(value)
}

/** Revision number, or null when the string is not a well-formed revision. */
export function parseRevision(value: string): number | null {
  const m = REVISION_RE.exec(value)
  return m ? Number(m[1]) : null
}

export function formatRevision(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`revision must be a positive integer, got ${n}`)
  }
  return `v${n}`
}

/**
 * Relative paths written *inside* a revision directory (`dom/000000.json`,
 * `console.ndjson`). Rejects anything that could escape the directory or resolve
 * differently on another platform.
 */
export function isSafeRelPath(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false
  // Backslashes, drive letters, UNC and absolute forms all resolve outside the
  // directory on at least one supported platform.
  if (/[\\:]/.test(value)) return false
  if (value.startsWith('/')) return false
  if (hasControlChars(value)) return false
  const segments = value.split('/')
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..')
}

export function capturesRoot(libraryRoot: string): string {
  return join(libraryRoot, 'captures')
}

export function captureDir(libraryRoot: string, captureId: string): string {
  if (!isCaptureId(captureId)) throw new Error('invalid capture id')
  return join(capturesRoot(libraryRoot), captureId)
}

/**
 * A revision's directory. Each revision owns its own, which is what makes the
 * whole thing land with a single `rename` — see ADR-001 for why the sidecar file
 * lives one level deeper than the milestone plan's sketch.
 */
export function revisionDir(libraryRoot: string, captureId: string, revision: string): string {
  if (parseRevision(revision) === null) throw new Error(`invalid revision: ${revision}`)
  return join(captureDir(libraryRoot, captureId), revision)
}

/** The staging directory a revision is assembled in before its single rename. */
export function tmpRevisionDir(libraryRoot: string, captureId: string, revision: string): string {
  if (parseRevision(revision) === null) throw new Error(`invalid revision: ${revision}`)
  return join(captureDir(libraryRoot, captureId), `.tmp-${revision}`)
}

export function sidecarFileName(revision: string): string {
  if (parseRevision(revision) === null) throw new Error(`invalid revision: ${revision}`)
  return `sidecar.${revision}.json`
}

export function sidecarPath(libraryRoot: string, captureId: string, revision: string): string {
  return join(revisionDir(libraryRoot, captureId, revision), sidecarFileName(revision))
}

/** Resolves a caller-supplied relative path inside a revision directory. */
export function resolveInRevision(
  libraryRoot: string,
  captureId: string,
  revision: string,
  relPath: string
): string {
  if (!isSafeRelPath(relPath)) throw new Error(`unsafe sidecar file path: ${relPath}`)
  return join(revisionDir(libraryRoot, captureId, revision), relPath)
}
