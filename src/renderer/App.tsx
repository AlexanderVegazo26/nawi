import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryItem, RecoverableRecordingInfo } from '@shared/types'
import { idleStatus, type RecordingStatus } from '@shared/recording'
import { CaptureView } from './components/CaptureView'
import { LibraryView } from './components/LibraryView'
import { EditorView } from './components/EditorView'
import { RecoveryBanner } from './components/RecoveryBanner'
import { LiveAnnouncer, OfflineBanner, Toast, UNDO_WINDOW_MS } from './components/ui'
import { failureFrom } from './lib/failure'
import { ThemeToggle } from './components/ThemeToggle'
import { AgentAccessToggle } from './components/AgentAccessToggle'

type View = 'capture' | 'library'
interface ToastMsg {
  id: number
  message: string
  tone: 'ok' | 'err'
  /** PRD-002 P5 — present on every destructive action's toast. */
  action?: { label: string; onAction: () => void }
  durationMs?: number
  /** How many times this same message fired in a row; 1 (or absent) shows no badge. */
  repeats?: number
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
  /**
   * Mirrored from the hidden recorder window via main. This window no longer
   * owns a MediaRecorder at all — it only renders what the engine reports, so
   * minimising or backgrounding it cannot affect a recording.
   */
  const [recording, setRecording] = useState<RecordingStatus>(idleStatus())
  const [recoverable, setRecoverable] = useState<RecoverableRecordingInfo[]>([])
  const toastId = useRef(0)

  const notify = useCallback((message: string, tone: 'ok' | 'err' = 'ok') => {
    setToasts((t) => {
      /*
       * Repeating an action repeats its toast, and three identical "Copied to
       * clipboard" bars say nothing the first one didn't while taking three
       * times the space. An immediate repeat replaces the previous card and
       * bumps a count, so it re-reads as fresh feedback rather than as backlog.
       *
       * Only the newest toast is coalesced: collapsing a repeat that sits
       * behind a *different* message would reorder the two, and an error that
       * scrolled upward while an unrelated success re-announced itself is worse
       * than a duplicate.
       */
      const last = t[t.length - 1]
      if (last && last.message === message && last.tone === tone && !last.action) {
        const repeats = (last.repeats ?? 1) + 1
        return [...t.slice(0, -1), { ...last, id: ++toastId.current, repeats }]
      }
      return [...t, { id: ++toastId.current, message, tone }]
    })
  }, [])

  /**
   * PRD-002 §1 P5 — the undo toast for a destructive action.
   *
   * Separate from `notify` because the lifetime is load-bearing: the default
   * 3.2 s toast would vanish 27 seconds before the window main is actually
   * holding open, leaving an undo that exists but that nobody can reach.
   */
  const notifyUndo = useCallback(
    (message: string, onUndo: () => void) => {
      const id = ++toastId.current
      setToasts((t) => [
        ...t,
        { id, message, tone: 'ok', durationMs: UNDO_WINDOW_MS, action: { label: 'Undo', onAction: onUndo } }
      ])
    },
    []
  )

  /**
   * UX-STA.4 — offline is a normal state.
   *
   * `navigator.onLine` is only ever a hint (it reports link state, not
   * reachability), which is fine precisely because nothing here depends on the
   * network; the banner is informational and never blocks an action.
   */
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  )
  useEffect(() => {
    const up = (): void => setOnline(true)
    const down = (): void => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  /** UX-A11Y.8 — capture completion and recording start/stop, announced. */
  const [announcement, setAnnouncement] = useState('')

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

  /* ---------------- recording (mirrored from the recorder window) ---------------- */
  useEffect(() => {
    // Ask once as well as subscribing: a recording started before this window
    // opened would otherwise show as idle until the next broadcast.
    void window.api.getRecordingStatus().then((res) => {
      if (res.ok) setRecording(res.value)
    })
    const offStatus = window.api.onRecordingStatus(setRecording)
    const offFinished = window.api.onRecordingFinished((item) => {
      setItems((prev) => [item, ...prev])
      setView('library')
      notify('Recording saved to library')
    })
    const offFailed = window.api.onRecordingFailed((error) => notify(error, 'err'))
    return () => {
      offStatus()
      offFinished()
      offFailed()
    }
  }, [notify])

  const stopRecording = useCallback(() => {
    void window.api.sendRecordCommand('stop')
  }, [])

  /* ---------------- FR-REC.3 recovery on launch ---------------- */
  const refreshRecoverable = useCallback(async () => {
    const res = await window.api.listRecoverableRecordings()
    if (res.ok) setRecoverable(res.value)
    // A failed scan is not worth a toast on launch: it means nothing was
    // offered, and the recording — if there is one — is still on disk for the
    // next attempt. It is logged in main.
  }, [])

  useEffect(() => {
    void refreshRecoverable()
  }, [refreshRecoverable])

  // Rescan once a recording ends, so a file left behind by a *previous* crash
  // does not reappear as an offer in the middle of a live recording.
  useEffect(() => {
    if (recording.phase === 'idle') void refreshRecoverable()
  }, [recording.phase, refreshRecoverable])

  const onRecover = useCallback(
    async (id: string) => {
      const res = await window.api.recoverRecording(id)
      if (!res.ok) {
        notify(res.error, 'err')
        return
      }
      setItems((prev) => [res.value, ...prev])
      setRecoverable((prev) => prev.filter((r) => r.id !== id))
      setView('library')
      notify('Recovered recording added to your library')
    },
    [notify]
  )

  const onDiscardRecoverable = useCallback(
    async (id: string) => {
      const res = await window.api.discardRecoverableRecording(id)
      if (!res.ok) {
        notify(res.error, 'err')
        return
      }
      setRecoverable((prev) => prev.filter((r) => r.id !== id))
    },
    [notify]
  )

  useEffect(() => {
    const handler = (): void => stopRecording()
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
      // UX-A11Y.8 — capture completion announced. The toast is `aria-live`
      // too, but it unmounts on a timer and a toast that has already gone is
      // not an announcement anyone can wait for.
      setAnnouncement(`Capture saved: ${item.name}, ${item.width} by ${item.height} pixels`)
    },
    [notify]
  )

  /** UX-A11Y.8 — recording start and stop announced. */
  const lastPhase = useRef(recording.phase)
  useEffect(() => {
    const prev = lastPhase.current
    lastPhase.current = recording.phase
    if (prev === recording.phase) return
    if (recording.phase === 'recording' && prev !== 'paused') setAnnouncement('Recording started')
    else if (recording.phase === 'paused') setAnnouncement('Recording paused')
    else if (recording.phase === 'recording' && prev === 'paused') setAnnouncement('Recording resumed')
    else if (prev !== 'idle' && recording.phase === 'idle') setAnnouncement('Recording stopped')
  }, [recording.phase])

  /* ---------------- global shortcuts from main ---------------- */
  useEffect(() => {
    return window.api.onShortcut((action) => {
      const isRecording = recording.phase !== 'idle' && recording.phase !== 'error'
      // A capture during recording would dim the recorded frames; refuse it.
      if (isRecording && action !== 'record-stop') {
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
          stopRecording()
          break
        case 'show-main':
          break
      }
    })
  }, [editing, onCaptured, notify, stopRecording, recording.phase])

  /**
   * PRD-002 §1 P5 — delete is reversible for 30 seconds.
   *
   * Main marks the item and schedules the real removal; this only has to hide
   * it and offer the way back. The undo path re-inserts at the position the
   * item's `createdAt` sorts to, not at the top, so undoing does not silently
   * reorder the grid.
   */
  const onDelete = useCallback(
    async (item: LibraryItem) => {
      const res = await window.api.deleteLibraryItem(item.id)
      if (!res.ok) {
        notify(
          failureFrom(res.error, {
            failed: `Couldn’t delete “${item.name}”`,
            intact: 'It is still in your library and nothing was removed',
            next: 'Try again'
          }),
          'err'
        )
        return
      }
      setItems((prev) => prev.filter((i) => i.id !== item.id))
      notifyUndo(`Deleted “${item.name}”`, () => {
        void window.api.restoreLibraryItem(item.id).then((restored) => {
          if (!restored.ok || !restored.value) {
            notify(
              failureFrom(restored.ok ? 'the undo window had already closed' : restored.error, {
                failed: `Couldn’t bring “${item.name}” back`,
                intact: 'Every other capture in your library is untouched',
                next: 'Deletes can only be undone within 30 seconds'
              }),
              'err'
            )
            return
          }
          const back = restored.value
          setItems((prev) =>
            [...prev, back].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          )
        })
      })
    },
    [notify, notifyUndo]
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
          /*
           * Handed in rather than rendered as a sibling: as a viewport-pinned
           * overlay this stack sat on top of the editor's properties bar,
           * covering the colour swatches and zoom controls. EditorView anchors
           * the slot above that bar instead.
           */
          toastSlot={
            <ToastStack
              variant="inline"
              toasts={toasts}
              dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))}
            />
          }
        />
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
        <AgentAccessToggle />
        <ThemeToggle />
        {recording.phase !== 'idle' && recording.phase !== 'error' && (
          <div className="flex flex-col items-center gap-1 text-[10px] text-danger" role="status">
            <span
              className={`h-2.5 w-2.5 rounded-full bg-danger ${
                recording.phase === 'paused' ? '' : 'motion-pulse animate-pulse'
              }`}
              aria-hidden="true"
            />
            {recording.phase === 'paused' ? 'PAUSED' : 'REC'}
          </div>
        )}
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
        <OfflineBanner online={online} />
        <RecoveryBanner
          items={recoverable}
          onRecover={(id) => void onRecover(id)}
          onDiscard={(id) => void onDiscardRecoverable(id)}
        />
        {/* min-h-0 so the scrolling view shrinks under the banner instead of
            pushing the layout past the viewport. */}
        <div className="min-h-0 flex-1">
          {view === 'capture' ? (
            <CaptureView onCaptured={onCaptured} notify={notify} recording={recording} />
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
        </div>
      </main>

      <LiveAnnouncer message={announcement} />
      <ToastStack toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  )
}

/**
 * How many toasts are ever drawn at once.
 *
 * `notify` appends without bound and `notifyUndo` pins one for a full 30 s, so
 * a few quick actions used to grow a column of bars tall enough to cover the
 * editor's toolbar and canvas. Three keeps the newest feedback visible while
 * putting a ceiling on the height; older ones are counted rather than drawn,
 * because silently dropping them would hide an error someone needs to see.
 */
const MAX_VISIBLE_TOASTS = 3

function ToastStack({
  toasts,
  dismiss,
  /**
   * `floating` pins the stack to the viewport's bottom-right — right for the
   * capture and library views, which have no bottom chrome.
   *
   * `inline` renders it in normal flow so a caller can anchor it. The editor
   * uses that to sit the stack directly above its properties bar: anchoring to
   * the footer means a wrapped, taller footer still cannot be covered, with no
   * measurement and no resize observer to keep in sync.
   */
  variant = 'floating'
}: {
  toasts: ToastMsg[]
  dismiss: (id: number) => void
  variant?: 'floating' | 'inline'
}): React.JSX.Element {
  // Newest first so the most recent action is nearest the surface it came from,
  // and so the ones dropped by the cap are the stalest.
  const ordered = [...toasts].reverse()
  const visible = ordered.slice(0, MAX_VISIBLE_TOASTS)
  const hidden = ordered.length - visible.length

  return (
    <div
      className={`pointer-events-none flex w-80 flex-col gap-2 ${
        variant === 'floating' ? 'fixed bottom-5 right-5 z-[60]' : 'z-[60]'
      }`}
    >
      {hidden > 0 && (
        <p className="self-end rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-text-secondary ring-1 ring-border-strong">
          {hidden} more notification{hidden === 1 ? '' : 's'}
        </p>
      )}
      {visible.map((t) => (
        <Toast
          key={t.id}
          message={t.message}
          tone={t.tone}
          action={t.action}
          durationMs={t.durationMs}
          repeats={t.repeats}
          onDismiss={() => dismiss(t.id)}
        />
      ))}
    </div>
  )
}
