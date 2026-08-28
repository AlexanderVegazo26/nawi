# Nawi

A modern Competitor A replacement — capture, record, annotate, edit, library, export.

Electron + React + TypeScript. Windows-first, but the codebase is cross-platform.

## Quick start

```bash
npm install
node node_modules/electron/install.js   # Electron 44 fetches its binary separately
npm run dev
```

> **Note on `npm install`:** Electron 44 no longer downloads its binary from a
> `postinstall` hook — you run `install-electron` (the line above) once. If npm's
> `allowScripts` policy blocks esbuild, run `npm install-scripts approve esbuild`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Runs the app with HMR against the Vite dev server |
| `npm run build` | Type-agnostic production build into `out/` |
| `npm run typecheck` | `tsc --noEmit` over both the node and web projects |
| `npm run test:e2e` | Builds, then runs the Playwright E2E suite against the real app |
| `npm run package` | Builds an unpacked app into `release/win-unpacked/` |
| `npm run dist` | Builds a distributable installer |

## What works today

- **Capture** — full screen, a specific window (with a thumbnail picker), or a
  dragged region.
- **Region select** — a *freeze-frame* overlay: every display is captured first,
  then an opaque overlay per display renders that frozen bitmap. There is no
  hide-then-capture race and no transparent-window compositing to fight.
- **Recording** — `getDisplayMedia` + `MediaRecorder` to WebM, with the source
  chosen by the app's own picker rather than the OS one, and optional system audio.
- **Annotation editor** — arrow, rectangle, ellipse, text, highlighter,
  blur/pixelate, step numbers, and crop, with undo/redo, zoom, and a colour and
  stroke palette. Fully keyboard-driven.
- **Library** — a searchable grid, rename, delete-with-confirm, and reopening any
  capture back into the editor.
- **Export** — PNG/JPEG with annotations flattened, copy-to-clipboard, or save the
  original asset untouched.

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

The shape worth knowing up front:

- **Stills never touch a media stream.** `desktopCapturer.getSources` with
  `thumbnailSize` set to the display's full pixel size *is* the screenshot. All of
  it happens in the main process.
- **DIP vs. physical pixels** is the single most bug-prone part of the app. The
  `screen` module speaks DIP; bitmaps are physical pixels. Every conversion goes
  through `dipRectToPixels` in `src/main/capture.ts` — don't inline that maths
  anywhere else.
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

## Testing

```bash
npm run test:e2e
```

10 Playwright tests drive the actual built Electron app: window rendering, the
preload security boundary, both library empty states, the capture pipeline end to
end (desktopCapturer → PNG → disk → index → `capture://` → `<img>`), annotating
and persisting a shape, undo, and delete-with-confirm.

## Known gaps

- Recording is WebM only. MP4 would mean bundling ffmpeg, which is deliberately
  deferred — see `docs/ARCHITECTURE.md`.
- Video captures show a placeholder tile in the library rather than a poster frame.
- System-audio capture (`audio: 'loopback'`) is Windows-only and degrades to
  video-only elsewhere.
- The library is a flat JSON index. That's correct at this scale and keeps the app
  free of native modules; it is not intended to scale to six figures of captures.
