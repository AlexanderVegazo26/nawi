import { describe, expect, it } from 'vitest'
import { DIM_OUTSIDE, PREVIEW_SIZE, dragRect, previewRect } from './region'

const screen = { width: 1440, height: 900 }

describe('previewRect', () => {
  it('is centred on the cursor, so the clear window follows it', () => {
    const r = previewRect({ x: 700, y: 400 }, screen)
    expect(r.x + r.width / 2).toBe(700)
    expect(r.y + r.height / 2).toBe(400)
    expect({ width: r.width, height: r.height }).toEqual(PREVIEW_SIZE)
  })

  it('stays inside the display at every edge and corner', () => {
    for (const p of [{ x: 0, y: 0 }, { x: 1440, y: 900 }, { x: 0, y: 900 }, { x: 1440, y: 0 }, { x: 5, y: 450 }]) {
      const r = previewRect(p, screen)
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.width).toBeLessThanOrEqual(screen.width)
      expect(r.y + r.height).toBeLessThanOrEqual(screen.height)
    }
  })

  it('shrinks to a display smaller than the preview instead of overflowing', () => {
    const r = previewRect({ x: 20, y: 20 }, { width: 100, height: 60 })
    expect(r).toEqual({ x: 0, y: 0, width: 100, height: 60 })
  })
})

describe('dragRect', () => {
  it('grows from the click point towards the pointer in every direction', () => {
    const o = { x: 100, y: 100 }
    expect(dragRect(o, { x: 160, y: 130 })).toEqual({ x: 100, y: 100, width: 60, height: 30 })
    expect(dragRect(o, { x: 40, y: 130 })).toEqual({ x: 40, y: 100, width: 60, height: 30 })
    expect(dragRect(o, { x: 160, y: 70 })).toEqual({ x: 100, y: 70, width: 60, height: 30 })
    expect(dragRect(o, { x: 40, y: 70 })).toEqual({ x: 40, y: 70, width: 60, height: 30 })
  })

  it('is empty at the click point, where the selection starts', () => {
    expect(dragRect({ x: 5, y: 9 }, { x: 5, y: 9 })).toEqual({ x: 5, y: 9, width: 0, height: 0 })
  })
})

describe('DIM_OUTSIDE', () => {
  it('dims the outside visibly but lightly', () => {
    expect(DIM_OUTSIDE).toBeGreaterThan(0.15)
    expect(DIM_OUTSIDE).toBeLessThan(0.45)
  })
})
