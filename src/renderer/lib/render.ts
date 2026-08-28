import type { AnnotationDoc, Rect, Shape, StepShape, TextShape, BlurShape } from '@shared/types'

/**
 * Canvas rendering for annotation documents.
 *
 * The same code path draws the on-screen editor and the exported image, so what
 * the user sees is by construction what they get. Shapes are in image-pixel
 * space; the caller sets the canvas to the image's natural size and scales the
 * element with CSS for zoom.
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

function roundedRect(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  radius: number
): void {
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

function drawStep(ctx: CanvasRenderingContext2D, s: StepShape, index: number): void {
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

  ctx.fillStyle = '#ffffff'
  ctx.font = `700 ${Math.round(r * 1.15)}px 'Segoe UI', system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(index), cx, cy + r * 0.04)
  ctx.restore()
}

/**
 * Blur/pixelate reads back the already-drawn pixels in the region and redraws
 * them obscured, so it composites over whatever is underneath rather than
 * needing a separate source image.
 */
function drawObscure(
  ctx: CanvasRenderingContext2D,
  s: BlurShape,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  origin: { x: number; y: number }
): void {
  const r = normalizeRect(s)
  if (r.width < 2 || r.height < 2) return

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

export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  stepIndex = 1,
  origin: { x: number; y: number } = { x: 0, y: 0 }
): void {
  const r = normalizeRect(shape)

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

    case 'blur':
      drawObscure(ctx, shape, canvas, origin)
      break

    case 'text':
      drawText(ctx, shape)
      break

    case 'step':
      drawStep(ctx, shape, stepIndex)
      break
  }
}

/** Draws the base image plus every shape, honouring the document's crop. */
export function renderDocument(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  imageSize: { width: number; height: number },
  doc: AnnotationDoc
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

  // Step numbers are derived from ordering, not stored, so inserting a step
  // mid-document renumbers the rest automatically.
  let step = 0
  for (const shape of doc.shapes) {
    if (shape.kind === 'step') step += 1
    drawShape(ctx, shape, canvas, step, crop ?? { x: 0, y: 0 })
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
