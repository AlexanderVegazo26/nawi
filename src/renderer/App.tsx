import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryItem } from '@shared/types'
import { CaptureView } from './components/CaptureView'
import { LibraryView } from './components/LibraryView'
import { EditorView } from './components/EditorView'
import { Toast } from './components/ui'
import { ThemeToggle } from './components/ThemeToggle'
import { ScreenRecorder, blobToBytes, type RecordingResult } from './lib/recorder'

type View = 'capture' | 'library'
interface ToastMsg {
  id: number
  message: string
  tone: 'ok' | 'err'
}

const RAIL: Array<{ id: View; label: string; icon: React.JSX.Element }> = [
  {
    id: 'capture',
    label: 'Capture',
    icon: (
      <>
        <rect x="3" y="6" width="18" height="13" rx="2" />
        <circle cx="12" cy="12.5" r="3.2" />
        <path d="M9 6l1.2-2h3.6L15 6" />
      </>
    )
  },
  {
    id: 'library',
    label: 'Library',
    icon: (
      <>
        <rect x="3" y="4" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="4" width="7.5" height="7.5" rx="1.5" />
        <rect x="3" y="14" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="14" width="7.5" height="7.5" rx="1.5" />
      </>
    )
  }
]

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>('capture')
  const [editing, setEditing] = useState<LibraryItem | null>(null)
  const [items, setItems] = useState<LibraryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<ToastMsg[]>([])
  const [recording, setRecording] = useState<{ elapsedMs: number } | null>(null)

  // Lazily constructed: `useRef(new ScreenRecorder())` would build and discard a
  // recorder on every render, and this object owns a MediaStream.
  const recorderRef = useRef<ScreenRecorder | null>(null)
  if (recorderRef.current === null) recorderRef.current = new ScreenRecorder()
  const toastId = useRef(0)

  const notify = useCallback((message: string, tone: 'ok' | 'err' = 'ok') => {
    const id = ++toastId.current
    setToasts((t) => [...t, { id, message, tone }])
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    const res = await window.api.listLibrary()
    setLoading(false)
    if (res.ok) setItems(res.value)
    else setError(res.error)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /* ---------------- recording timer ---------------- */
  useEffect(() => {
    if (!recording) return
    const started = Date.now()
    const t = setInterval(() => setRecording({ elapsedMs: Date.now() - started }), 250)
    return () => clearInterval(t)
    // Restarting the timer on every tick would reset it, so this depends only on
    // whether a recording is active, not on the elapsed value.
  }, [recording !== null]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Writes a finished recording to the library. Shared by the explicit and OS-initiated stop paths. */
  const persistRecording = useCallback(
    async (result: RecordingResult) => {
      const bytes = await blobToBytes(result.blob)
      const res = await window.api.saveRecording({
        data: bytes,
        width: result.width,
        height: result.height,
        durationMs: result.durationMs
      })
      if (!res.ok) {
        notify(res.error, 'err')
        return
      }
      setItems((prev) => [res.value, ...prev])
      setView('library')
      notify('Recording saved to library')
    },
    [notify]
  )

  const stopRecording = useCallback(async () => {
    const rec = recorderRef.current!
    // Clear the banner even when the recorder is already inactive, so the UI can
    // never be stuck showing "recording in progress" with a dead recorder.
    if (!rec.active) {
      setRecording(null)
      return
    }
    try {
      const result = await rec.stop()
      setRecording(null)
      await persistRecording(result)
    } catch (err) {
      setRecording(null)
      notify(err instanceof Error ? err.message : String(err), 'err')
    }
  }, [notify, persistRecording])

  // The user can stop a recording from the OS's own "stop sharing" bar. Without
  // this the finished blob is discarded and the app stays stuck mid-recording.
  useEffect(() => {
    const rec = recorderRef.current!
    rec.onAutoStop = () => {
      void (async () => {
        try {
          const result = await rec.result
          setRecording(null)
          if (result) await persistRecording(result)
          else notify('Recording stopped before anything was captured', 'err')
        } catch (err) {
          setRecording(null)
          notify(err instanceof Error ? err.message : String(err), 'err')
        }
      })()
    }
    return () => {
      rec.onAutoStop = null
    }
  }, [persistRecording, notify])

  // Never leave a capture stream running behind a closed window.
  useEffect(() => {
    const rec = recorderRef.current!
    return () => rec.cancel()
  }, [])

  useEffect(() => {
    const handler = (): void => void stopRecording()
    window.addEventListener('nawi:stop-recording', handler)
    return () => window.removeEventListener('nawi:stop-recording', handler)
  }, [stopRecording])

  /* ---------------- capture results ---------------- */
  const onCaptured = useCallback(
    (item: LibraryItem, openEditor: boolean) => {
      setItems((prev) => [item, ...prev])
      if (openEditor) setEditing(item)
      else setView('library')
      notify('Capture saved')
    },
    [notify]
  )

  /* ---------------- global shortcuts from main ---------------- */
  useEffect(() => {
    return window.api.onShortcut((action) => {
      // A capture during recording would dim the recorded frames; refuse it.
      if (recorderRef.current!.active && action !== 'record-stop') {
        notify('Stop the recording before starting a new capture', 'err')
        return
      }
      // Never destroy unsaved editor work behind the user's back.
      if (editing && action !== 'show-main') {
        notify('Close the editor before starting a new capture', 'err')
        return
      }

      switch (action) {
        case 'capture-region':
          setView('capture')
          void window.api.beginRegion().then((res) => {
            if (res.ok && res.value) onCaptured(res.value, true)
            else if (!res.ok) notify(res.error, 'err')
          })
          break
        case 'capture-fullscreen':
          setView('capture')
          void window.api.captureFullscreen().then((res) => {
            if (res.ok) onCaptured(res.value, true)
            else notify(res.error, 'err')
          })
          break
        case 'capture-window':
          setView('capture')
          break
        case 'record-start':
          setView('capture')
          break
        case 'record-stop':
          void stopRecording()
          break
        case 'show-main':
          break
      }
    })
  }, [editing, onCaptured, notify, stopRecording])

  const onDelete = useCallback(
    async (item: LibraryItem) => {
      const res = await window.api.deleteLibraryItem(item.id)
      if (!res.ok) {
        notify(res.error, 'err')
        return
      }
      setItems((prev) => prev.filter((i) => i.id !== item.id))
      notify(`Deleted “${item.name}”`)
    },
    [notify]
  )

  const onRename = useCallback(
    async (item: LibraryItem, name: string) => {
      const res = await window.api.renameLibraryItem(item.id, name)
      if (!res.ok) {
        notify(res.error, 'err')
        return
      }
      setItems((prev) => prev.map((i) => (i.id === item.id ? res.value : i)))
    },
    [notify]
  )

  if (editing) {
    return (
      <>
        <EditorView
          item={editing}
          onClose={() => {
            // The back button is labelled "Library", and the item the user was
            // just editing lives there — so that is where closing should land.
            setEditing(null)
            setView('library')
          }}
          onSaved={(updated) => {
            setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
            setEditing(updated)
          }}
          notify={notify}
        />
        <ToastStack toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
      </>
    )
  }

  return (
    <div className="flex h-full">
      <nav
        aria-label="Main"
        className="flex w-[76px] shrink-0 flex-col items-center gap-1.5 border-r border-border bg-surface-1 py-4"
      >
        <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-accent-fg">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
          </svg>
        </div>

        {RAIL.map((r) => (
          <button
            key={r.id}
            onClick={() => setView(r.id)}
            aria-current={view === r.id ? 'page' : undefined}
            className={`flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-xl text-[11px] transition-colors motion-tool ${
              view === r.id
                ? 'bg-surface-3 text-text-primary'
                : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
            }`}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              {r.icon}
            </svg>
            {r.label}
          </button>
        ))}

        <div className="flex-1" />
        <ThemeToggle />
        {recording && (
          <div className="flex flex-col items-center gap-1 text-[10px] text-danger">
            <span className="h-2.5 w-2.5 motion-pulse animate-pulse rounded-full bg-danger" />
            REC
          </div>
        )}
      </nav>

      <main className="min-w-0 flex-1">
        {view === 'capture' ? (
          <CaptureView
            onCaptured={onCaptured}
            notify={notify}
            recorder={recorderRef.current!}
            recording={recording}
            setRecording={setRecording}
          />
        ) : (
          <LibraryView
            items={items}
            loading={loading}
            error={error}
            onReload={reload}
            onOpen={setEditing}
            onDelete={onDelete}
            onRename={onRename}
            notify={notify}
            onNewCapture={() => setView('capture')}
          />
        )}
      </main>

      <ToastStack toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  )
}

function ToastStack({
  toasts,
  dismiss
}: {
  toasts: ToastMsg[]
  dismiss: (id: number) => void
}): React.JSX.Element {
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <Toast key={t.id} message={t.message} tone={t.tone} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  )
}
