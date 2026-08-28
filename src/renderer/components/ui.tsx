import { useEffect, useRef, type ReactNode } from 'react'

/** Small shared primitives. Kept deliberately plain so views stay readable. */

export function Button({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  title,
  className = '',
  type = 'button'
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle'
  disabled?: boolean
  title?: string
  className?: string
  type?: 'button' | 'submit'
}): React.JSX.Element {
  const styles: Record<string, string> = {
    primary: 'bg-brand-500 text-white hover:bg-brand-400 active:bg-brand-600',
    ghost: 'bg-ink-800 text-mist-100 hover:bg-ink-700 ring-1 ring-ink-600',
    subtle: 'bg-transparent text-mist-300 hover:bg-ink-800 hover:text-mist-100',
    danger: 'bg-red-600/90 text-white hover:bg-red-500'
  }
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      /* min-h-9 keeps every control at or above the 24px target-size floor. */
      className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

export function Spinner({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 text-mist-400" role="status" aria-live="polite">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-ink-600 border-t-brand-400" />
      <p className="text-sm">{label}</p>
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  body,
  action
}: {
  icon: ReactNode
  title: string
  body: string
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-ink-800 text-mist-400 ring-1 ring-ink-700">
        {icon}
      </div>
      <h2 className="text-lg font-semibold text-mist-100">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-mist-400">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function ErrorState({
  title,
  detail,
  onRetry
}: {
  title: string
  detail: string
  onRetry?: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center" role="alert">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-950/60 text-red-300 ring-1 ring-red-900/60">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
      </div>
      <h2 className="text-lg font-semibold text-mist-100">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-mist-400">{detail}</p>
      {onRetry && (
        <div className="mt-5">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  )
}

/** Focus-trapping modal that restores focus to whatever opened it. */
export function Modal({
  title,
  children,
  onClose,
  footer
}: {
  title: string
  children: ReactNode
  onClose: () => void
  footer?: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null
    // Initial focus goes to the safest control, not the destructive one.
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus]')
    ;(first ?? ref.current)?.focus()
    return () => restoreTo.current?.focus?.()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !ref.current) return
      const focusables = ref.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/70 p-6">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="surface w-full max-w-md rounded-2xl p-5 shadow-2xl"
      >
        <h2 className="text-base font-semibold text-mist-100">{title}</h2>
        <div className="mt-3 text-sm leading-relaxed text-mist-300">{children}</div>
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

export function Toast({
  message,
  tone,
  onDismiss
}: {
  message: string
  tone: 'ok' | 'err'
  onDismiss: () => void
}): React.JSX.Element {
  useEffect(() => {
    const t = setTimeout(onDismiss, tone === 'err' ? 6000 : 3200)
    return () => clearTimeout(t)
  }, [onDismiss, tone])

  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-3 text-sm shadow-2xl ring-1 ${
        tone === 'err'
          ? 'bg-red-950 text-red-100 ring-red-800'
          : 'bg-ink-800 text-mist-100 ring-ink-600'
      }`}
    >
      <span className="flex-1">{message}</span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded p-1 text-mist-400 hover:text-mist-100"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" fill="none">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatWhen(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? `Today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
        ` ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}
