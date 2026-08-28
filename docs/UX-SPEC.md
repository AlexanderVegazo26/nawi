# Competitor A Clone — UX Specification v1

Status: implementation-ready, Tier 3 (new user-facing product area, accessibility-critical capture overlay, multi-step journeys with real failure modes).
Scope: what one implementer builds immediately. Supersedes nothing.

---

## 1. Context

### 1.1 What exists

No `product-analyst` acceptance criteria, no persona roster, no design system, no prior design memory. The repo is empty. Therefore:

- This document **establishes** the baseline pattern set. §4.6 pattern reuse is not possible; every pattern here is new by necessity and does not need per-pattern justification against a system that does not exist. The next feature spec must reuse from here.
- Requirement IDs below (`UX-*`) are defined **by this document**, not traced to upstream criteria. `qa-engineer` should use them as the usability oracle; there is no higher authority to trace to yet.

### 1.2 User problem

A user needs to capture something on screen, mark it up so another person understands it, and get it out (clipboard/file) in seconds. The dominant cost is time-to-first-capture and time-to-share, not feature count. Every design decision below favors fewer steps and reversible actions over configurability.

### 1.3 Evidence classification (§3)

**Known facts (verifiable, not user research):**
- macOS gates screen capture behind a system Screen Recording permission; Windows 11 generally does not gate desktop capture equivalently. The permission-denied journey is therefore OS-asymmetric and real.
- macOS reserves Cmd+Shift+3 / 4 / 5. Windows reserves PrintScreen and Win+Shift+S. These cannot be used as our hotkeys.
- A globally-registered hotkey intercepts the keystroke before any focused window receives it. A combination cannot be both a global hotkey and an in-app shortcut.

**Assumptions (numbered, risk-rated):**
- **A1** — Users capture far more often than they record (est. 10:1), so capture is the default surface and recording is a peer entry point, not a mode switch. *Risk if wrong:* recording is buried one level too deep; mitigated cheaply by promoting the rail item. *Validates via:* entry-point usage counts once instrumented.
- **A2** — Granting macOS Screen Recording permission may require an app relaunch to take effect. The recovery flow is therefore designed to include a "Restart app" path. *Reasoning:* designing for relaunch degrades harmlessly if live re-check works; designing without it strands the user in a dead screen. *Risk if wrong:* one extra button that is never needed. *Validates via:* implementer testing grant-then-recheck on macOS.
- **A3** — Users expect a freshly-taken capture to open straight into the editor rather than land silently in the library. *Risk if wrong:* an unwanted modal interrupt on rapid-fire capture; §7.3 defines the repeated-capture rule that bounds this. *Validates via:* first usability pass.
- **A4** — Single-user local app; no accounts, no sync, no multi-tenant data. *Risk if wrong:* library IA needs an ownership dimension it currently lacks.
- **A5** — `Ctrl+Shift+<digit>` is registrable on Windows. *Risk if wrong:* the Windows language-bar / IME layout switcher has historically claimed `Ctrl+Shift`, so these four capture hotkeys are the most likely registration failures. Mitigated, not prevented, by the §4.4 registration-failure path. *Validates via:* implementer testing on a Windows install with two or more keyboard layouts.

**Hypotheses (track outcome, §8):**
- **H1** — Tool selection by single-letter shortcut (A/R/E/T/H/B/N/C) will be the dominant selection path for repeat users over clicking the toolbar. *Check:* shortcut-vs-click ratio.
- **H2** — A persistent always-on-top recording widget plus a global stop hotkey is sufficient that no user ever reports "I couldn't stop the recording." *Check:* support reports; zero is the pass bar.
- **H3** — 3-stop segmented controls (§9) are sufficient; no user requests finer numeric control.

**Decisions needed (owner: product):**
- **D1** — Editor save model: explicit save vs. autosave-on-every-edit. This spec implements **explicit save with a dirty-state guard** (§6.6) as the default because it makes discard meaningful, but this is a real fork and product owns it.
- **D2** — Whether a capture that the user discards without saving is deleted outright or retained in a recoverable holding area for the session. This spec implements outright deletion behind a confirm.

### 1.4 Out of scope (state plainly so it is not inferred)

MP4/H.264 export (requires an ffmpeg dependency — WebM only), audio capture, webcam overlay, scrolling capture, OCR/text-grab, cloud share/upload, a settings/preferences panel, themes (dark only), multi-user anything.

### 1.5 Visual baseline

Dark-first, dense, professional desktop utility.

| Token | Value | Use |
|---|---|---|
| `surface-0` | `#101114` | App background |
| `surface-1` | `#17191E` | Left rail, panels |
| `surface-2` | `#20232A` | Cards, inputs, toolbar |
| `surface-3` | `#2B2F38` | Hover / raised |
| `border` | `#363B45` | Dividers, card edges |
| `text-primary` | `#EDEFF3` | Body and headings |
| `text-secondary` | `#A2A9B6` | Metadata, hints |
| `accent` | `#4C8DFF` | Selection, primary action, focus |
| `danger` | `#FF5C5C` | Destructive, errors |
| `success` | `#3FD07E` | Confirmations |

Contrast obligations are stated as checkable values in §8; `ui-engineer` owns measuring the final values against these tokens and adjusting the token, not the requirement.

Density: 8px base grid. Rail 72px wide. Toolbar row height 40px. Body text 13px/20px. Metadata 11px/16px.

---

## 2. Information architecture — main window

**UX-IA-01.** On launch the app opens the **main window** in the **Library** view. There is no splash, no onboarding wizard, no modal.

Layout: left rail (72px, fixed) + main content (fills remainder). Minimum window size 960×640.

**UX-IA-02.** Left rail, top to bottom, each a 56×56 target with icon + 10px label beneath, tooltip showing the global hotkey:

1. **Capture** — opens the capture flyout (§3.1). Not a route.
2. **Record** — starts the recording pre-flight (§4).
3. **Library** — the default route. Selected on launch.
4. *(spacer, flex)*
5. **Help** — opens a shortcut cheat-sheet panel (a right-side drawer, 320px, listing every shortcut from §7.2). This is the only "settings-like" surface in v1.

The selected rail item shows a 2px `accent` left edge marker plus `surface-3` background. Selection state is conveyed by both, never color alone.

**UX-IA-03.** Main content area for Library: a 48px header row (search field left, capture-count right), then the capture grid (§5).

**UX-IA-04 — window model.** The **region-select overlay** (§3.5), the **window picker** (§3.2), and the **recording widget** (§4.2) are **separate always-on-top OS windows**, not routes inside the main window. The main window is hidden during region select and during recording. This is a hard architectural requirement, flagged to `solution-architect` (§10).

### Main window state table

| State | Behavior |
|---|---|
| initial/default | Library route, rail rendered, search empty, grid populated or empty per §5. |
| loading | On cold start, grid area shows 12 skeleton cards (`surface-2`, 1.5s shimmer, `prefers-reduced-motion` → static fill). Rail is interactive immediately; capture must never wait on library load. |
| empty | See §5 empty states — two distinct ones. |
| success | Not a distinct state for the shell; per-action toasts appear bottom-center, 4s, dismissible, `aria-live="polite"`. |
| error | Library index unreadable/corrupt → grid area replaced by inline error panel: "Couldn't open your capture library." + `Retry` + `Reveal library folder`. Rail capture actions stay enabled. |
| permission-denied | Not applicable at shell level — the shell requires no OS permission. Denial surfaces at the capture/record boundary (§3.4, §4.4). |
| degraded | (a) Library folder is read-only → grid renders, all delete/rename disabled with tooltip "Library folder is read-only"; capture still works but save routes to Save As. (b) Thumbnail generation failed for an item → card shows a generic file glyph + filename, item still opens. (c) Free disk under 500MB → persistent amber bar above the grid: "Low disk space — recordings may fail." |

---

## 3. Capture entry flows

**UX-CAP-01.** Three entry points, each reachable three ways: rail Capture flyout, global hotkey, tray/menu-bar menu. All three are subject to the mode-exclusion rules in §7.3.

### 3.1 Capture flyout

Clicking rail **Capture** opens a 240px flyout anchored to the rail with three rows: `Fullscreen`, `Window…`, `Region…`, each showing its hotkey right-aligned in `text-secondary`. Arrow keys move between rows, Enter activates, Esc closes and returns focus to the rail button. The flyout is a focus trap while open.

### 3.2 Fullscreen capture

**UX-CAP-02.** Trigger → main window hides (no animation; must not appear in the frame) → frame grabbed → main window returns with the editor open on the new capture (A3).

Multi-monitor: if more than one display is attached, fullscreen capture grabs **the display containing the pointer**. No prompt. The editor header states which display ("Display 2 · 2560×1440") so the user can tell they got the wrong one and retry in one keystroke.

| State | Behavior |
|---|---|
| initial | Nothing visible; the app hides. |
| loading | Grab is synchronous and sub-200ms; if it exceeds 400ms, show a spinner pill center-screen ("Capturing…"). |
| empty | Not applicable — a frame always contains pixels. |
| success | Editor opens; toast "Captured · Display 2". |
| error | Grab returned no frame → main window returns, modal: "Capture failed." + reason string + `Try again` / `Cancel`. Never fail silently back to the library. |
| permission-denied | §3.4. |
| degraded | GPU/hardware capture path unavailable → fall back to software capture; if the fallback exceeds 1s, show the "Capturing…" pill. No user-visible quality change is promised. Display hot-unplugged between trigger and grab → error state with "That display is no longer connected." |

### 3.3 Window picker

**UX-CAP-03.** Trigger → main window hides → a full-screen always-on-top picker window appears over a 60% `#000` scrim: a centered grid of window thumbnails, 3 columns, each card 280×180 thumbnail + app icon + window title (truncated, full title in tooltip).

Interaction: hover raises the card and shows a 2px `accent` border. Click captures. **Keyboard:** Tab/arrow keys move the selection ring through cards in visual order, Enter captures the focused card, Esc cancels and restores the main window. First card is focused on open.

| State | Behavior |
|---|---|
| initial | Grid rendered, first card focused. |
| loading | Thumbnails enumerate asynchronously — cards appear immediately with title + skeleton thumbnail, filling in as they resolve. The list must be usable before all thumbnails load. |
| empty | No capturable windows (all minimized) → centered message "No open windows to capture." + `Capture full screen instead` + `Cancel`. |
| success | Picker closes, editor opens on the capture. |
| error | Selected window closed between selection and grab → picker stays open, inline toast "That window closed." and the card is removed. |
| permission-denied | §3.4 — on macOS, window titles and thumbnails are unavailable without permission; do **not** render a grid of blank cards, route to §3.4. |
| degraded | Thumbnail unavailable for a specific window → card renders with app icon + title on `surface-2` and is still selectable. Never hide a capturable window because its preview failed. |

### 3.4 Permission-denied (capture and record) — designed in full

**UX-CAP-04.** This is a first-class screen, not a toast.

Trigger: any capture or record attempt where the OS reports screen-capture permission is not granted (macOS primarily; also any future OS that gates it).

Presentation: the main window returns to front and the content area is replaced by a centered panel, max-width 520px:

- Icon: a shield/monitor glyph, 48px, `text-secondary` — decorative, `aria-hidden`.
- H1 (18px, `text-primary`): **"Competitor A Clone needs permission to capture your screen."**
- Body (13px, `text-secondary`): "macOS requires you to allow screen recording for this app. Your captures stay on this Mac — nothing is uploaded."
- Numbered steps, visible, not hidden behind a disclosure:
  1. Open System Settings → Privacy & Security → Screen & System Audio Recording.
  2. Turn on **Competitor A Clone**.
  3. Return here and choose **Check again**.
- Primary button: **`Open System Settings`** — deep-links to the exact privacy pane.
- Secondary button: **`Check again`** — re-queries permission. On success → dismiss panel and immediately retry the original action the user asked for (do not make them re-trigger). On still-denied → the panel stays and an `aria-live="assertive"` line appears beneath: "Still not granted. If you just turned it on, restart the app."
- Tertiary text button: **`Restart app`** (A2). Present from the start, low emphasis.

Focus on open goes to the H1 (`tabindex="-1"`), announced by screen readers. Tab order: H1 → Open System Settings → Check again → Restart app → rail.

The panel does **not** disable the rail. Library remains browsable; only capture/record are gated. Rail Capture and Record items get an amber dot badge and tooltip "Permission required" while denied.

| State | Behavior |
|---|---|
| initial | Panel as above. |
| loading | `Check again` shows an inline spinner and disables for the duration (max 3s, then treat as still-denied). |
| empty | Not applicable — panel always has content. |
| success | Panel dismissed, original action retried, toast "Permission granted." |
| error | Deep-link failed to open System Settings → replace the primary button's action with a copyable path string and the message "Couldn't open System Settings — open it manually." |
| permission-denied | This *is* the state. Repeated failure never loops silently; the "restart" hint escalates on the second failed check. |
| degraded | On an OS with no such permission model (Windows 11), this screen is unreachable by design; capture failures there route to the §3.2 error state instead. |

### 3.5 Region drag-select — the overlay

**UX-CAP-05.** Trigger → main window hides → a borderless, always-on-top, click-through-disabled overlay window covers **every** attached display.

**What the screen looks like:**
- Entire screen dimmed to 55% `#000`. The live desktop is visible beneath it.
- Cursor becomes a crosshair. A 1px `accent` full-width horizontal line and full-height vertical line follow the cursor across all displays, so the user can align to distant edges.
- A hint pill sits centered at the top of the pointer's display, `surface-2` at 92% opacity, 8px radius: **"Drag to select · Esc to cancel · ← ↑ → ↓ to move"**. It fades out after the first drag begins and does not return.
- On drag: the selected rectangle is **undimmed** (full brightness, 0% scrim), bordered 1px `accent`, with 8 square handles (8×8, `accent`, white 1px inner border) at corners and edge midpoints.
- A dimension readout — `1280 × 720` — in a `surface-2` pill, 12px tabular-numeral text, sits **below-right of the selection's bottom-right corner, offset 8px**. Placement rule: if that position would fall outside the display bounds, flip it to inside the selection's bottom-right corner; if the selection is smaller than the pill plus 16px, place it above-right of the top-right corner instead. It must never be clipped.
- On release: the selection freezes with handles live. A small confirm bar appears immediately below the selection (same flip rule): `Capture` (primary) and `Redo selection` (secondary), plus the readout. Enter also confirms.

**Behaviors:**
- Minimum viable region: **8×8 px**. A drag smaller than that on release is treated as a click.
- **Click without drag:** selects the window under the cursor, auto-fitted to that window's bounds, presented as a normal editable selection (handles + confirm bar). This gives a fast path without a mode switch. If no window is resolvable, nothing happens and the hint pill re-shows for 2s.
- **Adjusting:** handles are draggable. Dragging inside the selection moves it. Shift during initial drag constrains to a square.
- **Multi-monitor:** the overlay spans all displays as one coordinate space; a selection may cross a display boundary and the resulting capture is the stitched rectangle. Displays with different scale factors are normalized to the highest scale factor present; state this in the readout as `1280 × 720 @2x` when scaling applies.
- **Cancel:** `Esc` at any point (before, during, or after drag) closes the overlay and restores the main window with nothing captured. Right-click also cancels. A cancel is silent — no toast, no confirm.

**UX-CAP-06 — non-pointer path (mandatory).** A canvas overlay with mouse-only interaction is a WCAG 2.1.1 failure. The overlay must be fully operable from the keyboard:

| Key | Action |
|---|---|
| Arrow keys | Move the selection origin 1px (no selection yet: moves the crosshair). |
| Shift + Arrow | Move 10px. |
| Alt + Arrow | Resize the selection by 1px from the bottom-right edge. |
| Alt + Shift + Arrow | Resize by 10px. |
| Space | With no selection: anchors the origin at the crosshair and starts a keyboard selection at 100×100. |
| Enter | Confirm and capture. |
| Esc | Cancel. |
| Tab | Cycles focus: selection → `Capture` → `Redo selection` → selection (trapped). |

On open, the overlay announces via `aria-live="assertive"`: "Region selection active. Press Space to start a selection, arrow keys to move, Enter to capture, Escape to cancel." Every dimension change announces the new `W × H` on a 300ms debounce via `aria-live="polite"`.

| State | Behavior |
|---|---|
| initial | Dimmed screen, crosshair, hint pill, no selection. |
| loading | Not applicable — the overlay renders from an already-grabbed backing frame; if that frame is not ready within 250ms the overlay shows the dim layer without live desktop content rather than delaying open. |
| empty | Zero-size / sub-minimum selection → confirm bar does not appear; `Capture` unreachable. |
| success | Overlay closes, editor opens with the cropped image; toast "Captured · 1280 × 720". |
| error | Crop produced no pixels → overlay closes, modal "Capture failed." + `Try again` / `Cancel`. |
| permission-denied | Overlay never opens; route to §3.4 before any dimming occurs. Never dim the screen and then fail. |
| degraded | (a) Display hot-unplugged mid-selection → overlay rebuilds its coordinate space, any selection wholly on the lost display is cleared and `aria-live` announces "Display disconnected, selection cleared."; a selection partly on it is clamped to remaining bounds. (b) Compositing unavailable → dim layer renders as a flat opaque `#000` at 55% without blur/live preview; selection and capture still function. |

---

## 4. Recording flow

**UX-REC-01.** Video only. WebM output. No audio, no webcam (§1.4).

### 4.1 Start

Rail **Record** or global hotkey → the region overlay (§3.5) opens in **record mode**: identical interaction, but the confirm button reads `Start recording` and the hint pill reads "Drag to select recording area · Esc to cancel". A `Full screen` chip in the confirm bar selects the whole pointer display in one click.

On confirm: overlay closes, main window hides, a **3-2-1 countdown** renders as a 96px numeral centered in the recording region over a 40% scrim. `Esc` during the countdown aborts with no file written. Countdown is skippable with Enter.

### 4.2 In-progress affordance — the user must always be able to stop

**UX-REC-02.** Three independent stop paths, all always available:

1. **Floating recording widget** — a separate always-on-top window, 220×44, `surface-2`, 8px radius, 1px `border`, positioned by default at the bottom-center of the recording display, 24px above the screen edge and **outside the recorded region** where geometry allows. Contents: a pulsing `danger` dot, elapsed time in tabular numerals (`00:14`), a `Pause/Resume` button, and a `Stop` button (`danger` fill, 32×32 with a square glyph). Draggable by its background.
2. **Global stop hotkey** — works regardless of focus, even if the widget is off-screen or occluded.
3. **Tray / menu-bar item** — its icon switches to a recording indicator; its menu's first item is `Stop recording`.

Hard requirements for the implementer:
- **The widget, the countdown, and the region border must be excluded from the captured frames.** Verify by recording a region that contains the widget's default position.
- The widget is **clamped to visible screen bounds** on every display-configuration change; it can never be dragged fully off-screen (minimum 48px always on-screen).
- If the widget window fails to create, recording **still starts** and a system notification fires: "Recording started. Press <hotkey> to stop." Never start a recording with no stop affordance — if both the widget and the hotkey fail to register, do not start; show the §4.4 error.
- The recording region is outlined with a 2px `danger` dashed border, animated (static under `prefers-reduced-motion`), also excluded from the frames.

Accessibility: the widget is keyboard-focusable (its hotkey brings it to focus), `role="toolbar"`, `aria-label="Recording controls"`, and announces elapsed time only on demand (an `Announce elapsed time` action), never continuously. Per §8.4, the widget must offset itself rather than obscure a focused control in another window.

### 4.3 Stop

**UX-REC-03.** On stop from any path: border and widget disappear, the main window returns to front, and the recording opens in a **playback view** — the video in a player (play/pause, scrub, keyboard: Space toggles, arrows seek ±5s) with a header showing duration, dimensions and file size.

The file is **written to the library immediately on stop**, before the playback view renders. A crash after stop must not lose the recording. Because the item is already saved, the playback view offers no "Save to library" action — that would be a no-op. Its actions are: `Save As…`, `Copy file`, `Rename`, `Delete` (delete-with-confirm, §5.5), and `Close` (returns to the library with the item selected). The header shows "Saved to library" in `text-secondary` so the absence of a save button is explained rather than merely unexplained.

Annotation of video is out of scope; the annotation editor is stills-only.

### 4.4 Recording state table

| State | Behavior |
|---|---|
| initial/default | Rail Record enabled; no widget. |
| loading | Between confirm and first frame: countdown (§4.1). If encoder init exceeds 2s after countdown, widget shows "Starting…" with a spinner in place of elapsed time; `Stop` remains live and aborts cleanly. |
| empty | A recording stopped under 1s produces a file with no usable frames → discard it and toast "Recording too short — nothing saved." Do not save a 0-byte file to the library. |
| success | Playback view (§4.3); toast "Recording saved · 00:42 · 4.1 MB". |
| error | Encoder failure mid-recording → recording halts, partial file is **kept and saved**, modal: "Recording stopped unexpectedly. We saved the first 00:31." + `Open` / `Delete`. Hotkey registration failure at start → modal "Couldn't register the stop shortcut (another app may be using it). Start anyway using the on-screen Stop button?" with `Start anyway` / `Cancel`. |
| permission-denied | §3.4, before the countdown. |
| degraded | (a) Disk falls below 200MB mid-recording → widget turns amber, shows "Low disk"; below 50MB the recording auto-stops and saves, with a modal explaining why. (b) Hardware encoding unavailable → software encoding; if sustained frame rate falls below 15fps for 3s, the widget shows an amber "Slow" chip with tooltip "Dropping frames — try a smaller region." (c) Recorded display disconnected → recording auto-stops and saves the partial file with the §4.4-error modal wording. |

---

## 5. Library

**UX-LIB-01.** Grid of cards, responsive column count at a 220px minimum card width, 16px gutter. Cards are 220×176: a 220×124 thumbnail (`object-fit: cover`, `surface-2` behind), then two metadata lines.

**UX-LIB-02 — metadata on the card:** line 1 is the capture name (13px `text-primary`, single-line ellipsis, full name in `title`); line 2 is `type · dimensions · relative time` (11px `text-secondary`), e.g. `PNG · 1280×720 · 4m ago` or `WebM · 1920×1080 · 00:42 · yesterday`. File size appears in the card's tooltip and in the editor header, not on the card face — it is the least-used field and the card is dense.

Video cards carry a duration chip bottom-left of the thumbnail and a play glyph.

**UX-LIB-03 — interaction:** single click selects (2px `accent` ring + 1px inner white for non-color redundancy). Double click or Enter opens (stills → editor §6; video → playback §4.3). Arrow keys move selection across the grid in visual order; Home/End jump to first/last. `Delete` key on a selected item runs delete-with-confirm. Right-click opens a context menu: `Open`, `Copy image`/`Copy file`, `Save As…`, `Reveal in Finder/Explorer`, `Rename`, `Delete`.

Rename is inline on the card label (F2 or context menu), Enter commits, Esc reverts. **While the rename field or the search field has focus, all bare-key library shortcuts are inactive** — `Delete`, `F2`, arrows, `Home` and `End` do not act on the grid; only `Enter`, `Esc` and `Tab` apply. This suppression rule is mandatory (see also §6.1 for the editor equivalent).

Sort: newest first, fixed. No sort control in v1.

**UX-LIB-04 — search:** a single field in the header, 280px, placeholder "Search captures", focused by its hotkey. Filters on capture name only (there is no OCR, §1.4), case-insensitive substring, debounced 150ms, filtering in place. A clear (×) button appears when non-empty; Esc clears the field and returns focus to the grid. Result count is announced `aria-live="polite"`: "12 captures".

**UX-LIB-05 — delete-with-confirm:** a modal, not a toast-with-undo (the file leaves disk). Title "Delete '<name>'?", body "This moves the file to the system trash. Captures in the trash can be restored from there." Buttons: `Cancel` (default focus) and `Delete` (`danger`). Esc cancels. Multi-select delete is out of scope for v1; single item only. Deletion moves to OS trash, never a permanent unlink — that is what makes the single confirm sufficient.

### 5.1 Library state table

| State | Behavior |
|---|---|
| initial/default | Grid, newest first, nothing selected, search empty. |
| loading | 12 skeleton cards (§2 shell table). Search field is disabled with a spinner while indexing. |
| empty — **no captures yet** | Grid area replaced by a centered onboarding panel, max-width 560px: 48px camera glyph (`aria-hidden`); H1 **"No captures yet"**; body "Take your first capture — it'll show up here." Then three side-by-side action cards, each 160×120 with icon, label and its hotkey rendered as a `<kbd>` chip: **Fullscreen**, **Window**, **Region**, plus a fourth text link **Record screen** beneath. Each card is a real button, tab-reachable in that order, Enter activates. Focus lands on the H1 on first render. This panel is the app's entire onboarding; there is no separate tour. |
| empty — **no search results** | The onboarding panel does **not** appear. Instead: centered, 320px, `text-secondary`: "No captures match '<query>'." + a single secondary button **`Clear search`** which empties the field and returns focus to it. The two empty states are never conflated — the discriminator is `searchQuery.length > 0`, not `items.length === 0`. |
| success | Post-action toasts: "Deleted", "Renamed", "Copied to clipboard". |
| error | Index read failure → §2 shell error panel. Per-item file missing on open → card shows a `danger` corner badge and opening yields modal "That file is no longer on disk." + `Remove from library`. |
| permission-denied | Not applicable — the library reads only the app's own folder. If that folder is inaccessible, that is the shell error state, not a permission screen. |
| degraded | (a) Read-only folder → rename/delete disabled with tooltip. (b) Thumbnail generation failed → generic file glyph on `surface-2` with the filename overlaid; item still opens. (c) Library exceeding 500 items → virtualized rendering; no user-visible change, but scroll position must survive a search-clear. |

---

## 6. Annotation editor

**UX-EDT-01.** Layout: 48px header (capture name, dimensions, file size, right-aligned `Copy`, `Save`, `Export ▾`, `Close`), then a horizontal tool bar (40px) beneath it, then the canvas area on `surface-0` with the image centered, then a 28px status bar (zoom control, cursor coordinates).

Canvas: fit-to-window on open, never upscaled past 100% on open. Zoom 25%–400% via the status control, `Ctrl/Cmd +` / `-`, `Ctrl/Cmd 0` (fit), `Ctrl/Cmd 1` (100%). Space-drag pans.

### 6.1 Tools

Eight tools, left-to-right, each a 32×32 icon button inside a 40px row (see §8.2 for the target-size requirement):

| Tool | Key | Behavior |
|---|---|---|
| Arrow | `A` | Drag from tail to head. Shift constrains to 15° increments. |
| Rectangle | `R` | Drag corner-to-corner. Shift = square. |
| Ellipse | `E` | Drag within bounds. Shift = circle. |
| Text | `T` | Click places a text box and enters edit mode; type inline. **`Enter` commits** (`Shift+Enter` inserts a line break); **`Esc` discards** the in-progress box. An empty box on commit is discarded. |
| Highlighter | `H` | Drag a translucent (40% alpha) rectangle; multiply blend so underlying text stays legible. |
| Blur / Pixelate | `B` | Drag a rectangle; the region is obscured. A segmented control in the properties row switches Blur ⟷ Pixelate; intensity is a 3-stop control (Light / Medium / Heavy), not a free slider. |
| Step number | `N` | Click places an auto-incrementing numbered badge (1, 2, 3…). Counter resets per capture and renumbers remaining badges on delete. |
| Crop | `C` | Enters a modal crop sub-state: handles on the image, dimmed outside, `Apply` / `Cancel` in the status bar, Enter applies, Esc cancels. Crop is destructive to the canvas bounds but **is undoable** (§6.5). |

Selection tool: `V` / Esc from any tool returns to Select, where existing objects can be clicked, moved, resized via handles, and deleted with `Delete`/`Backspace`.

**UX-EDT-04 — bare-key suppression (mandatory).** Single-letter tool keys (`V A R E F T H N B P X S M C`), swatch digits (`1`–`8`), `[` / `]`, and `Delete` are **inactive whenever a text input or inline-edit field has focus** — including a Text object in edit mode, the library search field, and inline rename. In those contexts only `Enter`, `Shift+Enter`, `Esc` and `Tab` carry shortcut meaning; every other keystroke is literal text. Without this, typing the word "Arrow" into a text box switches tools four times.

**Every tool is operable without a pointer.** With a tool active and no pointer input: Enter places a default-sized instance (100×60, or a 100px arrow) at canvas center; arrow keys move the selected object 1px (Shift 10px); Alt+arrows resize; Tab cycles through placed objects in creation order with a visible focus ring; Enter on a focused text object enters edit mode.

### 6.2 Tool + color + stroke presentation

A single **properties row** (36px) sits directly beneath the tool bar and re-renders for the active tool. It contains only what the active tool uses — it never shows disabled irrelevant controls:

- **Color** — 8 fixed swatches in a row (`#FF3B30`, `#FF9500`, `#FFCC00`, `#34C759`, `#4C8DFF`, `#AF52DE`, `#FFFFFF`, `#101114`), each a 24×24 button inside a 32×32 hit area, plus a 9th "custom" swatch opening the OS color picker. The selected swatch shows a 2px white ring **and** a checkmark glyph — not color alone. Keys `1`–`8` select swatches directly.
- **Stroke** — a 3-stop segmented control: `Thin` (2px), `Medium` (4px), `Thick` (8px), labelled with both a word and a visual weight. Keys `[` and `]` step down/up.
- **Fill** — for Rectangle/Ellipse only: a two-state toggle `Outline` / `Filled`.
- **Font size** — for Text only: a 3-stop segmented control `S` (14) / `M` (20) / `L` (32).
- **Intensity** — for Blur/Pixelate only, per §6.1.

Tool and property selections **persist across captures within a session** (a user who marks up in red at Medium keeps doing so). They reset to Arrow / red / Medium on app restart.

### 6.3 Annotation legibility over arbitrary imagery

Because annotations sit over a screenshot whose colors are unknown, contrast cannot be guaranteed (see §8.5). Mandatory mitigation: **every annotation stroke and text glyph renders with a 1px contrasting halo** — a `#101114` outline under light strokes and a `#FFFFFF` outline under dark strokes, chosen from the stroke color's relative luminance (threshold 0.5). Text objects additionally render on an optional 70%-opacity backing plate, on by default, toggleable in the properties row.

### 6.4 Header actions

- `Copy` — flattens and copies the annotated image to the clipboard (§7.2 hotkey). Toast "Copied to clipboard."
- `Save` — writes to the library, clears the dirty flag.
- `Export ▾` — §7.1.
- `Close` — §6.6.

### 6.5 Undo / redo

**UX-EDT-02.** A single linear undo stack, depth **50**, scoped to the open capture.

- Every operation is undoable, including **crop** and **blur/pixelate** — the pixel-modifying tools store their pre-operation region, not a flattened result. Nothing is baked into the base image until export.
- Redo is cleared by any new operation after an undo.
- Property changes (color, stroke) are **not** stack entries; changing a property on a *selected* object is.
- The stack is **not** persisted. It is cleared on Save and on Close, and it does not survive app restart. This is stated so the implementer does not invent persistence, and so the user is never offered an undo that silently cannot run.
- Undo/redo buttons are not in the toolbar (density); they are keyboard-only plus the context menu. Their disabled/enabled truth is announced via the context menu items.

### 6.6 Save / discard model (D1 — explicit save)

**UX-EDT-03.** The editor tracks a dirty flag. The header shows an `•` before the capture name while dirty.

Two materially different discard paths:

1. **A freshly captured, never-saved image.** Closing while dirty shows a modal: title "Discard this capture?", body "It hasn't been saved to your library yet. This can't be undone." Buttons `Cancel` (focus default) / `Save` (primary) / `Discard` (`danger`). Esc = Cancel. This is a genuine data-loss fork and the confirm is mandatory. It is also the confirm that a new incoming capture must run first (§7.3).
2. **An existing library item reopened and edited.** Closing while dirty shows: "Save changes to '<name>'?" with `Cancel` / `Discard changes` / `Save`. Discarding here loses only the edits; the original file is untouched. Lower-stakes wording, same three buttons.

Saving an edited library item **overwrites in place**; there is no versioning in v1. Say so in the save confirmation toast: "Saved · replaces the original."

### 6.7 Editor state table

| State | Behavior |
|---|---|
| initial/default | Arrow tool active, red, Medium stroke, image fit to window, clean flag, empty undo stack. |
| loading | Opening a library item: canvas area shows a centered spinner over `surface-0` for >200ms decodes; toolbar renders but is disabled until the image is decoded. Freshly captured images are already in memory and skip this. |
| empty | Not applicable in the usual sense — an editor always has a base image. The *no annotations* condition is not an empty state; the canvas is the content. Attempting to open the editor with no image is a programming error, not a user state, and routes to the error state. |
| success | `Save` → toast + dirty flag cleared. `Copy` → toast. |
| error | Image decode failure → canvas area replaced by "Couldn't open this capture." + `Reveal in Finder/Explorer` + `Close`. Save failure (disk full / read-only) → modal "Couldn't save." + reason + `Save As…` / `Cancel`; the dirty flag **stays set** and the editor stays open. Never clear a dirty flag on a failed write. |
| permission-denied | Not applicable — the editor touches no gated OS resource. Save-target permission failure is the error state above. |
| degraded | (a) GPU canvas acceleration unavailable → software rendering path; above 4000px on either axis, drop live-preview-while-dragging to an outline-only preview and note nothing to the user. (b) Very large image (>8000px) → canvas caps zoom at 200% and the status bar shows "Large image — some previews simplified." (c) OS color picker unavailable → the custom swatch is hidden, the 8 fixed swatches remain. |

---

## 7. Export / share, shortcuts, and mode exclusion

### 7.1 Export

**UX-EXP-01.** `Export ▾` in the editor header and `Save As…` in the library both open the OS save dialog with a format selector.

- **Stills:** PNG (default, lossless, transparency preserved) and JPG. Choosing JPG reveals a 3-stop quality control (`High` 90 / `Medium` 75 / `Low` 60) — not a numeric slider. JPG flattens transparency onto white; state this inline: "JPG doesn't support transparency."
- **Recordings:** WebM only. No format selector, no transcode. If a user chooses `Save As…` on a recording, the dialog is a plain file-destination dialog. MP4 is explicitly out of scope (§1.4) and must not appear as a disabled option — an option the user cannot use is worse than its absence.
- **Copy to clipboard:** stills copy as an image (PNG-backed) so it pastes into chat, docs and mail. Recordings copy as a **file reference**, not pixels; the menu item is therefore labelled `Copy file`, distinctly from the stills' `Copy image`. Never label them the same.
- Default filename: `Capture YYYY-MM-DD at HH.MM.SS`. Default directory: last-used export directory, falling back to the OS Pictures folder.

| State | Behavior |
|---|---|
| initial/default | Format = PNG for stills, WebM for recordings; last-used directory. |
| loading | Encode/write >400ms → the export button shows an inline spinner and disables; the rest of the editor stays interactive. Large recordings show a determinate progress bar in the status bar with a `Cancel` action. |
| empty | Not applicable — export always has a source. |
| success | Toast "Saved to <folder>" with a `Reveal` action, 6s. |
| error | Write failure → modal with the OS reason + `Choose another location` / `Cancel`. Clipboard write failure → toast (`danger`) "Couldn't copy to clipboard." Cancelled export leaves no partial file on disk — clean up. |
| permission-denied | Destination folder not writable → treated as the error state with the "Choose another location" CTA pre-focused. This is a filesystem permission, distinct from §3.4's screen-capture permission; do not reuse that screen. |
| degraded | Clipboard unavailable in the environment → `Copy` items are hidden, not disabled, and export remains the path. |

### 7.2 Keyboard shortcuts

**Global (system-wide, fire when the app is unfocused).** Registered at launch. A globally-registered combination is intercepted before any focused window sees it, so **no combination below may also appear in the in-app table**. Registration failure surfaces per §4.4-error, and the Help drawer marks any unregistered shortcut with an amber "unavailable" chip.

| Action | Windows/Linux | macOS |
|---|---|---|
| Capture region | `Ctrl+Shift+1` | `Ctrl+Opt+Cmd+1` |
| Capture fullscreen | `Ctrl+Shift+2` | `Ctrl+Opt+Cmd+2` |
| Capture window | `Ctrl+Shift+3` | `Ctrl+Opt+Cmd+3` |
| Start recording | `Ctrl+Shift+4` | `Ctrl+Opt+Cmd+4` |
| **Stop recording** | `Ctrl+Shift+S` | `Ctrl+Opt+Cmd+S` |
| Show main window | `Ctrl+Shift+0` | `Ctrl+Opt+Cmd+0` |

macOS uses the four-modifier `Ctrl+Opt+Cmd` set deliberately: `Cmd+Shift+3/4/5` are owned by the OS and must not be taken. Windows avoids `PrintScreen` and `Win+Shift+S` for the same reason. Per **A5**, the four Windows `Ctrl+Shift+<digit>` bindings are the expected-collision candidates (language-bar / IME layout switching) and are the ones most likely to exercise the registration-failure path — test them first.

**In-app (window-scoped).** `Ctrl` below = `Cmd` on macOS. None of these duplicates a global binding.

| Scope | Key | Action |
|---|---|---|
| Any window | `Esc` | Cancel current mode / close overlay / close modal |
| Any window | `F1` | Toggle the shortcut Help drawer |
| Library | `Ctrl+F` | Focus search |
| Library | `Enter` | Open selected |
| Library | `Delete` / `Backspace` | Delete selected (confirm) |
| Library | `F2` | Rename selected |
| Library | `Arrows` / `Home` / `End` | Move grid selection |
| Overlay | per §3.5 table | Keyboard region selection |
| Editor | `V A R E F T H N B P X S M C` | Select tool — see the resolved map and its reasoning in `src/renderer/lib/tools.ts` |
| Editor | `1`–`8` | Select color swatch |
| Editor | `[` / `]` | Decrease / increase stroke |
| Editor | `Ctrl+Z` | Undo |
| Editor | `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| Editor | `Ctrl+C` | Copy annotated image to clipboard |
| Editor | `Ctrl+S` | Save to library |
| Editor | **`Ctrl+Shift+E`** | Export / Save As |
| Editor | `Ctrl+W` | Close (dirty guard applies) |
| Editor | `Ctrl+ +` / `-` / `0` / `1` | Zoom in / out / fit / 100% |
| Editor | `Delete` | Delete selected annotation |
| Playback | `Space` | Play/pause |
| Playback | `←` / `→` | Seek ∓5s |

Export is `Ctrl+Shift+E`, **not** `Ctrl+Shift+S`: the latter is the global stop-recording hotkey and would be swallowed before the editor ever received it, making Export unreachable at all times. Bare-key entries in this table are subject to the §6.1 / §5 suppression rule while a text field has focus.

### 7.3 Mode exclusion and repeated capture

**UX-MODE-01.** Global hotkeys fire regardless of app state, so every combination below is reachable and must be defined.

| Trigger | App state | Behavior |
|---|---|---|
| Any capture or record hotkey | A capture overlay, window picker, or countdown is already active | **Suppressed.** No new overlay, no stacking. The active overlay keeps focus. The rail and tray items render disabled for the duration. |
| Any capture or record hotkey | A recording is in progress | **Suppressed.** Never dim or overlay a screen that is being recorded. The tray item's only capture-related entry while recording is `Stop recording`. |
| Capture hotkey | Editor open, **clean** (saved, or no edits) | Proceeds. On success the editor is replaced by the new capture. No confirm needed — nothing is lost. |
| Capture hotkey | Editor open, **dirty and never saved** | The capture is taken first (do not make the user re-trigger it and lose the moment), then the §6.6 path-1 confirm appears before the editor is replaced. `Cancel` keeps the current capture and holds the new one until resolved; `Discard` replaces it; `Save` saves the old and then opens the new. Silently replacing an unsaved capture is prohibited. |
| Capture hotkey | Editor open, **dirty, existing library item** | Same as above but with the §6.6 path-2 confirm. |
| Record hotkey | Editor open and dirty | The §6.6 confirm resolves first, then the record pre-flight opens. Recording never starts with an unresolved dirty editor behind it. |
| Any capture or record hotkey | Permission not granted | §3.4, before any overlay renders. |

At most one capture overlay, one recording, and one editor exist at any time. There are no multiple editor windows in v1.

---

## 8. Accessibility requirements (checkable values)

Target: **WCAG 2.2 Level AA** for all application chrome. Each item below is a pass/fail check `qa-engineer` can run.

**8.1 Contrast.**
- Body and metadata text ≥ **4.5:1** against its own surface. Explicitly: `text-secondary` (#A2A9B6) on `surface-1` (#17191E) and on `surface-2` (#20232A) must both measure ≥4.5:1; `ui-engineer` measures and adjusts the token if not.
- Text ≥18.66px bold or ≥24px: ≥ **3:1**.
- Non-text UI components and graphical objects (**1.4.11**, AA): ≥ **3:1** — includes input borders, the selected-swatch ring, the rail selection marker, toolbar icon glyphs, the recording dot, and the overlay's selection border against the dim layer.
- **Focus indicator (project requirement, not an AA criterion):** 2px `accent` outline, 2px offset, plus a 1px `#101114` inner ring so it holds against both light and dark adjacent pixels, measuring ≥ **3:1** against both the focused component and the adjacent background. WCAG 2.2 places focus *appearance* at AAA (2.4.13); this app adopts it anyway, and it is stated here as our own bar rather than attributed to AA.
- Disabled controls are exempt from contrast minima but must be distinguishable by more than opacity alone (add a lock/strike glyph or explanatory tooltip).

**8.2 Target size (2.5.8, AA).** All interactive targets ≥ **24×24 CSS px**. Primary controls exceed it: rail items **56×56**, editor tool buttons **40×40** hit area (32px glyph), color swatches **32×32** hit area (24px swatch), recording widget `Stop` **32×32**, library card whole-card target ≥ 220×176. The region overlay's drag handles render 8×8 but carry a **24×24 invisible hit area**; this is the one place the visual and the target intentionally differ, and it must be implemented, not skipped.

**8.3 Keyboard operability (2.1.1, 2.1.2).** Every function, including every editor tool and the region overlay, is operable from the keyboard — the tables in §3.5, §6.1 and §7.2 are the exhaustive definition. No keyboard trap anywhere except deliberate modal/overlay focus traps, each of which is escapable with `Esc`. Bare-key shortcuts are suppressed inside text fields (§6.1 UX-EDT-04, §5 UX-LIB-03).

**8.4 Focus order, management, and non-obscuring (2.4.3, 2.4.11).**
- Main window tab order: rail items (top→bottom) → search field → grid (grid is a single tab stop; arrows move within, per the composite-widget pattern) → Help drawer if open.
- Editor tab order: header actions (left→right) → tool bar (single tab stop, arrows move within) → properties row (single tab stop, arrows within) → canvas → status bar.
- Every modal and overlay traps focus, sets initial focus to its heading or its safest action (`Cancel` on destructive confirms), and **restores focus to the invoking control on close**. This restore is a named requirement, not a nicety.
- The region overlay sets focus to itself on open and returns focus to the invoking rail item or the library grid on cancel.
- **Focus Not Obscured (2.4.11, AA):** this app has three surfaces that can cover a focused control — the always-on-top recording widget, bottom-center toasts, and the properties row. None may **fully** obscure the focused element. Toasts reposition (bottom-center → top-center) when the focused element is behind them; the recording widget offsets by its own height along the nearest axis; the properties row is in normal flow and never overlaps. Scroll-into-view must account for the sticky header, tool bar and properties row so a focused canvas object is never scrolled beneath them.

**8.5 Stated conflict — annotation contrast is not guaranteeable.** The AA contrast requirement applies to application chrome only. Annotation colors sit over an arbitrary user screenshot whose background pixels are unknown and unconstrained; claiming AA over the canvas would be a false compliance claim. The mitigation is §6.3's mandatory contrasting halo plus the text backing plate. This is documented as a known, bounded exception, not an unaddressed failure.

**8.6 Motion (2.3.3).** `prefers-reduced-motion` disables: skeleton shimmer, the recording-dot pulse (becomes a static dot), the marching-ants region border (becomes static), toast slide-ins (become fades), and all zoom/pan easing. No content flashes more than 3×/second anywhere (2.3.1).

**8.7 Screen reader.** Every icon-only button carries an `aria-label`. The tool bar is `role="toolbar"` with roving tabindex; the color swatches are `role="radiogroup"`. Toasts are `aria-live="polite"`; capture/record failures and permission denial are `aria-live="assertive"`. The library grid is `role="grid"` with per-cell labels reading name, type, dimensions and age. Decorative glyphs are `aria-hidden="true"`.

**8.8 Text and zoom (1.4.4, 1.4.12).** All UI text scales to 200% without loss of function or clipped content; no fixed-height text containers in the rail, toolbar, or cards. Minimum body size 13px; nothing below 11px anywhere, and 11px is reserved for metadata only.

**8.9 Cognitive.** Every destructive action is confirmed or reversible (delete → OS trash; discard → confirm; edits → 50-deep undo). Error messages state what happened, why, and the next action — never a bare code. The permission screen (§3.4) is the reference standard for error copy.

---

## 9. Design-system impact

No design system exists (§1.1). This document defines the v1 baseline: the token set (§1.5), the rail + content shell, the card, the toolbar/properties-row pattern, the 3-stop segmented control (used for stroke, quality, font size and blur intensity — deliberately reused rather than four different controls), the toast, the destructive-confirm modal, and the full-panel error/permission screen. Future work reuses these; a new pattern from here on requires the §4.6 justification.

One reuse decision worth naming: **3-stop segmented controls instead of sliders** everywhere a continuous value was plausible (stroke width, JPG quality, blur intensity, font size). Rationale: sliders are poor keyboard and screen-reader targets, produce unreproducible values, and add precision no user of a markup tool needs. This is Hypothesis **H3** — track whether users request finer control.

---

## 10. Handoff notes

**To `ui-engineer` (primary):**
- §8 states accessibility *requirements*; you own measuring and adjusting the §1.5 tokens to satisfy them. If a token can't meet its ratio, change the token and report it — do not relax the ratio.
- The five non-negotiables that are easy to get quietly wrong: the region overlay's keyboard path (§3.5 / UX-CAP-06), the recording widget's exclusion from captured frames (§4.2), the two distinct library empty states (§5.1), bare-key suppression inside text fields (§6.1 / UX-EDT-04), and the mode-exclusion table (§7.3 / UX-MODE-01).
- Export is `Ctrl+Shift+E`. Do not "fix" it to `Ctrl+Shift+S` — that is the global stop-recording hotkey and would swallow it.
- Undo must cover crop and blur (§6.5) — store pre-operation regions; do not flatten until export.
- Any interaction not specified here is a gap in this spec. Bring it back rather than inventing it.

**To `solution-architect` (flag now, not mid-build):**
1. The capture overlay, window picker, and recording widget are **separate always-on-top OS windows**, not renderer routes (UX-IA-04). This shapes the window/IPC model.
2. **Global hotkey registration** is required, including a defined failure path when another app owns a combination (§4.4-error), and the global-vs-in-app exclusivity constraint in §7.2.
3. The **per-OS permission model** is asymmetric (§1.3, §3.4) and needs a permission-state query plus a system-settings deep-link per platform. A2 (relaunch-to-take-effect) needs verifying.
4. Multi-monitor coordinate normalization across differing scale factors (§3.5) affects the capture pipeline.
5. §7.3 requires a single global app-mode state machine (idle / overlay / countdown / recording / editor-dirty) that both the hotkey handler and the tray menu read from.
6. WebM-only recording keeps ffmpeg out of the dependency tree — confirm before any format expansion.

**To `qa-engineer`:** the `UX-*` IDs and every state table cell are the usability oracle. The four highest-value checks are the permission-denied journey (§3.4, all six states), the region overlay under keyboard-only operation (§3.5), the mode-exclusion matrix (§7.3), and typing a tool-key letter into a Text object without the tool changing (§6.1).

**To `technical-writer`:** the shortcut table (§7.2) and the permission-recovery steps (§3.4) are the two things end users will need documented.
