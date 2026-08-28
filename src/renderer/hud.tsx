/**
 * The recording HUD (UX-REC.1/2).
 *
 * Its own always-on-top window, ≤220×64, draggable, edge-snapping, and excluded
 * from the capture by `setContentProtection(true)` in main. It replaces the
 * full-page in-window recording takeover, which was invisible the moment the
 * main window lost focus — precisely when a recording is running.
 *
 * UX-REC.2 says: elapsed time, a live level meter per active audio track,
 * pause, stop, chapter marker. **Nothing else.** The mic-silence warning
 * (UX-REC.5) is the one addition, and it is a non-blocking strip that appears
 * only when it has something to say.
 *
 * Every control is 44×44 (UX-A11Y.9) and reachable by Tab; the shared `Button`
 * is 36px, so the HUD styles its own rather than shrinking the target.
 */

import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { idleStatus, type RecordingStatus, type TrackState } from '@shared/recording'
import { startThemeSync } from './lib/theme'
import './styles.css'

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 44×44 hit target with a smaller visual glyph inside it (UX-A11Y.9). */
function HudButton({
  label,
  onClick,
  children,
  tone = 'default',
  pressed
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  tone?: 'default' | 'danger'
  pressed?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      // `no-drag` matters: without it the whole HUD is a drag region and the
      // buttons never receive a click.
      className={`hud-no-drag flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors motion-tool focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
        tone === 'danger'
          ? 'text-danger hover:bg-danger-surface'
          : 'text-text-primary hover:bg-surface-3'
      }`}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  )
}

/**
 * A two-segment level meter, one segment per audio track.
 *
 * Height encodes level; a glyph and the accessible name encode *which* track
 * and whether it is muted, so nothing here is carried by colour alone
 * (UX-A11Y.4). Rendered from the same status the recorder publishes, so it
 * cannot drift from what is actually being encoded.
 */
function LevelMeter({ track }: { track: TrackState }): React.JSX.Element {
  const name = track.kind === 'mic' ? 'Microphone' : 'System audio'
  const pct = Math.round((track.level ?? 0) * 100)
  return (
    <div
      className="flex h-8 w-2.5 flex-col justify-end overflow-hidden rounded-sm bg-surface-3"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={track.muted ? 0 : pct}
      aria-label={`${name} level${track.muted ? ', muted' : ''}`}
      title={`${name}${track.muted ? ' (muted)' : ''}`}
    >
      <div
        className={`w-full rounded-sm transition-[height] motion-tool ${
          track.muted ? 'bg-text-secondary' : 'bg-success'
        }`}
        // Height is the only inline style here because it is a live value; the
        // colours come from the semantic tokens like everything else.
        style={{ height: `${track.muted ? 4 : Math.max(pct, 3)}%` }}
      />
    </div>
  )
}

function Hud(): React.JSX.Element {
  const [status, setStatus] = useState<RecordingStatus>(idleStatus())
  const [switching, setSwitching] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // The HUD can open after a recording has already started, so ask for the
    // current state rather than waiting for the next broadcast — otherwise it
    // shows 0:00 until the next tick.
    void window.api.getRecordingStatus().then((res) => {
      if (res.ok) setStatus(res.value)
    })
    return window.api.onRecordingStatus(setStatus)
  }, [])

  const send = (command: string): void => {
    void window.api.sendRecordCommand(command)
  }

  /* UX-A11Y.2: the HUD is fully keyboard-operable, including its position. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const step = e.shiftKey ? 40 : 10
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          // Only when the container itself has focus, so arrows still work
          // normally inside any control that wants them.
          if (document.activeElement !== rootRef.current) return
          e.preventDefault()
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
          void window.api.moveHud(dx, dy)
          break
        }
        case ' ':
          if (document.activeElement === rootRef.current) {
            e.preventDefault()
            send(status.phase === 'paused' ? 'resume' : 'pause')
          }
          break
        case 'Escape':
          if (status.phase === 'countdown') send('cancel')
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [status.phase])

  const audioTracks = status.tracks.filter((t) => t.kind === 'mic' || t.kind === 'system')
  const liveAudio = audioTracks.filter((t) => t.live)
  const paused = status.phase === 'paused'

  /* ---- countdown (PRD-002 Flow B) ---- */
  if (status.phase === 'countdown') {
    return (
      <div
        className="hud-drag surface flex h-full w-full items-center gap-3 rounded-xl px-3"
        role="status"
        aria-live="assertive"
      >
        <span className="font-mono text-2xl font-semibold tabular-nums text-text-primary">
          {status.countdown}
        </span>
        <span className="min-w-0 flex-1 text-xs leading-tight text-text-secondary">
          Recording starts in {status.countdown}…
        </span>
        <button
          type="button"
          onClick={() => send('skip-countdown')}
          /* UX-A11Y.9 — `h-11` alone gave a 44px-tall, ~30px-wide target. The
             requirement is 44x44, so the width floor has to be stated too. */
          className="hud-no-drag h-11 min-w-11 rounded-lg px-2 text-xs font-medium text-accent hover:bg-surface-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Skip
        </button>
        <HudButton label="Cancel recording" tone="danger" onClick={() => send('cancel')}>
          <path d="M18 6 6 18M6 6l12 12" />
        </HudButton>
      </div>
    )
  }

  /* ---- error / nothing recording ---- */
  if (status.phase === 'idle' || status.phase === 'error') {
    return (
      <div className="hud-drag surface flex h-full w-full items-center gap-2 rounded-xl px-3" role="status">
        <span className="text-xs leading-tight text-text-secondary">
          {status.error ?? 'No recording in progress.'}
        </span>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      role="group"
      aria-label="Recording controls"
      className="hud-drag surface flex h-full w-full flex-col rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <div className="flex flex-1 items-center gap-1.5 px-2">
        {/* UX-A11Y.4: the state is spelled out, never just a red dot. */}
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            paused ? 'bg-text-secondary' : 'motion-pulse animate-pulse bg-danger'
          }`}
          aria-hidden="true"
        />
        <span className="sr-only" role="status" aria-live="polite">
          {paused ? 'Recording paused' : 'Recording'}
        </span>
        <span className="font-mono text-sm font-semibold tabular-nums text-text-primary">
          {formatElapsed(status.elapsedMs)}
        </span>

        <div className="flex items-center gap-1 pl-0.5">
          {liveAudio.map((t) => (
            <LevelMeter key={t.kind} track={t} />
          ))}
        </div>

        <div className="flex-1" />

        <HudButton
          label={paused ? 'Resume recording' : 'Pause recording'}
          pressed={paused}
          onClick={() => send(paused ? 'resume' : 'pause')}
        >
          {paused ? <path d="M6 4l14 8-14 8z" /> : <path d="M8 5v14M16 5v14" />}
        </HudButton>
        <HudButton
          label={`Add chapter marker${status.chapters > 0 ? ` (${status.chapters} so far)` : ''}`}
          onClick={() => send('chapter')}
        >
          <path d="M6 3h12v18l-6-4.5L6 21z" />
        </HudButton>
        <HudButton label="Stop recording" tone="danger" onClick={() => send('stop')}>
          <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
        </HudButton>
      </div>

      {/* UX-REC.5 — non-blocking, and it never stops the recording. */}
      {status.micSilent && (
        <div
          className="flex items-center gap-1.5 rounded-b-xl bg-warning-surface px-2 py-1"
          role="status"
          aria-live="polite"
        >
          <span className="text-[10px] leading-none text-warning" aria-hidden="true">
            ⚠
          </span>
          <span className="min-w-0 flex-1 truncate text-[10px] leading-tight text-warning">
            Mic isn&apos;t picking anything up.
          </span>
          <button
            type="button"
            disabled={switching}
            onClick={() => {
              setSwitching(true)
              send('switch-mic')
              // Re-armed rather than latched: switching again is the obvious
              // next move if the second device is also silent.
              setTimeout(() => setSwitching(false), 1500)
            }}
            /* UX-A11Y.9 — this was a ~55x16 target. The glyph stays small; the
               hit area does not. */
            className="hud-no-drag inline-flex min-h-11 min-w-11 items-center justify-center rounded px-1.5 text-[10px] font-semibold text-warning underline disabled:opacity-50"
          >
            Switch mic
          </button>
        </div>
      )}
    </div>
  )
}

void startThemeSync()
  .catch(() => undefined)
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <Hud />
      </StrictMode>
    )
  })
