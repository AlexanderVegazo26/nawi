import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'

/**
 * The recording orchestrator's main-process behaviour, with Electron faked.
 *
 * Windows are plain objects that record what main does to them; the IPC
 * handlers `install` registers are captured and called directly, with the fake
 * recorder's webContents as the sender where the data plane requires it.
 */

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  Tray: class {
    setToolTip(): void {}
    setImage(): void {}
    destroy(): void {}
  },
  nativeImage: { createFromBitmap: () => ({}) },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  }
}))
vi.mock('../library', () => ({ save: vi.fn() }))
vi.mock('./store', () => ({ closeAll: vi.fn(), findRecoverable: vi.fn(async () => []) }))

type Orchestrator = typeof import('./orchestrator')
type Handler = (...args: unknown[]) => unknown

interface FakeWindow {
  label: string
  destroyed: boolean
  visible: boolean
  webContents: { id: number; send: ReturnType<typeof vi.fn>; once: Handler; on: Handler; executeJavaScript: Handler }
  on(event: string, cb: () => void): void
  isDestroyed(): boolean
  destroy(): void
  isVisible(): boolean
  showInactive(): void
  hide(): void
  setContentProtection(): void
  setAlwaysOnTop(): void
  setVisibleOnAllWorkspaces(): void
  getBounds(): { x: number; y: number; width: number; height: number }
  setBounds(): void
}

let nextId = 1

function fakeWindow(label: string): FakeWindow {
  const listeners = new Map<string, Array<() => void>>()
  const win: FakeWindow = {
    label,
    destroyed: false,
    visible: false,
    webContents: {
      id: nextId++,
      send: vi.fn(),
      once: (event, cb) => {
        if (event === 'did-finish-load') queueMicrotask(cb as () => void)
      },
      on: () => undefined,
      executeJavaScript: async () => false
    },
    on(event, cb) {
      listeners.set(event, [...(listeners.get(event) ?? []), cb])
    },
    isDestroyed: () => win.destroyed,
    destroy() {
      if (win.destroyed) return
      win.destroyed = true
      for (const cb of listeners.get('closed') ?? []) cb()
    },
    isVisible: () => win.visible,
    showInactive() {
      win.visible = true
    },
    hide() {
      win.visible = false
    },
    setContentProtection: () => undefined,
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    getBounds: () => ({ x: 0, y: 0, width: 220, height: 64 }),
    setBounds: () => undefined
  }
  return win
}

interface Harness {
  orchestrator: Orchestrator
  windows: FakeWindow[]
  setMainWindow(win: FakeWindow | null): void
  call(channel: string, ...args: unknown[]): Promise<unknown>
  callFrom(sender: FakeWindow, channel: string, ...args: unknown[]): Promise<unknown>
  recorder(): FakeWindow
  hud(): FakeWindow
}

async function setup(): Promise<Harness> {
  vi.resetModules()
  const orchestrator = await import('./orchestrator')
  const windows: FakeWindow[] = []
  let main: FakeWindow | null = fakeWindow('main')
  const handlers = new Map<string, Handler>()
  const sendersHandlers = new Map<string, Handler>()

  orchestrator.install(
    {
      createWindow: (_options, label) => {
        const win = fakeWindow(label)
        windows.push(win)
        return win as unknown as Electron.BrowserWindow
      },
      loadPage: () => undefined,
      armDisplayMedia: () => undefined,
      mainWindow: () => main as unknown as Electron.BrowserWindow | null
    },
    (channel, fn) => handlers.set(channel, fn as Handler),
    (channel, fn) => sendersHandlers.set(channel, fn as Handler)
  )

  const find = (label: string): FakeWindow => {
    const win = windows.filter((w) => w.label === label).at(-1)
    if (!win) throw new Error(`no ${label} window`)
    return win
  }

  return {
    orchestrator,
    windows,
    setMainWindow: (win) => {
      main = win
    },
    call: async (channel, ...args) => handlers.get(channel)!(...args),
    callFrom: async (sender, channel, ...args) => sendersHandlers.get(channel)!(sender.webContents, ...args),
    recorder: () => find('recorder'),
    hud: () => find('hud')
  }
}

/** Starts a recording and has the engine report it running, as the real recorder does. */
async function startRecording(h: Harness): Promise<void> {
  await h.call(IPC.startRecording, { sourceId: 'screen:1:0', tracks: {} })
  await h.callFrom(h.recorder(), IPC.publishRecordingStatus, { phase: 'recording', elapsedMs: 1000 })
}

/** The recorder's own publish when it reaches idle (after finalize, or on failure). */
async function engineReportsIdle(h: Harness, error: string | null = null): Promise<void> {
  await h.callFrom(h.recorder(), IPC.publishRecordingStatus, { phase: 'idle', error })
}

const stopsSent = (win: FakeWindow): number =>
  win.webContents.send.mock.calls.filter(([channel, command]) => channel === IPC.recordDispatch && command === 'stop')
    .length

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('stopActiveRecording — the global stop hotkey, handled in main', () => {
  it('tells the recorder to stop, without going through the main window', async () => {
    const h = await setup()
    await startRecording(h)
    // The main window is closed: the old path (its renderer) could not stop anything.
    h.setMainWindow(null)

    expect(h.orchestrator.stopActiveRecording()).toBe(true)
    expect(stopsSent(h.recorder())).toBe(1)
  })

  it('does nothing when no recording is active', async () => {
    const h = await setup()
    expect(h.orchestrator.stopActiveRecording()).toBe(false)

    await startRecording(h)
    await engineReportsIdle(h)
    expect(h.orchestrator.stopActiveRecording()).toBe(false)
    expect(stopsSent(h.recorder())).toBe(0)
  })
})

describe('onActiveChanged', () => {
  it('fires on the transitions only, not on every status tick', async () => {
    const h = await setup()
    const seen: boolean[] = []
    h.orchestrator.onActiveChanged((active) => seen.push(active))

    await startRecording(h)
    await h.callFrom(h.recorder(), IPC.publishRecordingStatus, { phase: 'recording', elapsedMs: 2000 })
    await h.callFrom(h.recorder(), IPC.publishRecordingStatus, { phase: 'paused', elapsedMs: 2000 })
    await engineReportsIdle(h)

    expect(seen).toEqual([true, false])
  })
})
