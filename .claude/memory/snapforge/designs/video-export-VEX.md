# Design decisions — Video export & trim (VEX)

Owner: ux-designer. Date: 2026-08-28. Resolves DEC-VEX.5 and DEC-VEX.6.
Requirement IDs are stable and published; nothing below edits UX-VEX.1-5 in place.

## DEC-VEX.5 — RESOLVED 2026-08-28 (ux-designer)

- Shuttle ladder (UX-VEX.6): L = forward 1x, 2x, 4x, 8x on repeated presses,
  clamped at 8x. J = reverse-scrub 1x, 2x, 4x, 8x, clamped. K = pause and reset
  the ladder to 1x. Pressing the opposite key from a shuttling state resets to
  1x in the new direction rather than stepping down the ladder.
  Reverse is a rAF-driven `currentTime` decrement, not a negative
  `playbackRate` (unsupported in Chromium) — hence UX-VEX.2's "or
  reverse-scrubs" wording is taken.
- Frame step (UX-VEX.7): `,` back / `.` forward (Premiere/Resolve convention);
  ArrowLeft/ArrowRight equivalent while the scrub bar has focus;
  Shift+Arrow = 1 second. Arrows are free on video items because the annotation
  tool rail is not mounted for them (EditorView.tsx:935).
- Marker treatment (UX-VEX.8): in/out are bracket-shaped flag chips on an opaque
  backing chip; playhead is a full-height line with a round handle. Shape, not
  colour, carries the distinction.

## DEC-VEX.6 — RESOLVED 2026-08-28 (ux-designer)

- Surface: a modal dialog ("Export video"), reusing `Modal` from ui.tsx — an
  inline panel would require restructuring EditorView.tsx, forbidden by NG-VEX.6.
- Defaults: format = source container; resolution = "Same as source";
  bitrate = "Same as source"; speed = 1x. GIF defaults: 480 px wide (aspect
  preserved), 10 fps.
- Consequence: transport and frame-step keys are suppressed while the dialog is
  open. The existing window-level keydown listener (EditorView.tsx:795) has no
  modal awareness; this is a real gap, not an assumption.

## Findings raised to other owners

- `typing` guard (EditorView.tsx:799-800) covers INPUT/TEXTAREA/contentEditable
  but NOT `SELECT`. The export dialog introduces selects; bare J/K/L would fire
  from a focused dropdown. Guard must be widened for UX-VEX.3 to hold.
- Frame step needs the source's real frame rate. `HTMLVideoElement` exposes
  none; a hardcoded 1/30 silently fails on 24 fps and VFR sources. Flagged to
  solution-architect against DEC-VEX.1/DEC-VEX.7.
- Cancel is unspecified by FR-VEX.11 and excluded by no NG-VEX. Flagged as a
  gap to product-analyst; it interacts with FR-VEX.12 (no partial file).

## Hypotheses to check after ship

- H-VEX.1: the 1/2/4/8 ladder is sufficient; no user asks for a slower shuttle.
- H-VEX.2: "Same as source" defaults mean most users never open the resolution
  or bitrate controls. If most users change them, the defaults are wrong.

## Prior open ux-designer decision, still open

technical-debt.md records UX-CAP.5 vs UX-A11Y.2 conflicting over the `Shift`
modifier. Untouched here — VEX uses Shift+Arrow only on the video scrub bar,
where no nudge/resize binding exists.
