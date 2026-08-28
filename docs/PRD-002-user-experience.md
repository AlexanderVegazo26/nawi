# PRD-002 — Aperture: User Experience Requirements

> **Status:** Draft v1.0
> **Companion doc:** `PRD-001-core-capture-platform.md` (functional scope, data contracts, build order)
> **Consumers:** Claude Code agents, design, frontend engineering

---

## 0. How agents should use this document

1. UX requirements are identified as `UX-<area>.<n>`. They inherit the same P0/P1/P2 priorities and milestone mapping as PRD-001.
2. This document is **authoritative for interaction, layout, states, copy, and accessibility**. Where it conflicts with an implementer's instinct about "how apps usually work," follow this document.
3. Do not ship a screen without its empty, loading, error, and permission-denied states. A screen with only its happy path is not done.
4. All copy in this document is normative. Use it verbatim unless a localization or brand review supersedes it.
5. Consult `/mnt/skills/public/frontend-design/SKILL.md` before implementing any UI surface.

---

## 1. Experience principles

These are the tiebreakers. When two designs are defensible, the one that better serves a higher-numbered principle wins.

**P1 — The capture never waits for the product.**
The moment between intent and captured pixels is the entire product. Uploads, AI passes, and sync happen after, never before. If the user has the image on their clipboard in 400 ms and the app crashes at 401 ms, we still succeeded.

**P2 — Structure is invisible until it is needed.**
The state layer is the differentiator, but a support agent grabbing a screenshot should never see the words "accessibility tree." Surface structure only where it changes what the user can do: element-aware selection, the agent panel, the healing view, the export dialog.

**P3 — Redaction is the default posture, not a feature.**
Detected sensitive data is redacted *before* the share sheet opens, and the user un-redacts deliberately. We would rather annoy someone with an over-eager blur than leak a customer's card number.

**P4 — Nothing generated is silently authoritative.**
Auto-narration, auto-healed steps, generated alt text, emitted test scripts — all are visibly marked as generated, all are editable, and none are published without a human pass. AI output that looks like human output is a trust bug.

**P5 — Every destructive act is reversible for 30 seconds.**
Delete, discard, overwrite, publish. Undo toast, always.

**P6 — The keyboard is a first-class input device.**
A power user should never touch the mouse except to select a region.

---

## 2. Information architecture

```
Aperture
├── Capture layer (OS-level, no window)
│   ├── Hotkey overlay          — region select, element select, mode switcher
│   ├── Recording HUD           — floating, draggable, minimal
│   └── Menu bar / tray         — quick actions, ring buffer toggle, recent 5
│
├── Editor (opens post-capture, local-first)
│   ├── Canvas                  — image or video
│   ├── Tool rail               — annotate, redact, crop, trim
│   ├── Inspector               — properties of the selected annotation
│   └── State panel (collapsed) — console, network, elements, agent trace
│
├── Library (web + desktop)
│   ├── Grid / list of captures
│   ├── Search (semantic + filters)
│   ├── Folders, tags, collections
│   └── Capture detail → Editor, Share, Guide, Export
│
├── Guides
│   ├── Guide list
│   ├── Step editor             — reorder, merge, split, retitle
│   ├── Health view             — ok / changed / broken per step
│   └── Export dialog
│
├── Agent console
│   ├── MCP connection status + tool call log
│   ├── Agent trace timeline (synced to a recording)
│   └── Approval queue          — agent-proposed annotations/redactions
│
└── Settings
    ├── Hotkeys, capture defaults, output
    ├── Privacy — masked apps, redaction rules, local-only mode
    ├── Brand kit
    ├── Integrations
    └── Workspace & members
```

**UX-IA.1 (P0):** Depth limit — no primary task requires more than 3 levels of navigation from the app root.
**UX-IA.2 (P0):** The Editor is reachable directly from a capture without passing through the Library.
**UX-IA.3 (P1):** The state panel is collapsed by default for personas Marcus and Priya, expanded by default for Ana and Rita (role-based default, user-overridable).

---

## 3. Core flows

### 3.1 Flow A — Instant capture (the 3-second path)

```
Hotkey → freeze + dim overlay → drag or click element → release
      → image on clipboard (< 800 ms total)
      → toast: "Copied. ⌘E to edit · ⌘⇧S to share"
      → toast dismisses after 5 s
```

**UX-CAP.1 (P0):** The overlay appears within 120 ms of the hotkey. If capture-source acquisition is slower, show the frozen frame immediately and acquire behind it.
**UX-CAP.2 (P0):** Escape cancels at any point with no artifact created and no toast.
**UX-CAP.3 (P0):** During region drag, display live dimensions in device pixels adjacent to the cursor, positioned to never leave the screen edge.
**UX-CAP.4 (P0):** Element-aware mode is entered by pressing `Space` during selection, not by a separate hotkey. The highlight animates in under 80 ms and shows the element's role and accessible name in a small label.
**UX-CAP.5 (P0):** Magnifier with per-pixel crosshair on arrow-key nudge; arrow keys move the edge by 1 px, `Shift`+arrow by 10 px.
**UX-CAP.6 (P1):** The last-used region is recallable with `R` during overlay; the region outline appears as a dashed ghost.
**UX-CAP.7 (P1):** If a masked application (FR-SEC.3) is inside the selection, its area renders as a solid black block **in the overlay itself**, so the user sees the masking before capturing, not after.

**Acceptance — UX-CAP.7**
```
GIVEN 1Password is configured as a masked app and is visible on screen
WHEN the user presses the capture hotkey
THEN the 1Password window region is rendered solid black in the selection overlay
AND a small label reads "Masked by workspace policy"
```

### 3.2 Flow B — Record and share

```
Hotkey/tray → source picker (screen / window / region) + track toggles
           → 3-2-1 countdown (skippable, remembered per user)
           → Recording HUD appears
           → [record] ... [⌘⇧M chapter marker] ... [stop]
           → Editor opens with the video, trimmed to remove pre-roll
           → share link available immediately, processing continues in background
```

**UX-REC.1 (P0):** The HUD occupies ≤ 220×64 px, is draggable, snaps to screen edges, and is excluded from the recording.
**UX-REC.2 (P0):** The HUD shows elapsed time, a live audio level meter per active track, pause, stop, and chapter marker. Nothing else.
**UX-REC.3 (P0):** A recording indicator is visible even when the HUD is minimized (tray badge + menu bar dot, red, animated).
**UX-REC.4 (P0):** Stopping produces a share link within 2 seconds, before transcoding, transcription, or OCR complete. The link page shows a progressive state: playable video first, transcript and chapters appearing as they finish.
**UX-REC.5 (P1):** If the mic level reads silent for the first 10 seconds, show a non-blocking HUD warning: *"Mic isn't picking anything up."* — with a one-click source switch. Never auto-stop the recording.
**UX-REC.6 (P1):** Ring buffer state is always legible: when armed, the tray icon shows a subtle ring; hovering reads *"Last 2 minutes ready to save."*

**Acceptance — UX-REC.4**
```
GIVEN a 12-minute recording has just stopped
WHEN the user clicks "Copy link" within 2 seconds
THEN a valid share URL is copied
AND opening that URL shows a playable video within 10 seconds
AND the transcript section shows a labelled processing state rather than an error or an empty panel
```

### 3.3 Flow C — Annotate and redact

**UX-ANN.1 (P0):** Tools are single-key: `A` arrow, `R` rectangle, `E` ellipse, `T` text, `N` numbered badge, `B` blur, `P` pixelate, `C` crop, `S` spotlight.
**UX-ANN.2 (P0):** Numbered badges auto-increment on placement and auto-renumber on reorder or deletion. Deleting badge 3 of 5 renumbers 4→3 and 5→4 with a 200 ms transition so the user sees it happen.
**UX-ANN.3 (P0):** Detected sensitive regions are **pre-redacted on editor open**, rendered with a distinct dashed outline and a count chip: *"3 items redacted automatically."* Clicking the chip lists them; each can be individually reverted with a confirm.
**UX-ANN.4 (P0):** Redaction on the canvas is visually distinct from a decorative blur — dashed border plus a small shield glyph — so no one mistakes an aesthetic blur for a security guarantee.
**UX-ANN.5 (P1):** Text callouts pick a contrasting fill automatically; the user sees the choice and can override. Never render unreadable text and leave it to the user to notice.
**UX-ANN.6 (P1):** Undo/redo depth ≥ 50, spanning annotation, crop, and trim operations in a single stack.

**Acceptance — UX-ANN.3**
```
GIVEN a screenshot containing a visible email address and an API key in a console pane
WHEN the editor opens
THEN both regions are already redacted
AND a chip reads "2 items redacted automatically"
AND reverting one requires an explicit confirmation naming what will be exposed
```

### 3.4 Flow D — Recording → guide

```
Capture detail → "Make a guide"
              → processing view with live step count ("Found 14 steps…")
              → Step editor
              → review each step (image, generated text, alt text)
              → Export
```

**UX-GDE.1 (P0):** Every generated step text and alt text is marked as generated with a subtle sparkle glyph until a human edits or explicitly accepts it. Accepting is a single click; accepting all is one click with an undo toast.
**UX-GDE.2 (P0):** Merging two steps is drag-onto; splitting is a scrubber on the step's source video segment. Both are undoable.
**UX-GDE.3 (P0):** The export dialog shows a live count of unreviewed generated content: *"9 of 14 steps still have generated text."* Export is permitted — this is information, not a gate — but the count is unmissable.
**UX-GDE.4 (P1):** Health states are color-and-glyph coded, never color alone: `ok` (no marker), `changed` (amber, refresh glyph), `broken` (red, unlink glyph).
**UX-GDE.5 (P1):** In the healing view, changed steps show a before/after image slider and a plain-language summary of what moved. Broken steps show the last-known target and offer *"Re-record this step"* as the primary action.
**UX-GDE.6 (P1):** A guide with any `broken` step cannot be published without either fixing it or explicitly marking it *"Known issue"* — which surfaces a banner on the published guide.

**Acceptance — UX-GDE.5**
```
GIVEN a healed guide with 2 changed steps and 1 broken step
WHEN the user opens the healing view
THEN each changed step offers a before/after comparison and an Accept action
AND the broken step displays its last-known selector and a Re-record action
AND a summary reads "2 steps updated, 1 needs attention"
```

### 3.5 Flow E — Agent capture (no human in the loop)

An agent calls `capture_element` over MCP while the user is working.

**UX-AGT.1 (P0):** Agent-initiated captures show a brief, non-modal, non-blocking indicator — a 2-second edge glow plus a tray badge increment. They never steal focus, never open the editor, and never interrupt typing.
**UX-AGT.2 (P0):** Agent-initiated captures are tagged `agent` in the Library and filterable. Their detail view names the requesting agent and the tool call.
**UX-AGT.3 (P0):** A persistent, always-reachable kill switch: tray → *"Pause agent access"*, which rejects all MCP tool calls with a clear error until resumed. State is visible in the tray icon.
**UX-AGT.4 (P1):** The Agent console shows a live tool-call log: timestamp, agent, tool, arguments summary, result, and a link to the resulting capture.
**UX-AGT.5 (P1):** The approval queue batches agent-proposed redactions and annotations. Each item shows before/after. Approve, reject, and edit are one click each; *"Approve all"* requires the user to have viewed each item at least once (scroll-through detection), preventing rubber-stamping.

**Acceptance — UX-AGT.3**
```
GIVEN agent access is paused
WHEN an MCP client calls capture_screen
THEN the call returns an error with code AGENT_ACCESS_PAUSED and a human-readable message
AND no capture is created
AND the tray icon visibly indicates the paused state
```

### 3.6 Flow F — Agent trace review

**UX-AGT.6 (P1):** A recording with an attached agent trace renders a third timeline lane beneath video and audio. Each tool call is a marker; clicking it seeks the video to that moment and expands arguments and result.
**UX-AGT.7 (P1):** Errors in the trace are visually prominent and independently filterable — *"Show only failures"* jumps between them with `N`/`P`.
**UX-AGT.8 (P2):** Reasoning summaries render as collapsible annotations, visually separated from tool calls, because they are the agent's account of itself rather than an observed fact.

---

## 4. Permissions and first-run

The single largest drop-off risk on macOS and Wayland.

**UX-PRM.1 (P0):** Request screen-recording permission at the moment of first capture intent, not at install. Show what will happen next, in the OS's own vocabulary.
**UX-PRM.2 (P0):** If permission is denied, do not dead-end. Show a recovery card with the exact OS path, a *"Open System Settings"* button that deep-links, and an explanation of why a restart may be required.
**UX-PRM.3 (P0):** Detect the state where permission was granted but the app needs a relaunch, and offer *"Relaunch now"* rather than failing silently — this is the most common macOS support ticket in this category.
**UX-PRM.4 (P0):** Microphone and camera permissions are requested independently and only when those tracks are first enabled.
**UX-PRM.5 (P1):** First-run teaches exactly three things and then stops: the capture hotkey, where captures go, and how to pause agent access. No multi-screen tour.

**Copy — UX-PRM.2 (normative)**

> **Aperture needs screen recording access**
> macOS asks for this before any app can see your screen. Nothing is captured until you press the hotkey.
> `[Open System Settings]`  `[I've done this — check again]`
> *Already granted it? macOS sometimes needs Aperture to relaunch before it takes effect.*

## 5. Empty, loading, error, and edge states

**UX-STA.1 (P0):** Every list surface has an empty state that offers the primary action, not a shrug. Library empty → *"Press ⌥⇧4 to take your first capture."* with the user's actual configured hotkey rendered.
**UX-STA.2 (P0):** Long operations (transcode, transcription, OCR, guide generation, healing) use progressive disclosure: the artifact is usable as soon as its first layer is ready, with later layers appearing in place. Never a full-screen blocking spinner.
**UX-STA.3 (P0):** Failure states name what failed, what still worked, and what to do. *"Transcription failed. Your video and screenshots are safe. [Retry] [Continue without transcript]"*
**UX-STA.4 (P0):** Offline is a normal state, not an error: a persistent, low-key banner reads *"Offline — captures are saved locally and will sync."* No modal, no red.
**UX-STA.5 (P1):** Disk-pressure warning before a recording starts if free space is below 2 GB, with the estimated size of the intended recording.
**UX-STA.6 (P1):** A capture whose state layer is unavailable (e.g. native desktop app, no accessibility API) shows this plainly in the state panel — *"No structured data available for this surface"* — rather than an empty panel that reads as a bug.

## 6. Accessibility

**UX-A11Y.1 (P0):** WCAG 2.2 AA across all product surfaces and all shared-link viewer pages.
**UX-A11Y.2 (P0):** Full keyboard operation of capture, annotation, and export. Region selection is fully keyboard-drivable (arrows to move, `Shift`+arrows to resize, `Enter` to capture).
**UX-A11Y.3 (P0):** Focus is visible, never trapped, and never lost on modal open/close. Focus returns to the invoking element on dismiss.
**UX-A11Y.4 (P0):** Never encode meaning in color alone — health states, redaction markers, and error indicators all carry a glyph or text.
**UX-A11Y.5 (P0):** Generated alt text is required on every exported guide image; the export blocks with a clear message if any image lacks it. This is the one place we do gate.
**UX-A11Y.6 (P1):** Video player supports captions from the transcript, keyboard seek, and adjustable playback rate.
**UX-A11Y.7 (P1):** Respect `prefers-reduced-motion`: disable auto-zoom preview animation, badge renumber transitions, and the agent-capture edge glow (replace with a static badge).
**UX-A11Y.8 (P1):** Screen reader announces capture completion, recording start/stop, and agent-initiated capture via a live region.
**UX-A11Y.9 (P1):** Minimum 44×44 px hit targets on all HUD and overlay controls.

**Acceptance — UX-A11Y.2**
```
GIVEN the user has never touched the mouse
WHEN they press the capture hotkey, use arrow keys to position and size a region, and press Enter
THEN a capture is produced matching the keyboard-defined region
AND the resulting toast is announced by the screen reader
AND every subsequent editor tool is reachable by Tab and activatable by Enter or Space
```

## 7. Visual and motion

**UX-VIS.1 (P0):** The capture overlay uses a neutral dim (rgba black, ~45%) with a fully transparent selection. No branded chrome in the overlay — the user's screen is the subject.
**UX-VIS.2 (P0):** Motion budget: overlay 120 ms, tool switching 80 ms, panel expand 200 ms, toast in/out 150 ms. Nothing in the capture path exceeds 200 ms.
**UX-VIS.3 (P0):** Dark and light themes, following the OS by default.
**UX-VIS.4 (P1):** Generated content carries a consistent visual signature (sparkle glyph + a subtle tinted background) used identically everywhere: narration, alt text, step text, healed steps, emitted test code.
**UX-VIS.5 (P1):** Brand kits apply to exported artifacts only, never to the app chrome. A customer's brand should not restyle the tool they are working in.

## 8. Notifications and interruption

**UX-NTF.1 (P0):** Interruption budget: at most one toast per user action. Background completions (transcode, OCR) never toast; they update in place in the Library.
**UX-NTF.2 (P0):** Never show a modal during an active recording. Anything urgent goes to the HUD as an inline warning.
**UX-NTF.3 (P1):** Digest agent activity — if an agent takes 12 captures in a minute, the tray badge counts them and one summary notification fires, not twelve.

## 9. Copy guidelines

- Say what happened, then what to do. *"Upload failed. Your capture is saved locally. [Retry]"*
- Never blame the user. No "invalid," no "you must."
- Never call generated content a fact. *"Suggested step text,"* not *"Step text."*
- Redaction copy names the risk concretely: *"This will expose an API key in the shared image."* — not *"Are you sure?"*
- Keep hotkeys in copy rendered as the user's actual binding, resolved at render time.
- Avoid the words *AI*, *powered*, *seamlessly*, *effortlessly* in product copy. Describe the behavior instead.

## 10. Responsive and cross-surface

**UX-RSP.1 (P0):** The shared-link viewer works on mobile web — video playback, transcript, comments, guide steps.
**UX-RSP.2 (P0):** The Editor requires ≥ 1024 px width; below that, the web app offers view + comment only, with a clear explanation.
**UX-RSP.3 (P1):** Guide exports (HTML, PDF) are readable at mobile widths without horizontal scroll; step images scale rather than crop.
**UX-RSP.4 (P1):** The Library is fully usable at tablet width.

## 11. UX metrics

| # | Metric | Target |
|---|---|---|
| UXM-1 | Time from hotkey to clipboard, p95 | < 800 ms |
| UXM-2 | First-capture completion rate for new users (install → first successful capture) | > 85% |
| UXM-3 | Permission-flow drop-off (macOS) | < 8% |
| UXM-4 | Share links created per active user per week | > 4 |
| UXM-5 | % of guides published with every generated step reviewed | > 60% |
| UXM-6 | Auto-redaction reverted by user (proxy for false-positive rate) | < 15% |
| UXM-7 | Agent-capture kill switch engaged per active workspace per month (proxy for trust failure) | < 0.2 |
| UXM-8 | Keyboard-only task completion for capture + annotate + share | 100% |

## 12. Design deliverables checklist

An agent implementing a surface should not consider it complete until:

- [ ] Happy path implemented and matching the flow spec in §3
- [ ] Empty, loading, partial-loading, error, offline, and permission-denied states implemented (§5)
- [ ] Keyboard path complete and focus order verified (§6)
- [ ] Reduced-motion variant implemented (§6, UX-A11Y.7)
- [ ] Dark and light themes verified
- [ ] All copy taken from §9 guidelines; no placeholder strings
- [ ] Generated content carries the §7 UX-VIS.4 signature
- [ ] Undo available for every destructive action (§1, P5)
- [ ] Screen reader pass on the primary flow
- [ ] Acceptance criteria from the relevant UX-* requirements pass as tests

## 13. Open questions

| # | Question | Owner | Needed by |
|---|---|---|---|
| UQ1 | Does the state panel belong in the Editor, or is it a separate "Inspect" surface? Splitting it keeps the Editor clean but adds a navigation step for Ana. | Design | M1 |
| UQ2 | Should agent-initiated captures be visible to the user by default, or opt-in? Proposal: visible by default; §3.5 assumes this. | Product | M1 |
| UQ3 | How aggressive should auto-redaction be on internal-only shares? Same rules, or relaxed? Over-redaction is the main annoyance risk (UXM-6). | Security + Design | M2 |
| UQ4 | Do healed guides notify the original author, the last editor, or a designated owner? | Product | M3 |
| UQ5 | Is the approval queue (UX-AGT.5) per user or per workspace? Per workspace risks diffusion of responsibility. | Product | M3 |
