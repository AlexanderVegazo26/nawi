import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Region select, driven in the real overlay window: no screen has to be picked first, a clear window follows the
 * pointer, a click anchors the selection and dragging expands it, and the outside is dimmed lightly.
 */

let app: ElectronApplication
let main: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'nawi-region-e2e-'))
  app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], cwd: process.cwd() })
  main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
})

async function libraryCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const res = await window.api.listLibrary()
    return res.ok ? res.value.length : -1
  })
}

async function openOverlay(): Promise<Page> {
  const opened = app.waitForEvent('window', { predicate: (w) => w.url().includes('overlay'), timeout: 20_000 })
  await main.evaluate(() => {
    ;(window as unknown as { __region: Promise<unknown> }).__region = window.api.beginRegion()
  })
  const overlay = await opened
  await overlay.waitForLoadState('domcontentloaded')
  // The overlay shows once its frozen screenshot is ready; the dim layer is the first thing it paints.
  await expect(overlay.getByTestId('overlay-dim')).toBeAttached()
  return overlay
}

async function centre(overlay: Page, testId: string): Promise<{ x: number; y: number }> {
  const box = await overlay.getByTestId(testId).boundingBox()
  if (!box) throw new Error(`${testId} has no box`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('region select: a clear window follows the pointer, a drag expands it, the outside is lightly dimmed', async () => {
  const before = await libraryCount(main)
  const overlay = await openOverlay()

  await overlay.mouse.move(260, 200)
  await expect(overlay.getByTestId('overlay-preview')).toBeVisible()
  const first = await centre(overlay, 'overlay-preview')
  expect(Math.abs(first.x - 260)).toBeLessThan(2)
  expect(Math.abs(first.y - 200)).toBeLessThan(2)

  await overlay.mouse.move(420, 280)
  await expect
    .poll(async () => (await centre(overlay, 'overlay-preview')).x, { message: 'the preview follows the pointer' })
    .toBeGreaterThan(415)

  // The outside is dimmed, but lightly: visible, and well short of the old 0.45.
  const dim = await overlay.getByTestId('overlay-dim').getAttribute('fill')
  const alpha = Number(/rgba\(0,0,0,([\d.]+)\)/.exec(dim ?? '')?.[1])
  expect(alpha).toBeGreaterThan(0.15)
  expect(alpha).toBeLessThan(0.4)

  // A click anchors the selection and dragging expands it from that point.
  await overlay.mouse.move(300, 220)
  await overlay.mouse.down()
  await overlay.mouse.move(500, 340, { steps: 6 })
  await expect(overlay.getByTestId('overlay-preview')).toHaveCount(0)
  const cut = overlay.locator('#cutout rect').nth(1)
  await expect(cut).toHaveAttribute('width', '200')
  await expect(cut).toHaveAttribute('height', '120')
  await expect(cut).toHaveAttribute('x', '300')
  await expect(cut).toHaveAttribute('y', '220')

  // Dragging back past the anchor grows the other way, and the selection never goes negative.
  await overlay.mouse.move(250, 180, { steps: 4 })
  await expect(cut).toHaveAttribute('x', '250')
  await expect(cut).toHaveAttribute('width', '50')

  // Escape mid-drag cancels: the capture resolves empty and nothing is saved.
  // The overlay window is destroyed by the cancel, so the press itself may report the page as closed.
  await overlay.keyboard.press('Escape').catch(() => undefined)
  await expect.poll(() => overlay.isClosed()).toBe(true)
  const result = await main.evaluate(
    () => (window as unknown as { __region: Promise<{ ok: boolean; value?: unknown }> }).__region
  )
  expect(result.ok).toBe(true)
  expect(result.value ?? null).toBeNull()
  expect(await libraryCount(main)).toBe(before)
})
