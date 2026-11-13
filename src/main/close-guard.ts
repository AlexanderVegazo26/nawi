import { IPC } from '@shared/ipc'

/** The slice of a BrowserWindow the guard touches, so it is testable without Electron. */
export interface GuardedWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  close(): void
  webContents: { send(channel: string): void }
}

/**
 * Asks before the main window's own close button discards unsaved annotations.
 *
 * The editor guarded only its in-app close (its button, Ctrl+W, Escape): the
 * window's X, Alt+F4 and a quit closed the window with no check. The editor
 * reports whether it has unsaved changes; while it does, a `close` is prevented
 * and the editor is asked to show the same "Discard unsaved changes?" dialog its
 * own close shows. Choosing Discard there confirms, and the close goes ahead —
 * as a quit again if a quit was what asked for it.
 */
export class CloseGuard {
  private unsaved = false
  private allowed = false
  private quitting = false
  private resumeQuit = false

  /** From the editor, as its dirty state changes; also cleared when the renderer reloads or dies. */
  setUnsaved(unsaved: boolean): void {
    this.unsaved = unsaved
  }

  /** `before-quit` fired: the next close is part of a quit. */
  quitRequested(): void {
    this.quitting = true
  }

  /** The window's `close` event. Returns true when it prevented the close. */
  onClose(event: { preventDefault(): void }, win: GuardedWindow): boolean {
    const quitting = this.quitting
    this.quitting = false
    if (this.allowed || !this.unsaved) return false
    event.preventDefault()
    // A prevented close cancels a quit; Discard resumes it.
    this.resumeQuit = quitting
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send(IPC.closeRequested)
    return true
  }

  /**
   * The user chose Discard in the dialog `onClose` asked for. Returns whether
   * the caller should quit (rather than only close the window).
   */
  confirm(win: GuardedWindow): { quit: boolean } {
    const quit = this.resumeQuit
    this.resumeQuit = false
    this.allowed = true
    if (!win.isDestroyed()) win.close()
    return { quit }
  }
}
