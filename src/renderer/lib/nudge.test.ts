import { describe, expect, it } from 'vitest'
import { NUDGE, NUDGE_FAST, isNudgeKey, nudgeRect, seedRect } from './nudge'

const BOUNDS = { width: 1000, height: 800 }
const R = { x: 100, y: 100, width: 200, height: 150 }

describe('UX-CAP.5 — keyboard nudge step sizes', () => {
  it('a plain arrow moves the selection by exactly 1 px', () => {
    // The shipped overlay *resized* on a plain arrow. This is the assertion
    // that fails if that behaviour comes back.
    const next = nudgeRect(R, 'ArrowRight', { shiftKey: false, ctrlKey: false }, BOUNDS)
    expect(next).toEqual({ ...R, x: 101 })
    expect(NUDGE).toBe(1)
  })

  it('Shift+arrow moves by exactly 10 px, not 16', () => {
    // 16 was the shipped fast step and matches neither PRD-002 nor UX-SPEC.
    const next = nudgeRect(R, 'ArrowDown', { shiftKey: true, ctrlKey: false }, BOUNDS)
    expect(next).toEqual({ ...R, y: 110 })
    expect(NUDGE_FAST).toBe(10)
  })

  it('moving does not change the selection size', () => {
    const next = nudgeRect(R, 'ArrowLeft', { shiftKey: true, ctrlKey: false }, BOUNDS)
    expect(next?.width).toBe(R.width)
    expect(next?.height).toBe(R.height)
  })

  it('all four arrows move in the right direction', () => {
    const m = (k: string): { x: number; y: number } => {
      const n = nudgeRect(R, k, { shiftKey: false, ctrlKey: false }, BOUNDS)
      return { x: n!.x, y: n!.y }
    }
    expect(m('ArrowLeft')).toEqual({ x: 99, y: 100 })
    expect(m('ArrowRight')).toEqual({ x: 101, y: 100 })
    expect(m('ArrowUp')).toEqual({ x: 100, y: 99 })
    expect(m('ArrowDown')).toEqual({ x: 100, y: 101 })
  })
})

describe('UX-A11Y.2 — the region is sizable from the keyboard', () => {
  it('Ctrl+arrow resizes without moving the origin', () => {
    const next = nudgeRect(R, 'ArrowRight', { shiftKey: false, ctrlKey: true }, BOUNDS)
    expect(next).toEqual({ ...R, width: 201 })
    expect(next?.x).toBe(R.x)
  })

  it('Ctrl+Shift+arrow resizes by the fast step', () => {
    const next = nudgeRect(R, 'ArrowDown', { shiftKey: true, ctrlKey: true }, BOUNDS)
    expect(next?.height).toBe(160)
  })

  it('a first arrow press with no selection yields a real, capturable rect', () => {
    // A zero-size seed would make Enter produce nothing, so "fully
    // keyboard-drivable" would be false for anyone who had not dragged first.
    const next = nudgeRect(null, 'ArrowRight', { shiftKey: false, ctrlKey: false }, BOUNDS)
    expect(next!.width).toBeGreaterThan(0)
    expect(next!.height).toBeGreaterThan(0)
  })

  it('seeds a centred rect inside the display', () => {
    const s = seedRect(BOUNDS)
    expect(s.x).toBeGreaterThanOrEqual(0)
    expect(s.y).toBeGreaterThanOrEqual(0)
    expect(s.x + s.width).toBeLessThanOrEqual(BOUNDS.width)
    expect(s.y + s.height).toBeLessThanOrEqual(BOUNDS.height)
  })
})

describe('clamping', () => {
  it('a selection cannot be moved off the left or top edge', () => {
    const at0 = { x: 0, y: 0, width: 50, height: 50 }
    expect(nudgeRect(at0, 'ArrowLeft', { shiftKey: true, ctrlKey: false }, BOUNDS)?.x).toBe(0)
    expect(nudgeRect(at0, 'ArrowUp', { shiftKey: true, ctrlKey: false }, BOUNDS)?.y).toBe(0)
  })

  it('a selection cannot be moved off the right or bottom edge', () => {
    const atEnd = { x: 950, y: 750, width: 50, height: 50 }
    expect(nudgeRect(atEnd, 'ArrowRight', { shiftKey: true, ctrlKey: false }, BOUNDS)?.x).toBe(950)
    expect(nudgeRect(atEnd, 'ArrowDown', { shiftKey: true, ctrlKey: false }, BOUNDS)?.y).toBe(750)
  })

  it('a resize cannot shrink the selection below 1 px', () => {
    const tiny = { x: 10, y: 10, width: 1, height: 1 }
    const next = nudgeRect(tiny, 'ArrowLeft', { shiftKey: true, ctrlKey: true }, BOUNDS)
    expect(next?.width).toBe(1)
  })

  it('a resize cannot extend past the display edge', () => {
    const wide = { x: 900, y: 10, width: 95, height: 50 }
    const next = nudgeRect(wide, 'ArrowRight', { shiftKey: true, ctrlKey: true }, BOUNDS)
    expect(next!.x + next!.width).toBeLessThanOrEqual(BOUNDS.width)
  })
})

describe('key filtering', () => {
  it('recognises exactly the four arrows', () => {
    expect(isNudgeKey('ArrowUp')).toBe(true)
    expect(isNudgeKey('ArrowDown')).toBe(true)
    expect(isNudgeKey('ArrowLeft')).toBe(true)
    expect(isNudgeKey('ArrowRight')).toBe(true)
    expect(isNudgeKey('Enter')).toBe(false)
    expect(isNudgeKey('a')).toBe(false)
    // Not inherited from Object.prototype — the lookup is on a plain record.
    expect(isNudgeKey('toString')).toBe(false)
  })

  it('a non-arrow key leaves the rect untouched', () => {
    expect(nudgeRect(R, 'Enter', { shiftKey: false, ctrlKey: false }, BOUNDS)).toBe(R)
  })
})
