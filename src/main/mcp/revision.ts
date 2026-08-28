import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { isSafeRelPath } from '../sidecar/paths'
import { isNdjsonRef } from '@shared/sidecar/types'
import type { SidecarRead } from '@shared/sidecar/types'
import type { RevisionFile } from '../sidecar/store'

/**
 * Carries a sidecar's side files forward into a new revision.
 *
 * **The bug this exists to prevent.** Each revision owns its own directory, and
 * every state-layer reference (`dom/000000.json`, `console.ndjson`, …) is
 * relative to *that* directory. So a new revision that copies the refs but not
 * the files points at paths which do not exist in it — a dangling reference. The
 * tempting shortcut is to null the refs instead, and that is worse: it silently
 * discards the harvested state layer, because the new revision becomes current
 * and nothing points at the old files any more. An agent that annotates a
 * capture and then reads its console log would get `null` back, with nothing
 * anywhere reporting that anything was lost.
 *
 * DC-6 still holds: the previous revision is never touched and stays
 * byte-identical. This copies out of it, it does not move.
 *
 * Deliberately electron-free so the rule is unit-testable against a temp
 * directory rather than only reachable through a launched app.
 */

/** Every state-layer path a sidecar references, relative to its revision directory. */
export function referencedPaths(sidecar: SidecarRead): string[] {
  const paths: string[] = []
  const state = sidecar.state_layer

  for (const ref of [state.dom_snapshot, state.accessibility_tree, state.network_har]) {
    if (ref && typeof ref.path === 'string') paths.push(ref.path)
  }
  for (const ref of [state.console_log, state.input_events]) {
    // An inline array (the DC-4 read shape) has no file to carry.
    if (ref !== null && isNdjsonRef(ref) && typeof ref.path === 'string') paths.push(ref.path)
  }
  // The pixel layer's frames/video/audio live under the library's assets
  // directory, not the revision directory, so they are deliberately not here.

  return [...new Set(paths)]
}

/**
 * Reads every referenced file so it can be republished in the next revision.
 *
 * Throws rather than skipping an unreadable file. A partial carry-forward would
 * publish a revision whose refs are half-valid, and the caller cannot tell which
 * half — failing here keeps the previous revision current and intact.
 *
 * Read as bytes, not text: a HAR or a DOM snapshot is copied verbatim, and
 * decoding it through a string would risk re-encoding it differently.
 */
export async function carryForwardFiles(
  currentRevisionDir: string,
  sidecar: SidecarRead
): Promise<RevisionFile[]> {
  const out: RevisionFile[] = []
  for (const path of referencedPaths(sidecar)) {
    // The path came out of a sidecar file, which a user can hand-edit, so it is
    // re-checked against the same allowlist the writer used.
    if (!isSafeRelPath(path)) {
      throw new Error(`sidecar references an unsafe path and cannot be revised: ${path}`)
    }
    const contents = await fs.readFile(join(currentRevisionDir, path)).catch((err: unknown) => {
      throw new Error(
        `cannot carry ${path} forward into a new revision: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    })
    out.push({ path, contents: new Uint8Array(contents) })
  }
  return out
}
