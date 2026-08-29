# Nawi

A screen capture and recording studio — capture, record, annotate, edit, library, export.

Electron + React + TypeScript. Windows-first, but the codebase is cross-platform.

## Quick start

For contributors building from source. If you just want to *use* Nawi, go to
[Installing and first run](#installing-and-first-run).

```bash
npm install
npm run install-electron   # Electron 44 fetches its binary separately
npm run dev
```

> **Note on `npm install`:** Electron 44 no longer downloads its binary from a
> `postinstall` hook — `npm run install-electron` (which runs
> `node node_modules/electron/install.js`) does it, once. If npm's
> `allowScripts` policy blocks esbuild, run `npm install-scripts approve esbuild`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Runs the app with HMR against the Vite dev server |
| `npm run build` | Production build into `out/` |
| `npm run typecheck` | `tsc --noEmit` over both the node and web projects |
| `npm run typecheck:node` / `typecheck:web` | One project at a time |
| `npm run test:unit` | Vitest unit suite (no app launch, no DOM required) |
| `npm run test:e2e` | Builds, then runs Playwright against the real app |
| `npm run package` | Builds an unpacked app into `release/win-unpacked/` |
| `npm run dist` | Builds a distributable installer for the current platform |
| `npm run dist:win` / `dist:mac` / `dist:linux` | Builds one platform's installers explicitly |

## Installers

| Platform | Artifacts | Architectures |
|---|---|---|
| Windows | NSIS installer (`.exe`) | x64, arm64 |
| macOS | `.dmg` + `.zip` | x64, arm64 |
| Linux | AppImage, `.deb`, `.rpm` | x64, arm64 (rpm x64 only) |

Every platform ships **separate x64 and arm64 builds** (except the Linux `.rpm`,
which is x64 only) — pick the one matching your hardware.

The macOS `.zip` is required, not optional: `electron-updater` looks the update
artifact up by its zip and auto-update is silently dead without one.

**electron-builder cannot cross-compile** — a macOS `.dmg` can only be produced
on macOS. `.github/workflows/release.yml` runs the three-OS matrix that actually
builds all of them; a local `npm run dist` only ever produces your own platform's.

**No build is code-signed yet.** What that means for you as a *user* is in
[Installing and first run](#installing-and-first-run), per platform. For a
maintainer: signing turns on by providing `CSC_LINK` / `CSC_KEY_PASSWORD`
(Windows) and `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` plus
`notarize: true` (macOS). No application icon is set either, so all three ship
the default Electron icon.

## Installing and first run

Audience: someone installing a released build and taking their first capture.
Contributors running from source want [Quick start](#quick-start) instead.

Two things behave differently on every platform, and both bite on first run:
**who grants screen-recording permission**, and **whether system audio can be
recorded at all**. Here is the whole matrix before the per-OS steps.

| | Windows | macOS | Linux |
|---|---|---|---|
| Per-app screen permission | None — the OS does not ask | Yes: TCC, granted in System Settings | Your desktop environment / portal |
| Relaunch after granting | No | **Yes** | No |
| System audio recorded | **Yes** (loopback) | No | No |
| Microphone | Prompted when you first record with it on | Prompted when you first record with it on | Prompted when you first record with it on |

> **First run, any platform: take a screenshot before you try a recording.**
> A failed *screenshot* is the only action that can raise Nawi's permission
> recovery card — the panel with the exact settings path, a button that opens
> it, and a re-try button. A failed *recording* never raises it; you get a
> transient error message and nothing else. So a screenshot is the diagnostic
> worth running first.
>
> **On Windows the card never appears at all.** Measured, not inferred: Windows
> reports screen access as `granted` unconditionally, and the card is raised only
> for `denied`, `restricted` or `unknown`. So every failed capture on Windows —
> driver, remote session, group policy — produces the transient message and
> nothing more. The per-OS steps below are the whole recovery path here; follow
> them by hand.
>
> On macOS the card is likely but not guaranteed: a first-ever attempt may report
> "not yet asked", which also falls through to the transient message.

> **Known defect: the card is titled "Aperture", not "Nawi."** It reads *"Aperture
> needs screen recording access"* (on Windows, *"Aperture couldn't read your
> screen"*). This is the right card for Nawi, not another application. Aperture is
> the project codename, and the card's copy is transcribed verbatim from a
> normative specification block that was never renamed — so the fix belongs in the
> spec first, and the test that asserts the string is faithfully pinning the spec
> rather than encoding a typo.

### Windows

1. Pick the NSIS installer (`.exe`) for your architecture — **arm64** for
   Windows-on-ARM, **x64** otherwise — and run it. **SmartScreen will warn you**,
   because the build is not code-signed. Choose **More info → Run anyway**.
2. Launch Nawi and take a screenshot. **Windows has no per-app screen-capture
   permission**, so there is nothing to grant and nothing to relaunch for.
3. Record. **System audio is captured on Windows and only on Windows** — Nawi
   asks the OS for the loopback device. The *Record system audio* track is on by
   default.
4. Microphone and webcam are prompted **when you press Record with that track
   ticked** — not when you tick it, and never at startup. Denying either leaves
   the screen recording running; the HUD shows that track as failed.

**If a capture fails anyway**, that is not a permission problem, because Windows
has none to give. The real causes are a display driver, a remote/RDP session, or
workplace group policy. Note that Nawi's recovery card — which names exactly
those causes — **cannot be raised on Windows**, so you will see only the
transient message. Were it shown, its **Open System Settings** button would land on
**Settings → Privacy & security** — the closest honest destination, since
Windows exposes no screen-capture privacy page.

### macOS

1. Open the `.dmg` and drag Nawi to Applications. Pick the build matching your
   hardware: **arm64** for Apple Silicon, **x64** for Intel.
2. **Gatekeeper will block it.** The build is neither signed nor notarized, so a
   *downloaded* copy is quarantined and macOS reports *"Nawi is damaged and
   can't be opened"* (exact wording varies by macOS version). It is not damaged.
   Clear the quarantine flag:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Nawi.app
   ```
   Building and running locally never reproduces this, because quarantine is
   applied only to downloads.
3. Launch Nawi and **take a screenshot** (Capture region / full screen). This is
   what triggers macOS's screen-recording request — Nawi deliberately does not
   ask at install or at launch.
4. Grant it in **System Settings → Privacy & Security → Screen & System Audio
   Recording**, then switch **Nawi** on. If the recovery card appeared, its
   **Open System Settings** button deep-links straight to that pane.
5. **Relaunch Nawi.** macOS reads the grant at process start, so it does not take
   effect in the already-running instance. The card carries a **Relaunch now**
   button next to the note *"Already granted it? macOS sometimes needs … to
   relaunch before it takes effect."*
   Be aware of what that button is and is not: it appears on **every** macOS
   permission card, because Nawi flags the possibility from the platform alone.
   It does **not** detect that you specifically are in the
   granted-but-not-relaunched state. If capture still fails after you have
   granted access, relaunch — the app will not work it out for you.
6. Record. **System audio is not captured on macOS.** The *Record system audio*
   track is on by default, so a default recording shows that track in an error
   state reading *"System audio is not available on this platform."* That is
   expected, not a fault: the video and any microphone track record normally.
   Untick the track to keep the HUD clean.
7. Microphone and webcam are prompted **when you press Record with that track
   ticked** — one at a time, and never together. Denying either leaves the screen
   recording running.

### Linux

1. Install the package for your distribution — `.AppImage` (x64/arm64), `.deb`
   (Debian/Ubuntu, x64/arm64), or `.rpm` (Fedora/RHEL, **x64 only**). An
   AppImage must be marked executable before it will run:
   ```bash
   chmod +x Nawi-*.AppImage && ./Nawi-*.AppImage
   ```
2. Screen capture goes through **your desktop environment's screen-sharing
   settings**, not an app-level permission — that is the wording Nawi itself
   uses, because it has no way to name your particular desktop's settings app.
   (Whether your compositor prompts via a portal on first capture is a property
   of your desktop environment, not of Nawi, and is not something this repo can
   confirm for you.)
3. If a capture fails, the recovery card points at those settings — but its
   **Open System Settings** button cannot work on Linux and will tell you it
   could not open settings. That is by design, not a crash; open them yourself.
4. Record. **System audio is not captured on Linux**, and the default-on *Record
   system audio* track shows *"System audio is not available on this platform."*
   — same as macOS, and equally expected. Microphone and webcam are prompted when
   you press Record with that track ticked.

### Putting the `nawi` CLI on your PATH

Nawi ships a `nawi` command-line front end, but **the installers deliberately do
not modify your system PATH** — an installer mutating machine-wide PATH leaves
residue behind on uninstall. Two ways to get it:

- `npm install -g .` from a clone of this repo, or
- point your shell at the copy inside the installed app. It is unpacked from the
  asar precisely so plain `node` can run it:
  - Windows — `<install dir>\resources\app.asar.unpacked\out\cli\index.js`
  - macOS — `/Applications/Nawi.app/Contents/Resources/app.asar.unpacked/out/cli/index.js`
  - Linux — `<install dir>/resources/app.asar.unpacked/out/cli/index.js`

What the CLI can do is in [Agent access](#agent-access--mcp-and-cli).

## Agent access — MCP and CLI

Nawi exposes twelve tools over a loopback JSON-RPC endpoint: `capture_screen`,
`capture_region`, `capture_element`, `start_recording`, `stop_recording`,
`get_capture`, `get_state_layer`, `list_captures`, `search_captures`, `annotate`,
`redact`, and `export_guide`. The MCP server, its dispatch layer, the state
projection and the revision model live in `src/main/mcp/`; `src/mcp/stdio-bridge.ts`
is the stdio front end an MCP client connects to.

`nawi` is a command-line front end to the **same** endpoint, with the same
bearer token and the same tools, so every rule the app enforces — the agent kill
switch, redaction gating, path confinement — applies unchanged.

```bash
nawi list
nawi capture --name "Login screen"
nawi capture-region --x 0 --y 0 --width 800 --height 600
nawi search --query invoice --json
```

Commands are a thin naming layer over the tools: `capture`, `capture-region`,
`capture-element`, `record`, `record-stop`, `get`, `list`, `search`, `annotate`,
`redact`, `export`.

Flag values are JSON-coerced, so `--width 800` sends a number while
`--name "Login screen"` sends a string. Exit codes are the scripting contract:
`0` success, `1` the app reported an error, `2` usage error, `3` Nawi is
not running.

It **will not start the app for you** — a shell command silently opening a GUI
is a surprise nobody consented to. That refusal is inherited from the MCP bridge.

The installers do **not** put `nawi` on your `PATH` — see
[Putting the `nawi` CLI on your PATH](#putting-the-nawi-cli-on-your-path) for the
shipped binary's location on each platform and why the installer leaves PATH
alone.

## What works today

- **Capture** — full screen, a specific window (with a thumbnail picker), or a
  dragged region.
- **Region select** — a *freeze-frame* overlay: every display is captured first,
  then an opaque overlay per display renders that frozen bitmap. There is no
  hide-then-capture race and no transparent-window compositing to fight.
- **Recording** — `getDisplayMedia` + `MediaRecorder`, with the source chosen by
  the app's own picker rather than the OS one. Optional system audio, microphone
  and webcam tracks, each permission-prompted independently and at the moment it
  is actually needed. A floating HUD controls the take.
- **Recording writes MP4 by default.** `MediaRecorder` on this Electron build
  accepts `video/mp4;codecs=avc1.42E01E,mp4a.40.2` and emits a real ISO-BMFF file
  at roughly 40% the size of the equivalent VP9 WebM — no ffmpeg, no WebCodecs, no
  native modules. The WebM fallback chain remains, because MP4 support is version-
  and platform-dependent. See `src/shared/recording.ts`, which probes rather than
  assumes.
- **Annotation editor** — arrow, rectangle, ellipse, text, highlighter,
  blur/pixelate, step numbers, and crop, with undo/redo, zoom, and a colour and
  stroke palette. Fully keyboard-driven. **Stills only** — see Known gaps.
- **Library** — a searchable grid, rename, delete-with-confirm, and reopening any
  capture back into the editor.
- **Export** — PNG/JPEG with annotations flattened, copy-to-clipboard, or save the
  original asset untouched. **Stills only** — see Known gaps.

## Keyboard shortcuts

Global (work while the app is unfocused):

| Action | Shortcut |
|---|---|
| Capture region | `Ctrl+Shift+1` |
| Capture full screen | `Ctrl+Shift+2` |
| Capture window | `Ctrl+Shift+3` |
| Start recording | `Ctrl+Shift+4` |
| Stop recording | `Ctrl+Shift+S` |
| Show main window | `Ctrl+Shift+0` |

In the editor: `A R E T H B N C V` select a tool, `1`–`8` pick a colour, `[`/`]`
adjust stroke, `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo, `Ctrl+S` save, `Ctrl+C` copy,
`Ctrl+Shift+E` export, `Ctrl+0/+/−` zoom.

> Export is `Ctrl+Shift+E`, not `Ctrl+Shift+S`: a global hotkey is intercepted
> before the focused window ever sees it, so binding Export to the same chord as
> global stop-recording would make Export unreachable at all times.

## Architecture

Two documents written before implementation, and still the reference:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — process split, IPC contract,
  capture pipeline, security posture, storage layout, annotation model.
- [`docs/UX-SPEC.md`](docs/UX-SPEC.md) — flows, every required screen state,
  accessibility requirements as checkable values, and the shortcut map.

> ARCHITECTURE.md §2.3 (and its assumption #4) still says MP4 would require
> bundling ffmpeg and that the app therefore records WebM only. That note is
> **superseded, not edited** — see `src/shared/recording.ts` for the probe that
> disproves it.

The shape worth knowing up front:

- **Stills never touch a media stream.** `desktopCapturer.getSources` with
  `thumbnailSize` set to the display's full pixel size *is* the screenshot. All of
  it happens in the main process.
- **DIP vs. physical pixels** is the single most bug-prone part of the app. The
  `screen` module speaks DIP; bitmaps are physical pixels. Every conversion goes
  through `dipRectToPixels` in `src/main/capture.ts` — don't inline that maths
  anywhere else.
- **All recorded audio goes through one Web Audio graph.** `MediaRecorder` encodes
  a single audio track; handing it a stream with both a loopback track and a
  microphone track silently drops one of them, with nothing reporting a problem.
  Mixing to one `MediaStreamAudioDestinationNode` is what makes both audible — and
  it is also why the tracks cannot be separated again after the fact.
- **Assets are served over a custom `capture://` scheme**, not `file://`.
  Cross-origin `fetch()` to a custom scheme is blocked from a `file://` page, so
  the renderer reads assets via `<img>`/`<video>` and anything needing bytes goes
  through IPC instead.

## Security posture

Every `BrowserWindow` runs with `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false` and `webSecurity: true`. The preload exposes named
methods only — never `ipcRenderer`, and no generic `invoke(channel, …)` escape
hatch. Library ids are validated against a UUID pattern and resolved through the
index rather than being used as path segments. An E2E test asserts that
`require`, `process` and `ipcRenderer` are all unreachable from the renderer.

`docs/SECURITY-REVIEW-M1A.md` records the standing review.

## Testing

```bash
npm run test:unit    # vitest
npm run test:e2e     # builds, then drives the real Electron app
```

64 Playwright tests across six specs drive the actual built app:

| Spec | Covers |
|---|---|
| `app.spec.ts` | Window rendering, the preload security boundary, library empty states, the capture pipeline end to end (desktopCapturer → PNG → disk → index → `capture://` → `<img>`), delete-with-confirm |
| `annotation.spec.ts` | Drawing and persisting shapes, undo/redo, tool and palette bindings |
| `recording.spec.ts` | The record lifecycle and track selection |
| `conformance.spec.ts` | UX-SPEC conformance over required screen states |
| `mcp.spec.ts` | The twelve tools over the loopback endpoint, redaction gating, the agent kill switch |
| `cli.spec.ts` | The `nawi` binary's exit-code contract, including its refusal to launch the app |

Unit tests live beside their subjects (`*.test.ts`) and cover the pure layers —
container selection, the sidecar/library store, redaction gating, HAR harvest,
CDP selectors and the MCP projection/revision model.

## Known gaps

- **Video is playback-only in the editor.** `isVideo` gates off annotate, crop,
  copy and export (`src/renderer/components/EditorView.tsx:922-1146`), so a
  recording cannot be trimmed, shortened or re-exported without leaving the app.
  Work on a video export pipeline — trim, format/resolution/bitrate control,
  animated GIF, speed change — is **in progress and not yet merged**; see
  [`docs/BACKLOG-video.md`](docs/BACKLOG-video.md) for the queue and
  `docs/DRAFT-video-export-VEX.md` for the requirements.
- Video captures show a placeholder tile in the library rather than a poster frame.
- System-audio capture (`audio: 'loopback'`) is Windows-only. Elsewhere the
  recording continues video-only, and because the track is enabled by default the
  user sees it in an error state ("System audio is not available on this
  platform") on every default macOS/Linux recording.
- A screen-permission failure during a *recording* reaches only a console log —
  it does not raise the UX-PRM.2 recovery card and does not surface a message the
  user can act on. Only a *screenshot* failure raises the card, and on Windows not
  even then: the OS reports access as granted unconditionally, which is outside
  the card's trigger condition, so the card is unreachable on that platform.
- The recovery card is titled "Aperture", the project codename. The copy is
  transcribed verbatim from a normative spec block that was never renamed.
- Mic and system audio are mixed down to a single track at record time, so they
  cannot be separated, muted independently or re-balanced afterwards.
- The library is a flat JSON index. That's correct at this scale and keeps the app
  free of native modules; it is not intended to scale to six figures of captures.
