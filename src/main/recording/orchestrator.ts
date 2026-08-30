/**
 * Main-process orchestration for recording.
 *
 * Three surfaces, deliberately separate windows:
 *
 *  - **recorder** — hidden, `backgroundThrottling: false`. Owns
 *    `getDisplayMedia`/`getUserMedia`/`MediaRecorder`. It lives here rather than
 *    in the main window because a background or minimised renderer is throttled:
 *    timers coalesce, `ondataavailable` starves, and the recording stutters or
 *    stalls. Nothing about the main window's visibility can reach it now.
 *  - **HUD** — always-on-top, ≤220×64, draggable, edge-snapping, excluded from
 *    the capture (UX-REC.1/2).
 *  - **tray** — a red dot so an active recording is visible when the HUD is
 *    minimised or behind something (UX-REC.3).
 *
 * The renderer is untrusted on both sides of this file. Data-plane channels
 * (`record:begin`, `record:chunk`, `record:finalize`, …) are answered **only**
 * for the recorder window's own `webContents`, so a compromised main window
 * cannot open a file handle or append bytes.
 */

import { BrowserWindow, Tray, app, nativeImage, screen, type NativeImage } from 'electron'
import { IPC } from '@shared/ipc'
import {
  isRecordCommand,
  idleStatus,
  type RecordingStatus,
  type StartRecordingOptions,
  type TrackSelection
} from '@shared/recording'
import type {
  BeginRecordingRequest,
  FinalizeRecordingRequest,
  LibraryItem,
  RecoverableRecordingInfo
} from '@shared/types'
import * as library from '../library'
import * as store from './store'

/** What the orchestrator needs from `index.ts`, injected so neither imports the other. */
export interface RecordingHost {
  /** Creates a window with the app's hardened webPreferences and diagnostics attached. */
  createWindow(options: Electron.BrowserWindowConstructorOptions, label: string): BrowserWindow
  /** Loads one of the renderer entry points into a window. */
  loadPage(win: BrowserWindow, page: 'index' | 'overlay' | 'recorder' | 'hud', query?: string): void
  /** Arms `setDisplayMediaRequestHandler` for the next request. */
  armDisplayMedia(sourceId: string, withAudio: boolean): void
  mainWindow(): BrowserWindow | null
}

/** HUD geometry. UX-REC.1 caps this at 220×64; the values are the cap, not a suggestion. */
const HUD_WIDTH = 220
const HUD_HEIGHT = 64
/** Distance from a screen edge at which the HUD snaps flush to it. */
const HUD_SNAP_PX = 24
const HUD_MARGIN = 16

let host: RecordingHost | null = null
let recorderWindow: BrowserWindow | null = null
let hudWindow: BrowserWindow | null = null
let tray: Tray | null = null
let trayTimer: NodeJS.Timeout | null = null
let trayPhase = false

/** Last status the recorder published. A window opening late asks for this. */
let status: RecordingStatus = idleStatus()
/**
 * The renderer-origin failure already broadcast for the current recording
 * attempt, so a repeat cannot be turned into a second toast, view switch and
 * card. Cleared when a new recording starts, which is what keeps this a
 * per-attempt guard: it can never swallow the report for a *different* attempt,
 * including the retry the recovery card offers.
 */
let reportedFailure: string | null = null

function requireHost(): RecordingHost {
  if (!host) throw new Error('recording orchestrator is not installed')
  return host
}

/* ------------------------------------------------------------------ *
 * Payload validation — everything below crossed a trust boundary
 * ------------------------------------------------------------------ */

function asTrackSelection(v: unknown): TrackSelection {
  const t = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  // Only a real `true` enables a track. Coercion here would silently turn on a
  // microphone the user never asked for.
  return { system: t.system === true, mic: t.mic === true, camera: t.camera === true }
}

function asStartOptions(v: unknown): StartRecordingOptions {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const sourceId = typeof o.sourceId === 'string' ? o.sourceId : ''
  // The id is handed straight to desktopCapturer's matcher, which only ever
  // compares it against real source ids — but bound the length so a megabyte
  // string cannot be parked in main's memory.
  if (!sourceId || sourceId.length > 512) throw new Error('a capture source is required')
  return { sourceId, tracks: asTrackSelection(o.tracks), countdown: o.countdown === true }
}

function clampNumber(v: unknown, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : 0
}

function sanitizeStatus(v: unknown): RecordingStatus {
  const s = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const phases = ['idle', 'countdown', 'recording', 'paused', 'stopping', 'error']
  const rawTracks = Array.isArray(s.tracks) ? s.tracks.slice(0, 8) : []
  return {
    phase: (phases.includes(s.phase as string) ? s.phase : 'idle') as RecordingStatus['phase'],
    elapsedMs: clampNumber(s.elapsedMs, 24 * 60 * 60 * 1000),
    countdown: clampNumber(s.countdown, 10),
    tracks: rawTracks.map((t) => {
      const r = (typeof t === 'object' && t !== null ? t : {}) as Record<string, unknown>
      const level = typeof r.level === 'number' && Number.isFinite(r.level) ? Math.min(Math.max(r.level, 0), 1) : null
      return {
        kind: (['screen', 'system', 'mic', 'camera'].includes(r.kind as string) ? r.kind : 'screen') as RecordingStatus['tracks'][number]['kind'],
        enabled: r.enabled === true,
        live: r.live === true,
        muted: r.muted === true,
        level,
        error: typeof r.error === 'string' ? r.error.slice(0, 500) : null
      }
    }),
    chapters: clampNumber(s.chapters, 10_000),
    micSilent: s.micSilent === true,
    container: s.container === 'mp4' || s.container === 'webm' ? s.container : null,
    error: typeof s.error === 'string' ? s.error.slice(0, 500) : null
  }
}

/* ------------------------------------------------------------------ *
 * Windows
 * ------------------------------------------------------------------ */

/** The hidden recorder window, created on first use and then kept alive. */
async function ensureRecorderWindow(): Promise<BrowserWindow> {
  if (recorderWindow && !recorderWindow.isDestroyed()) return recorderWindow
  const h = requireHost()
  const win = h.createWindow(
    {
      width: 480,
      height: 320,
      show: false,
      skipTaskbar: true,
      // The whole point of this window. A throttled renderer starves
      // MediaRecorder's data callback, which is the "recording stutters when
      // minimised" bug, and it is also what makes chunk-to-disk unreliable.
      webPreferences: { backgroundThrottling: false }
    },
    'recorder'
  )
  recorderWindow = win
  win.on('closed', () => {
    recorderWindow = null
  })

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the recording engine did not start in time')), 15_000)
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer)
      resolve()
    })
    win.webContents.once('did-fail-load', (_e, _code, desc) => {
      clearTimeout(timer)
      reject(new Error(`the recording engine failed to load: ${desc}`))
    })
  })
  h.loadPage(win, 'recorder')
  await ready
  return win
}

/**
 * Excludes the HUD from the recording (UX-REC.1).
 *
 * `setContentProtection(true)` is the mechanism used. Excluding the HUD from
 * the *source* is not an option: the user records a whole screen, and a screen
 * source has no per-window exclusion list — so window-level protection is the
 * only lever available.
 *
 * **Not verified on this build.** Content protection on Windows has two
 * possible behaviours depending on OS version and compositor path: the window
 * is omitted from the capture entirely (what we want), or it is blacked out,
 * which would leave a black rectangle in the recording. Which one this machine
 * does needs a visual check of a recorded frame; nothing here establishes it.
 */
function applyHudExclusion(win: BrowserWindow): void {
  win.setContentProtection(true)
}

function hudStartPosition(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: Math.round(area.x + area.width / 2 - HUD_WIDTH / 2),
    y: area.y + area.height - HUD_HEIGHT - HUD_MARGIN
  }
}

/**
 * Places the HUD at (x, y), kept on-screen and snapped flush to a nearby edge
 * (UX-REC.1).
 *
 * Clamping happens before snapping: doing it the other way round would drag a
 * snapped window back off the edge it just snapped to.
 */
function snapHud(win: BrowserWindow, wantX: number, wantY: number): void {
  const b = win.getBounds()
  const area = screen.getDisplayNearestPoint({ x: wantX, y: wantY }).workArea
  let x = Math.min(Math.max(wantX, area.x), area.x + area.width - b.width)
  let y = Math.min(Math.max(wantY, area.y), area.y + area.height - b.height)
  if (x - area.x < HUD_SNAP_PX) x = area.x
  if (area.x + area.width - (x + b.width) < HUD_SNAP_PX) x = area.x + area.width - b.width
  if (y - area.y < HUD_SNAP_PX) y = area.y
  if (area.y + area.height - (y + b.height) < HUD_SNAP_PX) y = area.y + area.height - b.height
  if (x !== b.x || y !== b.y) win.setBounds({ ...b, x, y })
}

function ensureHudWindow(): BrowserWindow {
  if (hudWindow && !hudWindow.isDestroyed()) return hudWindow
  const h = requireHost()
  const pos = hudStartPosition()
  const win = h.createWindow(
    {
      ...pos,
      width: HUD_WIDTH,
      height: HUD_HEIGHT,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      // Focusable, because UX-A11Y.2 requires a keyboard path to pause and stop.
      focusable: true,
      backgroundColor: '#00000000',
      transparent: true,
      hasShadow: false,
      webPreferences: { backgroundThrottling: false }
    },
    'hud'
  )
  hudWindow = win
  applyHudExclusion(win)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.on('closed', () => {
    hudWindow = null
  })
  // Mouse dragging is `-webkit-app-region: drag` in the HUD's own CSS, which
  // main never sees; snapping on the resulting `moved` event is how the edge
  // snap applies to a drag as well as to the keyboard path.
  let snapTimer: NodeJS.Timeout | null = null
  win.on('moved', () => {
    if (snapTimer) clearTimeout(snapTimer)
    // Debounced: snapping on every intermediate move event fights the drag.
    snapTimer = setTimeout(() => {
      if (!win.isDestroyed()) {
        const b = win.getBounds()
        snapHud(win, b.x, b.y)
      }
    }, 120)
  })
  h.loadPage(win, 'hud')
  return win
}

function showHud(): void {
  const win = ensureHudWindow()
  if (win.isVisible()) return
  win.showInactive()
}

function hideHud(): void {
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.hide()
}

/* ------------------------------------------------------------------ *
 * Tray indicator (UX-REC.3)
 * ------------------------------------------------------------------ */

/**
 * A 16×16 dot drawn procedurally.
 *
 * Generated rather than shipped as a file so the tray needs no build asset and
 * no packaging rule — and so the two animation frames are guaranteed to differ
 * only in alpha, which is what makes the blink read as one dot pulsing rather
 * than two icons swapping.
 */
function dotIcon(alpha: number): NativeImage {
  const size = 16
  const radius = 5.5
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - size / 2
      const dy = y + 0.5 - size / 2
      const d = Math.sqrt(dx * dx + dy * dy)
      // One pixel of feathering, so the dot is not a jagged square at 16px.
      const coverage = Math.min(Math.max(radius + 0.5 - d, 0), 1)
      const a = Math.round(255 * coverage * alpha)
      const i = (y * size + x) * 4
      // BGRA, premultiplied — the format createFromBitmap expects.
      buf[i] = Math.round(0x25 * coverage * alpha)
      buf[i + 1] = Math.round(0x25 * coverage * alpha)
      buf[i + 2] = Math.round(0xd0 * coverage * alpha)
      buf[i + 3] = a
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

/**
 * Whether the user asked for less motion.
 *
 * Main has no `prefers-reduced-motion` API, so this asks a live renderer. A
 * failure resolves to `false` rather than throwing: the indicator must appear
 * either way, and a static dot is the safe answer only for people who asked
 * for it.
 */
async function prefersReducedMotion(): Promise<boolean> {
  const win = requireHost().mainWindow() ?? recorderWindow
  if (!win || win.isDestroyed()) return false
  try {
    return await win.webContents.executeJavaScript(
      'window.matchMedia("(prefers-reduced-motion: reduce)").matches'
    )
  } catch {
    return false
  }
}

function stopTray(): void {
  if (trayTimer) clearInterval(trayTimer)
  trayTimer = null
  tray?.destroy()
  tray = null
}

async function updateTray(next: RecordingStatus): Promise<void> {
  const active = next.phase === 'recording' || next.phase === 'paused' || next.phase === 'countdown'
  if (!active) {
    stopTray()
    return
  }

  if (!tray) {
    tray = new Tray(dotIcon(1))
    // UX-A11Y.4: the state is never carried by the red colour alone.
    tray.setToolTip('Nawi — recording')
  }
  tray.setToolTip(
    next.phase === 'paused' ? 'Nawi — recording paused' : 'Nawi — recording'
  )

  // Paused is a *static* dot in every case: a pulsing "paused" indicator reads
  // as still running, which is the opposite of what it means.
  const shouldAnimate = next.phase === 'recording' && !(await prefersReducedMotion())
  if (shouldAnimate && !trayTimer) {
    trayTimer = setInterval(() => {
      trayPhase = !trayPhase
      tray?.setImage(dotIcon(trayPhase ? 0.35 : 1))
    }, 600)
  }
  if (!shouldAnimate && trayTimer) {
    clearInterval(trayTimer)
    trayTimer = null
    tray.setImage(dotIcon(next.phase === 'paused' ? 0.5 : 1))
  }
}

/* ------------------------------------------------------------------ *
 * Status fan-out
 * ------------------------------------------------------------------ */

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function publish(next: RecordingStatus): void {
  status = next
  broadcast(IPC.recordingStatus, next)
  void updateTray(next)
  if (next.phase === 'idle' || next.phase === 'error') hideHud()
  else showHud()
}

/** Every path that ends a recording routes through here, so nothing ends silently. */
function fail(message: string): void {
  console.error('[recording]', message)
  broadcast(IPC.recordingFailed, message)
  publish({ ...idleStatus(), error: message })
}

/* ------------------------------------------------------------------ *
 * Recovery (FR-REC.3)
 * ------------------------------------------------------------------ */

function toInfo(r: Awaited<ReturnType<typeof store.findRecoverable>>[number]): RecoverableRecordingInfo {
  return {
    id: r.id,
    startedAt: r.manifest.startedAt,
    container: r.manifest.container,
    size: r.size,
    estimatedDurationMs: r.estimatedDurationMs,
    chapters: r.manifest.chapters
  }
}

async function recover(id: string): Promise<LibraryItem> {
  const found = (await store.findRecoverable()).find((r) => r.id === id)
  if (!found) throw new Error('that recording is no longer available to recover')

  const item = await library.save({
    kind: 'video',
    captureKind: 'fullscreen',
    adoptFile: found.mediaPath,
    width: found.manifest.width,
    height: found.manifest.height,
    durationMs: found.estimatedDurationMs,
    container: found.manifest.container,
    chapters: found.manifest.chapters,
    recovered: true,
    name: `Recovered recording ${found.manifest.startedAt.replace(/[:.]/g, '-').replace('T', ' ').slice(0, 19)}`
  })
  // Commit only after the library owns the bytes: a crash in between must leave
  // the recording recoverable again rather than losing it to a stale marker.
  await store.commit(id)
  await store.discard(id)
  return item
}

/* ------------------------------------------------------------------ *
 * Install
 * ------------------------------------------------------------------ */

/** True when `sender` is the hidden recorder window, the only data-plane client. */
function isRecorder(sender: Electron.WebContents): boolean {
  return recorderWindow !== null && !recorderWindow.isDestroyed() && recorderWindow.webContents.id === sender.id
}

export function install(
  h: RecordingHost,
  handle: <T>(channel: string, fn: (...args: never[]) => Promise<T> | T) => void,
  handleWithSender: <T>(
    channel: string,
    fn: (sender: Electron.WebContents, ...args: never[]) => Promise<T> | T
  ) => void
): void {
  host = h

  /* --- control plane --------------------------------------------- */

  handle(IPC.startRecording, async (raw: unknown) => {
    if (status.phase !== 'idle' && status.phase !== 'error') {
      throw new Error('A recording is already in progress')
    }
    const options = asStartOptions(raw)
    // A new attempt: whatever the last one reported must not suppress this
    // one's failure, even if it fails identically.
    reportedFailure = null
    const win = await ensureRecorderWindow()
    // The HUD comes up before the first frame so the countdown has somewhere to
    // render, and so the user is never recording with nothing on screen saying so.
    showHud()
    win.webContents.send(IPC.recordRequest, options)
    return null
  })

  handle(IPC.recordCommand, (command: unknown) => {
    if (!isRecordCommand(command)) throw new Error('unknown recording command')
    if (!recorderWindow || recorderWindow.isDestroyed()) {
      // Nothing is recording; clear any stale HUD rather than leaving the user
      // with a pause button that does nothing.
      publish(idleStatus())
      return null
    }
    recorderWindow.webContents.send(IPC.recordDispatch, command)
    return null
  })

  handle(IPC.getRecordingStatus, () => status)

  handle(IPC.moveHud, (dx: unknown, dy: unknown) => {
    const win = hudWindow
    if (!win || win.isDestroyed()) return null
    const ddx = typeof dx === 'number' && Number.isFinite(dx) ? Math.round(dx) : 0
    const ddy = typeof dy === 'number' && Number.isFinite(dy) ? Math.round(dy) : 0
    const b = win.getBounds()
    snapHud(win, b.x + ddx, b.y + ddy)
    return null
  })

  /* --- data plane: recorder window only --------------------------- */

  handleWithSender(IPC.prepareRecording, (sender, sourceId: unknown, withAudio: unknown) => {
    if (!isRecorder(sender)) throw new Error('not permitted')
    if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 512) {
      throw new Error('a capture source is required')
    }
    requireHost().armDisplayMedia(sourceId, withAudio === true)
    return null
  })

  handleWithSender(IPC.beginRecording, async (sender, raw: unknown) => {
    if (!isRecorder(sender)) throw new Error('not permitted')
    const req = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<BeginRecordingRequest>
    if (typeof req.mimeType !== 'string' || req.mimeType.length > 200) {
      throw new Error('a recording mime type is required')
    }
    const { id } = await store.begin({
      mimeType: req.mimeType,
      width: clampNumber(req.width, 100_000),
      height: clampNumber(req.height, 100_000),
      tracks: asTrackSelection(req.tracks)
    })
    return { recordingId: id }
  })

  handleWithSender(IPC.recordChunk, async (sender, id: unknown, chunk: unknown) => {
    if (!isRecorder(sender)) throw new Error('not permitted')
    if (typeof id !== 'string') throw new Error('invalid recording id')
    if (!(chunk instanceof Uint8Array)) throw new Error('recording chunk must be a byte array')
    return store.appendChunk(id, chunk)
  })

  handleWithSender(IPC.markChapter, async (sender, id: unknown, atMs: unknown) => {
    if (!isRecorder(sender)) throw new Error('not permitted')
    if (typeof id !== 'string') throw new Error('invalid recording id')
    return store.addChapter(id, clampNumber(atMs, 24 * 60 * 60 * 1000))
  })

  handleWithSender(IPC.finalizeRecording, async (sender, raw: unknown) => {
    if (!isRecorder(sender)) throw new Error('not permitted')
    const req = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<FinalizeRecordingRequest>
    if (typeof req.recordingId !== 'string') throw new Error('invalid recording id')

    const closed = await store.close(req.recordingId)
    if (closed.bytes === 0) {
      await store.discard(req.recordingId)
      throw new Error('The recording stopped before any video was captured.')
    }
    const item = await library.save({
      kind: 'video',
      captureKind: 'fullscreen',
      adoptFile: closed.mediaPath,
      width: clampNumber(req.width, 100_000) || closed.manifest.width,
      height: clampNumber(req.height, 100_000) || closed.manifest.height,
      durationMs: clampNumber(req.durationMs, 24 * 60 * 60 * 1000),
      container: closed.manifest.container,
      chapters: closed.manifest.chapters
    })
    await store.commit(req.recordingId)
    await store.discard(req.recordingId)
    broadcast(IPC.recordingFinished, item)
    return item
  })

  handleWithSender(IPC.abortRecording, async (sender, id: unknown) => {
    if (!isRecorder(sender)) throw new Error('not permitted')
    if (typeof id !== 'string') throw new Error('invalid recording id')
    await store.discard(id)
    return null
  })

  handleWithSender(IPC.publishRecordingStatus, (sender, raw: unknown) => {
    if (!isRecorder(sender)) throw new Error('not permitted')
    publish(sanitizeStatus(raw))
    return null
  })

  /**
   * A renderer-origin failure, given the same treatment as a main-origin one.
   *
   * Gated on `isRecorder` like the rest of the data plane: any renderer being
   * able to broadcast "your recording failed" is a spoofable surface, not a
   * convenience.
   *
   * ## Why this does not copy `onRecorderGone`'s `phase === 'idle'` guard
   *
   * That guard is right there and wrong here. The engine sets `phase = 'idle'`
   * and publishes *before* it reports, so by the time this arrives main's own
   * status is normally already idle — an idle guard would drop the report the
   * card exists for. Worse, the status publish and this report travel on
   * different channels, so which arrives first is not even ordered: a guard on
   * phase would drop failures nondeterministically.
   *
   * ## What replaces it
   *
   * `fail()` only repaints: console, broadcast, publish(idle). It hides the HUD
   * and sets the tray to not-recording without stopping anything. A renderer
   * that reported a failure while still capturing would therefore have talked
   * main into suppressing the recording indicators of a capture still running —
   * which, in a screen-capture product, is the interesting attack rather than a
   * cosmetic bug. So the report also *ends* the capture: the engine is told to
   * stop through the same command channel the HUD's stop button uses.
   *
   * Residual, stated rather than papered over: a fully compromised recorder
   * renderer can ignore that dispatch and keep its own MediaRecorder running.
   * Main cannot reach inside a renderer to stop a MediaRecorder; what it can do
   * is refuse to keep persisting and refuse to let the UI lie for longer than
   * the round trip. Ending the capture from main entirely would mean destroying
   * the recorder window, which would also destroy the recoverable bytes of an
   * ordinary, honest failure — the FR-REC.3 case this whole path protects.
   */
  handleWithSender(IPC.reportRecordingFailure, (sender, raw: unknown) => {
    if (!isRecorder(sender)) throw new Error('not permitted')
    const message = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 2000) : null
    const text = message ?? 'The recording stopped because of an error.'

    /*
     * Repeat suppression, keyed on what this handler has already broadcast for
     * this attempt — deliberately NOT on `status`. The engine publishes its
     * failing status before it reports, so `status.error` already holds this
     * very message by the time the report arrives; keying on it suppressed the
     * first and only report of every start-path failure, which is the whole
     * defect this path exists to fix.
     *
     * The engine now reports a chunk failure once per recording, but main must
     * not depend on a renderer's restraint: each report costs the user a toast,
     * a forced view switch and a card, so an unthrottled renderer could pin
     * them on the capture view indefinitely.
     */
    if (reportedFailure === text) return null
    reportedFailure = text

    fail(text)
    // Not just repaint: end the capture. See the note above.
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.webContents.send(IPC.recordDispatch, 'stop')
    }
    return null
  })

  /* --- recovery ---------------------------------------------------- */

  handle(IPC.listRecoverableRecordings, async () => (await store.findRecoverable()).map(toInfo))
  handle(IPC.recoverRecording, (id: unknown) => {
    if (typeof id !== 'string') throw new Error('invalid recording id')
    return recover(id)
  })
  handle(IPC.discardRecoverableRecording, async (id: unknown) => {
    if (typeof id !== 'string') throw new Error('invalid recording id')
    await store.discard(id)
    return null
  })

  /* --- lifecycle --------------------------------------------------- */

  // Flush any open write stream on the way out, so a quit mid-recording leaves
  // a complete-as-possible file rather than a half-buffered one.
  app.on('will-quit', () => {
    stopTray()
    void store.closeAll()
  })
}

/**
 * Closes the recorder and HUD windows.
 *
 * Called when the main window closes. Without it, `window-all-closed` never
 * fires — the hidden recorder window is still a window — so on Windows the app
 * would keep running with no visible UI and no way to reach it.
 *
 * A recording in progress is the one exception: the windows stay, because the
 * recording is the user's work and the HUD is still on screen, so the app is
 * not invisible. Killing the engine here would silently end a recording the
 * user never asked to stop.
 */
export function shutdownWindows(): void {
  if (status.phase !== 'idle' && status.phase !== 'error') return
  stopTray()
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.destroy()
  if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.destroy()
}

/** Called when the recorder window dies unexpectedly, so the UI never wedges. */
export function onRecorderGone(reason: string): void {
  if (status.phase === 'idle') return
  fail(`The recording engine stopped unexpectedly (${reason}). Any recording in progress can be recovered from the library.`)
}

/**
 * Audio input devices, enumerated in the recorder window.
 *
 * Only a renderer can call `enumerateDevices`, and only one that already holds
 * microphone permission gets labels rather than empty strings — which is the
 * recorder window, not the main one. An unlabelled device is reported with a
 * positional name instead of being hidden, so the switcher still works before
 * permission is granted.
 */
export async function listAudioInputs(): Promise<Array<{ deviceId: string; label: string }>> {
  const win = recorderWindow
  if (!win || win.isDestroyed()) return []
  const raw: unknown = await win.webContents.executeJavaScript(
    `navigator.mediaDevices.enumerateDevices().then((ds) =>
       ds.filter((d) => d.kind === 'audioinput')
         .map((d, i) => ({ deviceId: d.deviceId, label: d.label || ('Microphone ' + (i + 1)) })))`
  )
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, 32)
    .map((d) => {
      const r = (typeof d === 'object' && d !== null ? d : {}) as Record<string, unknown>
      return {
        deviceId: typeof r.deviceId === 'string' ? r.deviceId.slice(0, 256) : '',
        label: typeof r.label === 'string' ? r.label.slice(0, 200) : ''
      }
    })
    .filter((d) => d.deviceId !== '')
}

export function currentStatus(): RecordingStatus {
  return status
}
