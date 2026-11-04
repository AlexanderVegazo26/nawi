import { isAbsolute } from 'node:path'
import { MAX_FLOW_PATH } from '../flow-run'
import { ToolError } from '../mcp/errors'
import type { MobileOpenResult, OpenStepId } from './open'
import type { MobileOpenView, MobileProgress, MobileScreenFrame, MobileStepView } from '@shared/mobile'

/**
 * Roadmap M1d: the window's side of "drop an .apk and see it running". One open at a time, run through the same
 * code as the MCP tool mobile_open (injected as `open`, so this file stays Electron-free and testable), with each
 * step sent to the window as it starts. Screen frames are served only for a device this session opened an app on:
 * the renderer can't make main run adb against an arbitrary serial.
 */

export type OpenOutcome = MobileOpenResult & { profile: string | null; profile_error: string | null }

export interface MobileUiDeps {
  /** openMobileFile with the window's defaults (grant, keep a window for the emulator, save the profile). */
  open(file: string, opts: { signal: AbortSignal; onStep: (id: OpenStepId, summary: string) => void }): Promise<OpenOutcome>
  findAdb(): Promise<string | null>
  capture(adb: string, serial: string): Promise<MobileScreenFrame>
  emit(progress: MobileProgress): void
}

/** Longest path accepted from the renderer, as for flows. */
const MAX_PATH = MAX_FLOW_PATH

export class MobileOpenBusyError extends Error {
  constructor() {
    super('An app is already being opened: wait for it to finish or press Cancel.')
    this.name = 'MobileOpenBusyError'
  }
}

export class MobileUiSession {
  private running: { openId: number; stop: AbortController } | null = null
  private lastId = 0
  /** Serials an app was launched on from this window. */
  private readonly opened = new Set<string>()

  constructor(private readonly deps: MobileUiDeps) {}

  get busy(): boolean {
    return this.running !== null
  }

  /** Open a dropped file. Rejects only for bad input or a second open while one runs; every outcome is a view. */
  async open(file: unknown): Promise<MobileOpenView> {
    if (typeof file !== 'string' || file.length === 0 || file.length > MAX_PATH || !isAbsolute(file) || /[\0\r\n]/.test(file)) {
      throw new Error('Drop an .apk file from your computer (Nawi needs its path).')
    }
    if (this.running) throw new MobileOpenBusyError()
    const openId = ++this.lastId
    const stop = new AbortController()
    this.running = { openId, stop }
    const base: MobileOpenView = {
      openId,
      ok: false,
      cancelled: false,
      fix: null,
      package: null,
      target: null,
      launched: null,
      steps: [],
      profile: null,
      profile_error: null
    }
    try {
      this.deps.emit({ openId, id: 'read', summary: 'reading the app file' })
      const result = await this.deps.open(file, {
        signal: stop.signal,
        onStep: (id, summary) => {
          if (!stop.signal.aborted) this.deps.emit({ openId, id, summary })
        }
      })
      if (result.ok && result.target?.serial) this.opened.add(result.target.serial)
      const read: MobileStepView = { id: 'read', status: 'ok', summary: result.package, fix: null }
      return {
        ...base,
        ok: result.ok,
        fix: result.fix,
        package: result.package,
        target: result.target,
        launched: result.launched,
        steps: [read, ...result.steps],
        profile: result.profile,
        profile_error: result.profile_error
      }
    } catch (err) {
      // Only the abort itself is a cancel: a real failure that lands after Cancel still says what went wrong.
      if (stop.signal.aborted && err === stop.signal.reason) return { ...base, cancelled: true }
      if (err instanceof ToolError) {
        // A file Nawi won't open (not found, not an APK, an .aab): the read step failed, with its fix.
        const fix = typeof err.detail.fix === 'string' ? err.detail.fix : 'Drop an .apk file built for Android.'
        const summary = err.message.endsWith(fix) ? err.message.slice(0, -fix.length).trim() : err.message
        return { ...base, fix, steps: [{ id: 'read', status: 'fail', summary, fix }] }
      }
      throw err
    } finally {
      this.running = null
    }
  }

  /** Stop the running open before its next step. False when nothing is running. */
  cancel(): boolean {
    if (!this.running) return false
    this.running.stop.abort(new Error('cancelled'))
    return true
  }

  /** One frame of a device an app was opened on from this window. */
  async screen(serial: unknown): Promise<MobileScreenFrame> {
    if (typeof serial !== 'string' || !this.opened.has(serial)) {
      throw new Error('No app was opened on that device from this window.')
    }
    // Looked up per frame (a few stat calls), so an SDK installed or moved meanwhile is picked up.
    const adb = await this.deps.findAdb()
    if (!adb) return { ok: false, error: 'adb is not available', fix: 'Install the Android SDK Platform-Tools and set ANDROID_HOME, then open the app again.' }
    return this.deps.capture(adb, serial)
  }
}
