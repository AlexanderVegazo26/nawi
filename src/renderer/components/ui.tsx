import { useEffect, useRef, type ReactNode } from 'react'

/** Small shared primitives. Kept deliberately plain so views stay readable. */

export function Button({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  title,
  className = '',
  type = 'button',
  autoFocusInModal = false,
  ariaPressed
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle'
  disabled?: boolean
  title?: string
  className?: string
  type?: 'button' | 'submit'
  /**
   * Marks this as the control `Modal` should focus on open (UX-A11Y.3).
   *
   * A named prop rather than a bare `data-autofocus` attribute because this
   * component does not spread unknown props onto the DOM: callers were already
   * writing `<Button data-autofocus>`, it was being dropped on the floor, and
   * every modal was silently falling back to focusing its own container.
   */
  autoFocusInModal?: boolean
  ariaPressed?: boolean
}): React.JSX.Element {
  const styles: Record<string, string> = {
    primary: 'bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-active',
    ghost: 'bg-surface-2 text-text-primary hover:bg-surface-3 ring-1 ring-border-strong',
    subtle: 'bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary',
    danger: 'bg-danger-fill text-white hover:bg-danger-hover'
  }
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      data-autofocus={autoFocusInModal ? '' : undefined}
      aria-pressed={ariaPressed}
      /* min-h-9 keeps every control at or above the 24px target-size floor. */
      className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors motion-tool disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

export function Spinner({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 text-text-secondary" role="status" aria-live="polite">
      <div className="h-7 w-7 motion-spin animate-spin rounded-full border-2 border-border border-t-accent-hover" />
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
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-2 text-text-secondary ring-1 ring-border-strong">
        {icon}
      </div>
      <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-text-secondary">{body}</p>
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
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-danger-surface text-danger ring-1 ring-danger/40">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
      </div>
      <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-text-secondary">{detail}</p>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/70 p-6">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="surface w-full max-w-md rounded-2xl p-5 shadow-2xl"
      >
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        <div className="mt-3 text-sm leading-relaxed text-text-secondary">{children}</div>
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
      className={`motion-toast pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-3 text-sm shadow-2xl ring-1 ${
        tone === 'err'
          ? 'bg-danger-surface text-danger ring-danger/50'
          : 'bg-surface-2 text-text-primary ring-border-strong'
      }`}
    >
      {/*
       * UX-A11Y.4 — tone must not be carried by colour alone. The glyph is a
       * redundant visual marker; the adjacent text is what a screen reader
       * announces, so the icon is aria-hidden and a text prefix carries the
       * same distinction into the accessible name.
       */}
      <span aria-hidden="true" className="shrink-0">
        {tone === 'err' ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5.5M12 16.5h.01" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <circle cx="12" cy="12" r="9" />
            <path d="m8 12.3 2.7 2.7L16 9.6" />
          </svg>
        )}
      </span>
      <span className="flex-1">
        <span className="font-semibold">{tone === 'err' ? 'Error: ' : 'Done: '}</span>
        {message}
      </span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded p-1 text-text-secondary hover:text-text-primary"
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
