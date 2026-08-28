import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  shell,
  type NativeImage
} from 'electron'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { CAPTURE_SCHEME, IPC } from '@shared/ipc'
import { mediaFormat } from '@shared/types'
import type {
  AgentAccessState,
  AnnotationDoc,
  ExportRequest,
  IpcResult,
  LibraryItem,
  Rect,
  SaveRecordingRequest
} from '@shared/types'
import * as library from './library'
import * as capture from './capture'
import * as settings from './settings'
import { startMcpServer, type McpServerHandle } from './mcp/server'
import { HOTKEY_ACTIONS, hotkeysDiffer, type HotkeyAction, type Settings } from '@shared/settings'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

/** State for an in-flight region selection. */
interface RegionSession {
  windows: BrowserWindow[]
  frames: Map<number, NativeImage>
  /** webContents.id -> displayId, so an overlay's identity comes from main, not its payload. */
  displayByWc: Map<number, number>
  /** Takes ownership of settling. Returns false if someone else already has it. */
  claim: () => boolean
  finish: (item: LibraryItem | null) => void
}
let regionSession: RegionSession | null = null

/** Backstop so a wedged overlay can never strand the user with no visible window. */
const REGION_TIMEOUT_MS = 120_000

/** The source the renderer is about to record; consumed by the display-media handler. */
let pendingRecordingSourceId: string | null = null
/**
 * Whether that pending request asked for audio. Kept alongside the source id and
 * cleared with it — a stale `true` would silently add a loopback track to the next
 * recording the user asked to be silent.
 */
let pendingRecordingAudio = false

/**
 * The loopback MCP endpoint, or null when it could not start.
 *
 * Null is a real, reportable state rather than an error: a port problem must not
 * stop Nawi from launching, so the app runs with the agent interface down
 * and says so instead of failing to open a window.
 */
let mcpServer: McpServerHandle | null = null

/* ------------------------------------------------------------------ *
 * Protocol — file:// is unusable under webSecurity against a dev-server
 * renderer origin, so assets and freeze frames are served over capture://
 * ------------------------------------------------------------------ */

protocol.registerSchemesAsPrivileged([
  {
    scheme: CAPTURE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
  }
])

function registerProtocol(): void {
  protocol.handle(CAPTURE_SCHEME, async (request) => {
    const url = new URL(request.url)
    // capture://asset/<uuid>  |  capture://freeze/<displayId>
    const kind = url.hostname
    const key = url.pathname.replace(/^\/+/, '')

    try {
      if (kind === 'asset') {
        const item = await library.getItem(key)
        if (!item) return new Response('Not found', { status: 404 })
        // net.fetch streams the file, which matters for multi-hundred-MB recordings.
        return net.fetch(pathToFileURL(item.filePath).toString())
      }

      if (kind === 'freeze') {
        const img = regionSession?.frames.get(Number(key))
        if (!img) return new Response('Not found', { status: 404 })
        return new Response(new Uint8Array(img.toPNG()), {
          headers: { 'content-type': 'image/png' }
        })
      }
    } catch (err) {
      console.error('[protocol]', err)
      return new Response('Error', { status: 500 })
    }
    return new Response('Not found', { status: 404 })
  })
}

/* ------------------------------------------------------------------ *
 * IPC plumbing
 * ------------------------------------------------------------------ */

/** Wraps a handler so a thrown error becomes a typed failure instead of an unhandled rejection. */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<T>> => {
    try {
      return { ok: true, value: await fn(...(args as never[])) }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[ipc:${channel}]`, error)
      return { ok: false, error }
    }
  })
}

const webPreferences = {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false
} as const

function loadPage(win: BrowserWindow, page: 'index' | 'overlay', query = ''): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devServer) void win.loadURL(`${devServer}/${page}.html${query}`)
  else void win.loadFile(join(__dirname, `../renderer/${page}.html`), { search: query.replace(/^\?/, '') })
}

/**
 * Surfaces renderer-side failures in the terminal. Without this a broken preload
 * or a CSP violation shows up only as a silent blank window.
 */
function attachDiagnostics(win: BrowserWindow, label: string): void {
  if (app.isPackaged) return
  const wc = win.webContents
  wc.on('did-finish-load', () => console.log(`[${label}] loaded ${wc.getURL()}`))
  wc.on('did-fail-load', (_e, code, desc, url) =>
    console.error(`[${label}] FAILED ${code} ${desc} ${url}`)
  )
  wc.on('preload-error', (_e, file, err) => console.error(`[${label}] PRELOAD ${file}`, err))
  wc.on('render-process-gone', (_e, details) =>
    console.error(`[${label}] RENDERER GONE`, details.reason)
  )
  wc.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') {
      console.error(`[${label}:console:${details.level}] ${details.message}`)
    }
  })
}

function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    const sameOrigin = devServer && url.startsWith(devServer)
    if (!sameOrigin && !url.startsWith('file:')) {
      event.preventDefault()
      if (url.startsWith('https:')) void shell.openExternal(url)
    }
  })
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 660,
    show: false,
    backgroundColor: '#0a0c10',
    autoHideMenuBar: true,
    webPreferences
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  hardenWindow(mainWindow)
  attachDiagnostics(mainWindow, 'main-window')
  loadPage(mainWindow, 'index')
}

/* ------------------------------------------------------------------ *
 * Region select — freeze-frame overlays
 * ------------------------------------------------------------------ */

function closeRegionSession(): void {
  if (!regionSession) return
  const { windows } = regionSession
  regionSession = null
  for (const w of windows) if (!w.isDestroyed()) w.destroy()
}

/**
 * Captures every display first, then shows an opaque overlay per display
 * rendering that frozen bitmap. Because the overlay shows a screenshot rather
 * than live content, it needs no transparency and there is no hide-then-capture
 * race to lose.
 */
async function beginRegion(): Promise<LibraryItem | null> {
  if (regionSession) return null

  const wasVisible = mainWindow?.isVisible() ?? false
  if (wasVisible) mainWindow?.hide()
  // Let the compositor actually retire the window before we grab the screen.
  await new Promise((r) => setTimeout(r, 180))

  let frames: Map<number, NativeImage>
  try {
    frames = await capture.captureAllDisplays()
  } catch (err) {
    if (wasVisible) mainWindow?.show()
    throw err
  }

  return new Promise<LibraryItem | null>((resolve) => {
    let owner = false
    let done = false
    let timer: NodeJS.Timeout

    /**
     * Two-phase settle. `claim` hands exclusive ownership to the first caller, so
     * an Escape landing while `commitRegion` is mid-save can't cancel a capture
     * that has already been written to disk.
     */
    const claim = (): boolean => {
      if (owner || done) return false
      owner = true
      return true
    }
    const finish = (item: LibraryItem | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      closeRegionSession()
      if (wasVisible) {
        mainWindow?.show()
        mainWindow?.focus()
      }
      resolve(item)
    }

    timer = setTimeout(() => {
      if (claim()) {
        console.warn('[beginRegion] timed out waiting for a selection')
        finish(null)
      }
    }, REGION_TIMEOUT_MS)

    const displayByWc = new Map<number, number>()
    const windows: BrowserWindow[] = []
    for (const d of screen.getAllDisplays()) {
      const win = new BrowserWindow({
        x: d.bounds.x,
        y: d.bounds.y,
        width: d.bounds.width,
        height: d.bounds.height,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        hasShadow: false,
        fullscreenable: false,
        backgroundColor: '#000000',
        show: false,
        webPreferences
      })
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      win.once('ready-to-show', () => {
        win.show()
        win.focus()
      })
      hardenWindow(win)
      attachDiagnostics(win, `overlay:${d.id}`)

      // An overlay that never loads is never "closed", so without these the
      // promise would hang forever with the main window hidden — leaving the
      // user no visible window and no way back short of Task Manager.
      win.webContents.on('did-fail-load', (_e, _code, desc) => {
        console.error(`[overlay:${d.id}] failed to load: ${desc}`)
        if (claim()) finish(null)
      })
      win.webContents.on('render-process-gone', () => {
        if (claim()) finish(null)
      })

      displayByWc.set(win.webContents.id, d.id)
      loadPage(win, 'overlay', `?display=${d.id}`)
      windows.push(win)
    }

    regionSession = { windows, frames, displayByWc, claim, finish }
    // If every overlay somehow goes away, treat it as a cancel rather than hanging.
    for (const w of windows) w.on('closed', () => {
      if (regionSession && regionSession.windows.every((x) => x.isDestroyed())) {
        if (claim()) finish(null)
      }
    })
  })
}

/**
 * `senderWcId` is the authority on which display committed — the payload's
 * displayId is only cross-checked, never trusted, so a message from anything
 * other than a registered overlay is ignored.
 */
async function commitRegion(senderWcId: number, claimedDisplayId: number, rect: Rect): Promise<void> {
  const sessionRef = regionSession
  if (!sessionRef) return

  const displayId = sessionRef.displayByWc.get(senderWcId)
  if (displayId === undefined) {
    console.warn('[commitRegion] ignoring message from an unregistered sender')
    return
  }
  if (displayId !== claimedDisplayId) {
    console.warn('[commitRegion] payload displayId did not match the sender; ignoring')
    return
  }

  // Take ownership *before* the await, so a concurrent Escape can't cancel a
  // capture that is already being written to disk.
  if (!sessionRef.claim()) return

  try {
    const frame = sessionRef.frames.get(displayId)
    if (!frame) throw new Error('Freeze frame missing for that display')
    const display = capture.displayById(displayId)
    const size = frame.getSize()
    const pixels = capture.dipRectToPixels(rect, display, size)
    if (pixels.width < 1 || pixels.height < 1) {
      sessionRef.finish(null)
      return
    }
    const cropped = frame.crop(pixels)
    const item = await library.save({
      kind: 'image',
      captureKind: 'region',
      bytes: Buffer.from(cropped.toPNG()),
      width: pixels.width,
      height: pixels.height
    })
    sessionRef.finish(item)
  } catch (err) {
    console.error('[commitRegion]', err)
    sessionRef.finish(null)
  }
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

/** Shows the save dialog for an item, returning the chosen path or null on cancel. */
async function askSavePath(
  itemId: string,
  format: 'png' | 'jpg' | 'webm'
): Promise<string | null> {
  const item = await library.getItem(itemId)
  // Strip characters Windows rejects in filenames.
  const base = (item?.name ?? 'export').replace(/[\\/:*?"<>|]/g, '-')
  const filters =
    format === 'webm'
      ? [{ name: 'WebM Video', extensions: ['webm'] }]
      : format === 'jpg'
        ? [{ name: 'JPEG Image', extensions: ['jpg', 'jpeg'] }]
        : [{ name: 'PNG Image', extensions: ['png'] }]

  const opts = { defaultPath: `${base}.${format}`, filters }
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, opts)
    : await dialog.showSaveDialog(opts)
  return result.canceled || !result.filePath ? null : result.filePath
}

function registerIpc(): void {
  handle(IPC.listSources, (kinds: Array<'screen' | 'window'>) => capture.listSources(kinds))
  handle(IPC.listDisplays, () => capture.listDisplays())

  handle(IPC.captureFullscreen, async (displayId?: number) => {
    const display = displayId != null ? capture.displayById(displayId) : screen.getPrimaryDisplay()
    const wasVisible = mainWindow?.isVisible() ?? false
    if (wasVisible) mainWindow?.hide()
    await new Promise((r) => setTimeout(r, 180))
    try {
      const img = await capture.captureDisplay(display)
      const size = img.getSize()
      return await library.save({
        kind: 'image',
        captureKind: 'fullscreen',
        bytes: Buffer.from(img.toPNG()),
        width: size.width,
        height: size.height
      })
    } finally {
      if (wasVisible) {
        mainWindow?.show()
        mainWindow?.focus()
      }
    }
  })

  handle(IPC.captureWindow, async (sourceId: string) => {
    const img = await capture.captureWindowSource(sourceId)
    const size = img.getSize()
    return library.save({
      kind: 'image',
      captureKind: 'window',
      bytes: Buffer.from(img.toPNG()),
      width: size.width,
      height: size.height
    })
  })

  handle(IPC.beginRegion, () => beginRegion())

  // IPC.overlayInit is registered separately — it resolves per-window from the sender.

  ipcMain.on(IPC.commitRegion, (e, displayId: number, rect: Rect) => {
    void commitRegion(e.sender.id, displayId, rect)
  })
  ipcMain.on(IPC.cancelRegion, (e) => {
    const s = regionSession
    // Only a registered overlay may cancel, and only if nothing else has
    // already taken ownership of settling this session.
    if (!s || !s.displayByWc.has(e.sender.id)) return
    if (s.claim()) s.finish(null)
  })

  handle(IPC.prepareRecording, (sourceId: string, withAudio: boolean) => {
    pendingRecordingSourceId = sourceId
    pendingRecordingAudio = withAudio === true
    return null
  })

  handle(IPC.saveRecording, (req: SaveRecordingRequest) =>
    library.save({
      kind: 'video',
      captureKind: 'fullscreen',
      bytes: Buffer.from(req.data),
      width: req.width,
      height: req.height,
      durationMs: req.durationMs
    })
  )

  handle(IPC.listLibrary, () => library.listItems())
  handle(IPC.deleteLibraryItem, async (id: string) => {
    await library.deleteItem(id)
    return null
  })
  handle(IPC.renameLibraryItem, (id: string, name: string) => library.renameItem(id, name))
  handle(IPC.saveAnnotations, (id: string, doc: AnnotationDoc) => library.saveAnnotations(id, doc))

  handle(IPC.readItemBytes, async (id: string) => {
    const { bytes, mime } = await library.readItemBytes(id)
    return { data: new Uint8Array(bytes), mime }
  })

  handle(IPC.exportAs, async (req: ExportRequest) => {
    const target = await askSavePath(req.itemId, req.format)
    if (!target) return null
    await fs.writeFile(target, Buffer.from(req.data))
    return target
  })

  /**
   * Exports the stored asset unchanged. Main copies the file itself, so a
   * multi-hundred-megabyte recording never has to cross the IPC boundary —
   * and the renderer can't fetch() a custom scheme cross-origin anyway.
   */
  handle(IPC.exportOriginal, async (itemId: string) => {
    const item = await library.getItem(itemId)
    if (!item) throw new Error('That capture no longer exists')
    const format = mediaFormat(item.kind).ext
    const target = await askSavePath(itemId, format)
    if (!target) return null
    await fs.copyFile(item.filePath, target)
    return target
  })

  handle(IPC.copyImageToClipboard, async (data: Uint8Array) => {
    // Validate by decoding first, so a malformed buffer fails loudly here rather
    // than silently landing an empty image on the user's clipboard.
    const img = nativeImage.createFromBuffer(Buffer.from(data))
    if (img.isEmpty()) throw new Error('Could not decode image for clipboard')
    // Electron 44 replaced clipboard.writeImage with the W3C-style async API.
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })
    ])
    return null
  })

  handle(IPC.revealInFolder, async (id: string) => {
    const item = await library.getItem(id)
    if (!item) throw new Error('That capture no longer exists')
    shell.showItemInFolder(item.filePath)
    return null
  })

  /* --- UX-AGT.3 kill switch --------------------------------------- *
   * Backed by the settings layer, so the choice survives a restart. The MCP
   * dispatcher reads the same value per call, which is what makes a pause take
   * effect on the agent's very next call rather than the next session.
   * ---------------------------------------------------------------- */
  handle(IPC.getAgentAccess, () => agentAccessState())
  handle(IPC.setAgentAccess, async (paused: unknown) => {
    // The renderer's payload is untrusted like any other: only a real boolean
    // moves the switch, and anything else is a refusal rather than a coercion
    // that could accidentally *resume* agent access.
    if (typeof paused !== 'boolean') throw new Error('agent access state must be a boolean')
    await settings.updateSettings({ agentAccessPaused: paused })
    return agentAccessState()
  })

  handle(IPC.getSettings, () => settings.getSettings())
  // The patch is untrusted; `updateSettings` validates and merges it in main.
  handle(IPC.updateSettings, (patch: unknown) => settings.updateSettings(patch))
}

/** The kill-switch state the renderer renders. */
async function agentAccessState(): Promise<AgentAccessState> {
  const current = await settings.getSettings()
  return {
    paused: current.agentAccessPaused,
    endpoint: mcpServer ? { port: mcpServer.info.port, url: mcpServer.info.url } : null
  }
}

/**
 * Broadcasts to every window rather than just the main one: overlays share the
 * same preload, and a theme change that never reaches them is exactly the kind of
 * bug that only shows up on a second monitor.
 */
function broadcastSettings(next: Settings): void {
  const agent: AgentAccessState = {
    paused: next.agentAccessPaused,
    endpoint: mcpServer ? { port: mcpServer.info.port, url: mcpServer.info.url } : null
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(IPC.settingsChanged, next)
    // Sent alongside rather than derived in the renderer, so a pause toggled from
    // anywhere reaches every window without each one re-deriving it.
    win.webContents.send(IPC.agentAccessChanged, agent)
  }
}

/**
 * Binds the accelerators currently in settings, replacing whatever was bound
 * before. Still best-effort — another app may already own a chord — but now the
 * strings come from a user-editable file, so a malformed accelerator (which
 * `globalShortcut.register` throws on, rather than returning false) must not abort
 * the loop and silently cost the user their remaining hotkeys.
 */
async function registerShortcuts(): Promise<void> {
  const current = await settings.getSettings()
  globalShortcut.unregisterAll()

  const bind = (accel: string, action: string): void => {
    // An empty chord means the action was deliberately left unbound — either by
    // the user, or by collision resolution yielding it. Asking Electron to
    // register '' throws, so don't.
    if (!accel) return
    try {
      const ok = globalShortcut.register(accel, () => {
        mainWindow?.show()
        mainWindow?.focus()
        mainWindow?.webContents.send(IPC.shortcut, action)
      })
      if (!ok) console.warn(`[shortcut] could not register ${accel} for ${action}`)
    } catch (err) {
      console.warn(`[shortcut] could not register ${accel} for ${action}:`, err)
    }
  }

  for (const action of HOTKEY_ACTIONS) bind(current.hotkeys[action], action)
}

app.whenReady().then(() => {
  registerProtocol()

  // Our own picker chooses the source, so the OS picker never appears.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void (async () => {
        try {
          // The handler needs the real Electron source object, not our DTO.
          const wanted = pendingRecordingSourceId
          const wantsAudio = pendingRecordingAudio
          pendingRecordingSourceId = null
          pendingRecordingAudio = false
          const real = await desktopCapturer.getSources({ types: ['screen', 'window'] })
          const match = real.find((s) => s.id === wanted)
          // Deliberately no `?? real[0]` fallback: silently recording a
          // different source than the user picked is a confidentiality problem.
          // Denying the request surfaces a real error in the renderer instead.
          if (!match) {
            console.error('[displayMedia] requested source is no longer available')
            callback({})
            return
          }
          // System audio needs an explicit `audio` key. Omitting it — as this
          // handler used to — means the renderer's `audio: true` request is
          // answered video-only and every recording is silent, with nothing
          // anywhere reporting a problem. `'loopback'` is Windows-only; on other
          // platforms we degrade to video rather than passing a value Electron
          // does not support there.
          if (wantsAudio && process.platform === 'win32') {
            callback({ video: match, audio: 'loopback' })
          } else {
            if (wantsAudio) {
              console.warn(
                `[displayMedia] system audio is not supported on ${process.platform}; recording video only`
              )
            }
            callback({ video: match })
          }
        } catch (err) {
          console.error('[displayMedia]', err)
          callback({})
        }
      })()
    },
    { useSystemPicker: false }
  )

  registerIpc()

  // Each overlay resolves its own identity from its URL, so this is per-window.
  ipcMain.handle(IPC.overlayInit, (event): IpcResult<{ displayId: number; freezeUrl: string; scaleFactor: number }> => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window for overlay')
      const url = new URL(win.webContents.getURL())
      const displayId = Number(url.searchParams.get('display'))
      const display = capture.displayById(displayId)
      return {
        ok: true,
        value: {
          displayId,
          freezeUrl: `${CAPTURE_SCHEME}://freeze/${displayId}`,
          scaleFactor: display.scaleFactor
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * The agent interface. Started after IPC is registered so a tool call cannot
   * arrive before the handlers exist.
   *
   * `startMcpServer` resolves null instead of throwing on an operational
   * failure, and this is deliberately not awaited into the launch path: a wedged
   * bind must degrade the agent interface, never prevent the window from
   * appearing.
   */
  void startMcpServer()
    .then((handle) => {
      mcpServer = handle
      if (handle) {
        // FR-SEC.1: a *listening* loopback socket is not network egress. Nothing
        // leaves this machine because of it, so a local-only indicator must not
        // treat this as outbound traffic.
        console.log(`[mcp] agent endpoint listening on ${handle.info.url} (loopback only, no egress)`)
      } else {
        console.error('[mcp] agent endpoint is not available; MCP tool calls cannot reach this app')
      }
    })
    .catch((err: unknown) => {
      console.error('[mcp] agent endpoint failed to start', err)
    })

  createMainWindow()

  // Subscribed synchronously: an update landing before the first read resolved
  // would otherwise persist with nothing broadcast and no rebind.
  let bound: Record<HotkeyAction, string> | null = null
  settings.onSettingsChanged((next) => {
    broadcastSettings(next)
    // Re-binding tears down every chord, so only do it when a binding actually
    // moved — an unrelated theme change must not blink the hotkeys off.
    if (bound && !hotkeysDiffer(bound, next.hotkeys)) return
    bound = next.hotkeys
    void registerShortcuts()
  })
  void settings.getSettings().then((initial) => {
    bound ??= initial.hotkeys
    return registerShortcuts()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  // Removes userData/mcp.json as well, so a bridge spawned after we exit reports
  // "Nawi is not running" rather than a bare connection refusal.
  void mcpServer?.close()
})
