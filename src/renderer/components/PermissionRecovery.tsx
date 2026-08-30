import { useCallback, useState } from 'react'
import type { PermissionState } from '@shared/types'
import { Button } from './ui'

/**
 * UX-PRM.2 / UX-PRM.3 — screen-recording permission recovery.
 *
 * PRD-002 §4 calls this the single largest drop-off risk in the product. What
 * shipped before was `describeMediaError`'s one line — "…permission was denied.
 * Grant access in your system settings…" — in a toast that auto-dismissed after
 * six seconds. That is a dead end, which UX-PRM.2 forbids by name: no OS path,
 * no way to open the pane, no way to re-check, and no mention of the relaunch
 * that UX-PRM.3 says is the most common support ticket in this category.
 *
 * ## Copy
 *
 * §4's copy block is normative and is used verbatim on macOS. On Windows the
 * OS vocabulary does not match it — Windows has no per-app screen-recording
 * grant and no pane to toggle — so repeating "macOS asks for this…" would send
 * the user somewhere that cannot fix their problem. The *structure* is kept
 * exactly (heading, two-line explanation, the same two buttons, a footnote) and
 * only the OS-specific sentences change. See `platformCopy` for the diff.
 */

interface Copy {
  heading: string
  line1: string
  line2: string
  footnote: string | null
}

/**
 * Pure so the platform wording is checkable without a browser or an OS.
 *
 * `settingsPath` comes from main (`src/main/permissions.ts`), which is the only
 * side that knows the real platform — the renderer must not sniff `navigator`
 * for this and get it wrong in a packaged build.
 */
export function platformCopy(state: PermissionState): Copy {
  if (state.platform === 'darwin') {
    /**
     * The card is raised by *a capture that already failed*, so the reported
     * status only chooses the wording — never whether the user sees anything.
     * Two macOS states make the §4 block untrue as written:
     *
     *  - `not-determined`: nothing has been denied, macOS simply has not asked
     *    yet. This is the first-ever-attempt case the card exists for.
     *  - `granted`: the grant is present and the capture failed anyway, so
     *    "needs screen recording access" would send the user to toggle a switch
     *    that is already on. The relaunch footnote is the useful part here,
     *    because a TCC grant is read at process start.
     *
     * The product name is kept as the §4 block spells it; correcting it is a
     * spec change, not a code change.
     */
    if (state.screen === 'not-determined') {
      return {
        heading: 'Aperture needs screen recording access',
        line1: 'macOS has not asked yet — it will the first time, and until then nothing can see your screen.',
        line2: 'Nothing is captured until you press the hotkey.',
        footnote:
          'Already granted it? macOS sometimes needs Aperture to relaunch before it takes effect.'
      }
    }
    if (state.screen === 'granted') {
      return {
        heading: 'Aperture couldn’t read your screen',
        line1: 'macOS reports the access as granted, so this is usually a grant that needs a relaunch to take effect.',
        line2: 'Nothing is captured until you press the hotkey.',
        footnote:
          'Already granted it? macOS sometimes needs Aperture to relaunch before it takes effect.'
      }
    }
    // Verbatim from PRD-002 §4.
    return {
      heading: 'Aperture needs screen recording access',
      line1: 'macOS asks for this before any app can see your screen.',
      line2: 'Nothing is captured until you press the hotkey.',
      footnote:
        'Already granted it? macOS sometimes needs Aperture to relaunch before it takes effect.'
    }
  }
  if (state.platform === 'win32') {
    return {
      heading: 'Aperture couldn’t read your screen',
      // Windows does not gate screen capture per app, so the honest second line
      // names what actually blocks it there rather than a permission toggle.
      line1: 'Windows doesn’t ask for screen recording access, so this is usually a display driver, a remote session, or a workplace policy.',
      line2: 'Nothing is captured until you press the hotkey.',
      // No relaunch hint: the macOS grant-then-relaunch state does not exist
      // here, and offering a restart that fixes nothing wastes the user's time.
      footnote: null
    }
  }
  return {
    heading: 'Aperture needs screen recording access',
    line1: `Your desktop asks for this before any app can see your screen. You can grant it in ${state.settingsPath}.`,
    line2: 'Nothing is captured until you press the hotkey.',
    footnote: null
  }
}

export function PermissionRecovery({
  state,
  detail,
  onRecheck,
  notify
}: {
  state: PermissionState
  /**
   * What actually failed, verbatim.
   *
   * The card is now raised by any failed capture, not only by one the OS models
   * as a denial — so without this line a missing encoder or a lost source would
   * be rendered as a permission problem. Showing the real message keeps the
   * card general instead of making it wrong, and it is deliberately not
   * string-matched to pick different copy: that would be a fragile, unfenced
   * classifier over messages nothing constrains.
   */
  detail?: string | null
  /** Re-runs whatever failed. UX-PRM.2's "[I've done this — check again]". */
  onRecheck: () => void
  notify: (msg: string, tone?: 'ok' | 'err') => void
}): React.JSX.Element {
  const copy = platformCopy(state)
  const [opening, setOpening] = useState(false)

  const openSettings = useCallback(async () => {
    setOpening(true)
    const res = await window.api.openScreenSettings()
    setOpening(false)
    // A deep link the OS refuses is exactly the case where a silent no-op
    // strands the user, so the path is spelled out as the fallback.
    if (!res.ok) notify(`Couldn’t open settings for you. Open ${state.settingsPath}.`, 'err')
  }, [notify, state.settingsPath])

  return (
    <div
      role="alert"
      data-testid="permission-recovery"
      className="surface mx-auto max-w-lg rounded-2xl p-6 text-center"
    >
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-warning-surface text-warning">
        {/* UX-A11Y.4 — a glyph, not colour, carries the state. */}
        <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
          <rect x="3" y="5" width="18" height="12" rx="2" />
          <path d="M8 21h8M12 17v4M3 5l18 12" />
        </svg>
      </div>

      <h2 className="text-lg font-semibold text-text-primary">{copy.heading}</h2>
      <p className="mt-2 text-sm leading-relaxed text-text-secondary">{copy.line1}</p>
      <p className="mt-1 text-sm leading-relaxed text-text-secondary">{copy.line2}</p>

      {detail && (
        /*
         * Clamped and wrapped at the point of *display*, not only at ingest.
         * The text originates in a renderer and is rendered inside a card that
         * looks like a system dialog, so a long unbroken string would push the
         * card's own buttons off screen — a legitimate-looking surface whose
         * actionable parts an attacker controls the visibility of. `break-words`
         * stops a single long token doing the same thing horizontally.
         */
        <p
          data-testid="permission-recovery-detail"
          className="mt-3 max-h-24 overflow-y-auto break-words rounded-lg bg-surface-2 px-3 py-2 text-left text-xs text-text-secondary"
        >
          What went wrong: {detail.slice(0, 300)}
          {detail.length > 300 ? '…' : ''}
        </p>
      )}

      <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-secondary">
        {state.settingsPath}
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" size="hit" disabled={opening} onClick={() => void openSettings()}>
          Open System Settings
        </Button>
        <Button size="hit" autoFocusInModal onClick={onRecheck}>
          I&apos;ve done this — check again
        </Button>
      </div>

      {copy.footnote && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-xs italic text-text-secondary">{copy.footnote}</p>
          {/* UX-PRM.3 — offer the relaunch rather than failing silently. */}
          {state.relaunchMayBeRequired && (
            <div className="mt-3">
              <Button size="hit" onClick={() => void window.api.relaunchApp()}>
                Relaunch now
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
