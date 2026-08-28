import { describe, expect, it } from 'vitest'
import type { PermissionState } from '@shared/types'
import { platformCopy } from './PermissionRecovery'

function state(over: Partial<PermissionState> = {}): PermissionState {
  return {
    platform: 'darwin',
    screen: 'denied',
    settingsPath: 'System Settings → Privacy & Security → Screen & System Audio Recording',
    relaunchMayBeRequired: true,
    ...over
  }
}

describe('UX-PRM.2 — normative recovery copy', () => {
  it('uses PRD-002 §4’s copy verbatim on macOS', () => {
    const c = platformCopy(state())
    expect(c.heading).toBe('Aperture needs screen recording access')
    expect(c.line1).toBe('macOS asks for this before any app can see your screen.')
    expect(c.line2).toBe('Nothing is captured until you press the hotkey.')
  })

  it('carries UX-PRM.3’s relaunch hint on macOS', () => {
    expect(platformCopy(state()).footnote).toBe(
      'Already granted it? macOS sometimes needs Aperture to relaunch before it takes effect.'
    )
  })

  it('does not tell a Windows user about macOS', () => {
    // The structure is kept; the OS-specific sentences are not. Repeating
    // "macOS asks for this" on Windows sends the user to a pane that does not
    // exist.
    const c = platformCopy(state({ platform: 'win32', relaunchMayBeRequired: false }))
    expect(c.line1).not.toContain('macOS')
    expect(c.heading).not.toContain('macOS')
    expect(c.line1.length).toBeGreaterThan(0)
  })

  it('offers no relaunch hint where a relaunch fixes nothing', () => {
    // UX-PRM.3's grant-then-relaunch state is a macOS TCC behaviour. Offering
    // it on Windows would cost the user a restart for no reason.
    expect(platformCopy(state({ platform: 'win32' })).footnote).toBeNull()
    expect(platformCopy(state({ platform: 'linux' })).footnote).toBeNull()
  })

  it('keeps the reassurance clause on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(platformCopy(state({ platform })).line2).toBe(
        'Nothing is captured until you press the hotkey.'
      )
    }
  })

  it('names the OS path main resolved, never one the renderer guessed', () => {
    const c = platformCopy(state({ platform: 'linux', settingsPath: 'the GNOME sharing panel' }))
    expect(c.line1).toContain('the GNOME sharing panel')
  })
})

describe('PRD-002 §9 — banned words', () => {
  it('avoids AI / powered / seamlessly / effortlessly in recovery copy', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const c = platformCopy(state({ platform }))
      const all = [c.heading, c.line1, c.line2, c.footnote ?? ''].join(' ')
      expect(all).not.toMatch(/\bAI\b|\bpowered\b|\bseamlessly\b|\beffortlessly\b/i)
    }
  })

  it('never blames the user', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const c = platformCopy(state({ platform }))
      const all = [c.heading, c.line1, c.line2, c.footnote ?? ''].join(' ')
      expect(all).not.toMatch(/\binvalid\b|\byou must\b/i)
    }
  })
})
