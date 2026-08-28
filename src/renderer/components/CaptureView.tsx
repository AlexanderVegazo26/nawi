import { useCallback, useEffect, useState } from 'react'
import type { CaptureSource, LibraryItem } from '@shared/types'
import { Button, ErrorState, Spinner, formatDuration } from './ui'
import { ScreenRecorder, blobToBytes } from '../lib/recorder'

type Busy = null | 'fullscreen' | 'region' | 'window'

export function CaptureView({
  onCaptured,
  notify,
  recorder,
  recording,
  setRecording
}: {
  onCaptured: (item: LibraryItem, openEditor: boolean) => void
  notify: (msg: string, tone?: 'ok' | 'err') => void
  recorder: ScreenRecorder
  recording: { elapsedMs: number } | null
  setRecording: (v: { elapsedMs: number } | null) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState<Busy>(null)
  const [picker, setPicker] = useState<'window' | 'record' | null>(null)
  const [sources, setSources] = useState<CaptureSource[] | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [withAudio, setWithAudio] = useState(true)

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
    else notify(res.error, 'err')
  }, [onCaptured, notify])

  const doRegion = useCallback(async () => {
    setBusy('region')
    const res = await window.api.beginRegion()
    setBusy(null)
    if (!res.ok) {
      notify(res.error, 'err')
      return
    }
    // null means the user cancelled — that is not an error worth a toast.
    if (res.value) onCaptured(res.value, true)
  }, [onCaptured, notify])

  const doWindow = useCallback(
    async (sourceId: string) => {
      setPicker(null)
      setBusy('window')
      const res = await window.api.captureWindow(sourceId)
      setBusy(null)
      if (res.ok) onCaptured(res.value, true)
      else notify(res.error, 'err')
    },
    [onCaptured, notify]
  )

  const startRecording = useCallback(
    async (sourceId: string) => {
      setPicker(null)
      try {
        await recorder.start(sourceId, withAudio)
        setRecording({ elapsedMs: 0 })
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), 'err')
      }
    },
    [recorder, withAudio, notify, setRecording]
  )

  const cards: Array<{
    id: Busy | 'record'
    title: string
    body: string
    hint: string
    icon: React.JSX.Element
    action: () => void
  }> = [
    {
      id: 'region',
      title: 'Region',
      body: 'Drag to select any part of the screen.',
      hint: 'Ctrl+Shift+1',
      icon: <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />,
      action: () => void doRegion()
    },
    {
      id: 'fullscreen',
      title: 'Full screen',
      body: 'Capture your entire primary display.',
      hint: 'Ctrl+Shift+2',
      icon: <rect x="2" y="4" width="20" height="14" rx="2" />,
      action: () => void doFullscreen()
    },
    {
      id: 'window',
      title: 'Window',
      body: 'Pick a single open application window.',
      hint: 'Ctrl+Shift+3',
      icon: <path d="M3 5h18v14H3zM3 9h18" />,
      action: () => setPicker('window')
    },
    {
      id: 'record',
      title: 'Record',
      body: 'Capture a video of a screen or window.',
      hint: 'Ctrl+Shift+4',
      icon: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" fill="currentColor" /></>,
      action: () => setPicker('record')
    }
  ]

  if (recording) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6">
        <div className="relative flex h-24 w-24 items-center justify-center">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/20" />
          <span className="relative inline-flex h-16 w-16 items-center justify-center rounded-full bg-red-600">
            <span className="h-6 w-6 rounded-sm bg-white" />
          </span>
        </div>
        <div className="text-center">
          <p className="font-mono text-3xl font-semibold tabular-nums text-mist-100">
            {formatDuration(recording.elapsedMs)}
          </p>
          <p className="mt-1 text-sm text-mist-400">Recording in progress</p>
        </div>
        <Button
          variant="danger"
          onClick={() => window.dispatchEvent(new CustomEvent('nawi:stop-recording'))}
          className="px-6"
        >
          Stop recording (Ctrl+Shift+S)
        </Button>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold text-mist-100">New capture</h1>
        <p className="mt-1.5 text-sm text-mist-400">
          Grab a still or record your screen. Everything lands in your library.
        </p>

        <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {cards.map((c) => (
            <button
              key={c.id}
              onClick={c.action}
              disabled={busy !== null}
              className="surface group flex items-start gap-4 rounded-xl p-5 text-left transition-colors hover:border-brand-500/60 hover:bg-ink-800 disabled:opacity-50"
            >
              <span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-brand-400 ring-1 ring-ink-600 group-hover:bg-brand-500/15">
                {busy === c.id ? (
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-ink-600 border-t-brand-400" />
                ) : (
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    {c.icon}
                  </svg>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-semibold text-mist-100">{c.title}</span>
                  <kbd className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-mist-400 ring-1 ring-ink-600">
                    {c.hint}
                  </kbd>
                </span>
                <span className="mt-1 block text-sm leading-relaxed text-mist-400">{c.body}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {picker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/75 p-8">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={picker === 'window' ? 'Choose a window' : 'Choose what to record'}
            className="surface flex max-h-[80vh] w-full max-w-3xl flex-col rounded-2xl shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-ink-700 px-5 py-3.5">
              <h2 className="text-base font-semibold text-mist-100">
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
                <p className="py-16 text-center text-sm text-mist-400">
                  No capturable {picker === 'window' ? 'windows' : 'sources'} were found.
                </p>
              )}
              {sources && sources.length > 0 && (
                <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  {sources.map((s) => (
                    <li key={s.id}>
                      <button
                        onClick={() =>
                          picker === 'window' ? void doWindow(s.id) : void startRecording(s.id)
                        }
                        className="group w-full overflow-hidden rounded-lg bg-ink-800 text-left ring-1 ring-ink-600 transition-colors hover:ring-brand-500"
                      >
                        <img
                          src={s.thumbnail}
                          alt=""
                          className="aspect-video w-full bg-ink-900 object-cover"
                        />
                        <span className="flex items-center gap-2 px-3 py-2">
                          {s.appIcon && <img src={s.appIcon} alt="" className="h-4 w-4 shrink-0" />}
                          <span className="truncate text-xs text-mist-300 group-hover:text-mist-100">
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
              <div className="border-t border-ink-700 px-5 py-3">
                <label className="flex items-center gap-2.5 text-sm text-mist-300">
                  <input
                    type="checkbox"
                    checked={withAudio}
                    onChange={(e) => setWithAudio(e.target.checked)}
                    className="h-4 w-4 accent-[var(--color-brand-500)]"
                  />
                  Record system audio when available
                </label>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export { ScreenRecorder, blobToBytes }
