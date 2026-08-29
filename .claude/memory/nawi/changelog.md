# Changelog — Nawi

## 2026-08-29 — Video trim & export (VEX): documentation attempted, NOT published

Draft: `docs/DRAFT-video-export-VEX.md`. Status DRAFT, not publishable.

- **The feature is not in the shipping tree.** `src/**` has no video-export code.
  Two unmerged worktrees (`.claude/worktrees/wf_84e8e7ae-c95-4`, `-5`) each add
  `VideoEditorPanel.tsx` + a `videoExport` module + an `EditorView.tsx` edit.
  They are competing candidates with different seams, not two halves.
- **Verified and safe to document once merged:** the J/K/L shuttle ladder
  (1/2/4/8, `K` pauses and resets, opposite key resets to 1x in the new
  direction) and `,`/`.` frame stepping with clamping at both ends. Identical in
  both candidates and matching the resolved DEC-VEX.5 design.
- **Unverified, one uniform reason — no exported file has ever been produced:**
  format/resolution/bitrate selection, GIF output, speed change, composition,
  progress/terminal state, no-partial-file. AE-VEX.1–.4 not produced;
  `beginExport`'s native save dialog has no automation injection point.
- **No runbook written.** Tier 3 procedure could not be walked.

### Stale-doc risk to watch (§6 structural cause)

Any user doc that publishes *numeric* export values will drift on the next
decision, not on the next code change: `PROVISIONAL_SPEEDS` (DEC-VEX.4 open) and
the AE-VEX.6 duration tolerance (proposed, unconfirmed). Keep those values in
one referenced place, not inline in prose.

### Untestable here — do not re-attempt blindly

Producing AE-VEX.1–.4 artifacts requires either a human at the native save
dialog or a test-only path-injection hook in main. Also: no MP4 exists in the
local library, so the MP4 demux half of the export input matrix is unverifiable
on this machine.
