import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AnnotationDoc, LibraryItem, Rect, Shape, ShapeKind } from '@shared/types'
import { hitTest, normalizeRect, renderDocument } from '../lib/render'
import { Button, Modal, Spinner } from './ui'
import { cssVar } from '../lib/theme'

type Tool = ShapeKind | 'select' | 'crop'

const TOOLS: Array<{ id: Tool; label: string; key: string; icon: React.JSX.Element }> = [
  { id: 'select', label: 'Select', key: 'V', icon: <path d="m4 3 7 17 2.5-6.5L20 11 4 3Z" /> },
  { id: 'arrow', label: 'Arrow', key: 'A', icon: <path d="M5 19 19 5M19 5h-8M19 5v8" /> },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: <rect x="4" y="6" width="16" height="12" rx="2" /> },
  { id: 'ellipse', label: 'Ellipse', key: 'E', icon: <ellipse cx="12" cy="12" rx="8" ry="6" /> },
  { id: 'text', label: 'Text', key: 'T', icon: <path d="M5 6h14M12 6v12M9 18h6" /> },
  { id: 'highlight', label: 'Highlighter', key: 'H', icon: <path d="M4 20h16M6 16l8-10 4 4-8 10H6v-4Z" /> },
  { id: 'blur', label: 'Blur / pixelate', key: 'B', icon: <path d="M4 8h4v4H4zM12 8h4v4h-4zM8 12h4v4H8zM16 12h4v4h-4z" /> },
  { id: 'step', label: 'Step number', key: 'N', icon: <circle cx="12" cy="12" r="7" /> },
  { id: 'crop', label: 'Crop', key: 'C', icon: <path d="M6 2v16h16M2 6h16v16" /> }
]

const SWATCHES = ['#ff4d4f', '#ff9f0a', '#ffd60a', '#32d74b', '#4c8dff', '#bf5af2', '#ffffff', '#0a0c10']

const MAX_HISTORY = 50

function emptyDoc(): AnnotationDoc {
  return { version: 1, shapes: [], crop: null }
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function EditorView({
  item,
  onClose,
  onSaved,
  notify
}: {
  item: LibraryItem
  onClose: () => void
  onSaved: (item: LibraryItem) => void
  notify: (msg: string, tone?: 'ok' | 'err') => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  /**
   * One atomic history state with a pure reducer. Calling setFuture/setDoc from
   * inside a setHistory updater is an impure reducer - StrictMode double-invokes
   * updaters, which duplicated entries, and it would misbehave under concurrent
   * rendering.
   */
  const [hist, setHist] = useState<{
    past: AnnotationDoc[]
    present: AnnotationDoc
    future: AnnotationDoc[]
  }>({ past: [], present: item.annotations ?? emptyDoc(), future: [] })
  const doc = hist.present
  const history = hist.past
  const future = hist.future
  const [tool, setTool] = useState<Tool>('select')
  const [color, setColor] = useState(SWATCHES[0])
  const [stroke, setStroke] = useState(4)
  const [zoom, setZoom] = useState(1)
  const [dirty, setDirty] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null)
  const [cropDraft, setCropDraft] = useState<Rect | null>(null)

  const draggingRef = useRef<{
    start: { x: number; y: number }
    shape: Shape | null
    before?: AnnotationDoc
  } | null>(null)
  const [preview, setPreview] = useState<Shape | null>(null)

  const isVideo = item.kind === 'video'

  /* ---------------- load the source image ---------------- */
  useEffect(() => {
    if (isVideo) {
      setLoading(false)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      imageRef.current = img
      // Fit the capture to the viewport on open. A full-resolution screenshot is
      // almost always larger than the window, and opening at 100% would put most
      // of the image — and the tools' reach — outside the scroll viewport.
      const wrap = wrapRef.current
      if (wrap) {
        const pad = 64
        const fit = Math.min(
          1,
          (wrap.clientWidth - pad) / img.naturalWidth,
          (wrap.clientHeight - pad) / img.naturalHeight
        )
        setZoom(fit > 0.05 ? fit : 1)
      }
      setLoading(false)
    }
    img.onerror = () => {
      if (cancelled) return
      setLoadError('This capture could not be loaded from disk.')
      setLoading(false)
    }

    // Deliberately NOT `capture://asset/<id>`. An image from a custom scheme is
    // cross-origin to this page, which taints the canvas — and a tainted canvas
    // makes toBlob() and getImageData() throw, silently breaking both Export and
    // Copy. Reading the bytes over IPC and using a same-origin blob: URL keeps
    // the canvas clean.
    void (async () => {
      const res = await window.api.readItemBytes(item.id)
      if (cancelled) return
      if (!res.ok) {
        setLoadError(res.error)
        setLoading(false)
        return
      }
      // Copy out of the view's own byte range — the underlying buffer is typed
      // as ArrayBufferLike, which isn't a valid BlobPart.
      const view = res.value.data
      const buf = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
      const blob = new Blob([buf], { type: res.value.mime })
      objectUrl = URL.createObjectURL(blob)
      img.src = objectUrl
    })()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [item.id, isVideo])

  /* ---------------- redraw ---------------- */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img) return
    const working: AnnotationDoc = preview
      ? { ...doc, shapes: [...doc.shapes, preview] }
      : doc
    renderDocument(canvas, img, { width: item.width, height: item.height }, working)

    // Selection affordance draws on top and is never part of the document.
    if (selectedId) {
      const s = doc.shapes.find((x) => x.id === selectedId)
      const ctx = canvas.getContext('2d')
      if (s && ctx) {
        const r = normalizeRect(s)
        const off = doc.crop ? normalizeRect(doc.crop) : { x: 0, y: 0 }
        ctx.save()
        ctx.strokeStyle = cssVar('--color-accent', '#5a97ff')
        ctx.lineWidth = 2 / zoom
        ctx.setLineDash([6 / zoom, 4 / zoom])
        const pad = 6
        ctx.strokeRect(
          r.x - off.x - pad,
          r.y - off.y - pad,
          Math.max(r.width, 2) + pad * 2,
          Math.max(r.height, 2) + pad * 2
        )
        ctx.restore()
      }
    }

    if (cropDraft) {
      const ctx = canvas.getContext('2d')
      const r = normalizeRect(cropDraft)
      if (ctx) {
        // cropDraft is in image space; the canvas is crop-relative when a crop is
        // already applied. Convert once, here, rather than mixing the two spaces.
        const off = doc.crop ? normalizeRect(doc.crop) : { x: 0, y: 0 }
        const cx = r.x - off.x
        const cy = r.y - off.y
        ctx.save()
        // Neutral black at 45% per PRD-002 UX-VIS.1 — the dim sits over the
        // user's own image, so it must not tint it toward either theme.
        ctx.fillStyle = 'rgba(0,0,0,0.45)'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.clearRect(cx, cy, r.width, r.height)
        if (imageRef.current) {
          ctx.drawImage(imageRef.current, r.x, r.y, r.width, r.height, cx, cy, r.width, r.height)
        }
        ctx.strokeStyle = cssVar('--color-accent', '#5a97ff')
        ctx.lineWidth = 2 / zoom
        ctx.strokeRect(cx, cy, r.width, r.height)
        ctx.restore()
      }
    }
  }, [doc, preview, selectedId, cropDraft, item.width, item.height, zoom])

  useEffect(() => {
    if (!loading && !loadError) redraw()
  }, [redraw, loading, loadError])

  /* ---------------- history ---------------- */
  const commit = useCallback((next: AnnotationDoc) => {
    setHist((h) => ({
      past: [...h.past.slice(-(MAX_HISTORY - 1)), h.present],
      present: next,
      future: []
    }))
    setDirty(true)
  }, [])

  /** Updates the document without creating a history entry (live drag feedback). */
  const setPresent = useCallback((fn: (d: AnnotationDoc) => AnnotationDoc) => {
    setHist((h) => ({ ...h, present: fn(h.present) }))
  }, [])

  /** Pushes an explicit before-state, for gestures whose start we snapshotted. */
  const pushHistory = useCallback((before: AnnotationDoc) => {
    setHist((h) => ({
      past: [...h.past.slice(-(MAX_HISTORY - 1)), before],
      present: h.present,
      future: []
    }))
    setDirty(true)
  }, [])

  const undo = useCallback(() => {
    setHist((h) =>
      h.past.length === 0
        ? h
        : {
            past: h.past.slice(0, -1),
            present: h.past[h.past.length - 1],
            future: [h.present, ...h.future]
          }
    )
    setDirty(true)
  }, [])

  const redo = useCallback(() => {
    setHist((h) =>
      h.future.length === 0
        ? h
        : { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }
    )
    setDirty(true)
  }, [])

  /* ---------------- pointer → image coords ---------------- */
  const toImage = useCallback(
    (e: React.PointerEvent): { x: number; y: number } => {
      const canvas = canvasRef.current!
      const box = canvas.getBoundingClientRect()
      const off = doc.crop ? normalizeRect(doc.crop) : { x: 0, y: 0 }
      return {
        x: ((e.clientX - box.left) / box.width) * canvas.width + off.x,
        y: ((e.clientY - box.top) / box.height) * canvas.height + off.y
      }
    },
    [doc.crop]
  )

  const makeShape = (kind: ShapeKind, p: { x: number; y: number }): Shape => {
    const base = {
      id: uid(),
      x: p.x,
      y: p.y,
      width: 0,
      height: 0,
      color,
      strokeWidth: stroke
    }
    if (kind === 'text') return { ...base, kind: 'text', text: '', fontSize: Math.max(16, stroke * 6) }
    if (kind === 'step') return { ...base, kind: 'step' }
    if (kind === 'blur') return { ...base, kind: 'blur', mode: 'pixelate', intensity: Math.max(6, stroke * 3) }
    return { ...base, kind } as Shape
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (isVideo || loading || loadError) return
    const p = toImage(e)
    ;(e.target as Element).setPointerCapture?.(e.pointerId)

    if (tool === 'select') {
      // Topmost shape wins, matching what the user sees.
      const hit = [...doc.shapes].reverse().find((s) => hitTest(s, p.x, p.y))
      setSelectedId(hit?.id ?? null)
      // Snapshot the pre-move document so the move itself is undoable.
      if (hit) draggingRef.current = { start: p, shape: hit, before: doc }
      return
    }

    if (tool === 'crop') {
      draggingRef.current = { start: p, shape: null }
      setCropDraft({ x: p.x, y: p.y, width: 0, height: 0 })
      return
    }

    if (tool === 'text') {
      setTextDraft({ x: p.x, y: p.y, value: '' })
      return
    }

    if (tool === 'step') {
      commit({ ...doc, shapes: [...doc.shapes, makeShape('step', p)] })
      return
    }

    draggingRef.current = { start: p, shape: makeShape(tool as ShapeKind, p) }
    setPreview(makeShape(tool as ShapeKind, p))
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const drag = draggingRef.current
    if (!drag) return
    const p = toImage(e)

    if (tool === 'crop') {
      setCropDraft({ x: drag.start.x, y: drag.start.y, width: p.x - drag.start.x, height: p.y - drag.start.y })
      return
    }

    if (tool === 'select' && drag.shape) {
      const dx = p.x - drag.start.x
      const dy = p.y - drag.start.y
      setPresent((d) => ({
        ...d,
        shapes: d.shapes.map((s) =>
          s.id === drag.shape!.id ? { ...s, x: drag.shape!.x + dx, y: drag.shape!.y + dy } : s
        )
      }))
      return
    }

    if (drag.shape) {
      setPreview({ ...drag.shape, width: p.x - drag.start.x, height: p.y - drag.start.y })
    }
  }

  const onPointerUp = (): void => {
    const drag = draggingRef.current
    draggingRef.current = null

    if (tool === 'crop' && cropDraft) {
      const r = normalizeRect(cropDraft)
      setCropDraft(null)
      if (r.width > 8 && r.height > 8) {
        commit({ ...doc, crop: r })
        setTool('select')
      }
      return
    }

    if (tool === 'select') {
      // Only record a history entry if the shape actually moved, so a plain
      // click to select doesn't pollute the undo stack.
      if (drag?.shape && drag.before) {
        const moved = drag.before.shapes.find((s) => s.id === drag.shape!.id)
        const now = doc.shapes.find((s) => s.id === drag.shape!.id)
        if (moved && now && (moved.x !== now.x || moved.y !== now.y)) pushHistory(drag.before)
      }
      return
    }

    if (preview) {
      const r = normalizeRect(preview)
      // Discard accidental click-sized shapes.
      if (r.width > 3 || r.height > 3) commit({ ...doc, shapes: [...doc.shapes, preview] })
      setPreview(null)
    }
  }

  const commitText = (): void => {
    if (!textDraft) return
    const value = textDraft.value.trim()
    if (value) {
      const shape = makeShape('text', { x: textDraft.x, y: textDraft.y })
      commit({ ...doc, shapes: [...doc.shapes, { ...shape, kind: 'text', text: value, fontSize: Math.max(16, stroke * 6) } as Shape] })
    }
    setTextDraft(null)
  }

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    commit({ ...doc, shapes: doc.shapes.filter((s) => s.id !== selectedId) })
    setSelectedId(null)
  }, [selectedId, doc, commit])

  /* ---------------- flatten for save/export ---------------- */
  const flatten = useCallback(async (type: 'image/png' | 'image/jpeg'): Promise<Uint8Array> => {
    const img = imageRef.current
    if (!img) throw new Error('Image not loaded')
    const out = document.createElement('canvas')
    renderDocument(out, img, { width: item.width, height: item.height }, doc)
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, type, 0.92))
    if (!blob) throw new Error('Could not encode image')
    return new Uint8Array(await blob.arrayBuffer())
  }, [doc, item.width, item.height])

  const save = useCallback(async () => {
    const res = await window.api.saveAnnotations(item.id, doc)
    if (!res.ok) {
      notify(res.error, 'err')
      return
    }
    setDirty(false)
    onSaved(res.value)
    notify('Saved to library')
  }, [item.id, doc, notify, onSaved])

  const copy = useCallback(async () => {
    try {
      const bytes = await flatten('image/png')
      const res = await window.api.copyImageToClipboard(bytes)
      notify(res.ok ? 'Copied to clipboard' : res.error, res.ok ? 'ok' : 'err')
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'err')
    }
  }, [flatten, notify])

  const exportAs = useCallback(
    async (format: 'png' | 'jpg' | 'webm') => {
      try {
        let bytes: Uint8Array
        if (format === 'webm') {
          notify('Use the library’s Export action for recordings', 'err')
          return
        }
        bytes = await flatten(format === 'jpg' ? 'image/jpeg' : 'image/png')
        const res = await window.api.exportAs({ itemId: item.id, format, data: bytes })
        if (!res.ok) notify(res.error, 'err')
        else if (res.value) notify(`Exported to ${res.value}`)
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), 'err')
      }
    },
    [flatten, item.id, notify]
  )

  const requestClose = useCallback(() => {
    if (dirty) setConfirmClose(true)
    else onClose()
  }, [dirty, onClose])

  /* ---------------- keyboard ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      // Bare-key tool shortcuts must not fire while the user is typing.
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase()
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault()
          undo()
        } else if ((k === 'z' && e.shiftKey) || k === 'y') {
          e.preventDefault()
          redo()
        } else if (k === 's') {
          e.preventDefault()
          void save()
        } else if (k === 'c' && !typing) {
          e.preventDefault()
          void copy()
        } else if (k === 'e' && e.shiftKey) {
          e.preventDefault()
          void exportAs('png')
        } else if (k === 'w') {
          e.preventDefault()
          requestClose()
        } else if (k === '0') {
          e.preventDefault()
          setZoom(1)
        } else if (k === '=' || k === '+') {
          e.preventDefault()
          setZoom((z) => Math.min(4, z * 1.2))
        } else if (k === '-') {
          e.preventDefault()
          setZoom((z) => Math.max(0.1, z / 1.2))
        }
        return
      }

      if (typing) return

      if (e.key === 'Escape') {
        if (textDraft) setTextDraft(null)
        else if (selectedId) setSelectedId(null)
        else requestClose()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelected()
        return
      }
      if (e.key === '[') setStroke((s) => Math.max(1, s - 1))
      if (e.key === ']') setStroke((s) => Math.min(40, s + 1))

      const digit = Number(e.key)
      if (digit >= 1 && digit <= 8) {
        setColor(SWATCHES[digit - 1])
        return
      }
      const match = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase())
      if (match) setTool(match.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, save, copy, exportAs, requestClose, deleteSelected, selectedId, textDraft])

  const displaySize = useMemo(() => {
    const c = doc.crop ? normalizeRect(doc.crop) : null
    return { width: c ? c.width : item.width, height: c ? c.height : item.height }
  }, [doc.crop, item.width, item.height])

  /* ---------------- render ---------------- */
  return (
    <div className="flex h-full flex-col bg-surface-0">
      {/* header */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-3 py-2">
        <Button variant="subtle" onClick={requestClose} title="Close (Ctrl+W)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Library
        </Button>
        <div className="mx-2 h-5 w-px bg-surface-3" />
        <h1 className="truncate text-sm font-semibold text-text-primary">{item.name}</h1>
        {dirty && <span className="rounded bg-warning-surface px-2 py-0.5 text-xs text-warning">Unsaved</span>}
        <div className="flex-1" />
        <Button onClick={undo} disabled={history.length === 0} title="Undo (Ctrl+Z)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8" />
          </svg>
        </Button>
        <Button onClick={redo} disabled={future.length === 0} title="Redo (Ctrl+Shift+Z)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 7v6h-6M21 13a9 9 0 1 1-3-7.7L21 8" />
          </svg>
        </Button>
        <div className="mx-1 h-5 w-px bg-surface-3" />
        <Button onClick={() => void copy()} disabled={isVideo} title="Copy (Ctrl+C)">
          Copy
        </Button>
        <Button onClick={() => void exportAs('png')} disabled={isVideo} title="Export (Ctrl+Shift+E)">
          Export
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={!dirty} title="Save (Ctrl+S)">
          Save
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* tool rail */}
        {!isVideo && (
          <nav
            aria-label="Annotation tools"
            className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface-1 py-2"
          >
            {TOOLS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTool(t.id)}
                title={`${t.label} (${t.key})`}
                aria-label={t.label}
                aria-pressed={tool === t.id}
                className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors motion-tool ${
                  tool === t.id
                    ? 'bg-accent text-accent-fg'
                    : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary'
                }`}
              >
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  {t.icon}
                </svg>
              </button>
            ))}
          </nav>
        )}

        {/* canvas */}
        <main className="relative min-w-0 flex-1 overflow-auto bg-surface-0 p-8" ref={wrapRef}>
          {loading && (
            <div className="flex h-full items-center justify-center">
              <Spinner label="Loading capture…" />
            </div>
          )}

          {loadError && (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <p className="text-base font-semibold text-text-primary">{loadError}</p>
                <p className="mt-2 text-sm text-text-secondary">
                  The file may have been moved or deleted outside the app.
                </p>
              </div>
            </div>
          )}

          {isVideo && !loading && (
            <div className="flex h-full items-center justify-center">
              <video
                src={`capture://asset/${item.id}`}
                controls
                className="max-h-full max-w-full rounded-lg ring-1 ring-border-strong"
              />
            </div>
          )}

          {!isVideo && !loading && !loadError && (
            <div className="flex min-h-full items-center justify-center">
              <div className="relative">
                <canvas
                  ref={canvasRef}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  tabIndex={0}
                  aria-label="Annotation canvas"
                  style={{
                    width: displaySize.width * zoom,
                    height: displaySize.height * zoom,
                    cursor: tool === 'select' ? 'default' : 'crosshair'
                  }}
                  className="rounded-lg bg-surface-0 shadow-2xl ring-1 ring-border-strong"
                />
                {textDraft && (
                  <textarea
                    autoFocus
                    value={textDraft.value}
                    onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
                    onBlur={commitText}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        commitText()
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setTextDraft(null)
                      }
                    }}
                    style={{
                      left: (textDraft.x - (doc.crop ? normalizeRect(doc.crop).x : 0)) * zoom,
                      top: (textDraft.y - (doc.crop ? normalizeRect(doc.crop).y : 0)) * zoom,
                      color,
                      fontSize: Math.max(16, stroke * 6) * zoom
                    }}
                    className="absolute min-w-[8ch] resize-none rounded border border-accent-hover bg-scrim/80 px-1 font-semibold outline-none"
                    rows={1}
                    placeholder="Type…"
                  />
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* properties bar */}
      {!isVideo && (
        <footer className="flex shrink-0 items-center gap-4 border-t border-border bg-surface-1 px-4 py-2">
          <div className="flex items-center gap-1.5" role="group" aria-label="Color">
            {SWATCHES.map((c, i) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                aria-label={`Color ${i + 1}`}
                aria-pressed={color === c}
                title={`Color ${i + 1}`}
                className={`flex h-8 w-8 items-center justify-center rounded-full ${
                  color === c ? 'ring-2 ring-accent-hover ring-offset-2 ring-offset-surface-1' : ''
                }`}
              >
                <span
                  className="h-5 w-5 rounded-full ring-1 ring-white/25"
                  style={{ backgroundColor: c }}
                />
              </button>
            ))}
          </div>

          <div className="h-5 w-px bg-surface-3" />

          <label className="flex items-center gap-2 text-xs text-text-secondary">
            Stroke
            <input
              type="range"
              min={1}
              max={40}
              value={stroke}
              onChange={(e) => setStroke(Number(e.target.value))}
              className="w-28 accent-[var(--color-accent)]"
              aria-label="Stroke width"
            />
            <span className="w-6 font-mono text-text-primary">{stroke}</span>
          </label>

          {doc.crop && (
            <>
              <div className="h-5 w-px bg-surface-3" />
              <Button variant="subtle" onClick={() => commit({ ...doc, crop: null })}>
                Reset crop
              </Button>
            </>
          )}

          <div className="flex-1" />

          <span className="font-mono text-xs text-text-secondary">
            {Math.round(displaySize.width)} × {Math.round(displaySize.height)}
          </span>
          <div className="h-5 w-px bg-surface-3" />
          <div className="flex items-center gap-1">
            <Button variant="subtle" onClick={() => setZoom((z) => Math.max(0.1, z / 1.2))} title="Zoom out (Ctrl+-)">
              −
            </Button>
            <button
              onClick={() => setZoom(1)}
              title="Reset zoom (Ctrl+0)"
              className="min-w-14 rounded px-2 py-1 font-mono text-xs text-text-secondary hover:bg-surface-3"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button variant="subtle" onClick={() => setZoom((z) => Math.min(4, z * 1.2))} title="Zoom in (Ctrl++)">
              +
            </Button>
          </div>
        </footer>
      )}

      {confirmClose && (
        <Modal
          title="Discard unsaved changes?"
          onClose={() => setConfirmClose(false)}
          footer={
            <>
              <Button data-autofocus onClick={() => setConfirmClose(false)}>
                Keep editing
              </Button>
              <Button variant="danger" onClick={onClose}>
                Discard
              </Button>
            </>
          }
        >
          Your annotations on <strong className="text-text-primary">{item.name}</strong> haven&apos;t been
          saved. Discarding closes the editor and loses them.
        </Modal>
      )}
    </div>
  )
}
