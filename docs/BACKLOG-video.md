# Video editing backlog

Queued video-editor work, in dependency order. Created 2026-08-29.

Gap analysis was benchmarked against Competitor A, an open-source NLE
and another open-source NLE. Both references are MLT+FFmpeg NLEs, so most of
their surface (multi-track compositing, colour grading, chroma key, keyframable filter graphs,
proxy editing, EDL, VST hosting) is deliberately **not** a goal for a capture tool. What follows is
the filtered set that fits.

## Structural context

Our whole video stack is `MediaRecorder` (`src/shared/recording.ts` documents the deliberate
"no ffmpeg, no WebCodecs, no native modules" stance for *recording*). Every item below is bounded
by what replaces that for *export*. VEX (below) is settling this; items marked **blocked on VEX**
should not start until it does, or they will each re-litigate the same decision.

---

## VEX — Video export pipeline — IN PROGRESS, NOT MERGED

Trim in/out, export control (format/resolution/bitrate), animated GIF, speed change,
frame-stepping + J-K-L transport. Requirements in `docs/DRAFT-video-export-VEX.md`; design
decisions in `.claude/memory/nawi/designs/video-export-VEX.md`.

**Status: NO-GO.** Two conflicting unmerged candidates exist as git worktrees
(`worktree-wf_84e8e7ae-c95-4`, `-5`). `-4` is renderer-only with a port abstraction but no path to
disk; `-5` has the main-process disk path and the dependency decision but no port. Acceptance
evidence AE-VEX.1–.4 was **never produced** — the WebCodecs encode path has not executed once.

Open before anything else here proceeds:
- Consolidate onto `-5`, port `-4`'s scrub bar.
- `mediabunny` is MPL-2.0 and bundles into the renderer chunk; §3.2 source-availability and §3.4
  notice obligations are unaddressed.
- No ffmpeg/ffprobe on the dev machine, so no output duration can currently be measured.

---

## VEX-ADJ — Audio waveform in the scrub bar

Draw the audio envelope along the trim scrub bar. This is how a user finds the silence to trim to;
another open-source NLE and an open-source NLE both show it on the clip.

- Same component as the VEX scrub bar — cheapest while that component is still being built.
- Feasible on the current stack via `AudioContext.decodeAudioData` over the recording's audio,
  downsampled to per-pixel peaks. No new dependency expected.
- **Blocked on VEX** only in the sense that it should land in the same component, not before it.

## STILL — Extract a still frame from video

Grab the current frame as an image and hand it to the existing screenshot annotation editor.

- Genuinely independent of the export pipeline — `canvas.drawImage` off the `<video>` element.
- Highest value-to-effort item on this list, and it bridges video into the annotation tooling we
  already have.
- **Not blocked on VEX.**

## AUD — Audio post-processing

Whole-track mute, volume, and fade in/out on an existing recording.

**Known constraint, verified — do not write an acceptance criterion that ignores it:**
`src/renderer/lib/recorder.ts:324` sums mic and system audio into one
`MediaStreamAudioDestinationNode` *before* `MediaRecorder` sees it. The recorded file therefore has
a **single** audio track. Whole-track operations are achievable from the file. "Duck the mic" or
"remove system audio, keep narration" is **not recoverable** — that requires changing the recorder
to emit separate tracks, which is a recorder change with backward-compatibility implications for
every recording already on disk.

- **Blocked on VEX** (needs the re-encode path).

## CAP — Auto-captions from speech

Generate captions/subtitles from narration, with an editor to correct them. another open-source NLE does this via
Whisper. For narrated screen demos this is the most differentiating item on the list — it is what
a browser-based recorder and current Competitor A lead with.

**Unresolved decision, and it is a privacy decision before it is a technical one:** a local model
(large binary payload, offline, no data leaves the machine) versus a cloud transcription API
(small, better accuracy, but ships the user's screen-recording audio to a third party). For a tool
whose codebase already carries a redaction gate for captured HAR data
(`src/main/harvest/redaction.gate.test.ts`), quietly defaulting to cloud upload would contradict a
stance the project already takes elsewhere. Decide explicitly; do not let it default.

Secondary: caption burn-in vs. sidecar `.srt`/`.vtt` is a separate question, and burn-in is
**blocked on VEX**.

## JOIN — Joining clips

Combine multiple recordings into one output. Competitor A has this ("combine").

- The only item that changes the model from one-input-one-output to N-inputs. Sequence it last.
- **Blocked on VEX.**

---

## Considered and deferred

Surfaced during the an open-source NLE/another open-source NLE comparison, judged real but lower priority:

- **Blur/pixelate a region for redaction**, optionally motion-tracked to follow a moving element.
  On-brand — the codebase already redacts captured HAR data but has nothing for video pixels.
- **Zoom/pan keyframes (Ken Burns / zoom-to-cursor).** The headline Competitor B screen-demo feature.
- **Background/queued rendering** rather than blocking the UI. Matters much more if export turns
  out to be slow.
- **Markers / chapters**, **freeze-frame**.

## Out of scope

Video annotation and video crop are gated off today (`EditorView.tsx:922-1146`) and are tracked
separately from this list. Multi-track compositing, transitions, colour grading, LUTs, chroma key,
the audio mixer, proxy editing, HDR, VST hosting, MLT project XML, EDL, batch encoding — not goals.
