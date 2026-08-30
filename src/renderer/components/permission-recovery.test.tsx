import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionState } from '@shared/types'
import { PermissionRecovery, platformCopy } from './PermissionRecovery'

/**
 * UX-PRM.2 — the card's wording, now that the *status* chooses the wording
 * rather than whether the card appears at all.
 *
 * `platformCopy` is pure precisely so this is checkable without an OS. The
 * macOS expectations here are UNVERIFIED as behaviour — no macOS hardware was
 * available — but they are verified as copy: this asserts which sentence the
 * function returns for a given state, which is all the function decides.
 */

function state(over: Partial<PermissionState>): PermissionState {
  return {
    platform: 'darwin',
    screen: 'denied',
    settingsPath: 'System Settings → Privacy & Security → Screen & System Audio Recording',
    relaunchMayBeRequired: true,
    ...over
  }
}

describe('platformCopy — the status picks the wording', () => {
  it('does not claim macOS denied anything when it has not asked yet', () => {
    // `not-determined` is a legal status (src/main/permissions.ts) and the
    // plausible first-ever-attempt state. Telling that user their access was
    // denied describes a refusal that never happened.
    const copy = platformCopy(state({ screen: 'not-determined' }))
    expect(copy.line1).toContain('has not asked yet')
    expect(copy.line1).not.toContain('asks for this before any app')
  })

  it('does not tell a macOS user to grant access the OS already reports as granted', () => {
    // A capture failed *despite* the grant. "needs screen recording access"
    // sends the user to toggle a switch that is already on; the relaunch is the
    // part that actually helps.
    const copy = platformCopy(state({ screen: 'granted' }))
    expect(copy.heading).toBe('Aperture couldn’t read your screen')
    expect(copy.line1).toContain('granted')
    expect(copy.footnote).toContain('relaunch')
  })

  it('keeps the PRD-002 §4 block verbatim for an actual denial', () => {
    const copy = platformCopy(state({ screen: 'denied' }))
    expect(copy.heading).toBe('Aperture needs screen recording access')
    expect(copy.line1).toBe('macOS asks for this before any app can see your screen.')
  })

  it('leaves the Windows copy alone — its status is always granted and the copy already says so', () => {
    const copy = platformCopy(
      state({ platform: 'win32', screen: 'granted', relaunchMayBeRequired: false })
    )
    expect(copy.heading).toBe('Aperture couldn’t read your screen')
    expect(copy.line1).toContain('display driver')
    expect(copy.footnote).toBeNull()
  })
})

describe('the card explains what actually failed', () => {
  const noop = (): void => undefined

  it('renders the underlying error, so a non-permission failure is not dressed as a permission problem', () => {
    // The card is now raised by *any* failed capture. Without this line, "no
    // supported video encoder" would render under "usually a display driver, a
    // remote session, or a workplace policy" — a new dishonesty, not a fix.
    const html = renderToStaticMarkup(
      <PermissionRecovery
        state={state({ platform: 'win32', screen: 'granted', relaunchMayBeRequired: false })}
        detail="This build has no supported video encoder for recording."
        onRecheck={noop}
        notify={noop}
      />
    )
    expect(html).toContain('data-testid="permission-recovery-detail"')
    expect(html).toContain('no supported video encoder')
  })

  it('omits the detail block entirely when there is nothing to say', () => {
    const html = renderToStaticMarkup(
      <PermissionRecovery state={state({})} detail={null} onRecheck={noop} notify={noop} />
    )
    expect(html).not.toContain('data-testid="permission-recovery-detail"')
  })
})
