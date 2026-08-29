# Changelog — Nawi

## 2026-08-29 — README "Installing and first run" verified and rewritten

Per-OS install/first-run docs (Tier 3: an external user acts on them unattended).
Verified against `src/main/permissions.ts`, `src/main/index.ts`,
`src/renderer/lib/recorder.ts`, `src/renderer/components/CaptureView.tsx`,
`electron-builder.yml`, `package.json`.

Corrected in the draft:
- "Nawi detects the granted-but-not-relaunched state" — **false**.
  `relaunchMayBeRequired` is `platform === 'darwin'`, a static flag
  (`permissions.ts:65`). The Relaunch button shows on every macOS card.
- "mic/webcam prompted when first enabled" — actually prompted **on pressing
  Record** with the track ticked, before the countdown (`recorder.ts:227-228`).
- "degrades to video-only" on mac/Linux understates it: the system-audio track
  defaults **on** (`CaptureView.tsx:46`), so the user sees a track error,
  "System audio is not available on this platform." (`recorder.ts:293`).
- Windows "capture works immediately" reframed: no per-app grant exists, but
  capture can still fail on driver / remote session / group policy.

### Discrepancies open for qa-engineer
1. UX-PRM.3 ("detect the granted-but-relaunch-needed state") is **not
   implemented** — platform flag only.
2. A screen-permission failure during **recording** never raises the recovery
   card; `onFailed` only `console.error`s (`src/renderer/recorder.tsx:33-35`) and
   App toasts (`App.tsx:157`). Only screenshot failures route to
   `onCaptureFailed`. This is the dead-end UX-PRM.2 forbids.
3. User-facing recovery-card copy still says **"Aperture"**, the pre-rename
   product name (`PermissionRecovery.tsx:43,52,63` + footnote :47).
4. Card reachability unverified: it renders only for screen status
   denied/restricted/unknown (`CaptureView.tsx:96-101`). `not-determined` (a real
   value, `permissions.ts:48`) falls through to a toast — likely the first-ever
   macOS attempt. Windows behaviour depends on what
   `getMediaAccessStatus('screen')` returns there, which nothing pins.

### Untestable here — do not re-attempt blindly
No macOS or Linux machine available. Unverifiable by reading: the Gatekeeper
"Nawi is damaged" string (asserted in `electron-builder.yml:77-82`), the
`xattr -dr com.apple.quarantine` remedy, AppImage `chmod +x`, and any
Wayland-portal / X11 prompting behaviour. The README now avoids asserting the
Wayland/X11 claim rather than repeating the draft's version of it.

### Stale-doc risk to watch (§6 structural cause)
Source-line citations inside user-facing install steps rot on the next refactor
and the reader has no source tree anyway. Citations were pushed into Known gaps
and this file; keep the install steps free of them.

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
