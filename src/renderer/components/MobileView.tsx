/**
 * Roadmap M1d — drop an .apk, see it running.
 *
 * The file is dropped anywhere on the window (App turns the drop into a
 * `request`) or picked with the button, which keeps the flow usable from the
 * keyboard. Main does the work (the same open as the MCP tool mobile_open) and
 * reports each step as it starts; this view lists the steps, shows the one fix
 * when a step fails, and once the app runs, the device's live screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, EmptyState } from './ui'
import {
  MOBILE_STEPS,
  isAndroidPackageName,
  type MobileOpenView,
  type MobileStepId,
  type MobileStepStatus
} from '@shared/mobile'

export interface ApkRequest {
  path: string
  name: string
  /** Changes on every drop, so dropping the same file again opens it again. */
  nonce: number
}

const STEP_LABEL: Record<MobileStepId, string> = {
  read: 'Read the app',
  doctor: 'Find a device',
  boot: 'Start the virtual device',
  install: 'Install',
  grant: 'Grant permissions',
  launch: 'Launch'
}

type RowStatus = MobileStepStatus | 'running' | 'done' | 'pending' | 'not-run' | 'cancelled'

const STATUS_TEXT: Record<RowStatus, string> = {
  ok: 'done',
  done: 'done',
  warn: 'done with a warning',
  fail: 'failed',
  skipped: 'skipped',
  running: 'in progress',
  pending: 'waiting',
  'not-run': 'not run',
  cancelled: 'cancelled'
}

const STATUS_MARK: Record<RowStatus, string> = {
  ok: '✓',
  done: '✓',
  warn: '!',
  fail: '✕',
  skipped: '–',
  running: '…',
  pending: '·',
  'not-run': '·',
  cancelled: '–'
}

const STATUS_TONE: Record<RowStatus, string> = {
  ok: 'text-success',
  done: 'text-success',
  warn: 'text-warning',
  fail: 'text-danger',
  skipped: 'text-text-secondary',
  running: 'text-accent',
  pending: 'text-text-secondary',
  'not-run': 'text-text-secondary',
  cancelled: 'text-text-secondary'
}

interface Row {
  id: MobileStepId
  status: RowStatus
  summary: string
  fix: string | null
}

export type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; started: Map<MobileStepId, string> }
  | { kind: 'done'; view: MobileOpenView; started: Map<MobileStepId, string> }
  | { kind: 'error'; message: string }

function rowsFor(phase: Phase): Row[] {
  if (phase.kind === 'running') {
    const ids = [...phase.started.keys()]
    const current = ids[ids.length - 1]
    return MOBILE_STEPS.map((id) => ({
      id,
      status: !phase.started.has(id) ? 'pending' : id === current ? 'running' : 'done',
      summary: phase.started.get(id) ?? '',
      fix: null
    }))
  }
  if (phase.kind === 'done') {
    const { view, started } = phase
    const byId = new Map(view.steps.map((s) => [s.id, s]))
    const ids = [...started.keys()]
    const current = ids[ids.length - 1]
    return MOBILE_STEPS.map((id) => {
      const s = byId.get(id)
      if (s) return { id, status: s.status, summary: s.summary, fix: s.fix }
      // Cancelled: the step that was running is the one that stopped.
      if (view.cancelled && started.has(id)) return { id, status: id === current ? 'cancelled' : 'done', summary: started.get(id) ?? '', fix: null }
      return { id, status: 'not-run', summary: '', fix: null }
    })
  }
  return []
}

/** The open in progress or last finished, owned by App (which never unmounts) so no view change restarts it. */
export interface MobileOpen {
  phase: Phase
  /** The file being or last opened. */
  request: ApkRequest | null
  /** Start opening `req`; false (nothing changes) while another open runs. */
  start: (req: ApkRequest) => boolean
  cancel: () => void
}

export function useMobileOpen(): MobileOpen {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [request, setRequest] = useState<ApkRequest | null>(null)
  const started = useRef<Map<MobileStepId, string>>(new Map())
  const running = useRef(false)
  /** The open id main tagged this open's first event with; events of any other open are dropped. */
  const openId = useRef<number | null>(null)

  useEffect(
    () =>
      window.api.onMobileProgress((p) => {
        if (!running.current) return
        // Main's first event of an open is 'read': it tells us that open's id.
        if (openId.current === null && p.id === 'read') openId.current = p.openId
        if (p.openId !== openId.current) return
        started.current = new Map(started.current).set(p.id, p.summary)
        setPhase({ kind: 'running', started: started.current })
      }),
    []
  )

  const start = useCallback((req: ApkRequest): boolean => {
    if (running.current) return false
    running.current = true
    openId.current = null
    started.current = new Map()
    setRequest(req)
    setPhase({ kind: 'running', started: started.current })
    void (async () => {
      try {
        const r = await window.api.openApk(req.path)
        setPhase(r.ok ? { kind: 'done', view: r.value, started: started.current } : { kind: 'error', message: r.error })
      } catch (err) {
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        running.current = false
      }
    })()
    return true
  }, [])

  const cancel = useCallback(() => void window.api.cancelMobileOpen(), [])
  return { phase, request, start, cancel }
}

export function MobileView({
  open,
  onPick,
  active = true,
  screenIntervalMs = 1000
}: {
  open: MobileOpen
  /** A file chosen with the button; App opens it like a drop. */
  onPick: (file: File) => void
  /** False while another view is shown: the live screen stops polling. */
  active?: boolean
  screenIntervalMs?: number
}): React.JSX.Element {
  const { phase, request, start } = open
  const input = useRef<HTMLInputElement>(null)

  const pick = (
    <>
      <input
        ref={input}
        type="file"
        accept=".apk,.aab"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) onPick(file)
        }}
      />
      <Button variant={phase.kind === 'idle' ? 'primary' : 'subtle'} onClick={() => input.current?.click()} disabled={phase.kind === 'running'}>
        Choose an .apk…
      </Button>
    </>
  )

  if (phase.kind === 'idle') {
    return (
      <EmptyState
        icon={<PhoneIcon />}
        title="Open an Android app"
        body="Drop an .apk anywhere on this window. Nawi finds a device or virtual device that can run it, installs it, grants its permissions, starts it and shows its screen here."
        action={pick}
      />
    )
  }

  const rows = rowsFor(phase)
  const view = phase.kind === 'done' ? phase.view : null
  const serial = view?.ok ? (view.target?.serial ?? null) : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-auto p-6 lg:flex-row">
      <section aria-labelledby="mobile-open-title" className="flex min-w-0 flex-1 flex-col gap-4 lg:max-w-xl">
        <h2 id="mobile-open-title" className="text-lg font-semibold text-text-primary">
          {request?.name ?? 'Android app'}
        </h2>
        <ol aria-label="Steps" className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-3 rounded-lg bg-surface-1 px-3 py-2 ring-1 ring-border">
              <span aria-hidden="true" className={`mt-0.5 w-4 shrink-0 text-center font-semibold ${STATUS_TONE[row.status]}`}>
                {STATUS_MARK[row.status]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-text-primary">
                  {STEP_LABEL[row.id]} <span className="sr-only">— {STATUS_TEXT[row.status]}</span>
                </p>
                {row.summary && <p className="break-words text-xs text-text-secondary">{row.summary}</p>}
                {row.fix && row.status === 'warn' && <p className="break-words text-xs text-warning">{row.fix}</p>}
              </div>
            </li>
          ))}
        </ol>

        <div role="status" aria-live="polite" className="text-sm text-text-secondary">
          {phase.kind === 'running' && 'Opening the app…'}
          {view?.ok && `${view.package} is running on ${view.target?.name ?? 'the device'}.`}
          {view?.cancelled && 'Cancelled.'}
        </div>
        {view && !view.ok && !view.cancelled && view.fix && (
          <div role="alert" className="rounded-lg bg-danger-surface px-3 py-2 text-sm text-text-primary ring-1 ring-danger">
            <p className="font-medium">What to do</p>
            <p className="mt-1 break-words">{view.fix}</p>
          </div>
        )}
        {phase.kind === 'error' && (
          <div role="alert" className="rounded-lg bg-danger-surface px-3 py-2 text-sm text-text-primary ring-1 ring-danger">
            <p className="break-words">{phase.message}</p>
          </div>
        )}
        {view?.ok && view.profile && (
          <p className="break-words text-xs text-text-secondary">
            Saved as {view.profile}: open it with <code>nawi mobile-open</code> or the mobile_open tool to repeat this.
          </p>
        )}
        {view?.ok && view.profile_error && <p className="break-words text-xs text-warning">{view.profile_error}</p>}

        <div className="flex flex-wrap gap-2">
          {phase.kind === 'running' ? (
            <Button variant="subtle" onClick={open.cancel}>
              Cancel
            </Button>
          ) : (
            request && (
              <Button variant="subtle" onClick={() => start(request)}>
                {view?.ok ? 'Open again' : 'Try again'}
              </Button>
            )
          )}
          {pick}
        </div>
      </section>

      {serial && active && <LiveScreen key={serial} serial={serial} intervalMs={screenIntervalMs} />}
    </div>
  )
}

/** Consecutive failed frames after which polling stops until the user retries. */
export const SCREEN_MAX_FAILURES = 3

/**
 * The device's screen, refreshed one frame at a time (the next request goes out
 * only after the last reply, so a slow device is never flooded), and paused
 * while the window is hidden.
 */
export function LiveScreen({ serial, intervalMs }: { serial: string; intervalMs: number }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [problem, setProblem] = useState<{ error: string; fix: string | null } | null>(null)
  const [stopped, setStopped] = useState(false)
  const [round, setRound] = useState(0)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let shown: string | null = null
    const next = (): void => {
      timer = setTimeout(() => void tick(), intervalMs)
    }
    const tick = async (): Promise<void> => {
      if (!live) return
      if (document.hidden) return next()
      const r = await window.api.getMobileScreen(serial).catch((err: unknown) => ({ ok: false as const, error: String(err) }))
      if (!live) return
      const frame = r.ok ? r.value : { ok: false as const, error: r.error, fix: null }
      if (frame.ok) {
        failures = 0
        const nextUrl = URL.createObjectURL(new Blob([frame.png as BlobPart], { type: 'image/png' }))
        if (shown) URL.revokeObjectURL(shown)
        shown = nextUrl
        setUrl(nextUrl)
        setSize({ width: frame.width, height: frame.height })
        setProblem(null)
      } else {
        failures++
        setProblem({ error: frame.error, fix: frame.fix })
        if (failures >= SCREEN_MAX_FAILURES) {
          setStopped(true)
          return
        }
      }
      next()
    }
    setStopped(false)
    void tick()
    return () => {
      live = false
      clearTimeout(timer)
      if (shown) URL.revokeObjectURL(shown)
    }
  }, [serial, intervalMs, round])

  return (
    <section aria-label={`Screen of ${serial}`} className="flex min-w-0 flex-col items-center gap-3">
      {url ? (
        <img
          src={url}
          alt={`Live screen of ${serial}`}
          width={size?.width}
          height={size?.height}
          className="h-auto max-h-[70vh] w-auto max-w-full rounded-2xl object-contain ring-1 ring-border-strong"
        />
      ) : (
        !problem && <p className="text-sm text-text-secondary">Waiting for the screen…</p>
      )}
      {problem && (
        <div role={stopped ? 'alert' : undefined} className="max-w-sm text-center text-xs text-text-secondary">
          <p className="break-words">{problem.error}</p>
          {problem.fix && <p className="mt-1 break-words">{problem.fix}</p>}
        </div>
      )}
      {stopped && (
        <Button variant="subtle" onClick={() => setRound((n) => n + 1)}>
          Show the screen again
        </Button>
      )}
    </section>
  )
}

export function PhoneIcon(): React.JSX.Element {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <PhonePaths />
    </svg>
  )
}

/** The phone outline, shared with the Mobile entry of App's rail. */
export function PhonePaths(): React.JSX.Element {
  return (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" />
    </>
  )
}

/** True when a drag carries files (not text or a link), so the window should accept the drop. */
export function dragHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files')
}

export { isAndroidPackageName }
