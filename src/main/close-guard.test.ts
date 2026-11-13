import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { CloseGuard, type GuardedWindow } from './close-guard'

type Fn = () => void

function fakeWindow() {
  const send = vi.fn<(channel: string) => void>()
  const win = {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn<Fn>(),
    show: vi.fn<Fn>(),
    focus: vi.fn<Fn>(),
    close: vi.fn<Fn>(),
    send,
    webContents: { send }
  }
  return win satisfies GuardedWindow
}

const closeEvent = () => ({ preventDefault: vi.fn<Fn>() })

describe('CloseGuard — the window close button and unsaved annotations', () => {
  it('lets the window close when the editor has nothing unsaved', () => {
    const guard = new CloseGuard()
    const event = closeEvent()
    expect(guard.onClose(event, fakeWindow())).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('holds the close and asks the editor while annotations are unsaved', () => {
    const guard = new CloseGuard()
    const win = fakeWindow()
    guard.setUnsaved(true)
    const event = closeEvent()

    expect(guard.onClose(event, win)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(win.send).toHaveBeenCalledWith(IPC.closeRequested)
  })

  it('closes for real once Discard confirms', () => {
    const guard = new CloseGuard()
    const win = fakeWindow()
    guard.setUnsaved(true)
    guard.onClose(closeEvent(), win)

    expect(guard.confirm(win)).toEqual({ quit: false })
    expect(win.close).toHaveBeenCalled()
    // The close that confirm() starts must not be held again.
    const event = closeEvent()
    expect(guard.onClose(event, win)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('resumes a quit that the unsaved check interrupted', () => {
    const guard = new CloseGuard()
    const win = fakeWindow()
    guard.setUnsaved(true)
    guard.quitRequested()
    guard.onClose(closeEvent(), win)
    expect(guard.confirm(win)).toEqual({ quit: true })
  })

  it('stops holding once the editor reports its work saved or closed', () => {
    const guard = new CloseGuard()
    guard.setUnsaved(true)
    guard.setUnsaved(false)
    expect(guard.onClose(closeEvent(), fakeWindow())).toBe(false)
  })
})
