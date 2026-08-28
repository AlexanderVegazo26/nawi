import type {
  AnnotationDoc,
  FreehandShape,
  MagnifyShape,
  Point,
  Rect,
  RedactShape,
  Shape,
  SpotlightShape,
  StepShape,
  TextShape,
  BlurShape
} from '@shared/types'

/**
 * Canvas rendering for annotation documents.
 *
 * The same code path draws the on-screen editor and the exported image, so what
 * the user sees is by construction what they get. Shapes are in image-pixel
 * space; the caller sets the canvas to the image's natural size and scales the
 * element with CSS for zoom.
 *
 * COLOUR RULE. Everything drawn here becomes pixels in the user's exported
 * file, so it uses fixed literals and never `cssVar()`. Resolving a theme token
 * here would make the same document export differently depending on whether the
 * app was in dark mode — a real regression wearing compliance's clothes. Theme
 * tokens belong on editor-only overlays (the selection ring, the crop dim),
 * which the *editor* paints on top and this module never touches.
 */

/** Normalizes a possibly-negative-extent rect into a positive-extent one. */
export function normalizeRect(r: Rect): Rect {
  return {
    x: r.width < 0 ? r.x + r.width : r.x,
    y: r.height < 0 ? r.y + r.height : r.y,
    width: Math.abs(r.width),
    height: Math.abs(r.height)
  }
}

/** Tight bounding box of a point list. */
export function bboxOfPoints(points: readonly Point[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = points[0].x
  let maxX = points[0].x
  let minY = points[0].y
  let maxY = points[0].y
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Squared distance from a point to a segment. Squared to avoid a sqrt per segment. */
function distSqToSegment(px: number, py: number, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return (px - a.x) ** 2 + (py - a.y) ** 2
  let t = ((px - a.x) * dx + (py - a.y) * dy) / lenSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = a.x + t * dx
  const cy = a.y + t * dy
  return (px - cx) ** 2 + (py - cy) ** 2
}

/**
 * True when (px,py) is within `tolerance` of the polyline.
 *
 * A freehand stroke's bounding box is a poor proxy for the stroke — a large
 * diagonal squiggle would swallow clicks nowhere near any ink — so hit-testing
 * measures against the segments themselves.
 */
export function pointNearPolyline(
  points: readonly Point[],
  px: number,
  py: number,
  tolerance: number
): boolean {
  if (points.length === 0) return false
  const tolSq = tolerance * tolerance
  if (points.length === 1) {
    return (px - points[0].x) ** 2 + (py - points[0].y) ** 2 <= tolSq
  }
  for (let i = 1; i < points.length; i += 1) {
    if (distSqToSegment(px, py, points[i - 1], points[i]) <= tolSq) return true
  }
  return false
}

/**
 * The number each step badge displays, keyed by shape id.
 *
 * ARCHITECTURE.md §5: the number is DERIVED from ordinal position, never
 * stored. That is what makes UX-ANN.2's renumbering automatic — deleting badge
 * 3 of 5 renumbers the rest because there is no stored number to go stale.
 */
export function deriveStepIndices(shapes: readonly Shape[]): Record<string, number> {
  const out: Record<string, number> = {}
  let n = 0
  for (const s of shapes) {
    if (s.kind === 'step') {
      n += 1
      out[s.id] = n
    }
  }
  return out
}

function roundedRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  const rad = Math.min(radius, r.width / 2, r.height / 2)
  ctx.beginPath()
  ctx.moveTo(r.x + rad, r.y)
  ctx.arcTo(r.x + r.width, r.y, r.x + r.width, r.y + r.height, rad)
  ctx.arcTo(r.x + r.width, r.y + r.height, r.x, r.y + r.height, rad)
  ctx.arcTo(r.x, r.y + r.height, r.x, r.y, rad)
  ctx.arcTo(r.x, r.y, r.x + r.width, r.y, rad)
  ctx.closePath()
}

function drawArrow(ctx: CanvasRenderingContext2D, s: Shape): void {
  const x1 = s.x
  const y1 = s.y
  const x2 = s.x + s.width
  const y2 = s.y + s.height
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const len = Math.hypot(x2 - x1, y2 - y1)
  // Head scales with stroke weight but never overruns a short arrow.
  const head = Math.min(s.strokeWidth * 4.5, len * 0.5)

  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineWidth = s.strokeWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Stop the shaft short so the head's point is the true endpoint.
  const shaftEndX = x2 - Math.cos(angle) * head * 0.82
  const shaftEndY = y2 - Math.sin(angle) * head * 0.82

  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(shaftEndX, shaftEndY)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7))
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7))
  ctx.closePath()
  ctx.fill()
}

/** FR-ANN.1 freehand. A smoothed polyline through the captured points. */
function drawFreehand(ctx: CanvasRenderingContext2D, s: FreehandShape): void {
  const pts = s.points
  if (pts.length === 0) return
  ctx.save()
  ctx.strokeStyle = s.color
  ctx.lineWidth = s.strokeWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (pts.length === 1) {
    // A single tap still has to leave a mark, or a click reads as a no-op.
    ctx.fillStyle = s.color
    ctx.beginPath()
    ctx.arc(pts[0].x, pts[0].y, s.strokeWidth / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    return
  }

  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  // Quadratic through segment midpoints: the standard trick for turning a
  // sampled pointer path into a smooth stroke without storing control points.
  for (let i = 1; i < pts.length - 1; i += 1) {
    const mx = (pts[i].x + pts[i + 1].x) / 2
    const my = (pts[i].y + pts[i + 1].y) / 2
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
  }
  const last = pts[pts.length - 1]
  ctx.lineTo(last.x, last.y)
  ctx.stroke()
  ctx.restore()
}

function drawText(ctx: CanvasRenderingContext2D, s: TextShape): void {
  ctx.save()
  ctx.font = `600 ${s.fontSize}px 'Segoe UI', system-ui, sans-serif`
  ctx.textBaseline = 'top'
  ctx.fillStyle = s.color
  const lines = s.text.split('\n')
  const lineHeight = s.fontSize * 1.3
  lines.forEach((line, i) => ctx.fillText(line, s.x, s.y + i * lineHeight))
  ctx.restore()
}

/**
 * A step badge.
 *
 * `anim` drives UX-ANN.2's 200 ms renumber: the old number fades out and slides
 * up while the new one fades in from below, so a renumber is *seen* rather than
 * simply having happened. Callers pass `null` under `prefers-reduced-motion`,
 * which lands on the plain single-number path.
 */
function drawStep(
  ctx: CanvasRenderingContext2D,
  s: StepShape,
  index: number,
  anim: { from: number; progress: number } | null
): void {
  const r = Math.max(14, s.strokeWidth * 6)
  const cx = s.x
  const cy = s.y
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = s.color
  ctx.fill()
  ctx.lineWidth = Math.max(2, r * 0.12)
  ctx.strokeStyle = 'rgba(255,255,255,0.92)'
  ctx.stroke()

  ctx.font = `700 ${Math.round(r * 1.15)}px 'Segoe UI', system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const baseY = cy + r * 0.04
  if (anim && anim.from !== index) {
    const p = Math.min(1, Math.max(0, anim.progress))
    const travel = r * 0.9
    // Clip to the badge so the sliding glyphs never spill onto the image.
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2)
    ctx.clip()
    ctx.fillStyle = '#ffffff'
    ctx.globalAlpha = 1 - p
    ctx.fillText(String(anim.from), cx, baseY - travel * p)
    ctx.globalAlpha = p
    ctx.fillText(String(index), cx, baseY + travel * (1 - p))
    ctx.restore()
  } else {
    ctx.fillStyle = '#ffffff'
    ctx.fillText(String(index), cx, baseY)
  }
  ctx.restore()
}

/**
 * Blur/pixelate/solid.
 *
 * blur and pixelate read back the already-drawn pixels in the region and redraw
 * them obscured, so they composite over whatever is underneath rather than
 * needing a separate source image. 'solid' reads nothing at all — it paints
 * over, which is the whole point: after this call the region's original values
 * are not present in the canvas in any form, recoverable or otherwise.
 */
function drawObscure(
  ctx: CanvasRenderingContext2D,
  s: BlurShape | RedactShape,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  origin: Point
): void {
  const r = normalizeRect(s)
  if (r.width < 2 || r.height < 2) return

  if (s.mode === 'solid') {
    ctx.save()
    // Opaque neutral black, not `s.color`: a redaction fill must be
    // unambiguous and must not depend on the swatch that happened to be
    // selected. `globalAlpha`/`globalCompositeOperation` are reset explicitly
    // because a partially transparent redaction would leak the original.
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#000000'
    ctx.fillRect(r.x, r.y, r.width, r.height)
    ctx.restore()
    return
  }

  // drawImage's SOURCE rect is never affected by the context transform, so the
  // readback must be done in canvas space explicitly. Shapes are in image space
  // and the canvas is crop-relative; without subtracting the crop origin this
  // copies pixels from the wrong part of the image - which for a redaction tool
  // means showing content it was never asked to reveal while leaving the
  // sensitive pixels visible.
  const src = { x: r.x - origin.x, y: r.y - origin.y }

  const scratch = document.createElement('canvas')
  const sctx = scratch.getContext('2d')
  if (!sctx) return

  if (s.mode === 'pixelate') {
    const block = Math.max(2, Math.round(s.intensity))
    const w = Math.max(1, Math.round(r.width / block))
    const h = Math.max(1, Math.round(r.height / block))
    scratch.width = w
    scratch.height = h
    sctx.imageSmoothingEnabled = false
    sctx.drawImage(canvas as CanvasImageSource, src.x, src.y, r.width, r.height, 0, 0, w, h)
    ctx.save()
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(scratch, 0, 0, w, h, r.x, r.y, r.width, r.height)
    ctx.restore()
  } else {
    scratch.width = Math.round(r.width)
    scratch.height = Math.round(r.height)
    sctx.drawImage(canvas as CanvasImageSource, src.x, src.y, r.width, r.height, 0, 0, scratch.width, scratch.height)
    ctx.save()
    ctx.filter = `blur(${Math.max(2, s.intensity)}px)`
    // Clip so the blur's soft edge can't bleed outside the selected region.
    ctx.beginPath()
    ctx.rect(r.x, r.y, r.width, r.height)
    ctx.clip()
    ctx.drawImage(scratch, r.x, r.y, r.width, r.height)
    ctx.restore()
  }
}

/** A shield outline, centred on (cx, cy), `size` tall. */
function shieldPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const h = size
  const w = size * 0.82
  ctx.beginPath()
  ctx.moveTo(cx, cy - h / 2)
  ctx.lineTo(cx + w / 2, cy - h / 4)
  ctx.lineTo(cx + w / 2, cy + h / 10)
  ctx.quadraticCurveTo(cx + w / 2, cy + h / 2, cx, cy + h / 2)
  ctx.quadraticCurveTo(cx - w / 2, cy + h / 2, cx - w / 2, cy + h / 10)
  ctx.lineTo(cx - w / 2, cy - h / 4)
  ctx.closePath()
}

/**
 * UX-ANN.4 — the marker that makes a redaction unmistakable: a dashed border
 * plus a small shield glyph.
 *
 * Painted for BOTH the editor and the export. The requirement's purpose is that
 * "no one mistakes an aesthetic blur for a security guarantee", and the person
 * most likely to make that mistake is whoever receives the shared image — who
 * never sees the editor. It is drawn strictly inside the obscured region, so it
 * can never uncover a pixel it is marking.
 */
function drawRedactionMarker(ctx: CanvasRenderingContext2D, s: RedactShape): void {
  const r = normalizeRect(s)
  if (r.width < 8 || r.height < 8) return
  const inset = Math.max(2, Math.min(4, r.width / 12, r.height / 12))
  const dash = Math.max(4, Math.min(12, r.width / 8))

  ctx.save()
  ctx.lineWidth = Math.max(1.5, Math.min(3, r.height / 14))
  ctx.setLineDash([dash, dash * 0.7])
  // White on a black fill, and light-on-mid over a blurred/pixelated region;
  // a dark companion stroke underneath keeps it visible on a pale one, so the
  // marker survives any background rather than only a convenient one.
  ctx.strokeStyle = 'rgba(0,0,0,0.75)'
  ctx.strokeRect(r.x + inset, r.y + inset, r.width - inset * 2, r.height - inset * 2)
  ctx.lineDashOffset = dash
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'
  ctx.strokeRect(r.x + inset, r.y + inset, r.width - inset * 2, r.height - inset * 2)

  // Shield, sized to the region but never larger than a corner badge.
  const size = Math.min(r.height * 0.5, r.width * 0.35, 22)
  if (size >= 8) {
    const cx = r.x + r.width - inset - size * 0.62
    const cy = r.y + inset + size * 0.62
    ctx.setLineDash([])
    ctx.lineWidth = Math.max(1, size / 11)
    shieldPath(ctx, cx, cy, size)
    ctx.fillStyle = 'rgba(0,0,0,0.72)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.stroke()
    // Tick inside the shield — a bare outline at this size reads as a generic
    // pentagon, and UX-A11Y.4 wants the marker to carry meaning as a glyph.
    ctx.beginPath()
    ctx.moveTo(cx - size * 0.19, cy + size * 0.02)
    ctx.lineTo(cx - size * 0.04, cy + size * 0.17)
    ctx.lineTo(cx + size * 0.21, cy - size * 0.15)
    ctx.stroke()
  }
  ctx.restore()
}

/** FR-ANN.5 spotlight: dim everything outside the rect, leaving it untouched. */
function drawSpotlight(
  ctx: CanvasRenderingContext2D,
  s: SpotlightShape,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  origin: Point
): void {
  const r = normalizeRect(s)
  if (r.width < 2 || r.height < 2) return
  const dim = Math.min(0.95, Math.max(0, s.dim))

  ctx.save()
  // Punch the hole with the even-odd rule rather than four fillRects: adjacent
  // rects seam visibly at fractional coordinates.
  ctx.beginPath()
  ctx.rect(origin.x, origin.y, canvas.width, canvas.height)
  ctx.rect(r.x, r.y, r.width, r.height)
  // Neutral black, matching UX-VIS.1's dim — it sits over the user's own image,
  // so it must not tint toward either theme.
  ctx.fillStyle = `rgba(0,0,0,${dim})`
  ctx.fill('evenodd')
  ctx.restore()
}

/** FR-ANN.5 magnifier inset: the region redrawn enlarged, in place, with a ring. */
function drawMagnify(
  ctx: CanvasRenderingContext2D,
  s: MagnifyShape,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  origin: Point
): void {
  const r = normalizeRect(s)
  if (r.width < 8 || r.height < 8) return
  const factor = Math.max(1.1, s.factor)

  // Source is the composited canvas, so the magnifier shows annotations under
  // it too — what the user sees magnified is what is actually there.
  const sw = r.width / factor
  const sh = r.height / factor
  const sx = r.x - origin.x + (r.width - sw) / 2
  const sy = r.y - origin.y + (r.height - sh) / 2

  const scratch = document.createElement('canvas')
  scratch.width = Math.max(1, Math.round(sw))
  scratch.height = Math.max(1, Math.round(sh))
  const sctx = scratch.getContext('2d')
  if (!sctx) return
  // Copy first: drawing the canvas onto itself with an overlapping source and
  // destination is undefined enough in practice to produce smears.
  sctx.drawImage(canvas as CanvasImageSource, sx, sy, sw, sh, 0, 0, scratch.width, scratch.height)

  ctx.save()
  ctx.beginPath()
  ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2)
  ctx.clip()
  ctx.drawImage(scratch, r.x, r.y, r.width, r.height)
  ctx.restore()

  ctx.save()
  ctx.lineWidth = Math.max(2, s.strokeWidth)
  ctx.strokeStyle = s.color
  ctx.beginPath()
  ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

export interface DrawOptions {
  /** Displayed number for a step badge. */
  stepIndex?: number
  /** Crop origin in image space; the canvas is crop-relative. */
  origin?: Point
  /** UX-ANN.2 renumber cross-fade for this badge, or null for the instant path. */
  stepAnim?: { from: number; progress: number } | null
}

export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: DrawOptions = {}
): void {
  const r = normalizeRect(shape)
  const origin = options.origin ?? { x: 0, y: 0 }

  switch (shape.kind) {
    case 'arrow':
      drawArrow(ctx, shape)
      break

    case 'line':
      ctx.save()
      ctx.strokeStyle = shape.color
      ctx.lineWidth = shape.strokeWidth
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(shape.x, shape.y)
      ctx.lineTo(shape.x + shape.width, shape.y + shape.height)
      ctx.stroke()
      ctx.restore()
      break

    case 'rect':
      ctx.save()
      ctx.strokeStyle = shape.color
      ctx.lineWidth = shape.strokeWidth
      roundedRect(ctx, r, shape.strokeWidth * 1.2)
      ctx.stroke()
      ctx.restore()
      break

    case 'ellipse':
      ctx.save()
      ctx.strokeStyle = shape.color
      ctx.lineWidth = shape.strokeWidth
      ctx.beginPath()
      ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
      break

    case 'highlight':
      ctx.save()
      // Multiply keeps underlying text readable through the wash.
      ctx.globalCompositeOperation = 'multiply'
      ctx.globalAlpha = 0.42
      ctx.fillStyle = shape.color
      ctx.fillRect(r.x, r.y, r.width, r.height)
      ctx.restore()
      break

    case 'freehand':
      drawFreehand(ctx, shape)
      break

    case 'blur':
      drawObscure(ctx, shape, canvas, origin)
      break

    case 'redact':
      drawObscure(ctx, shape, canvas, origin)
      drawRedactionMarker(ctx, shape)
      break

    case 'spotlight':
      drawSpotlight(ctx, shape, canvas, origin)
      break

    case 'magnify':
      drawMagnify(ctx, shape, canvas, origin)
      break

    case 'text':
      drawText(ctx, shape)
      break

    case 'step':
      drawStep(ctx, shape, options.stepIndex ?? 1, options.stepAnim ?? null)
      break
  }
}

export interface RenderOptions {
  /**
   * UX-ANN.2. Numbers the badges were showing before the change, keyed by shape
   * id, plus how far through the 200 ms transition we are. Omitted (or
   * progress >= 1) renders the final numbers with no motion — which is also the
   * reduced-motion path.
   */
  renumber?: { from: Record<string, number>; progress: number } | null
}

/** Draws the base image plus every shape, honouring the document's crop. */
export function renderDocument(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  imageSize: { width: number; height: number },
  doc: AnnotationDoc,
  options: RenderOptions = {}
): void {
  const crop = doc.crop ? normalizeRect(doc.crop) : null
  const outW = Math.max(1, Math.round(crop ? crop.width : imageSize.width))
  const outH = Math.max(1, Math.round(crop ? crop.height : imageSize.height))

  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.clearRect(0, 0, outW, outH)
  if (crop) {
    ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, outW, outH)
    ctx.translate(-crop.x, -crop.y)
  } else {
    ctx.drawImage(image, 0, 0, outW, outH)
  }

  const origin = crop ?? { x: 0, y: 0 }
  const stepIndices = deriveStepIndices(doc.shapes)
  const renumber = options.renumber && options.renumber.progress < 1 ? options.renumber : null

  for (const shape of doc.shapes) {
    const stepIndex = stepIndices[shape.id]
    const from = renumber?.from[shape.id]
    drawShape(ctx, shape, canvas, {
      stepIndex,
      origin,
      stepAnim:
        renumber && from !== undefined && from !== stepIndex
          ? { from, progress: renumber.progress }
          : null
    })
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

export function hitTest(shape: Shape, px: number, py: number): boolean {
  const r = normalizeRect(shape)
  const pad = Math.max(8, shape.strokeWidth * 2)
  if (shape.kind === 'step') {
    const rad = Math.max(14, shape.strokeWidth * 6) + 4
    return Math.hypot(px - shape.x, py - shape.y) <= rad
  }
  if (shape.kind === 'freehand') {
    return pointNearPolyline(shape.points, px, py, pad)
  }
  if (shape.kind === 'text') {
    const t = shape as TextShape
    const lines = t.text.split('\n')
    const w = Math.max(...lines.map((l) => l.length)) * t.fontSize * 0.6
    const h = lines.length * t.fontSize * 1.3
    return px >= t.x - pad && px <= t.x + w + pad && py >= t.y - pad && py <= t.y + h + pad
  }
  return (
    px >= r.x - pad && px <= r.x + r.width + pad && py >= r.y - pad && py <= r.y + r.height + pad
  )
}

/**
 * Moves a shape by (dx, dy).
 *
 * Freehand carries its geometry in `points`, so translating only the bbox would
 * leave the stroke behind while its selection ring walked away. Every shape
 * type must go through here rather than through an inline `{...s, x, y}`.
 */
export function translateShape(shape: Shape, dx: number, dy: number): Shape {
  const moved = { ...shape, x: shape.x + dx, y: shape.y + dy }
  if (moved.kind === 'freehand') {
    return { ...moved, points: moved.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
  }
  return moved
}
