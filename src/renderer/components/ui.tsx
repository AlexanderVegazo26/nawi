import { useEffect, useRef, type ReactNode } from 'react'
import { Dialog, DialogContent, DialogOverlay, DialogTitle } from './shadcn/dialog'

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
  ariaPressed,
  ariaLabel,
  size = 'default'
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
  ariaLabel?: string
  /**
   * `hit` raises the control to a 44x44 px minimum for UX-A11Y.9 (HUD and
   * overlay controls) and WCAG 2.2 SC 2.5.8.
   *
   * A variant rather than a new default: `Button` is used on every surface, and
   * moving the baseline would reflow the Library, the Editor rail and every
   * modal footer at once. The requirement names HUD and overlay specifically,
   * so that is where the variant is applied.
   */
  size?: 'default' | 'hit'
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
      aria-label={ariaLabel}
      data-size={size}
      /*
       * WCAG 2.2 SC 2.5.8 sets a 24x24 px floor; UX-A11Y.9 sets a stricter
       * 44x44 px floor for HUD and overlay controls, which `size="hit"`
       * applies. The default 36 px clears 2.5.8 but NOT UX-A11Y.9 — so the
       * requirement is met by the call site choosing the variant, not by this
       * default.
       */
      className={`inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors motion-tool disabled:cursor-not-allowed disabled:opacity-40 ${
        size === 'hit' ? 'min-h-11 min-w-11 px-4' : 'min-h-9 px-3.5'
      } ${styles[variant]} ${className}`}
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

/**
 * UX-STA.2 loading placeholder for the Library grid.
 *
 * Replaces a full-screen `Spinner`, which the requirement forbids outright
 * ("Never a full-screen blocking spinner"). The point is not that a skeleton
 * looks nicer: the spinner replaced the *entire* view, so the header, the
 * search field and the New capture button all disappeared while the index was
 * read, and a user who pressed Ctrl+F during the load hit nothing. These cards
 * occupy the grid's real geometry, so the surrounding surface stays operable
 * and nothing reflows when the real cards arrive.
 *
 * One `role="status"` on the container, not per card — twelve live regions
 * would announce twelve times.
 */
export function SkeletonGrid({ count = 8 }: { count?: number }): React.JSX.Element {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading your library…</span>
      <ul
        aria-hidden="true"
        className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4"
        data-testid="library-skeleton"
      >
        {Array.from({ length: count }, (_, i) => (
          <li key={i} className="surface overflow-hidden rounded-xl">
            <div className="motion-pulse aspect-video animate-pulse bg-surface-2" />
            <div className="flex flex-col gap-2 px-3 py-3">
              <div className="motion-pulse h-3.5 w-3/5 animate-pulse rounded bg-surface-2" />
              <div className="motion-pulse h-2.5 w-4/5 animate-pulse rounded bg-surface-2" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * UX-VIS.4 — the generated-content signature: sparkle glyph plus a subtle
 * tinted background, used identically everywhere.
 *
 * Built now, before M2 produces any generated content, because P4 ("nothing
 * generated is silently authoritative") is only satisfied by the treatment
 * being *consistent*. If each of narration, alt text, step text and emitted
 * code invents its own marker at the point it ships, the signature teaches the
 * user nothing and the principle is decorative.
 *
 * The glyph is `aria-hidden` and the marking is carried into the accessible
 * name by real text, so the distinction survives with no sight of the tint —
 * UX-A11Y.4, never meaning by colour alone.
 */
export function GeneratedContent({
  children,
  label = 'Suggested',
  as: Tag = 'div',
  className = ''
}: {
  children: ReactNode
  /** Names *what* is suggested, e.g. "Suggested step text". Never "Step text". */
  label?: string
  as?: 'div' | 'span' | 'p'
  className?: string
}): React.JSX.Element {
  return (
    <Tag
      data-generated="true"
      className={`rounded-lg bg-accent/10 px-2.5 py-1.5 ring-1 ring-accent/30 ${className}`}
    >
      <span className="mr-1.5 inline-flex items-center gap-1 align-middle text-[11px] font-semibold uppercase tracking-wide text-accent">
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="shrink-0"
        >
          <path d="M12 2.5l1.9 5.2 5.2 1.9-5.2 1.9L12 16.7l-1.9-5.2L4.9 9.6l5.2-1.9L12 2.5Z" />
          <path d="M18.5 15.5l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4Z" />
        </svg>
        {label}
      </span>
      {children}
    </Tag>
  )
}

/**
 * UX-STA.4 — offline is a normal state, not an error.
 *
 * Deliberately not a modal and deliberately not `--color-danger`: the
 * requirement says "No modal, no red", and everything this app does — capture,
 * annotate, export to disk — works with no network at all. `role="status"`
 * rather than `role="alert"` for the same reason.
 */
export function OfflineBanner({ online }: { online: boolean }): React.JSX.Element | null {
  if (online) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className="flex shrink-0 items-center gap-2.5 border-b border-border bg-surface-2 px-6 py-2 text-xs text-text-secondary"
    >
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="shrink-0"
      >
        <path d="M2 2l20 20M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 4-2.6M19 12.9a10 10 0 0 0-6.3-2.9M1.7 9.4A15 15 0 0 1 6 6.6M22.3 9.4a15 15 0 0 0-8.8-3.3M12 20h.01" />
      </svg>
      Offline — captures are saved locally and will sync.
    </div>
  )
}

/**
 * A one-shot polite announcement for a screen reader (UX-A11Y.8).
 *
 * The node has to exist in the tree *before* its text changes or many screen
 * readers never announce it, so this renders an always-present empty region and
 * only the text changes. Callers pass a monotonically-changing `message`.
 */
export function LiveAnnouncer({
  message,
  assertive = false
}: {
  message: string
  assertive?: boolean
}): React.JSX.Element {
  return (
    <div
      className="sr-only"
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      aria-atomic="true"
      data-testid={assertive ? 'announcer-assertive' : 'announcer-polite'}
    >
      {message}
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

/**
 * Focus-trapping modal that restores focus to whatever opened it.
 *
 * The focus trap, scroll lock, Escape handling and focus restoration are Radix
 * `Dialog`'s (see `./shadcn/dialog`); this component is the app-shaped wrapper
 * around it. The props are unchanged from the hand-rolled version on purpose —
 * every call site renders `<Modal>` conditionally and passes `onClose`, so the
 * component owns `open` and reports closure the one way callers already expect.
 *
 * Three behaviours are pinned here rather than left to Radix's defaults:
 *
 *   - `onOpenAutoFocus` re-implements the `[data-autofocus]` targeting that
 *     `Button`'s `autoFocusInModal` prop feeds (see its comment above). Radix
 *     would otherwise focus the FIRST focusable child, and every current caller
 *     is a destructive confirm — that default would land initial focus on
 *     "Delete"/"Revert" instead of the safe escape hatch. UX-A11Y.3.
 *   - `onPointerDownOutside` is prevented. Radix dismisses on outside click by
 *     default; the previous modal did not, and a stray click discarding a
 *     confirm dialog is a silent behaviour change nobody asked for. Escape and
 *     the footer buttons remain the ways out.
 *   - `aria-describedby={undefined}` suppresses Radix's dev warning about a
 *     missing `Dialog.Description`. This API has no description slot; the title
 *     plus body content is the whole accessible name/among.
 */
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
  /*
   * Focus restoration is OURS, not Radix's, and removing this breaks
   * UX-A11Y.3 ("dismissing the delete confirm returns focus to the invoking
   * card") — which is an E2E test, so the unit suite will not catch it.
   *
   * Radix restores focus in `onCloseAutoFocus`, which runs while the dialog is
   * closing. Every caller here renders `<Modal>` conditionally and drops it in
   * the same tick that `onClose` clears their state, so the whole subtree
   * unmounts before that lifecycle ever runs and focus lands on <body>. An
   * effect cleanup is the one hook that still fires on unmount, which is why
   * this is the same approach the hand-rolled modal used.
   */
  const restoreTo = useRef<HTMLElement | null>(null)
  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null
    return () => restoreTo.current?.focus?.()
  }, [])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogOverlay />
      <DialogContent
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          const content = e.currentTarget as HTMLElement | null
          const safest = content?.querySelector<HTMLElement>('[data-autofocus]')
          if (!safest) return // No marked control: let Radix do its thing.
          e.preventDefault()
          safest.focus()
        }}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="text-base font-semibold text-text-primary">{title}</DialogTitle>
        <div className="mt-3 text-sm leading-relaxed text-text-secondary">{children}</div>
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </DialogContent>
    </Dialog>
  )
}

/** PRD-002 §1 P5 — the undo window for every destructive act, in ms. */
export const UNDO_WINDOW_MS = 30_000

export function Toast({
  message,
  tone,
  onDismiss,
  action,
  durationMs,
  repeats
}: {
  message: string
  tone: 'ok' | 'err'
  onDismiss: () => void
  /**
   * The P5 undo affordance. Present on every destructive action's toast, which
   * is why the toast — not a confirmation modal — is where "reversible for 30
   * seconds" is actually implemented.
   */
  action?: { label: string; onAction: () => void }
  /** Overrides the default lifetime; an undo toast must outlive the 30 s window. */
  durationMs?: number
  /**
   * Repeat count for a message that fired several times in a row. Rendered as a
   * badge rather than as extra cards, so repeating an action does not grow a
   * column of identical bars over the view underneath.
   */
  repeats?: number
}): React.JSX.Element {
  useEffect(() => {
    const t = setTimeout(onDismiss, durationMs ?? (tone === 'err' ? 6000 : 3200))
    return () => clearTimeout(t)
  }, [onDismiss, tone, durationMs])

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
        {/* Inside the live region on purpose: "(x3)" is part of what happened,
            and a screen reader that announced only the message would report a
            repeat as a single event. */}
        {repeats && repeats > 1 ? (
          <span className="ml-1.5 rounded-full bg-surface-3 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">
            ×{repeats}
          </span>
        ) : null}
      </span>
      {action && (
        <button
          onClick={() => {
            action.onAction()
            onDismiss()
          }}
          data-testid="toast-action"
          className="shrink-0 rounded-lg px-2.5 py-1 text-sm font-semibold text-accent underline underline-offset-2 hover:bg-surface-3"
        >
          {action.label}
        </button>
      )}
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
