# DRAFT — Video trim & export (VEX)

Status: **DRAFT / NOT PUBLISHABLE.** Tier 3. Author: technical-writer, 2026-08-29.

**This feature is not in the shipping tree.** `src/**` in the checked-out
repository contains no video-export code. The work exists only in two unmerged
worktrees under `.claude/worktrees/`, which are two *overlapping candidate
implementations*, not two halves of one change. Nothing below may be published
to users until one candidate is merged and re-verified against the merged tree.

---

## 1. Audience and scope

Audience: someone who recorded a screen demo in Nawi and wants to ship part
of it. Scope of this draft: the editor's transport, frame-stepping and trim
interaction only. Export settings (format, resolution, bitrate, speed, GIF) are
**deliberately excluded** — see §4.

## 2. Verified behaviour (read from code; identical in both candidates)

Applies to video library items only; image items are unchanged.

### Transport — J / K / L

| Key | Effect |
|---|---|
| `L` | Play forward. Repeat to shuttle: 1x → 2x → 4x → 8x, clamped at 8x. |
| `J` | Play in reverse (reverse-scrub). Same rungs: 1x → 2x → 4x → 8x, clamped. |
| `K` | Pause, and reset the shuttle back to 1x. |

Pressing the opposite direction key while shuttling resets to **1x in the new
direction** — it does not step down the ladder.

Verified: `wf_84e8e7ae-c95-5/src/shared/videoExport.ts:389-416` and
`wf_84e8e7ae-c95-4/src/renderer/lib/videoExport.ts:93-118`. Both match the
resolved design in `.claude/memory/nawi/designs/video-export-VEX.md`
(DEC-VEX.5, 2026-08-28).

Reverse is implemented as a seek-driven scrub, not negative playback rate —
Chromium does not support the latter. Expect reverse to look like scrubbing.

### Frame stepping

`,` steps one frame back, `.` steps one frame forward. Stepping is clamped at
both ends: at the first frame, back does nothing; at the last, forward does
nothing. Neither wraps nor errors. Verified: `videoExport.ts` `stepFrame`
(candidate `-5`), and the arrow-key table in candidate `-4`.

**Caveat that belongs in user-facing copy:** the step is one *nominal* frame.
Screen recordings are frequently variable-frame-rate, so a step is not
guaranteed to land on the adjacent coded frame. Verified as a measured fact:
on the one real recording in this tree, average packet rate is 7.49 while best-
guess frame rate is 28.57.

### Typing safety

Bare `J`/`K`/`L` do not fire while a text field is focused. Candidate `-4` also
widens the guard to `<select>` and suppresses transport keys while the export
dialog is open; candidate `-5` was not confirmed to do either.

## 3. Bindings that DIVERGE between the two candidates — do not document yet

| Behaviour | Candidate `-4` | Candidate `-5` |
|---|---|---|
| Arrow keys as frame step | only while the scrub bar has focus | while the panel is open |
| `Shift`+Arrow = 1 second | present | absent |
| `I` / `O` set in/out | not present | present |
| Export surface | modal dialog behind an optional `VideoExportPort`; feature inert without it | panel mounted directly, own IPC |

The resolved design (DEC-VEX.5) specifies scrub-bar-scoped arrows and
Shift+Arrow. Candidate `-5` does not implement that. Routed as a discrepancy.

## 4. NOT documented, because it has never produced a file

Unverified — uniform reason: **no exported artifact exists**. AE-VEX.1–.4 were
not produced by either candidate; `beginExport` opens a native
`dialog.showSaveDialog` with no injection point, so the automated path stalls
there; the WebCodecs encode path is unexercised; the IPC export seam is wired on
both sides but no byte has crossed it.

Consequently the following are **claims, not documented behaviour**: output
format selection, output resolution, target bitrate (FR-VEX.5), animated GIF
output (FR-VEX.7/.8), speed multipliers (FR-VEX.9), composition of trim + speed
+ resolution in one export (FR-VEX.10), progress/terminal state (FR-VEX.11), and
no-partial-file on failure (FR-VEX.12 — its filesystem module is unit-tested,
its end-to-end behaviour is not).

478 passing unit tests are evidence about pure functions. They are not evidence
about an exported file, and AE-VEX.0 forbids any oracle other than a measured
file.

Values that are provisional and will drift if published now: `PROVISIONAL_SPEEDS`
(DEC-VEX.4 unanswered) and the AE-VEX.6 duration tolerance (proposed, unconfirmed).

## 5. No runbook

A Tier 3 export procedure cannot be walked here, so none is written. §1.6.

## 6. Discrepancies routed

1. **Two unmerged, incompatible candidates** (`-4` inert-without-port vs `-5`
   self-wired). → merge owner / solution-architect. Blocks all publication.
2. **ADR-0001 names the wrong frame-rate field.** `averagePacketRate` (7.49
   measured) vs `bestGuessFrameRate` (28.57) — user-visible, it sets frame-step
   size. → solution-architect.
3. **Silent 30 fps fallback** in candidate `-5`'s `stepFrame` when frame rate is
   unknown, against the design finding that a hardcoded 1/30 silently fails on
   24 fps and VFR sources. → qa-engineer / solution-architect.
4. **UX-VEX.6/.7/.8 are referenced in code** but the published criteria set only
   defines UX-VEX.1–.5. IDs are stable and published; new IDs need
   product-analyst, not a code comment. → product-analyst.
5. `-4` and `-5` disagree on whether `EditorView.tsx` was dirty at baseline.
   → merge owner.

## 7. Draft release notes (UNRELEASED — do not ship)

No `release-manager` statement of readiness exists for this work.

> ### Unreleased — video trim & export
>
> **Not shipping. The export path has never produced a file.**
>
> Landed in candidate branches only: an in/out trim interaction over a recorded
> video, a J-K-L shuttle transport (1x/2x/4x/8x, `K` pauses), frame stepping with
> `,` and `.`, and the removal of the editor's blanket block on video export.
>
> Not functional: choosing an output format, resolution, bitrate or speed, and
> GIF output. The controls exist; nothing has been observed writing a file with
> those settings applied.
>
> **Required before any of this is announced:** one merged implementation, plus
> AE-VEX.1–.4 artifacts measured per AE-VEX.0.
