# Nawi

A screen capture and recording studio — capture, record, annotate, edit, library, export.

Electron + React + TypeScript. Windows-first, but the codebase is cross-platform.

## Quick start

```bash
npm install
node node_modules/electron/install.js   # Electron 44 fetches its binary separately
npm run dev
```

> **Note on `npm install`:** Electron 44 no longer downloads its binary from a
> `postinstall` hook — you run the line above once. If npm's `allowScripts`
> policy blocks esbuild, run `npm install-scripts approve esbuild`.

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

The macOS `.zip` is required, not optional: `electron-updater` looks the update
artifact up by its zip and auto-update is silently dead without one.

**electron-builder cannot cross-compile** — a macOS `.dmg` can only be produced
on macOS. `.github/workflows/release.yml` runs the three-OS matrix that actually
builds all of them; a local `npm run dist` only ever produces your own platform's.

**Neither platform's build is code-signed yet.** Windows installers trigger a
SmartScreen warning, and downloaded macOS builds are blocked by Gatekeeper
("Nawi is damaged") — a failure that does *not* reproduce when building and
running locally, because quarantine is only applied to downloads. Signing turns
on by providing `CSC_LINK` / `CSC_KEY_PASSWORD` (Windows) and `APPLE_ID` /
`APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` plus `notarize: true` (macOS).
No application icon is set either, so all three ship the default Electron icon.

## Installing and first run

Nawi needs permission to record your screen, and the OS decides how that is
granted. The steps differ per platform, and the macOS one has a step people
routinely miss.

### Windows

1. Run the NSIS installer (`.exe`). **SmartScreen will warn you** — the build is
   not code-signed yet. Choose **More info → Run anyway**.
2. Launch Nawi. **No per-app screen-capture permission exists on Windows**, so
   capture works immediately with nothing to grant.
3. Microphone and webcam are prompted only at the moment you first enable them,
   never at startup. Denying either leaves screen recording working.

System audio capture is supported here and only here — Nawi uses the Windows
loopback device. On macOS and Linux, recordings degrade to video-only.

### macOS

1. Open the `.dmg` and drag Nawi to Applications. Pick the build matching your
   hardware: **arm64** for Apple Silicon, **x64** for Intel.
2. **Gatekeeper will block it** — the build is not signed or notarized, so a
   downloaded copy is quarantined and reports *"Nawi is damaged and can't be
   opened."* It is not damaged. Clear the quarantine flag:
   ```bash
   xattr -d com.apple.quarantine /Applications/Nawi.app
   ```
   This does not reproduce when building locally, because quarantine is applied
   only to downloads.
3. Launch Nawi, then grant screen recording in
   **System Settings → Privacy & Security → Screen & System Audio Recording**.
   The in-app permission screen has a button that deep-links straight there.
4. **Relaunch Nawi.** macOS reads the TCC grant at process start, so the
   permission does not take effect in the running instance. Nawi detects this
   case and says so rather than leaving you looking at a dead capture button.

System audio is not captured on macOS; recordings are video plus microphone.

### Linux

1. Install the package for your distribution — `.AppImage` (any), `.deb`
   (Debian/Ubuntu), or `.rpm` (Fedora/RHEL, x64 only). For the AppImage, mark it
   executable first:
   ```bash
   chmod +x Nawi-*.AppImage && ./Nawi-*.AppImage
   ```
2. Screen capture goes through your desktop environment's screen-sharing
   settings rather than an app-level permission. On Wayland the portal prompts on
   first capture; on X11 it generally just works.

System audio is not captured on Linux; recordings are video plus microphone.

### Building from source (any platform)

```bash
npm install
npm run install-electron   # Electron 44 fetches its binary separately
npm run dev
```

`npm run dist` builds installers for **your own platform only** — electron-builder
cannot cross-compile. Use the release workflow's three-OS matrix for the rest.

### Putting the `nawi` CLI on your PATH

The installers deliberately do not modify system PATH, since that leaves residue
on uninstall. See [Agent access](#agent-access--mcp-and-cli) below for the shipped
binary's location on each platform, or install from the repo with `npm install -g .`.

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

The installers do **not** put `nawi` on your `PATH`; mutating system PATH
from an installer leaves residue behind on uninstall. Get it on PATH either by
installing from the repo (`npm install -g .`), or by pointing at the shipped
copy, which is unpacked from the asar precisely so plain `node` can run it:

- Windows — `<install dir>\resources\app.asar.unpacked\out\cli\index.js`
- macOS — `/Applications/Nawi.app/Contents/Resources/app.asar.unpacked/out/cli/index.js`
- Linux — `<install dir>/resources/app.asar.unpacked/out/cli/index.js`

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
- System-audio capture (`audio: 'loopback'`) is Windows-only and degrades to
  video-only elsewhere.
- Mic and system audio are mixed down to a single track at record time, so they
  cannot be separated, muted independently or re-balanced afterwards.
- The library is a flat JSON index. That's correct at this scale and keeps the app
  free of native modules; it is not intended to scale to six figures of captures.
