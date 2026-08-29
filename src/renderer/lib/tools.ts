import type { ShapeKind } from '@shared/types'

/**
 * The editor's tool set and its single-key bindings.
 *
 * Data only — no icons, no React — so the resolved map is testable in the node
 * test environment and a duplicate binding is a failing test rather than a
 * keystroke that silently picks whichever tool happens to be first.
 */

export type ToolId =
  | ShapeKind
  | 'select'
  | 'crop'
  /** Decorative pixelate. Same `blur` shape as the `blur` tool, different mode. */
  | 'pixelate'

export interface ToolDef {
  id: ToolId
  label: string
  /** Single uppercase letter. */
  key: string
  /** Short description used as the tool's accessible hint. */
  hint: string
}

/* ===========================================================================
 * RESOLVED KEY MAP — UX-ANN.1 vs. the shipped bindings.
 *
 * The divergence recorded in COMPETITIVE-CAPABILITY-MATRIX.md §4.3 is resolved
 * here. Written down so it is not re-litigated.
 *
 * PRD-002 UX-ANN.1 specifies:  A R E T N B P C S
 *   A arrow   R rectangle   E ellipse   T text   N numbered badge
 *   B blur    P pixelate    C crop      S spotlight
 *
 * Shipped before this change:  A R E T H B N C V
 *   ...i.e. A R E T N B C identical to the PRD, plus H highlighter and
 *   V select, and *missing* P and S entirely.
 *
 * Resolution:
 *
 * 1. PRD-002 wins wherever it speaks. `P` now selects a dedicated decorative
 *    pixelate tool (previously folded into `B`, matrix §4.3), and `S` selects
 *    spotlight (previously absent). `A R E T N B C` were already correct.
 *
 * 2. `H` highlighter and `V` select are KEPT as shipped. PRD-002 leaves both
 *    unassigned, so these are additions to the spec rather than contradictions
 *    of it. `V` matches the near-universal convention for a selection arrow
 *    (Figma, Illustrator, Sketch); `H` is the initial of the tool. Neither
 *    collides with a PRD-assigned letter.
 *
 * 3. `X` = REDACT is a genuine gap in PRD-002, not a preference.
 *    FR-ANN.3 requires three obscure modes — blur, pixelate, and solid
 *    redaction — and UX-ANN.4 requires the redaction to be a distinct
 *    affordance, but UX-ANN.1's list assigns a key to only the first two.
 *    A tool the spec mandates and does not key has to be keyed by someone.
 *    `X` was chosen because `R` (rectangle), `S` (spotlight) and `D`
 *    (conventionally "duplicate"/"delete") are taken or risky, and a crossed-out
 *    box is the ordinary redaction mark.
 *    >>> FLAG for product-analyst: UX-ANN.1 should be amended to include a
 *        redaction key. `X` is this implementation's answer, not a ratified one.
 *
 * 4. `M` = MAGNIFIER is the same kind of gap, one requirement earlier.
 *    FR-ANN.5 lists "spotlight/dim, crop, magnifier inset"; UX-ANN.1 keys only
 *    the first two. `M` is the initial and is unclaimed.
 *    >>> FLAG for product-analyst, same as (3).
 *
 * 5. Freehand (FR-ANN.1, P0) is likewise unkeyed by UX-ANN.1 — the whole tool
 *    was missing from the product, which is why nothing conflicted. `F`.
 *
 * Digits 1-8 remain colour swatches and `[` / `]` remain stroke width, so no
 * tool may take a digit or a bracket.
 * ======================================================================== */

export const TOOLS: readonly ToolDef[] = [
  { id: 'select', label: 'Select', key: 'V', hint: 'Pick and move an existing annotation' },
  { id: 'arrow', label: 'Arrow', key: 'A', hint: 'Drag to point at something' },
  { id: 'rect', label: 'Rectangle', key: 'R', hint: 'Drag to outline a region' },
  { id: 'ellipse', label: 'Ellipse', key: 'E', hint: 'Drag to circle a region' },
  { id: 'freehand', label: 'Freehand', key: 'F', hint: 'Draw a freehand line' },
  { id: 'text', label: 'Text', key: 'T', hint: 'Click to place a text callout' },
  { id: 'highlight', label: 'Highlighter', key: 'H', hint: 'Drag to wash over text' },
  { id: 'step', label: 'Step number', key: 'N', hint: 'Click to place a numbered badge' },
  { id: 'blur', label: 'Blur', key: 'B', hint: 'Decorative soft blur — not a redaction' },
  { id: 'pixelate', label: 'Pixelate', key: 'P', hint: 'Decorative pixelation — not a redaction' },
  { id: 'redact', label: 'Redact', key: 'X', hint: 'Remove the pixels from the exported image' },
  { id: 'spotlight', label: 'Spotlight', key: 'S', hint: 'Dim everything outside the region' },
  { id: 'magnify', label: 'Magnifier', key: 'M', hint: 'Enlarge the region in place' },
  { id: 'crop', label: 'Crop', key: 'C', hint: 'Drag to trim the image' }
] as const

/** Bindings PRD-002 UX-ANN.1 states outright, for the conformance test. */
export const PRD_UX_ANN_1: Readonly<Record<string, ToolId>> = {
  A: 'arrow',
  R: 'rect',
  E: 'ellipse',
  T: 'text',
  N: 'step',
  B: 'blur',
  P: 'pixelate',
  C: 'crop',
  S: 'spotlight'
}

/** Keys the editor reserves for non-tool controls; no tool may claim one. */
export const RESERVED_KEYS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '[', ']']

/** Resolves a bare keypress to a tool, or null. Case-insensitive. */
export function toolForKey(key: string): ToolId | null {
  if (key.length !== 1) return null
  const upper = key.toUpperCase()
  return TOOLS.find((t) => t.key === upper)?.id ?? null
}

export function toolById(id: ToolId): ToolDef {
  const t = TOOLS.find((x) => x.id === id)
  if (!t) throw new Error(`unknown tool: ${id}`)
  return t
}
