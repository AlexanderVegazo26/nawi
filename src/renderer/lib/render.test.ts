import { describe, expect, it } from 'vitest'
import type { FreehandShape, Shape, StepShape } from '@shared/types'
import {
  bboxOfPoints,
  deriveStepIndices,
  hitTest,
  normalizeRect,
  pointNearPolyline,
  translateShape
} from './render'

/**
 * The geometry half of the renderer. Everything asserted here is a pure
 * function; the pixel-level guarantees (FR-ANN.3's byte scan, the UX-ANN.4
 * marker) are in e2e/annotation.spec.ts, because they need a real canvas.
 */

function step(id: string): StepShape {
  return { id, kind: 'step', x: 10, y: 10, width: 0, height: 0, color: '#f00', strokeWidth: 4 }
}

function freehand(id: string, points: Array<{ x: number; y: number }>): FreehandShape {
  const bb = bboxOfPoints(points)
  return {
    id,
    kind: 'freehand',
    x: bb.x,
    y: bb.y,
    width: bb.width,
    height: bb.height,
    color: '#f00',
    strokeWidth: 4,
    points
  }
}

describe('normalizeRect', () => {
  it('flips negative extents', () => {
    expect(normalizeRect({ x: 30, y: 40, width: -10, height: -20 })).toEqual({
      x: 20,
      y: 20,
      width: 10,
      height: 20
    })
  })
})

describe('bboxOfPoints', () => {
  it('tightly bounds the points', () => {
    expect(bboxOfPoints([{ x: 5, y: 9 }, { x: 1, y: 20 }, { x: 12, y: 3 }])).toEqual({
      x: 1,
      y: 3,
      width: 11,
      height: 17
    })
  })

  it('is zero-sized for a single point and for none', () => {
    expect(bboxOfPoints([{ x: 4, y: 4 }])).toEqual({ x: 4, y: 4, width: 0, height: 0 })
    expect(bboxOfPoints([])).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

describe('pointNearPolyline', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 100, y: 0 }
  ]

  it('hits along the segment and misses beyond the tolerance', () => {
    expect(pointNearPolyline(line, 50, 3, 5)).toBe(true)
    expect(pointNearPolyline(line, 50, 8, 5)).toBe(false)
  })

  it('does not extend past the endpoints', () => {
    expect(pointNearPolyline(line, 104, 0, 5)).toBe(true)
    expect(pointNearPolyline(line, 120, 0, 5)).toBe(false)
  })

  it('ignores the empty interior of a bounding box', () => {
    // The whole point of segment-distance hit testing: an L-shaped stroke has a
    // large bbox whose middle contains no ink at all.
    const l = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 }
    ]
    expect(pointNearPolyline(l, 60, 20, 6)).toBe(false)
    expect(pointNearPolyline(l, 60, 100, 6)).toBe(true)
  })

  it('treats a single point as a dot', () => {
    expect(pointNearPolyline([{ x: 10, y: 10 }], 12, 10, 5)).toBe(true)
    expect(pointNearPolyline([{ x: 10, y: 10 }], 30, 10, 5)).toBe(false)
    expect(pointNearPolyline([], 0, 0, 5)).toBe(false)
  })
})

describe('hitTest for freehand', () => {
  const stroke = freehand('a', [
    { x: 0, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 }
  ])

  it('is hittable at all — the bbox is not degenerate', () => {
    expect(stroke.width).toBeGreaterThan(0)
    expect(hitTest(stroke, 0, 50)).toBe(true)
  })

  it('measures against the ink, not the bounding box', () => {
    expect(hitTest(stroke, 60, 20)).toBe(false)
  })

  it('stays hittable when the stroke is a straight vertical tick with zero width', () => {
    // A deliberate short vertical mark has width 0. Falling back to the rect
    // test would still work here, but the tolerance must come from the stroke.
    const tick = freehand('t', [
      { x: 50, y: 10 },
      { x: 50, y: 30 }
    ])
    expect(tick.width).toBe(0)
    expect(hitTest(tick, 51, 20)).toBe(true)
  })
})

describe('translateShape', () => {
  it('moves a plain shape by its origin', () => {
    const r: Shape = {
      id: 'r',
      kind: 'rect',
      x: 10,
      y: 20,
      width: 5,
      height: 5,
      color: '#f00',
      strokeWidth: 2
    }
    expect(translateShape(r, 3, -4)).toMatchObject({ x: 13, y: 16, width: 5, height: 5 })
  })

  it('moves a freehand stroke POINTS as well as its bbox', () => {
    // The bug this exists to prevent: translating only x/y leaves the drawn
    // stroke behind while its selection ring walks away.
    const f = freehand('f', [
      { x: 0, y: 0 },
      { x: 10, y: 10 }
    ])
    const moved = translateShape(f, 5, 7)
    expect(moved.kind).toBe('freehand')
    const mf = moved as FreehandShape
    expect(mf.points).toEqual([
      { x: 5, y: 7 },
      { x: 15, y: 17 }
    ])
    expect(mf.x).toBe(5)
    expect(mf.y).toBe(7)
    // bbox and points still agree after the move
    expect(bboxOfPoints(mf.points)).toEqual({ x: mf.x, y: mf.y, width: mf.width, height: mf.height })
  })

  it('does not mutate the original', () => {
    const f = freehand('f', [{ x: 1, y: 1 }])
    translateShape(f, 100, 100)
    expect(f.points).toEqual([{ x: 1, y: 1 }])
  })
})

describe('deriveStepIndices — UX-ANN.2', () => {
  const rect: Shape = {
    id: 'r',
    kind: 'rect',
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    color: '#f00',
    strokeWidth: 1
  }

  it('numbers step badges by ordinal position, ignoring other shapes', () => {
    const shapes = [step('a'), rect, step('b'), step('c')]
    expect(deriveStepIndices(shapes)).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('renumbers 4→3 and 5→4 when badge 3 of 5 is deleted', () => {
    // The exact scenario UX-ANN.2 names.
    const shapes = ['a', 'b', 'c', 'd', 'e'].map(step)
    expect(deriveStepIndices(shapes)).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5 })
    const after = deriveStepIndices(shapes.filter((s) => s.id !== 'c'))
    expect(after).toEqual({ a: 1, b: 2, d: 3, e: 4 })
  })

  it('renumbers on reorder too, because nothing is stored', () => {
    const shapes = [step('a'), step('b'), step('c')]
    const reordered = [shapes[2], shapes[0], shapes[1]]
    expect(deriveStepIndices(reordered)).toEqual({ c: 1, a: 2, b: 3 })
  })

  it('is empty for a document with no badges', () => {
    expect(deriveStepIndices([rect])).toEqual({})
    expect(deriveStepIndices([])).toEqual({})
  })
})
