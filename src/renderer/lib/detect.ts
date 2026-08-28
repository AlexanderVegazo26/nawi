/**
 * UX-ANN.3 — the pre-redaction seam.
 *
 * >>> THERE IS NO DETECTOR YET. <<<
 *
 * FR-AI.2/FR-AI.3 (OCR + pixel classification) are not built, and the detection
 * itself belongs in the main process, not here. This module is the *shape* of
 * the hole so that the editor UI — the chip, the list, the named-risk revert
 * confirmation — is real, exercised code today rather than a thing to be added
 * "when detection lands".
 *
 * `detectSensitiveRegions` returns `[]` unconditionally, and deliberately does
 * not fabricate findings: a fake detection in a production path would put a
 * black box over the user's image for no reason and teach them to distrust the
 * feature. Tests supply their own regions through `toRedactions`.
 *
 * ---------------------------------------------------------------------------
 * HOW A DETECTOR ATTACHES
 *
 * 1. main gains `detectSensitiveRegions(itemId): Promise<IpcResult<SensitiveRegion[]>>`
 *    on `NawiApi` (owned by the IPC/main side, not by this file).
 * 2. Replace the body below with that call. Nothing else changes: the editor
 *    already handles the loading, empty, error and populated states, and
 *    already maps regions to shapes via `toRedactions`.
 * 3. `label` must be a concrete noun phrase — "an API key", "an email address" —
 *    because PRD-002 §9 requires the revert confirmation to name the risk, and
 *    that copy is built from this string verbatim.
 * ---------------------------------------------------------------------------
 */

import type { Rect, RedactShape } from '@shared/types'

/** One region a detector believes should not be shared. */
export interface SensitiveRegion {
  /** Stable within one detection pass; becomes the shape id. */
  id: string
  /** Image-pixel space, like every other coordinate in the annotation model. */
  rect: Rect
  /**
   * Concrete noun phrase naming what is exposed if this is reverted, e.g.
   * "an API key". Rendered directly into user-visible copy — see §9.
   */
  label: string
  /** 0..1. Surfaced so a low-confidence auto-redaction can be labelled as such. */
  confidence: number
}

/** What the editor asks the detector about. */
export interface DetectInput {
  itemId: string
  width: number
  height: number
}

export type DetectionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; regions: SensitiveRegion[] }
  | { status: 'error'; message: string }

/**
 * Returns the regions that must be redacted before the user sees the image.
 *
 * Today: always empty, because no detector exists. See the header — this is the
 * seam, not a stub pretending to be a feature.
 */
export async function detectSensitiveRegions(_input: DetectInput): Promise<SensitiveRegion[]> {
  return []
}

/** True when the current build actually has a detector behind the seam. */
export const DETECTOR_AVAILABLE = false

/**
 * Converts detector output into redaction shapes.
 *
 * Solid, not blur: an automatic redaction the user has not inspected is the
 * last place to use a reversible transform. `auto` marks it as machine-placed,
 * which is what drives the chip, the list, and the revert confirmation.
 */
export function toRedactions(regions: SensitiveRegion[], strokeWidth = 4): RedactShape[] {
  return regions.map((r) => ({
    id: r.id,
    kind: 'redact' as const,
    x: r.rect.x,
    y: r.rect.y,
    width: r.rect.width,
    height: r.rect.height,
    color: '#000000',
    strokeWidth,
    mode: 'solid' as const,
    auto: { label: r.label, confidence: r.confidence }
  }))
}

/**
 * The chip's copy. UX-ANN.3's acceptance quotes "2 items redacted automatically"
 * exactly, so the singular/plural split is part of the requirement, not styling.
 */
export function redactionChipLabel(count: number): string {
  return count === 1
    ? '1 item redacted automatically'
    : `${count} items redacted automatically`
}

/**
 * The revert confirmation body. PRD-002 §9: name the risk concretely — never
 * "Are you sure?".
 */
export function revertWarning(label: string): string {
  return `This will expose ${label} in the shared image.`
}
