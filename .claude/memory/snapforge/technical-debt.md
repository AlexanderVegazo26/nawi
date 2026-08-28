# Technical debt — Nawi

## 2026-08-28 — Annotation editor (M1b)

### Sensitive-region detector seam is unfilled (UX-ANN.3)
`src/renderer/lib/detect.ts` defines the contract and returns `[]` unconditionally;
`DETECTOR_AVAILABLE === false`. The editor's chip, list and named-risk revert
confirmation are real and exercised (via a saved document containing auto
redactions), but the **loading and error states are implemented and never
reached in this build** — the loading chrome is deliberately gated on
`DETECTOR_AVAILABLE` so it does not flash on every editor open for a call that
can only return nothing. Filling the seam (FR-AI.2/3, main-process OCR/pixel
detection) makes both states live; re-test them then.

### Key map: `X` (redact) and `M` (magnifier) are unratified
PRD-002 UX-ANN.1 lists `A R E T N B P C S` and assigns no key to solid
redaction (required by FR-ANN.3) or to the magnifier inset (FR-ANN.5).
`src/renderer/lib/tools.ts` picks `X` and `M` and records the reasoning in a
block comment; `src/renderer/lib/tools.test.ts` locks the whole map.
**Needs a `product-analyst` decision to amend UX-ANN.1.** `V` (select) and `H`
(highlighter) are retained from the shipped build — the PRD leaves both
unassigned, so they are additions rather than contradictions.

### Redaction is solid-only, by decision
`RedactShape.mode` is the one-member union `'solid'`. Blur- and pixelate-mode
redactions were designed and then removed: they are transforms of the original
values, so they cannot satisfy FR-ANN.3's "the underlying pixels must not exist
in the exported artifact", and shipping them under a shield glyph would be the
exact confusion UX-ANN.4 exists to prevent. Decorative blur and pixelate remain
as their own tools, labelled as decorative. Revisit only if a destructive
non-solid mode is actually specified.

### Canvas colours must not be tokenised
Everything `src/renderer/lib/render.ts` draws becomes pixels in the user's
exported file, so it uses fixed literals, never `cssVar()`. Routing them through
theme tokens would make the same document export differently in dark and light
mode. `e2e/annotation.spec.ts` asserts byte-identical exports across both
themes; `cssVar` belongs only on editor-only overlays (selection ring, crop dim).

## 2026-08-28 — PRD-002 conformance pass: what was left open

- **UX-STA.6 ("No structured data available for this surface") is not
  implemented.** There is no state-panel surface in `src/renderer/**` for it to
  attach to — nothing in the renderer reads a sidecar. The requirement needs the
  state panel to exist first; building the empty-state component alone would be a
  component with no consumer.
- **UX-CAP.5 vs UX-A11Y.2 conflict is unresolved in the spec.** Both claim the
  `Shift` modifier ("Shift+arrow = 10 px" vs "Shift+arrow = resize"). Implemented
  as arrows = move 1 px, Shift+arrow = move 10 px, Ctrl+arrow = resize (reusing
  the modifier the shipped overlay already used, so nothing new was invented).
  Documented in `src/renderer/lib/nudge.ts`. Needs a ux-designer decision.
- **UX-PRM.2/3 cannot be validated on this machine.** Windows has no per-app
  screen-recording grant and `systemPreferences.getMediaAccessStatus('screen')`
  cannot report a denial there, so the recovery card is driven by an actual failed
  capture rather than by permission status. The macOS branch — including the
  verbatim §4 copy and the UX-PRM.3 relaunch offer — is unit-tested for copy but
  has never been executed against a real TCC denial.
- **P5 undo is implemented for delete only.** Discard (`discardRecoverableRecording`)
  and overwrite still have no undo toast.
- **The 30-second undo toast overlaps subsequent interactions.** It is bottom-right,
  `pointer-events-auto`, and outlives a view change into the Editor. It already
  made one pre-existing E2E locator ambiguous. Whether it visually obscures Editor
  controls is unassessed.
