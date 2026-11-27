import type { Rect } from '@shared/types'

/**
 * Geometry for the region-select overlay, kept out of the component so it can be tested without a window.
 *
 * Before the first click a small clear "window" follows the cursor, so the user sees where a selection will
 * start; a click anchors the selection at that point and dragging expands it. Everything outside the clear
 * area is dimmed, but only lightly: the user has to see what is being left out without losing the screen.
 */

/** Opacity of the dim outside the clear area. 0.45 hid too much of the screen; this still reads as "outside". */
export const DIM_OUTSIDE = 0.32

/** Size of the clear window that follows the cursor before a click, in DIP. */
export const PREVIEW_SIZE = { width: 140, height: 90 } as const

export interface Point {
  x: number
  y: number
}

export interface Bounds {
  width: number
  height: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi))

/** The clear window centred on the cursor, kept inside the display so it never clips at an edge. */
export function previewRect(cursor: Point, bounds: Bounds, size: Bounds = PREVIEW_SIZE): Rect {
  const width = Math.min(size.width, bounds.width)
  const height = Math.min(size.height, bounds.height)
  return {
    x: clamp(cursor.x - width / 2, 0, bounds.width - width),
    y: clamp(cursor.y - height / 2, 0, bounds.height - height),
    width,
    height
  }
}

/** The selection between the click point and the pointer, whichever corner it is dragged towards. */
export function dragRect(origin: Point, point: Point): Rect {
  return {
    x: Math.min(origin.x, point.x),
    y: Math.min(origin.y, point.y),
    width: Math.abs(point.x - origin.x),
    height: Math.abs(point.y - origin.y)
  }
}
