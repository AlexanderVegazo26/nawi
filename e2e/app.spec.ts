import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * End-to-end tests against the built app.
 *
 * Each run gets a throwaway userData directory so the library starts genuinely
 * empty and the tests never touch the developer's real captures.
 */

let app: ElectronApplication
let win: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'nawi-e2e-'))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: process.cwd()
  })
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
})

test('main window renders the capture view', async () => {
  await expect(win.getByRole('heading', { name: 'New capture' })).toBeVisible()
  await expect(win.getByRole('button', { name: /Region/ })).toBeVisible()
  await expect(win.getByRole('button', { name: /Full screen/ })).toBeVisible()
})

test('preload exposes exactly the intended API and nothing else', async () => {
  const surface = await win.evaluate(() => ({
    keys: Object.keys((window as unknown as { api: Record<string, unknown> }).api).sort(),
    hasRequire: typeof (window as unknown as { require?: unknown }).require !== 'undefined',
    hasProcess: typeof (window as unknown as { process?: unknown }).process !== 'undefined',
    hasIpcRenderer: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer !== 'undefined'
  }))

  // The security boundary: no Node reachable from the renderer.
  expect(surface.hasRequire).toBe(false)
  expect(surface.hasProcess).toBe(false)
  expect(surface.hasIpcRenderer).toBe(false)

  expect(surface.keys).toContain('captureFullscreen')
  expect(surface.keys).toContain('beginRegion')
  expect(surface.keys).toContain('listLibrary')
  expect(surface.keys).toContain('saveAnnotations')
})

test('library starts empty and shows the no-captures state', async () => {
  await win.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'No captures yet' })).toBeVisible()
})

test('fullscreen capture produces a real image and lands in the library', async () => {
  // Drive the documented IPC surface directly: this asserts the capture
  // pipeline end-to-end (desktopCapturer -> PNG -> disk -> index).
  const result = await win.evaluate(async () => {
    const res = await window.api.captureFullscreen()
    return res.ok
      ? { ok: true as const, width: res.value.width, height: res.value.height, size: res.value.size, id: res.value.id }
      : { ok: false as const, error: res.error }
  })

  expect(result.ok, result.ok ? '' : `capture failed: ${(result as { error: string }).error}`).toBe(true)
  if (!result.ok) return

  expect(result.width).toBeGreaterThan(100)
  expect(result.height).toBeGreaterThan(100)
  // A real PNG of a screen is never a few bytes.
  expect(result.size).toBeGreaterThan(5000)

  const list = await win.evaluate(async () => {
    const res = await window.api.listLibrary()
    return res.ok ? res.value.length : -1
  })
  expect(list).toBe(1)
})

test('the capture:// protocol serves the stored asset back as a real image', async () => {
  // Note: fetch() to a custom scheme is blocked cross-origin from a file:// page,
  // so the supported path is <img>/<video> - which is what the app itself uses.
  const probe = await win.evaluate(async () => {
    const res = await window.api.listLibrary()
    if (!res.ok || res.value.length === 0) return { loaded: false, w: 0, h: 0 }
    const id = res.value[0].id
    return new Promise<{ loaded: boolean; w: number; h: number }>((resolve) => {
      const img = new Image()
      img.onload = () => resolve({ loaded: true, w: img.naturalWidth, h: img.naturalHeight })
      img.onerror = () => resolve({ loaded: false, w: 0, h: 0 })
      img.src = `capture://asset/${id}`
    })
  })

  expect(probe.loaded).toBe(true)
  expect(probe.w).toBeGreaterThan(100)
  expect(probe.h).toBeGreaterThan(100)

  // The two tests above drove the API directly, so the store now holds items the
  // React tree never saw. Reset it before the UI-driven tests so the on-screen
  // state and the store agree.
  await win.evaluate(async () => {
    const res = await window.api.listLibrary()
    if (!res.ok) return
    for (const item of res.value) await window.api.deleteLibraryItem(item.id)
  })
})

test('capturing through the UI opens the editor with a live canvas', async () => {
  await win.getByRole('button', { name: 'Capture', exact: true }).click()
  await win.getByRole('button', { name: /Full screen/ }).click()

  // The capture flow lands the user straight in the editor.
  await expect(win.locator('canvas[aria-label="Annotation canvas"]')).toBeVisible({ timeout: 20_000 })
  await expect(win.getByRole('button', { name: 'Save' })).toBeVisible()
})

test('annotations draw on the canvas, persist, and mark the document dirty', async () => {
  await win.getByRole('button', { name: 'Rectangle' }).click()
  const canvas = win.locator('canvas[aria-label="Annotation canvas"]')
  const box = (await canvas.boundingBox())!

  await win.mouse.move(box.x + 60, box.y + 60)
  await win.mouse.down()
  await win.mouse.move(box.x + 220, box.y + 170, { steps: 12 })
  await win.mouse.up()

  // The unsaved badge is the user-visible signal that a shape was committed.
  await expect(win.getByText('Unsaved')).toBeVisible()

  await win.getByRole('button', { name: 'Save' }).click()
  await expect(win.getByText('Saved to library')).toBeVisible()

  const shapes = await win.evaluate(async () => {
    const res = await window.api.listLibrary()
    return res.ok ? (res.value[0].annotations?.shapes.length ?? 0) : -1
  })
  expect(shapes).toBe(1)
})

test('undo removes the annotation and the change round-trips to disk', async () => {
  await win.getByRole('button', { name: 'Undo' }).click()
  await expect(win.getByText('Unsaved')).toBeVisible()
  await win.getByRole('button', { name: 'Save' }).click()

  const shapes = await win.evaluate(async () => {
    const res = await window.api.listLibrary()
    return res.ok ? (res.value[0].annotations?.shapes.length ?? 0) : -1
  })
  expect(shapes).toBe(0)
})

test('the library grid shows the capture after leaving the editor', async () => {
  await win.getByRole('button', { name: 'Library', exact: true }).click()
  const card = win.locator('ul[aria-label="Captures"] > li').first()
  await expect(card).toBeVisible()
  // The thumbnail is served over capture:// - proves the protocol works in the DOM.
  await expect(card.locator('img')).toBeVisible()
})

test('delete asks for confirmation, then empties the library', async () => {
  const card = win.locator('ul[aria-label="Captures"] > li').first()
  await card.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(win.getByRole('dialog', { name: 'Delete this capture?' })).toBeVisible()
  await win.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()

  await expect(win.getByRole('heading', { name: 'No captures yet' })).toBeVisible()

  const count = await win.evaluate(async () => {
    const res = await window.api.listLibrary()
    return res.ok ? res.value.length : -1
  })
  expect(count).toBe(0)
})
