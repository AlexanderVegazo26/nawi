import { useCallback, useEffect, useRef, useState } from 'react'
import type { CaptureSource, DiskPressure, LibraryItem, PermissionState } from '@shared/types'
import type { HotkeyAction } from '@shared/settings'
import type { RecordingStatus, TrackSelection } from '@shared/recording'
import { Button, ErrorState, Modal, Spinner, formatBytes } from './ui'
import { PermissionRecovery } from './PermissionRecovery'
import { hotkeyLabel, useHotkeys } from '../lib/hotkeys'
import { failureFrom } from '../lib/failure'

type Busy = null | 'fullscreen' | 'region' | 'window'

/**
 * FR-REC.1 — the four tracks, chosen independently before recording starts.
 *
 * Screen is not in this list because it is not optional; a recording with no
 * video track is not a recording. Mic and camera permission are requested by
 * the recorder window at the moment the track is first enabled (UX-PRM.4), not
 * here and not up front, so ticking a box never prompts.
 */
const TRACK_TOGGLES: Array<{ key: keyof TrackSelection; label: string; hint: string }> = [
  { key: 'system', label: 'System audio', hint: 'Sound coming out of this computer' },
  { key: 'mic', label: 'Microphone', hint: 'Asks for permission the first time' },
  // Honest label: the camera is opened, permission-gated and reported in the
  // HUD, but its pixels are not composited into the video yet. Saying "recorded"
  // would promise a capability nothing produces.
  {
    key: 'camera',
    label: 'Webcam (preview only)',
    hint: 'Opens the camera and reports its state; not yet included in the recorded video'
  }
]

export function CaptureView({
  onCaptured,
  notify,
  recording
}: {
  onCaptured: (item: LibraryItem, openEditor: boolean) => void
  notify: (msg: string, tone?: 'ok' | 'err') => void
  recording: RecordingStatus
}): React.JSX.Element {
  const [busy, setBusy] = useState<Busy>(null)
  const [picker, setPicker] = useState<'window' | 'record' | null>(null)
  const [sources, setSources] = useState<CaptureSource[] | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [tracks, setTracks] = useState<TrackSelection>({ system: true, mic: false, camera: false })
  const [countdown, setCountdown] = useState(true)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  /** §9 — hotkeys in copy resolved from settings at render time, never literals. */
  const hotkeys = useHotkeys()
  /** UX-PRM.2 — set when a capture failed in a way a permission would explain. */
  const [permission, setPermission] = useState<PermissionState | null>(null)
  /**
   * Which capture the recovery card is offering to retry.
   *
   * Held because "I've done this — check again" has to re-run *the thing that
   * failed*: a user whose region capture was denied and who is then handed a
   * full-screen capture gets a different artifact than the one they asked for,
   * silently.
   */
  const retryRef = useRef<(() => void) | null>(null)
  /** UX-STA.5 — the pending disk-pressure warning, and what it is gating. */
  const [pressure, setPressure] = useState<{ info: DiskPressure; sourceId: string } | null>(null)

  // Track choices and the countdown are remembered per user through the M0
  // settings layer, so the picker opens where the user left it.
  useEffect(() => {
    void window.api.getSettings().then((res) => {
      if (res.ok) {
        setTracks({
          system: res.value.captureDefaults.recordAudio,
          mic: res.value.captureDefaults.recordMicrophone,
          camera: res.value.captureDefaults.recordWebcam
        })
        setCountdown(res.value.captureDefaults.recordCountdown)
      }
      // Either way the picker becomes usable: a settings read that failed must
      // not leave the user unable to record.
      setSettingsLoaded(true)
    })
  }, [])

  /**
   * UX-PRM.2 — turn a failed capture into a recovery card instead of a toast.
   *
   * Driven by an *actual failure*, never by the permission status alone. On
   * Windows `getMediaAccessStatus('screen')` cannot report a denial (see
   * `src/main/permissions.ts`), so a status-first check would show this to
   * nobody there; on macOS a status check that ran before the first capture
   * attempt would show it to everyone. Asking only after something failed is
   * the ordering that works on both.
   */
  const onCaptureFailed = useCallback(
    async (error: string, retry: () => void): Promise<void> => {
      const res = await window.api.getScreenPermission()
      const denied = res.ok && (res.value.screen === 'denied' || res.value.screen === 'restricted')
      // `unknown` covers Windows and any platform where the API says nothing.
      // A capture that failed with nothing else to blame is still worth the
      // recovery card, because the alternative is the dead-end toast.
      const unhelpfulStatus = res.ok && res.value.screen === 'unknown'
      if (res.ok && (denied || unhelpfulStatus)) {
        retryRef.current = retry
        setPermission(res.value)
        return
      }
      notify(
        failureFrom(error, {
          failed: 'That capture didn’t complete',
          intact: 'Nothing was saved and your library is unchanged',
          next: 'Try again'
        }),
        'err'
      )
    },
    [notify]
  )

  const loadSources = useCallback(async (kinds: Array<'screen' | 'window'>) => {
    setSources(null)
    setSourceError(null)
    const res = await window.api.listSources(kinds)
    if (res.ok) setSources(res.value)
    else setSourceError(res.error)
  }, [])

  useEffect(() => {
    if (picker === 'window') void loadSources(['window'])
    if (picker === 'record') void loadSources(['screen', 'window'])
  }, [picker, loadSources])

  const doFullscreen = useCallback(async () => {
    setBusy('fullscreen')
    const res = await window.api.captureFullscreen()
    setBusy(null)
    if (res.ok) onCaptured(res.value, true)
    else await onCaptureFailed(res.error, () => void doFullscreen())
  }, [onCaptured, onCaptureFailed])

  const doRegion = useCallback(async () => {
    setBusy('region')
    const res = await window.api.beginRegion()
    setBusy(null)
    if (!res.ok) {
      await onCaptureFailed(res.error, () => void doRegion())
      return
    }
    // null means the user cancelled — that is not an error worth a toast.
    if (res.value) onCaptured(res.value, true)
  }, [onCaptured, onCaptureFailed])

  const doWindow = useCallback(
    async (sourceId: string) => {
      setPicker(null)
      setBusy('window')
      const res = await window.api.captureWindow(sourceId)
      setBusy(null)
      if (res.ok) onCaptured(res.value, true)
      else await onCaptureFailed(res.error, () => void doWindow(sourceId))
    },
    [onCaptured, onCaptureFailed]
  )

  const startRecording = useCallback(
    async (sourceId: string) => {
      setPicker(null)
      // Persist the choice before starting, so it survives even if the
      // recording itself fails — the user should not have to re-tick after an
      // error.
      void window.api.updateSettings({
        captureDefaults: {
          recordAudio: tracks.system,
          recordMicrophone: tracks.mic,
          recordWebcam: tracks.camera,
          recordCountdown: countdown
        }
      })
      const res = await window.api.startRecording({ sourceId, tracks, countdown })
      // Failures after this point arrive through `onRecordingFailed` in App;
      // this only reports a request main refused outright.
      if (!res.ok) {
        notify(
          failureFrom(res.error, {
            failed: 'That recording didn’t start',
            intact: 'Nothing was recorded and your library is unchanged',
            next: 'Pick a source and try again'
          }),
          'err'
        )
      }
    },
    [tracks, countdown, notify]
  )

  /**
   * UX-STA.5 — disk-pressure precheck, run *before* the recording starts.
   *
   * Before, not during: a recording that runs out of disk halfway is the
   * failure this exists to prevent, and a warning after the fact is a report,
   * not a check. Asking main each time rather than caching, because free space
   * is exactly the kind of value that changes between the app launching and the
   * user pressing record.
   */
  const requestRecording = useCallback(
    async (sourceId: string) => {
      const res = await window.api.getDiskPressure(5)
      // A failed or unknown reading must not block a recording — the user came
      // here to record, and refusing on a check we could not perform is worse
      // than the risk it was checking for.
      if (res.ok && res.value.known && res.value.low) {
        setPicker(null)
        setPressure({ info: res.value, sourceId })
        return
      }
      await startRecording(sourceId)
    },
    [startRecording]
  )

  const cards: Array<{
    id: Busy | 'record'
    title: string
    body: string
    /**
     * §9 — "Keep hotkeys in copy rendered as the user's actual binding,
     * resolved at render time." These were string literals; a user who rebound
     * region capture was being told to press a chord that did nothing.
     */
    hotkey: HotkeyAction
    icon: React.JSX.Element
    action: () => void
  }> = [
    {
      id: 'region',
      title: 'Region',
      body: 'Drag to select any part of the screen.',
      hotkey: 'capture-region',
      icon: <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />,
      action: () => void doRegion()
    },
    {
      id: 'fullscreen',
      title: 'Full screen',
      body: 'Capture your entire primary display.',
      hotkey: 'capture-fullscreen',
      icon: <rect x="2" y="4" width="20" height="14" rx="2" />,
      action: () => void doFullscreen()
    },
    {
      id: 'window',
      title: 'Window',
      body: 'Pick a single open application window.',
      hotkey: 'capture-window',
      icon: <path d="M3 5h18v14H3zM3 9h18" />,
      action: () => setPicker('window')
    },
    {
      id: 'record',
      title: 'Record',
      body: 'Capture a video of a screen or window.',
      hotkey: 'record-start',
      icon: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" fill="currentColor" /></>,
      action: () => setPicker('record')
    }
  ]

  const isRecording = recording.phase !== 'idle' && recording.phase !== 'error'

  return (
    <div className="h-full overflow-auto p-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold text-text-primary">New capture</h1>
        <p className="mt-1.5 text-sm text-text-secondary">
          Grab a still or record your screen. Everything lands in your library.
        </p>

        {/* The recording itself lives in the floating HUD now, so this window is
            free to be used during a recording. All this needs to do is say so
            and offer the way out. */}
        {isRecording && (
          <div
            className="surface mt-5 flex flex-wrap items-center gap-3 rounded-xl px-4 py-3"
            role="status"
            aria-live="polite"
          >
            <span
              className={`h-2.5 w-2.5 rounded-full bg-danger ${
                recording.phase === 'paused' ? '' : 'motion-pulse animate-pulse'
              }`}
              aria-hidden="true"
            />
            <p className="min-w-0 flex-1 text-sm text-text-secondary">
              {recording.phase === 'paused'
                ? 'Recording paused. Use the floating controls to resume.'
                : 'Recording. The floating controls stay on top of every window.'}
            </p>
            <Button
              variant="ghost"
              onClick={() =>
                void window.api.sendRecordCommand(recording.phase === 'paused' ? 'resume' : 'pause')
              }
            >
              {recording.phase === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button
              variant="danger"
              onClick={() => window.dispatchEvent(new CustomEvent('nawi:stop-recording'))}
            >
              Stop recording
            </Button>
          </div>
        )}

        {/* UX-PRM.2 — the recovery card replaces the capture cards, because a
            grid of buttons that all fail is not a useful thing to look at. */}
        {permission && (
          <div className="mt-6">
            <PermissionRecovery
              state={permission}
              notify={notify}
              onRecheck={() => {
                // "Check again" means retry the thing that failed, not re-read
                // a status flag — on Windows the status can never say denied,
                // so a status re-read would clear the card while capture is
                // still broken. And it must be the *same* capture kind: retrying
                // a region denial with a full-screen grab hands the user a
                // different artifact than the one they asked for.
                const retry = retryRef.current
                retryRef.current = null
                setPermission(null)
                retry?.()
              }}
            />
          </div>
        )}

        <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {cards.map((c) => (
            <button
              key={c.id}
              onClick={c.action}
              disabled={busy !== null}
              className="surface group flex items-start gap-4 rounded-xl p-5 text-left transition-colors motion-tool hover:border-accent/60 hover:bg-surface-2 disabled:opacity-50"
            >
              <span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-accent-hover ring-1 ring-border-strong group-hover:bg-accent/15">
                {busy === c.id ? (
                  <span className="h-5 w-5 motion-spin animate-spin rounded-full border-2 border-border border-t-accent-hover" />
                ) : (
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    {c.icon}
                  </svg>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-semibold text-text-primary">{c.title}</span>
                  <kbd className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-text-secondary ring-1 ring-border-strong">
                    {hotkeyLabel(hotkeys, c.hotkey)}
                  </kbd>
                </span>
                <span className="mt-1 block text-sm leading-relaxed text-text-secondary">{c.body}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {picker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/75 p-8">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={picker === 'window' ? 'Choose a window' : 'Choose what to record'}
            className="surface flex max-h-[80vh] w-full max-w-3xl flex-col rounded-2xl shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <h2 className="text-base font-semibold text-text-primary">
                {picker === 'window' ? 'Choose a window' : 'Choose what to record'}
              </h2>
              <Button variant="subtle" onClick={() => setPicker(null)}>
                Cancel (Esc)
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-5">
              {sources === null && !sourceError && (
                <div className="py-16">
                  <Spinner label="Looking for sources…" />
                </div>
              )}
              {sourceError && (
                <ErrorState
                  title="Couldn't list capture sources"
                  detail={sourceError}
                  onRetry={() => void loadSources(picker === 'window' ? ['window'] : ['screen', 'window'])}
                />
              )}
              {sources?.length === 0 && (
                <p className="py-16 text-center text-sm text-text-secondary">
                  No capturable {picker === 'window' ? 'windows' : 'sources'} were found.
                </p>
              )}
              {sources && sources.length > 0 && (
                <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  {sources.map((s) => (
                    <li key={s.id}>
                      <button
                        onClick={() =>
                          picker === 'window' ? void doWindow(s.id) : void requestRecording(s.id)
                        }
                        className="group w-full overflow-hidden rounded-lg bg-surface-2 text-left ring-1 ring-border-strong transition-colors motion-tool hover:ring-accent"
                      >
                        <img
                          src={s.thumbnail}
                          alt=""
                          className="aspect-video w-full bg-surface-0 object-cover"
                        />
                        <span className="flex items-center gap-2 px-3 py-2">
                          {s.appIcon && <img src={s.appIcon} alt="" className="h-4 w-4 shrink-0" />}
                          <span className="truncate text-xs text-text-secondary group-hover:text-text-primary">
                            {s.name}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {picker === 'record' && (
              <fieldset className="border-t border-border px-5 py-3">
                <legend className="sr-only">Tracks to record</legend>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                  {TRACK_TOGGLES.map((t) => (
                    <label
                      key={t.key}
                      title={t.hint}
                      className="flex items-center gap-2.5 text-sm text-text-secondary"
                    >
                      <input
                        type="checkbox"
                        checked={tracks[t.key]}
                        disabled={!settingsLoaded}
                        onChange={(e) =>
                          setTracks((prev) => ({ ...prev, [t.key]: e.target.checked }))
                        }
                        className="h-4 w-4 accent-[var(--color-accent)]"
                      />
                      {t.label}
                    </label>
                  ))}
                  <span className="flex-1" />
                  <label className="flex items-center gap-2.5 text-sm text-text-secondary">
                    <input
                      type="checkbox"
                      checked={countdown}
                      disabled={!settingsLoaded}
                      onChange={(e) => setCountdown(e.target.checked)}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    3-2-1 countdown
                  </label>
                </div>
              </fieldset>
            )}
          </div>
        </div>
      )}

      {/*
        UX-STA.5 — disk-pressure warning before the recording starts, naming the
        estimated size of the intended recording.

        Informational, not a gate: the requirement says "warning", and refusing
        to record on a machine whose disk the user knows better than we do would
        be the app deciding for them. So the primary action is still Record.
      */}
      {pressure && (
        <Modal
          title="Not much room left on this disk"
          onClose={() => setPressure(null)}
          footer={
            <>
              <Button autoFocusInModal onClick={() => setPressure(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const target = pressure.sourceId
                  setPressure(null)
                  void startRecording(target)
                }}
              >
                Record anyway
              </Button>
            </>
          }
        >
          You have <strong className="text-text-primary">{formatBytes(pressure.info.freeBytes)}</strong>{' '}
          free. A {pressure.info.estimateMinutes}-minute recording is usually about{' '}
          <strong className="text-text-primary">{formatBytes(pressure.info.estimatedBytes)}</strong>.
          Recording anyway is fine — a recording that runs out of space is stopped and kept, not lost.
        </Modal>
      )}
    </div>
  )
}
