/**
 * The main window at the sizes it can actually have: its minimum (1024x660,
 * createMainWindow's minWidth/minHeight), its default (1360x860), a wide
 * desktop (1920x1080), and the minimum at 200% zoom (Ctrl+= in Electron
 * halves the CSS viewport, so 512x330 CSS px).
 *
 * Every screen at every size: no horizontal page scroll, nothing wider than
 * the viewport, every rail button reachable, and every visible control at
 * least 24x24 CSS px (WCAG 2.5.8).
 */
import { expect, test } from '@playwright/test'
import { openScreen, SCREENS } from './views'

const SIZES = [
  { id: 'min', width: 1024, height: 660, zoom: 1 },
  { id: 'default', width: 1360, height: 860, zoom: 1 },
  { id: 'wide', width: 1920, height: 1080, zoom: 1 },
  { id: 'min-zoom200', width: 512, height: 330, zoom: 2 }
]

const MIN_TARGET = 24

for (const size of SIZES) {
  test.describe(`${size.id} (${size.width}x${size.height} CSS px)`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.zoom
    })

    for (const screen of SCREENS) {
      test(`${screen.id} fits without horizontal scroll and keeps targets >= 24px`, async ({ page }) => {
        await openScreen(page, screen, 'dark')

        const scroll = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth
        }))
        expect(
          scroll.scrollWidth,
          `${screen.id} at ${size.id}: page scrolls sideways (scrollWidth ${scroll.scrollWidth} > innerWidth ${scroll.innerWidth})`
        ).toBeLessThanOrEqual(scroll.innerWidth)

        // Elements that stick out past the right edge, unless an ancestor
        // scrolls them (overflow-x auto/scroll) — that is reachable content.
        const overflowing = await page.evaluate(() => {
          const out: string[] = []
          const vw = window.innerWidth
          for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
            const r = el.getBoundingClientRect()
            if (r.width === 0 || r.height === 0 || r.right <= vw + 1) continue
            let scroller = false
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
              const ox = getComputedStyle(p).overflowX
              if (ox === 'auto' || ox === 'scroll') {
                scroller = true
                break
              }
            }
            if (scroller || getComputedStyle(el).position === 'fixed') continue
            const label = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? ''
            out.push(`<${el.tagName.toLowerCase()}> "${label}" right=${Math.round(r.right)}`)
          }
          return out.slice(0, 10)
        })
        expect(overflowing, `${screen.id} at ${size.id}: elements past the viewport's right edge (${size.width}px)`).toEqual([])

        const nav = page.getByRole('navigation', { name: 'Main' })
        for (const rail of ['Capture', 'Library', 'Mobile']) {
          await expect(
            nav.getByRole('button', { name: rail, exact: true }),
            `${screen.id} at ${size.id}: rail button ${rail} should be on screen`
          ).toBeInViewport()
        }

        const small = await page.evaluate((min) => {
          const out: string[] = []
          const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch]'
          for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
            const r = el.getBoundingClientRect()
            const style = getComputedStyle(el)
            if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || el.closest('[aria-hidden=true]')) continue
            if (el.classList.contains('sr-only')) continue
            if (r.width < min || r.height < min) {
              const label = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? ''
              out.push(`<${el.tagName.toLowerCase()}> "${label}" ${Math.round(r.width)}x${Math.round(r.height)}`)
            }
          }
          return out
        }, MIN_TARGET)
        expect(small, `${screen.id} at ${size.id}: controls smaller than ${MIN_TARGET}x${MIN_TARGET} CSS px`).toEqual([])
      })
    }
  })
}
