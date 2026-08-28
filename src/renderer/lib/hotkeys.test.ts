import { describe, expect, it } from 'vitest'
import { DEFAULT_HOTKEYS } from '@shared/settings'
import { UNBOUND_LABEL, formatAccelerator, hotkeyLabel } from './hotkeys'

const WIN = 'Win32'
const MAC = 'MacIntel'

describe('PRD-002 §9 — hotkeys rendered as the user’s actual binding', () => {
  it('renders CommandOrControl as Ctrl on Windows and ⌘ on macOS', () => {
    expect(formatAccelerator('CommandOrControl+Shift+1', WIN)).toBe('Ctrl+Shift+1')
    expect(formatAccelerator('CommandOrControl+Shift+1', MAC)).toBe('⌘⇧1')
  })

  it('renders the rebound chord, not the default', () => {
    // The whole point of the requirement: a user who rebound region capture was
    // previously told to press Ctrl+Shift+1, which did nothing.
    const rebound = { ...DEFAULT_HOTKEYS, 'capture-region': 'Alt+F9' }
    expect(hotkeyLabel(rebound, 'capture-region', WIN)).toBe('Alt+F9')
    expect(hotkeyLabel(rebound, 'capture-region', WIN)).not.toBe('Ctrl+Shift+1')
  })

  it('names an unbound action instead of rendering an empty chord', () => {
    // `resolveHotkeyCollisions` writes '' for an action that lost a collision,
    // so this is a reachable state, not a defensive branch.
    const collided = { ...DEFAULT_HOTKEYS, 'capture-region': '' }
    expect(hotkeyLabel(collided, 'capture-region', WIN)).toBe(UNBOUND_LABEL)
  })

  it('falls back to the default binding when settings could not be read', () => {
    expect(hotkeyLabel(null, 'capture-fullscreen', WIN)).toBe('Ctrl+Shift+2')
  })

  it('maps every modifier Electron accepts', () => {
    expect(formatAccelerator('Ctrl+Alt+Shift+K', WIN)).toBe('Ctrl+Alt+Shift+K')
    expect(formatAccelerator('Control+Alt+Shift+K', MAC)).toBe('⌃⌥⇧K')
    expect(formatAccelerator('Command+K', MAC)).toBe('⌘K')
    expect(formatAccelerator('Super+K', WIN)).toBe('Win+K')
  })

  it('passes an unrecognised key through rather than dropping it', () => {
    expect(formatAccelerator('CommandOrControl+PrintScreen', WIN)).toBe('Ctrl+PrintScreen')
  })

  it('renders the shipped defaults the way the old literals read', () => {
    // Guards the migration itself: these four literals were hardcoded in
    // CaptureView, so the resolved labels must still match on a default install.
    expect(hotkeyLabel(DEFAULT_HOTKEYS, 'capture-region', WIN)).toBe('Ctrl+Shift+1')
    expect(hotkeyLabel(DEFAULT_HOTKEYS, 'capture-fullscreen', WIN)).toBe('Ctrl+Shift+2')
    expect(hotkeyLabel(DEFAULT_HOTKEYS, 'capture-window', WIN)).toBe('Ctrl+Shift+3')
    expect(hotkeyLabel(DEFAULT_HOTKEYS, 'record-start', WIN)).toBe('Ctrl+Shift+4')
  })
})
