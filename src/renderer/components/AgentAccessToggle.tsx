import { useEffect, useState } from 'react'
import type { AgentAccessState } from '@shared/types'

/**
 * UX-AGT.3 — the always-reachable agent kill switch.
 *
 * The requirement names a tray entry; this is the in-app rail control, which is
 * the surface that exists today (there is no tray icon in this build yet). It is
 * deliberately visible at all times rather than buried in a settings tree: a
 * kill switch the user cannot find in a hurry is not one.
 *
 * Three states, not two. "Paused" and "no endpoint" are different facts and the
 * control must not conflate them — an agent cannot reach a server that failed to
 * start either, but *resuming* will not fix that, and a control claiming to be
 * "Active" while nothing is listening is a lie the user would act on.
 */

type Mode = 'active' | 'paused' | 'unavailable'

function modeOf(state: AgentAccessState | null): Mode {
  if (state === null) return 'unavailable'
  if (state.paused) return 'paused'
  return state.endpoint === null ? 'unavailable' : 'active'
}

const COPY: Record<Mode, { label: string; detail: string }> = {
  active: { label: 'Agent access on', detail: 'Agents can capture through MCP.' },
  paused: { label: 'Agent access paused', detail: 'Every MCP tool call is being refused.' },
  unavailable: {
    label: 'Agent endpoint down',
    detail: 'The local MCP endpoint is not listening, so no agent can reach Nawi.'
  }
}

export function AgentAccessToggle(): React.JSX.Element {
  const [state, setState] = useState<AgentAccessState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.getAgentAccess().then((res) => {
      if (alive && res.ok) setState(res.value)
    })
    // Main broadcasts on every change, so a pause made in another window — or by
    // a future tray entry — is reflected here without polling.
    const stop = window.api.onAgentAccessChanged((next) => setState(next))
    return () => {
      alive = false
      stop()
    }
  }, [])

  const mode = modeOf(state)
  const paused = mode === 'paused'

  const toggle = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    // Deliberately *not* painted optimistically, unlike the theme toggle. This
    // control makes a security claim: showing "paused" before the write landed
    // would tell the user that agent access is off while it is still on.
    const res = await window.api.setAgentAccessPaused(!paused)
    if (res.ok) setState(res.value)
    setBusy(false)
  }

  return (
    <button
      onClick={() => void toggle()}
      disabled={busy || state === null}
      aria-pressed={paused}
      data-testid="agent-access-toggle"
      data-agent-access={mode}
      title={`${COPY[mode].label} — ${COPY[mode].detail}${
        mode === 'unavailable' ? '' : paused ? ' Click to resume.' : ' Click to pause.'
      }`}
      className={`flex h-11 w-11 flex-col items-center justify-center rounded-xl transition-colors motion-tool disabled:opacity-50 ${
        paused
          ? 'text-danger hover:bg-surface-2'
          : mode === 'unavailable'
            ? 'text-text-secondary hover:bg-surface-2'
            : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
      }`}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {paused || mode === 'unavailable' ? (
          // Pause bars for paused; the same slashed plug reads as "not connected".
          <>
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </>
        ) : (
          <>
            <rect x="3" y="7" width="18" height="12" rx="2" />
            <path d="M8 7V5a4 4 0 0 1 8 0v2" />
          </>
        )}
      </svg>
      {/* The glyph alone cannot carry a security state, so it is also text for AT. */}
      <span className="sr-only">
        {COPY[mode].label}. {COPY[mode].detail}
      </span>
    </button>
  )
}
