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
 * `seal.ts` is unnameable elsewhere).
 *
 * ## What is and is not enforced — precisely
 *
 * An earlier version of this comment claimed "nothing unsealed reaches disk" is
 * checked by the compiler on every call site. **That was false**, and a security
 * review found the hatch already in use. Accurately:
 *
 * **Enforced by the compiler.** You cannot call `writeSealedRevision` without a
 * `SealedRevision`, and you cannot fabricate one: the `sealed` brand is a
 * `unique symbol` declared inside `seal.ts` and exported only as part of a type,
 * so no other module can name it or produce a value carrying it. The side files
 * ride inside the same container as the branded sidecar, so a caller also cannot
 * pair a sealed sidecar with unscanned files.
 *
 * **Not enforced — the one real hatch.** `writeSealedRevision` is not the only
 * route to `writeRevisionAtomically`. `library.ts`'s `saveSidecarRevision`
 * accepts a plain `Sidecar` and calls the store directly, and
 * `mcp/tools.ts` (the `annotate` path) reaches it with an
 * `as Parameters<typeof library.saveSidecarRevision>[1]` cast. So the invariant
 * holds on *this* path by type and on that path only by convention.
 *
 * **Why it is not simply closed, since the next reader will ask.** Narrowing
 * `saveSidecarRevision` to `SealedSidecar` requires routing `annotate` through
 * `seal()`, and `seal()` throws on non-string contents by design. `annotate`
 * carries files forward via `mcp/revision.ts`'s `carryForwardFiles`, which reads
 * them as `Uint8Array` precisely so a HAR or DOM snapshot is copied byte-exact
 * rather than re-encoded through a string. Unifying the paths therefore needs a
 * deliberate binary-content policy in `seal()` first — whether carried-forward
 * bytes from an already-sealed revision may pass through unscanned, and how that
 * is recorded in the report. That is a shared-contract decision spanning
 * `library.ts` and the MCP tools, which this milestone's harvest work does not
 * own; it is filed for `solution-architect`.
 *
 * **Why it is not exploitable today.** `annotate`'s carried-forward files come
 * out of a revision that was already sealed, so no unscanned content is
 * introduced — the bytes were scanned when they were first written. The seam is
 * an integrity gap in the invariant, not a live leak.
 *
 * Callers must still route through here rather than calling
 * `writeRevisionAtomically` directly. That remains a convention; the plan pairs
 * it with an ESLint `no-restricted-imports` ban, which is the right belt for
 * this brace and is not yet in place.
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
