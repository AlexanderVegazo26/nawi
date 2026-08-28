/**
 * The only door into a capture directory.
 *
 * This module deliberately contains almost no logic. `store.ts` already owns the
 * revisioned, staged, fsynced, single-`rename` write (DC-3/DC-6) and is tested
 * as such; reimplementing any of that here would create a second, less-proven
 * path to the same bytes — which is precisely the thing a chokepoint exists to
 * prevent.
 *
 * What this module adds is the *type*: `writeSealedRevision` accepts only a
 * `SealedRevision`, which is constructible only by `seal()` (the brand symbol in
 * `seal.ts` is unnameable elsewhere). So "nothing unsealed reaches disk" is
 * checked by the compiler on every call site, rather than being a rule someone
 * has to remember at 5pm.
 *
 * Callers must route through here rather than calling `writeRevisionAtomically`
 * directly. That last step is a convention the compiler cannot enforce — the
 * plan pairs it with an ESLint `no-restricted-imports` ban, which is the right
 * belt for this brace.
 */

import { nextRevision, writeRevisionAtomically } from './store'
import type { SealedRevision } from './seal'

export interface WriteResult {
  /** The revision actually written, e.g. `"v1"`. */
  revision: string
  /** Revision-relative paths written alongside the sidecar. */
  files: string[]
}

/**
 * Publishes one sealed revision.
 *
 * `revision` is resolved by the store when not supplied, folding in `atLeast` so
 * a caller holding the library index's view cannot reuse a number that an
 * orphaned directory already claimed.
 */
export async function writeSealedRevision(
  libraryRoot: string,
  sealedRevision: SealedRevision,
  options: { revision?: string; atLeastRevision?: number } = {}
): Promise<WriteResult> {
  const { sidecar, files } = sealedRevision
  const captureId = sidecar.capture_id

  const revision =
    options.revision ?? (await nextRevision(libraryRoot, captureId, options.atLeastRevision ?? 0))

  // `writeRevisionAtomically` re-validates with the strict parser and rejects a
  // capture_id mismatch. Both are load-bearing and neither is duplicated here.
  await writeRevisionAtomically(libraryRoot, captureId, revision, sidecar, [...files])

  return { revision, files: files.map((f) => f.path) }
}
