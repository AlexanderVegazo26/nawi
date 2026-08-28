import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Rect } from '@shared/types'
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
/** Keyboard nudge distances, in DIP. */
const NUDGE = 1
const NUDGE_FAST = 16

function Overlay(): React.JSX.Element {
  const [init, setInit] = useState<Init | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const [cursor, setCursor] = useState({ x: 0, y: 0 })
  const dragging = useRef(false)

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
      // Keyboard-driven selection: arrows size the rect from the current origin.
      const step = e.shiftKey ? NUDGE_FAST : NUDGE
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step]
      }
      const d = delta[e.key]
      if (!d) return
      e.preventDefault()
      setRect((prev) => {
        const base = prev ?? { x: window.innerWidth / 2, y: window.innerHeight / 2, width: 0, height: 0 }
        // Ctrl moves the whole selection; plain arrows resize it.
        if (e.ctrlKey) return { ...base, x: base.x + d[0], y: base.y + d[1] }
        return { ...base, width: Math.max(0, base.width + d[0]), height: Math.max(0, base.height + d[1]) }
      })
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
            className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:bg-accent-hover"
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

      <div className="pointer-events-none absolute inset-x-0 bottom-10 flex justify-center">
        <div className="surface rounded-full px-5 py-2.5 text-sm text-text-secondary shadow-2xl">
          Drag to select · <kbd className="text-text-primary">Arrows</kbd> resize ·{' '}
          <kbd className="text-text-primary">Enter</kbd> confirm ·{' '}
          <kbd className="text-text-primary">Esc</kbd> cancel
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Overlay />
  </StrictMode>
)
