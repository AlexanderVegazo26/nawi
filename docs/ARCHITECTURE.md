# Nawi — Architecture Note

Status: accepted (ADR-001, greenfield). Date: 2026-08-28.
Scope: Electron + Vite + React + TypeScript desktop capture/annotation app. Windows primary.

Epistemic labels used below: **[required]** (correctness/hard constraint), **[consensus]**, **[preference]**, **[ASSUMPTION — verify]**.

---

## 0. Load-bearing decisions up front

1. **Stills and recordings use different capture paths.** Stills: `desktopCapturer` in main, no media stream. Recording: `getDisplayMedia` + `MediaRecorder` in renderer. Do not unify them — a still pulled out of a video stream is blurry and a frame behind. **[required]**
2. **Zero native modules.** No `better-sqlite3`, no `sharp`, no native ffmpeg bindings. A node-gyp rebuild against Electron's ABI on Node 26 is exactly the thing that breaks `npm install`. This forces the JSON index (§4) and WebM-only recording (§2.3). **[required, derived from the Node 26 / npm 12 constraint]**
3. **Region capture uses freeze-frame**, not a live transparent overlay (§2.2). **[consensus]**
4. **Non-destructive editing.** Original capture bytes are immutable; annotations are a sidecar JSON doc; flattening happens only on export. **[preference, but it makes re-edit free and keeps the index small]**
5. **No frame/bitmap buffers over IPC per operation.** Main writes files and returns ids; the renderer loads pixels through a custom `capture://` protocol (§1.4). **[required — a 4K PNG structured-cloned per call is 10–20 MB]** There are exactly three sanctioned exceptions, all renderer→main and all unavoidable because only the renderer can produce the bytes: `record:chunk` (§2.3), `ExportRequest.flattenedPng`, and `annotations:save.thumbnailPng`. Do not "optimise" these away.

### NFRs (measurable targets)

| Attribute | Target |
|---|---|
| Fullscreen still capture (single 4K display) | < 400 ms from hotkey to editor showing image |
| Region overlay appearance after hotkey | < 250 ms (freeze-frame must feel instant) |
| Crop accuracy | exact to the pixel at 100 %, 125 %, 150 %, 200 % Windows scaling |
| Recording | 1080p30, no dropped-frame stutter when the UI window is unfocused or minimised |
| Library list render | < 200 ms for 2 000 items |
| Library index | JSON is adequate to ~5–10 k items; revisit above that |
| Undo depth | 50 steps, ≤ 50 ms per undo |
| `npm install && npm run build` on clean Windows / Node 26 | succeeds with no compiler toolchain installed |

---

## 1. Process split & IPC

### 1.1 Responsibilities

**Main** — window lifecycle; global hotkeys (`globalShortcut`); `desktopCapturer`; all filesystem I/O (captures, thumbnails, index); PNG encode/crop via `nativeImage`; clipboard; `session.setDisplayMediaRequestHandler`; the `capture://` protocol; shell/dialog. All IPC payloads are validated here — **treat the renderer as untrusted even though we wrote it**.

**Preload** — nothing but `contextBridge.exposeInMainWorld` over `ipcRenderer.invoke` plus an allowlisted `on`. No logic, no `fs`, no `path` (it cannot have them under `sandbox: true`, §3).

**Renderer** — React UI: capture library, annotation editor (canvas), export dialogs. Owns `getDisplayMedia` + `MediaRecorder` (they are web APIs and exist nowhere else). Owns the region-select overlay UI.

Three renderer entry points: `main` (library + editor), `overlay` (region select), `recorder` (hidden, holds `MediaRecorder`).

### 1.2 Shared contract

One file, `src/shared/ipc.ts`, imported by main, preload and renderer so the three cannot drift. **[required]**

```ts
// ---------- domain types ----------
export type CaptureId = string;              // uuid v4
export type Rect = { x: number; y: number; width: number; height: number };

export type SourceKind = 'screen' | 'window';

export interface CaptureSource {
  id: string;                 // desktopCapturer source id
  kind: SourceKind;
  name: string;
  displayId?: number;         // Electron screen.Display.id, screens only
  thumbnailDataUrl: string;   // small, picker-only
}

export interface DisplayInfo {
  id: number;
  bounds: Rect;               // DIP, screen coordinate space
  scaleFactor: number;        // e.g. 1.25
  isPrimary: boolean;
}

export type CaptureKind = 'region' | 'window' | 'fullscreen' | 'recording';

export interface CaptureRecord {
  id: CaptureId;
  kind: CaptureKind;
  createdAt: string;          // ISO-8601 UTC
  title: string;              // editable, defaults from window name / timestamp
  file: string;               // relative to captures/, e.g. "2026/08/<id>.png"
  thumb: string;              // relative to thumbs/,   e.g. "<id>.jpg"
  /** ORIGINAL source pixels, always — never the post-crop size. The library
   *  grid derives display aspect from doc.crop when hasAnnotations is true. */
  width: number;
  height: number;
  bytes: number;
  durationMs?: number;        // recordings only
  hasAnnotations: boolean;    // sidecar <id>.annotations.json exists
  tags: string[];
}

export interface CaptureLibraryIndex {
  version: 1;
  items: CaptureRecord[];     // newest first
}

// ---------- request/response ----------
export interface FreezeFrame {           // one per display
  displayId: number;
  bounds: Rect;                          // DIP
  scaleFactor: number;
  imageUrl: string;                      // capture://frozen/<displayId>?t=<nonce>
}

export type ExportFormat = 'png' | 'jpg' | 'webm';

export interface ExportRequest {
  id: CaptureId;
  format: ExportFormat;
  quality?: number;                      // 1..100, jpg only
  /** Flattened pixels produced by the renderer canvas. Only sent for
   *  annotated exports; omit to export the original file untouched. */
  flattenedPng?: Uint8Array;
  targetPath?: string;                   // omit -> main shows save dialog
}

export interface IpcMap {
  // --- capture (renderer -> main, invoke/handle) ---
  'capture:fullscreen':     (displayId?: number) => Promise<CaptureRecord>;
  'capture:listSources':    (kinds: SourceKind[]) => Promise<CaptureSource[]>;
  'capture:window':         (sourceId: string) => Promise<CaptureRecord>;
  /** Grabs every display, stores the bitmaps in main, opens one opaque
   *  overlay window per display, resolves when the user commits or cancels. */
  'capture:beginRegion':    () => Promise<CaptureRecord | null>;
  /** Called BY the overlay window. rect is in DIP within that display. */
  'capture:commitRegion':   (p: { displayId: number; rect: Rect }) => Promise<void>;
  'capture:cancelRegion':   () => Promise<void>;
  /** Takes no argument by design: main resolves the display from
   *  event.sender -> the overlay window it created. An overlay must not be
   *  able to name a display and read another screen's frozen bitmap. */
  'capture:getFreezeFrame': () => Promise<FreezeFrame>;

  // --- recording ---
  'record:start':  (p: { sourceId: string; audio: boolean }) => Promise<{ id: CaptureId }>;
  'record:chunk':  (p: { id: CaptureId; data: Uint8Array }) => Promise<void>;
  'record:stop':   (p: { id: CaptureId; durationMs: number;
                         width: number; height: number }) => Promise<CaptureRecord>;
  'record:abort':  (p: { id: CaptureId }) => Promise<void>;

  // --- library ---
  'library:list':      (p?: { search?: string; tag?: string }) => Promise<CaptureRecord[]>;
  'library:get':       (id: CaptureId) => Promise<CaptureRecord | null>;
  'library:delete':    (ids: CaptureId[]) => Promise<void>;
  'library:rename':    (p: { id: CaptureId; title: string }) => Promise<CaptureRecord>;
  'library:revealInExplorer': (id: CaptureId) => Promise<void>;

  // --- annotations (sidecar doc, §5) ---
  'annotations:load': (id: CaptureId) => Promise<AnnotationDoc | null>;
  /** thumbnailPng is the flattened+cropped 320px thumb; only the renderer can
   *  produce it, and without it the library would show un-annotated thumbs
   *  forever. Returns the updated record so the grid can re-read aspect. */
  'annotations:save': (p: { id: CaptureId; doc: AnnotationDoc;
                            thumbnailPng?: Uint8Array }) => Promise<CaptureRecord>;

  // --- export / clipboard ---
  'export:save':      (req: ExportRequest) => Promise<{ path: string } | null>;
  'export:clipboard': (p: { id: CaptureId; flattenedPng?: Uint8Array }) => Promise<void>;
}

// --- main -> renderer events (webContents.send), allowlisted in preload ---
export interface IpcEvents {
  'library:changed':  { added?: CaptureId[]; removed?: CaptureId[] };
  'record:tick':      { id: CaptureId; elapsedMs: number; bytes: number };
  'record:error':     { id: CaptureId; message: string };
  'capture:opened':   { id: CaptureId };   // hotkey capture -> open in editor
  'recorder:command': { action: 'start' | 'stop'; sourceId?: string; audio?: boolean;
                        id?: CaptureId };  // to the hidden recorder window
}
```

`flattenedPng` is the one deliberate exception to "no buffers over IPC": it happens once per explicit user export, not per frame. **[preference, with the cost acknowledged]**

### 1.3 Patterns

- Request/response → `invoke`/`handle`. Main→renderer → `webContents.send`. Never `ipcRenderer.sendSync`. **[consensus]**
- Recording chunks flow renderer → main as `Uint8Array` on `MediaRecorder`'s `ondataavailable` (timeslice 1000 ms); main appends to an open write stream. Keeps the whole video out of renderer memory. **[required for long recordings]**
- **There is deliberately no `capture:save` channel.** Every capture handler writes the file, the thumbnail and the index entry (atomically, §4) *before* it resolves. A capture therefore cannot exist in the UI without existing on disk, and there is no window in which an unsaved capture can be lost. **[required]**
- **Sender-derived trust.** `capture:commitRegion` / `capture:cancelRegion` / `capture:getFreezeFrame` are only accepted from a `webContents` that main itself registered as an overlay; the authoritative `displayId` comes from that registration, not from the payload (the payload value is compared and a mismatch is rejected). **[required]**
- **Region capture lifecycle.** Main holds a single `pendingRegionCapture` slot. Two initiators exist: `capture:beginRegion` from the library UI (resolves the promise with the record, or `null`), and a global hotkey with no caller (result is delivered as a `capture:opened` event instead). A `beginRegion` while a capture is already pending is rejected immediately. If overlays are destroyed without commit or cancel (display change, crash, focus loss), main resolves the pending promise with `null` so the UI can never hang. **[required]**

### 1.4 `capture://` protocol **[required]**

With `webSecurity: true` and the dev renderer served from `http://localhost:5173`, `file://` loads are blocked. Main registers a scheme via `protocol.registerSchemesAsPrivileged` before `app.ready` and serves it with `protocol.handle('capture', ...)`:

- `capture://img/<id>` → full capture file
- `capture://thumb/<id>` → thumbnail
- `capture://frozen/<displayId>?t=<nonce>` → in-memory freeze frame (overlay only)

**[ASSUMPTION — verify]** Whether `<video>` scrubbing over `capture://` requires `stream: true` (range-request support) in `registerSchemesAsPrivileged`. If omitted and it is required, recordings play but cannot be seeked — a confusing bug to chase later. Test seeking on a long recording early.

The handler resolves the id through the index, then verifies the resolved path is inside `userData` before reading — never concatenate the URL into a path. **[required]**

---

## 2. How capture actually works on Windows

### 2.1 Stills — main process only

`desktopCapturer.getSources({ types: ['screen'|'window'], thumbnailSize })`. Renderer access to `desktopCapturer` was removed in Electron 17, so this is main-side by necessity. Requesting `thumbnailSize` at the display's full pixel size returns a full-resolution `NativeImage` — that *is* the screenshot. No `getUserMedia` is involved in stills at all.

- Full pixel size = `display.bounds.{width,height} * display.scaleFactor`.
- Map source → display via `source.display_id` (string) against `screen.getAllDisplays()`.
- Encode with `image.toPNG()`; crop with `image.crop(rect)`.

**[ASSUMPTION — verify at implementation]** Fidelity and latency of full-resolution `thumbnailSize` on multi-monitor mixed-DPI Windows have historically been flaky. Verify on a 4K + 1080p mixed-scaling rig early; if it degrades, fall back to per-display capture with an explicit `types: ['screen']` call scoped to one display.

**[ASSUMPTION — verify]** That `display_id` is reliably populated on Windows in current Electron. Fallback if not: match by comparing source thumbnail aspect/size to display bounds, or capture displays one at a time in `screen.getAllDisplays()` order.

### 2.2 Region overlay — freeze-frame **[consensus]**

Order of operations, and the ordering is the whole point:

1. Hotkey → main captures a full-resolution bitmap of **every** display via `desktopCapturer`, holds them in memory.
2. Main opens **one overlay window per display**, each positioned at that display's DIP `bounds`.
3. Each overlay renders its own frozen bitmap, full-bleed, with a dark mask; the user drags a selection, which punches a hole in the mask. Magnifier and pixel readout come free because the pixels are already local.
4. On commit, the overlay sends `capture:commitRegion` with a DIP rect; main crops the *already-captured* bitmap and destroys all overlays.

Why this rather than a live transparent overlay: a transparent live overlay must be hidden before capturing, which is racy and can capture the overlay itself or a stale frame — and it sidesteps Windows transparency/compositing quirks entirely, because **the overlay does not need `transparent: true`** — it is an opaque window showing a screenshot.

Overlay `BrowserWindow` options: `frame: false`, `alwaysOnTop: true` with level `'screen-saver'`, `skipTaskbar: true`, `hasShadow: false`, `resizable: false`, `movable: false`, `fullscreenable: false`, `x/y/width/height` from the display's DIP bounds. Escape and right-click cancel all overlays.

**DPI conversion — the single most likely bug in this app. [required]**

`screen` APIs are in DIP; the bitmap is in physical pixels.

```
pixelRect = {
  x:      round((dipRect.x - display.bounds.x) * display.scaleFactor),
  y:      round((dipRect.y - display.bounds.y) * display.scaleFactor),
  width:  round(dipRect.width  * display.scaleFactor),
  height: round(dipRect.height * display.scaleFactor),
}
```

Do the conversion in exactly one function in main. A rect that skips it is off by 25 % at 125 % scaling. Clamp to bitmap bounds; reject zero-area rects.

Per-display overlays (rather than one window spanning the virtual desktop) are chosen because a single spanning window gets one `scaleFactor` from its host display and mis-scales everything on the others.

### 2.3 Recording — renderer

Main: `session.defaultSession.setDisplayMediaRequestHandler((req, cb) => cb({ video: chosenSource, audio: 'loopback' }))`, where `chosenSource` comes from our own picker (`capture:listSources`) rather than the OS one. Renderer: `navigator.mediaDevices.getDisplayMedia({ video: true, audio: wantAudio })` → `MediaRecorder` → chunks over IPC.

The legacy `getUserMedia` + `chromeMediaSource: 'desktop'` / `chromeMediaSourceId` constraint form still works and is the fallback, but design to `setDisplayMediaRequestHandler`. **[consensus]**

- **v1 ships WebM** (`video/webm;codecs=vp9` → vp8 → default). MP4 export is deferred; the known cost is bundling ffmpeg, which conflicts with the zero-native-modules rule (a sidecar ffmpeg.exe binary, ~80 MB, is the escape hatch if the requirement returns). This is a real scope tradeoff, stated as such. **[required, derived from §0.2]**
- `MediaRecorder` lives in a **dedicated hidden recorder window** with `backgroundThrottling: false`, so recording survives the user minimising or closing the library window. Without that flag, recording stutters on focus loss. **[required]**

**[ASSUMPTION — verify]** `audio: 'loopback'` availability/behaviour in `setDisplayMediaRequestHandler` (it is Windows-only). Degrade to video-only with a visible notice if unavailable.

**[ASSUMPTION — verify]** Whether current Chromium's `MediaRecorder` offers any usable MP4/H.264 mime type. Some codec combos exist; do not depend on it. Gate on `MediaRecorder.isTypeSupported`.

---

## 3. Security posture — do not get this wrong

Every `BrowserWindow` (main, overlay, recorder), no exceptions:

```
contextIsolation: true
nodeIntegration: false
nodeIntegrationInWorker: false
nodeIntegrationInSubFrames: false
sandbox: true
webSecurity: true
allowRunningInsecureContent: false
preload: <the one preload>
```

**The trap:** `sandbox: true` means the preload **cannot** `require('fs')` or `require('path')` — only `electron`'s `ipcRenderer` and `contextBridge`. This is correct, not a limitation: all filesystem work belongs in main. Do **not** flip `sandbox: false` to work around it. **[required]**

Also required:
- Never expose `ipcRenderer` itself, and never expose a generic `invoke(channel, ...)`. Expose named methods only.
- `on` is wrapped with an allowlist of `IpcEvents` keys; the listener receives the payload only, never the `IpcRendererEvent`.
- Every `handle` validates its payload shape/ranges in main before touching disk. Ids must match a uuid regex and resolve through the index — never used as a path segment directly.
- `webContents.setWindowOpenHandler` → `{ action: 'deny' }`; intercept `will-navigate` for anything off-origin and route to `shell.openExternal` only for `https:`.
- CSP on the renderer HTML: `default-src 'self'; img-src 'self' capture: data: blob:; media-src 'self' capture: blob:; script-src 'self'`.
- No remote content is ever loaded into a `BrowserWindow`.

Preload surface (the complete API — anything not here does not exist to the renderer):

```ts
export interface AppApi {
  capture: {
    fullscreen(displayId?: number): Promise<CaptureRecord>;
    listSources(kinds: SourceKind[]): Promise<CaptureSource[]>;
    window(sourceId: string): Promise<CaptureRecord>;
    beginRegion(): Promise<CaptureRecord | null>;
    commitRegion(p: { displayId: number; rect: Rect }): Promise<void>;
    cancelRegion(): Promise<void>;
    getFreezeFrame(): Promise<FreezeFrame>;
  };
  record: {
    start(p: { sourceId: string; audio: boolean }): Promise<{ id: CaptureId }>;
    chunk(p: { id: CaptureId; data: Uint8Array }): Promise<void>;
    stop(p: { id: CaptureId; durationMs: number; width: number; height: number }): Promise<CaptureRecord>;
    abort(p: { id: CaptureId }): Promise<void>;
  };
  library: {
    list(p?: { search?: string; tag?: string }): Promise<CaptureRecord[]>;
    get(id: CaptureId): Promise<CaptureRecord | null>;
    delete(ids: CaptureId[]): Promise<void>;
    rename(p: { id: CaptureId; title: string }): Promise<CaptureRecord>;
    revealInExplorer(id: CaptureId): Promise<void>;
  };
  annotations: {
    load(id: CaptureId): Promise<AnnotationDoc | null>;
    save(p: { id: CaptureId; doc: AnnotationDoc; thumbnailPng?: Uint8Array }): Promise<CaptureRecord>;
  };
  exportTo: {
    save(req: ExportRequest): Promise<{ path: string } | null>;
    clipboard(p: { id: CaptureId; flattenedPng?: Uint8Array }): Promise<void>;
  };
  on<K extends keyof IpcEvents>(channel: K, cb: (payload: IpcEvents[K]) => void): () => void;
}
declare global { interface Window { api: AppApi } }
```

---

## 4. Storage layout

Root: `app.getPath('userData')` → `%APPDATA%/Nawi/`.

```
userData/
  captures/2026/08/<id>.png | <id>.webm     # immutable originals, YYYY/MM sharding
  thumbs/<id>.jpg                           # 320px long edge, jpeg q80
  annotations/<id>.annotations.json         # sidecar, §5
  library.json                              # CaptureLibraryIndex
  settings.json
  logs/
```

Index record shape = `CaptureRecord` / `CaptureLibraryIndex` in §1.2.

**No database. [decision, justified]** Single user, single writer, no concurrency, and no query beyond in-memory sort/filter/substring-search — a 5 k-item index is roughly 2 MB of JSON, loaded once at startup and held in memory. The stronger argument is §0.2: `better-sqlite3` is a native module and would put a node-gyp rebuild on the critical path of `npm install` on Node 26. Revisit above ~10 k items or if full-text/OCR search is added.

**Required durability rules:**
- Atomic write: serialise to `library.json.tmp`, `fsync`, then `fs.rename` over `library.json`. A crash mid-write to the real file destroys the entire library. **[required]**
- Writes debounced 500 ms and always flushed on `before-quit`.
- Startup: if `library.json` fails to parse, rename it to `library.corrupt-<ts>.json` and rebuild by scanning `captures/` — never start from an empty index that a subsequent write would make permanent. **[required]**
- Delete = remove index entry, then unlink file/thumb/sidecar. Orphan files are tolerable; orphan index entries are not — so index first.

Files are `<id>.png`, never user-supplied titles: titles are display-only and never touch the filesystem.

---

## 5. Annotation data model

Plain serialisable data, discriminated union, **no class instances** (they must survive `JSON.stringify` and structured clone).

```ts
export type ShapeId = string;
export type Point = { x: number; y: number };

/** ALL coordinates are in ORIGINAL IMAGE PIXEL space — never canvas or
 *  screen space — so zoom/pan can never corrupt stored geometry. */
interface ShapeBase {
  id: ShapeId;
  z: number;                  // paint order, ascending
  locked?: boolean;
  hidden?: boolean;
  rotation?: number;          // radians, about the shape's bbox centre
}

export interface StrokeStyle { color: string; width: number; opacity: number;
                               dash?: 'solid' | 'dashed' }
export interface FillStyle   { color: string; opacity: number }

export type Shape =
  | ({ type: 'arrow';  from: Point; to: Point; stroke: StrokeStyle;
       head: 'triangle' | 'line'; headSize: number;
       curve?: Point }                                            & ShapeBase)
  | ({ type: 'rect';    rect: Rect; stroke?: StrokeStyle; fill?: FillStyle;
       cornerRadius?: number }                                    & ShapeBase)
  | ({ type: 'ellipse'; rect: Rect; stroke?: StrokeStyle; fill?: FillStyle } & ShapeBase)
  | ({ type: 'text';    rect: Rect; text: string; color: string;
       fontFamily: string; fontSize: number;
       bold?: boolean; italic?: boolean;
       align: 'left' | 'center' | 'right';
       background?: FillStyle; autoSize: boolean }                & ShapeBase)
  | ({ type: 'highlighter'; points: Point[]; color: string;
       width: number; opacity: number }                           & ShapeBase)
  | ({ type: 'obscure';  rect: Rect; mode: 'blur' | 'pixelate';
       intensity: number /* 1..100 */ }                           & ShapeBase)
  | ({ type: 'step';     center: Point; radius: number;
       fill: FillStyle; textColor: string; group?: string;
       /** NOT stored: the displayed number is derived at render time from
        *  the ordinal position of this shape among same-group 'step'
        *  shapes sorted by z — so deleting #2 renumbers automatically. */
     }                                                            & ShapeBase);

export interface AnnotationDoc {
  version: 1;
  captureId: CaptureId;
  /** Source image pixel dimensions the coordinates were authored against.
   *  A mismatch on load means the source changed -> refuse and warn. */
  sourceWidth: number;
  sourceHeight: number;
  /** Document-level transform. There is exactly ONE crop and it is NOT a
   *  shape — modelling it as a shape is a mistake found late. Applied at
   *  render/export after shapes are painted in source space. */
  crop?: Rect;
  shapes: Shape[];
  updatedAt: string;
}
```

**Undo/redo: full-document snapshot stack.** `{ past: AnnotationDoc[]; present: AnnotationDoc; future: AnnotationDoc[] }`, `past` capped at 50 (drop oldest). One snapshot is committed **on gesture end** (pointer-up, text-commit, property-change-blur), never per `mousemove`; in-flight drags mutate a transient preview outside the doc.

Justification **[preference, deliberate]**: the document is kilobytes of JSON, so snapshotting is cheap and *impossible to get subtly wrong*, whereas command-pattern or patch-based undo is a week of inverse-operation bugs for no user-visible benefit at this size. `version: 1` gives cheap forward migration.

Rendering is a pure function of `(sourceImage, AnnotationDoc, viewport)`. `obscure` shapes read from the source image beneath them, so they must be painted from the pristine source layer, not from the already-composited canvas — otherwise stacked blurs compound.

---

## 6. Build & packaging

**`electron-vite` + `electron-builder`. [consensus]** electron-vite gives the three build targets (main / preload / renderer), correct externalisation of Electron builtins, main-process restart and renderer HMR from one `electron.vite.config.ts`. Hand-rolling three Vite configs is a day of yak-shaving for no gain. Packaging: `electron-builder`, NSIS target on Windows.

Dependency budget (deliberately small): runtime — `react`, `react-dom`, plus a canvas layer (`konva` + `react-konva`, or hand-rolled 2D canvas; **[preference]**, defer to the implementer, but nothing native either way). Dev — `electron`, `electron-vite`, `vite`, `electron-builder`, `typescript`, `@types/*`. No state library beyond React context/reducer at this size.

```
src/
  main/      index.ts, windows/, capture/, storage/, ipc/, protocol.ts
  preload/   index.ts
  renderer/  main/  overlay/  recorder/     # three html entries
  shared/    ipc.ts, annotations.ts, types.ts
```

Scripts:

```json
{
  "dev":        "electron-vite dev",
  "build":      "npm run typecheck && electron-vite build",
  "preview":    "electron-vite preview",
  "typecheck":  "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
  "package":    "npm run build && electron-builder --win --publish never",
  "package:dir":"npm run build && electron-builder --win --dir"
}
```

`"build"` runs typecheck first so the shared IPC contract is enforced at build time rather than at runtime.

**[ASSUMPTION — verify first thing]** electron-vite and electron-builder installing and running cleanly on Node 26 / npm 12 specifically. Both are widely used but Node 26 is very new. Verify by scaffolding a hello-world that reaches `npm run package:dir` **before** any feature work — this is the highest-risk unknown in the whole plan and it is cheap to retire.

---

## 7. Assumptions register (verify at implementation, do not treat as fact)

| # | Assumption | Risk if wrong | Fallback |
|---|---|---|---|
| 1 | Full-resolution `thumbnailSize` is accurate and fast on mixed-DPI multi-monitor Windows | Blurry or slow stills | Per-display capture calls |
| 2 | `source.display_id` populates reliably on Windows | Cannot map source → display; wrong DPI | Ordered capture / bounds matching |
| 3 | `audio: 'loopback'` works in `setDisplayMediaRequestHandler` on Windows | No system audio | Video-only with notice |
| 4 | No dependable MP4/H.264 `MediaRecorder` mime type | MP4 export impossible in v1 | Ship WebM; ffmpeg sidecar later |
| 5 | electron-vite + electron-builder are clean on Node 26 | Toolchain rework | Pin Node 22 LTS via `.nvmrc`, or hand-rolled Vite configs |
| 6 | `capture://` needs `stream: true` for `<video>` seeking | Recordings play but cannot be scrubbed | Add the flag; worst case serve recordings from a small localhost range server |

## 8. Handoff

- **software-engineer** — retire Assumption 5 first (scaffold → `package:dir`), then `src/shared/ipc.ts`, then main-side capture + storage, then editor. Non-negotiables: §3 in full, the DPI conversion in §2.2, atomic index writes in §4, no image buffers over IPC except `flattenedPng`.
- **security-engineer** — review the trust boundary: preload surface (§3), `capture://` path resolution, CSP, IPC payload validation.
- **performance-engineer** — NFR table in §0 is the target set; recording stutter under focus loss and the 4K freeze-frame latency are the two to measure.
- **ux-designer** — overlay interaction (magnifier, snapping, window-highlight-on-hover) and editor tool affordances are theirs; this note fixes only the data model, not the UI. **Known v1 limitation to design around:** hover-to-highlight-a-window (a headline Competitor A interaction) is not reachable — Electron does not expose foreign window bounds, so window capture goes through a source picker list instead. Treat that as a decision, not a surprise.
- **database-engineer** — not engaged; §4 justifies no DB. Re-engage if the >10 k-item threshold or full-text search arrives.

ADR: this document *is* ADR-001 for the project. Copy to `.claude/memory/nawi/decisions/` when that tree is created; supersede rather than edit if a decision here is reversed.
