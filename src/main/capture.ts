import { desktopCapturer, screen, type NativeImage, type Display } from 'electron'
import type { CaptureSource, DisplayInfo, Rect } from '@shared/types'

/**
 * Still capture lives entirely in main.
 *
 * `desktopCapturer.getSources` with `thumbnailSize` set to the display's full
 * pixel size returns the screenshot itself as a NativeImage — no media stream,
 * no getUserMedia, no renderer involvement.
 */

export function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    scaleFactor: d.scaleFactor,
    isPrimary: d.id === primaryId
  }))
}

/**
 * DIP → physical pixels, relative to the display's own origin.
 *
 * This is the single most likely source of subtle bugs in the app: the `screen`
 * module speaks DIP, captured bitmaps are physical pixels, and at 125% scaling a
 * rect that skips this conversion is off by 25%. Every rect conversion goes
 * through here — do not inline the arithmetic anywhere else.
 */
export function dipRectToPixels(rect: Rect, display: Display, bitmapSize: { width: number; height: number }): Rect {
  const f = display.scaleFactor
  const raw = {
    x: Math.round((rect.x - display.bounds.x) * f),
    y: Math.round((rect.y - display.bounds.y) * f),
    width: Math.round(rect.width * f),
    height: Math.round(rect.height * f)
  }
  // Clamp into the bitmap; a selection dragged past the edge must not throw.
  const x = Math.max(0, Math.min(raw.x, bitmapSize.width))
  const y = Math.max(0, Math.min(raw.y, bitmapSize.height))
  return {
    x,
    y,
    width: Math.max(0, Math.min(raw.width, bitmapSize.width - x)),
    height: Math.max(0, Math.min(raw.height, bitmapSize.height - y))
  }
}

function pixelSize(d: Display): { width: number; height: number } {
  return {
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor)
  }
}

export async function listSources(kinds: Array<'screen' | 'window'>): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: kinds,
    thumbnailSize: { width: 640, height: 400 },
    fetchWindowIcons: true
  })
  return sources
    // Windows reports a few zero-area phantom windows; they're never useful targets.
    .filter((s) => !s.thumbnail.isEmpty())
    .map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      displayId: s.display_id || null
    }))
}

/** Full-resolution bitmap of one display. */
export async function captureDisplay(display: Display): Promise<NativeImage> {
  const size = pixelSize(display)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  if (sources.length === 0) throw new Error('No screen sources available')

  // display_id is the reliable mapping when populated; fall back to index order
  // against getAllDisplays(), which desktopCapturer follows on Windows.
  const byId = sources.find((s) => s.display_id === String(display.id))
  if (byId) return byId.thumbnail

  const all = screen.getAllDisplays()
  const idx = all.findIndex((d) => d.id === display.id)
  const chosen = (idx >= 0 ? sources[idx] : undefined) ?? sources[0]
  return chosen.thumbnail
}

/** Full-resolution bitmap of every display, keyed by display id. */
export async function captureAllDisplays(): Promise<Map<number, NativeImage>> {
  const displays = screen.getAllDisplays()
  const out = new Map<number, NativeImage>()
  // Sequential on purpose: concurrent full-res grabs contend badly on Windows.
  for (const d of displays) {
    out.set(d.id, await captureDisplay(d))
  }
  return out
}

export async function captureWindowSource(sourceId: string): Promise<NativeImage> {
  // Ask for something generously large; desktopCapturer returns the window's
  // native size when the requested box is bigger than the window.
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 8192, height: 8192 }
  })
  const match = sources.find((s) => s.id === sourceId)
  if (!match) throw new Error('That window is no longer available')
  if (match.thumbnail.isEmpty()) throw new Error('That window could not be captured')
  return match.thumbnail
}

export function displayById(id: number): Display {
  const found = screen.getAllDisplays().find((d) => d.id === id)
  if (!found) throw new Error(`No display with id ${id}`)
  return found
}
