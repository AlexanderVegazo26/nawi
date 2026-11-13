import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The renderer entry points; the only documents a Nawi window may show. */
export const APP_PAGES = ['index', 'overlay', 'recorder', 'hud'] as const

/**
 * Whether a navigation target is one of the app's own pages.
 *
 * Every window carries the full preload API, so whatever document a window
 * navigates to gets it too. Allowing any `file:` URL meant an HTML file dropped
 * on a window (the HUD and the overlays do not intercept drops) loaded with that
 * API. A packaged build allows exactly the four built pages in `rendererDir`;
 * a dev build also allows the dev server's origin. Query and fragment are
 * ignored: the overlay is addressed as `overlay.html?display=<id>`.
 */
export function isAppPage(url: string, rendererDir: string, devServer?: string): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (devServer) {
    try {
      if (target.origin === new URL(devServer).origin) return true
    } catch {
      // A malformed dev-server URL allows nothing extra.
    }
  }
  if (target.protocol !== 'file:') return false
  target.search = ''
  target.hash = ''
  return APP_PAGES.some((page) => pathToFileURL(join(rendererDir, `${page}.html`)).href === target.href)
}
