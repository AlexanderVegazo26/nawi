import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Rect } from '@shared/types'
import { isNudgeKey, nudgeRect } from './lib/nudge'
import { LiveAnnouncer } from './components/ui'
import './styles.css'

/**
 * Region-select overlay.
 *
 * The window is opaque and shows a frozen screenshot of its own display, so
 * there is no live-content race and no transparency required. All coordinates
 * here are DIP relative to the display; main converts to physical pixels.
 */

interface Init {
  displayId: number
  freezeUrl: string
  scaleFactor: number
}

const MIN_DRAG = 4
/** Side of the magnifier loupe, in CSS px. */
const LOUPE = 132
/** How many source pixels the loupe shows across. */
const LOUPE_SOURCE_PX = 11

function Overlay(): React.JSX.Element {
  const [init, setInit] = useState<Init | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const [cursor, setCursor] = useState({ x: 0, y: 0 })
  const dragging = useRef(false)
  /**
   * True once an arrow key has been used. Gates the magnifier (UX-CAP.5 asks
   * for it "on arrow-key nudge") and switches the hint line to the keyboard
   * bindings, so a mouse user is not taught chords they are not using.
   */
  const [keyboardDriven, setKeyboardDriven] = useState(false)
  /** UX-A11Y.2 — debounced polite announcement of the current dimensions. */
  const [dimensions, setDimensions] = useState('')

  const scale = init?.scaleFactor ?? 1

  /**
   * UX-A11Y.2 — "the result announced".
   *
   * Debounced: an arrow key held down fires dozens of keydowns a second, and an
   * undebounced live region turns that into a screen-reader queue the user
   * cannot talk over. 400 ms is long enough that only a settled size is spoken.
   */
  useEffect(() => {
    if (!rect || rect.width < 1 || rect.height < 1) return
    const t = setTimeout(() => {
      setDimensions(
        `Selection ${Math.round(rect.width * scale)} by ${Math.round(rect.height * scale)} pixels, ` +
          `at ${Math.round(rect.x * scale)}, ${Math.round(rect.y * scale)}`
      )
    }, 400)
    return () => clearTimeout(t)
  }, [rect, scale])

  useEffect(() => {
    let cancelled = false
    void window.api.overlayInit().then((res) => {
      if (cancelled) return
      if (res.ok) setInit(res.value)
      else setError(res.error)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const commit = useCallback(
    (r: Rect | null) => {
      if (!init) return
      if (!r || r.width < 1 || r.height < 1) {
        window.api.cancelRegion()
        return
      }
      // Sent as display-local DIP — the overlay spans exactly its own display,
      // so client coordinates already are that. Main looks the display's bounds
      // up from the sender rather than us round-tripping through
      // virtual-desktop space via window.screenX (which would break on
      // negative-origin or mixed-DPI monitor layouts).
      window.api.commitRegion(init.displayId, {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height
      })
    },
    [init]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        window.api.cancelRegion()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        commit(rect)
        return
      }
      // UX-CAP.5 / UX-A11Y.2. The step sizes and the modifier assignment live
      // in `lib/nudge.ts`, which also documents why the two requirements
      // conflict and which one won. The shipped code here matched neither: it
      // resized on a plain arrow and used a 16 px fast step.
      if (!isNudgeKey(e.key)) return
      e.preventDefault()
      setKeyboardDriven(true)
      setRect((prev) =>
        nudgeRect(
          prev,
          e.key,
          { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey },
          { width: window.innerWidth, height: window.innerHeight }
        )
      )
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commit, rect])

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button === 2) {
      window.api.cancelRegion()
      return
    }
    if (e.button !== 0) return
    dragging.current = true
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    setOrigin({ x: e.clientX, y: e.clientY })
    setRect({ x: e.clientX, y: e.clientY, width: 0, height: 0 })
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    setCursor({ x: e.clientX, y: e.clientY })
    if (!dragging.current || !origin) return
    const x = Math.min(origin.x, e.clientX)
    const y = Math.min(origin.y, e.clientY)
    setRect({
      x,
      y,
      width: Math.abs(e.clientX - origin.x),
      height: Math.abs(e.clientY - origin.y)
    })
  }

  const onPointerUp = (): void => {
    if (!dragging.current) return
    dragging.current = false
    if (!rect || rect.width < MIN_DRAG || rect.height < MIN_DRAG) {
      setRect(null)
      setOrigin(null)
      return
    }
    commit(rect)
  }

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-0">
        <div className="surface max-w-md rounded-xl px-6 py-5 text-center">
          <p className="text-base font-semibold text-text-primary">Couldn&apos;t start region capture</p>
          <p className="mt-2 text-sm text-text-secondary">{error}</p>
          <button
            /* UX-A11Y.9 — 44x44 minimum on overlay controls. */
            className="mt-4 inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
            onClick={() => window.api.cancelRegion()}
          >
            Close (Esc)
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative h-full w-full cursor-crosshair select-none overflow-hidden bg-surface-0"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault()
        window.api.cancelRegion()
      }}
    >
      {init && (
        <img
          src={init.freezeUrl}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full object-fill"
        />
      )}

      {/* Dim mask with the selection punched out via even-odd fill. */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        <defs>
          <mask id="cutout">
            <rect width="100%" height="100%" fill="white" />
            {rect && (
              <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} fill="black" />
            )}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.45)" mask="url(#cutout)" />
        {rect && rect.width > 0 && (
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={1.5}
          />
        )}
      </svg>

      {/* Crosshair guides before the first drag. */}
      {!rect && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <line x1={cursor.x} y1={0} x2={cursor.x} y2="100%" stroke="var(--color-accent)" strokeOpacity={0.5} strokeWidth={1} />
          <line x1={0} y1={cursor.y} x2="100%" y2={cursor.y} stroke="var(--color-accent)" strokeOpacity={0.5} strokeWidth={1} />
        </svg>
      )}

      {rect && rect.width > 0 && (
        <div
          className="pointer-events-none absolute rounded-md bg-scrim/90 px-2 py-1 font-mono text-xs text-text-primary ring-1 ring-border-strong"
          style={{
            left: rect.x,
            // Sit above the selection unless it would clip off the top edge.
            top: rect.y > 32 ? rect.y - 28 : rect.y + rect.height + 8
          }}
        >
          {Math.round(rect.width * (init?.scaleFactor ?? 1))} ×{' '}
          {Math.round(rect.height * (init?.scaleFactor ?? 1))} px
        </div>
      )}

      {/*
        UX-CAP.5 magnifier with a per-pixel crosshair.

        Shown on arrow-key nudge, which is the case the requirement names and
        the one that needs it: a keyboard user nudging by 1 px has no other way
        to see which pixel the edge is on. The loupe is the same frozen
        screenshot, scaled up with `image-rendering: pixelated` so individual
        source pixels are square blocks rather than a blur, and the crosshair is
        drawn on the block boundary — a smoothed magnifier would show a larger
        picture of nothing useful.

        It tracks the bottom-right corner because that is the corner Ctrl+arrow
        resizes.
      */}
      {keyboardDriven && rect && init && (
        <div
          className="pointer-events-none absolute overflow-hidden rounded-lg shadow-2xl ring-2 ring-border-strong"
          data-testid="overlay-magnifier"
          aria-hidden="true"
          style={{
            width: LOUPE,
            height: LOUPE,
            // Keep it on screen: flip to the other side of the corner when the
            // default placement would run past an edge.
            left: Math.min(Math.max(0, rect.x + rect.width + 16), window.innerWidth - LOUPE),
            top: Math.min(Math.max(0, rect.y + rect.height + 16), window.innerHeight - LOUPE)
          }}
        >
          <img
            src={init.freezeUrl}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              imageRendering: 'pixelated',
              width: `${window.innerWidth * (LOUPE / LOUPE_SOURCE_PX)}px`,
              height: `${window.innerHeight * (LOUPE / LOUPE_SOURCE_PX)}px`,
              left: `${-(rect.x + rect.width) * (LOUPE / LOUPE_SOURCE_PX) + LOUPE / 2}px`,
              top: `${-(rect.y + rect.height) * (LOUPE / LOUPE_SOURCE_PX) + LOUPE / 2}px`
            }}
          />
          <svg className="absolute inset-0 h-full w-full">
            <line x1={LOUPE / 2} y1={0} x2={LOUPE / 2} y2={LOUPE} stroke="var(--color-accent)" strokeWidth={1} />
            <line x1={0} y1={LOUPE / 2} x2={LOUPE} y2={LOUPE / 2} stroke="var(--color-accent)" strokeWidth={1} />
            <rect
              x={LOUPE / 2}
              y={LOUPE / 2}
              width={LOUPE / LOUPE_SOURCE_PX}
              height={LOUPE / LOUPE_SOURCE_PX}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={1.5}
            />
          </svg>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-10 flex justify-center">
        <div className="surface rounded-full px-5 py-2.5 text-sm text-text-secondary shadow-2xl">
          {/*
            §9 — no hardcoded chord that does not match the behaviour. The
            previous line said "Arrows resize", which was true of the shipped
            handler and wrong against both specs.
          */}
          Drag to select · <kbd className="text-text-primary">Arrows</kbd> move 1px ·{' '}
          <kbd className="text-text-primary">Shift</kbd> 10px ·{' '}
          <kbd className="text-text-primary">Ctrl</kbd>+arrows resize ·{' '}
          <kbd className="text-text-primary">Enter</kbd> confirm ·{' '}
          <kbd className="text-text-primary">Esc</kbd> cancel
        </div>
      </div>

      {/*
        UX-A11Y.2. Two regions, deliberately:
        - assertive, once, on open — a screen-reader user whose screen just
          froze under a capture overlay needs to be told immediately, and this
          interrupts. It is the only assertive announcement in the app.
        - polite, debounced, for dimensions — frequent and non-urgent.
      */}
      <LiveAnnouncer
        assertive
        message={
          init
            ? 'Region capture. Arrow keys move the selection, Shift for ten pixels, Control and arrows to resize, Enter to capture, Escape to cancel.'
            : ''
        }
      />
      <LiveAnnouncer message={dimensions} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Overlay />
  </StrictMode>
)
