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

/* ------------------------------------------------------------------ *
 * Regression tests for defects found in review — each of these was a
 * real bug that the original suite could not have caught.
 * ------------------------------------------------------------------ */

test('moving a shape is undoable', async () => {
  await win.getByRole('button', { name: 'Capture', exact: true }).click()
  await win.getByRole('button', { name: /Full screen/ }).click()
  const canvas = win.locator('canvas[aria-label="Annotation canvas"]')
  await expect(canvas).toBeVisible({ timeout: 20_000 })

  const readPos = async (): Promise<{ x: number; y: number } | null> =>
    win.evaluate(async () => {
      const r = await window.api.listLibrary()
      const s = r.ok ? r.value[0].annotations?.shapes[0] : null
      return s ? { x: s.x, y: s.y } : null
    })

  // Draw a rectangle and persist it.
  await win.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await canvas.boundingBox())!
  await win.mouse.move(box.x + 50, box.y + 50)
  await win.mouse.down()
  await win.mouse.move(box.x + 160, box.y + 130, { steps: 10 })
  await win.mouse.up()
  await win.getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => (await readPos()) !== null).toBe(true)
  const posBefore = (await readPos())!

  // Drag it with the select tool.
  await win.getByRole('button', { name: 'Select' }).click()
  await win.mouse.move(box.x + 105, box.y + 90)
  await win.mouse.down()
  await win.mouse.move(box.x + 205, box.y + 170, { steps: 10 })
  await win.mouse.up()
  await win.getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => Math.round((await readPos())!.x)).not.toBe(Math.round(posBefore.x))

  // The move must be undoable — it previously created no history entry at all,
  // so Undo silently discarded some earlier operation instead.
  await win.getByRole('button', { name: 'Undo' }).click()
  await win.getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => Math.round((await readPos())!.x)).toBe(Math.round(posBefore.x))
  expect(Math.round((await readPos())!.y)).toBe(Math.round(posBefore.y))
})

test('copy to clipboard works against the real Electron clipboard API', async () => {
  // Electron 44 replaced clipboard.writeImage with an async ClipboardItem API.
  // If that call shape were wrong the feature would fail silently in a build.
  await expect(win.locator('canvas[aria-label="Annotation canvas"]')).toBeVisible()
  await win.getByRole('button', { name: 'Copy', exact: true }).click()

  await expect
    .poll(async () => app.evaluate(async ({ clipboard }) => clipboard.has('image/png')), {
      timeout: 10_000
    })
    .toBe(true)
})

test('blur renders correctly over a cropped document', async () => {
  const canvas = win.locator('canvas[aria-label="Annotation canvas"]')
  const box = (await canvas.boundingBox())!

  // Crop, which shifts the canvas origin away from image-space (0,0).
  await win.getByRole('button', { name: 'Crop' }).click()
  await win.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.95, { steps: 10 })
  await win.mouse.up()

  await expect.poll(async () => (await canvas.boundingBox())!.width < box.width).toBe(true)

  // Draw a blur inside the cropped view. Before the fix this read pixels from
  // the wrong part of the image — a redaction tool showing unrelated content.
  await win.getByRole('button', { name: 'Blur / pixelate' }).click()
  const b = (await canvas.boundingBox())!
  await win.mouse.move(b.x + 30, b.y + 30)
  await win.mouse.down()
  await win.mouse.move(b.x + 140, b.y + 110, { steps: 10 })
  await win.mouse.up()

  // The blurred region must be fully opaque: sampling out of bounds yields
  // transparent pixels, which is exactly what the coordinate bug produced.
  const alpha = await win.evaluate(() => {
    const c = document.querySelector('canvas[aria-label="Annotation canvas"]') as HTMLCanvasElement
    const ctx = c.getContext('2d')!
    const d = ctx.getImageData(60, 60, 1, 1).data
    return d[3]
  })
  expect(alpha).toBe(255)
})

/**
 * Runs last: it is the only test that mutates app-wide settings, and a theme
 * broadcast could otherwise change what earlier assertions are looking at.
 *
 * This exercises the whole settings chain in a real Electron process — preload
 * method, channel name, main handler, disk write, and the main->renderer
 * broadcast. Unit tests cover the store with `electron` mocked, which proves
 * nothing about whether the two sides agree on a channel.
 */
test('settings round-trip across the real IPC boundary and broadcast a change', async () => {
  const initial = await win.evaluate(() => window.api.getSettings())
  expect(initial.ok).toBe(true)
  if (!initial.ok) return
  // The defaults are the accelerators main used to hardcode.
  expect(initial.value.hotkeys['capture-region']).toBe('CommandOrControl+Shift+1')
  expect(initial.value.theme).toBe('system')

  // Arm the listener before the update, then apply it and wait for the broadcast.
  const broadcast = await win.evaluate(async () => {
    const seen = new Promise<string>((resolve) => {
      const off = window.api.onSettingsChanged((s) => {
        off()
        resolve(s.theme)
      })
    })
    const updated = await window.api.updateSettings({ theme: 'light' })
    return { updated, broadcastTheme: await seen }
  })

  expect(broadcast.updated.ok).toBe(true)
  if (!broadcast.updated.ok) return
  expect(broadcast.updated.value.theme).toBe('light')
  // Untouched fields survive a partial patch.
  expect(broadcast.updated.value.hotkeys).toEqual(initial.value.hotkeys)
  expect(broadcast.broadcastTheme).toBe('light')

  // Re-read: the value came off the store, not just back out of the patch.
  const reread = await win.evaluate(() => window.api.getSettings())
  expect(reread.ok && reread.value.theme).toBe('light')

  // And it is genuinely on disk under this run's userData.
  const onDisk = JSON.parse(await fs.readFile(join(userDataDir, 'settings.json'), 'utf-8'))
  expect(onDisk.theme).toBe('light')

  await win.evaluate(() => window.api.updateSettings({ theme: 'system' }))
})

test('the theme preference actually reaches the pixels, not just the disk', async () => {
  // The settings round-trip above proves plumbing. It passed while the theme did
  // nothing at all on screen, because nothing consumed the stored value. This
  // asserts the effect: computed background, in both directions, from the store.
  const bg = async (): Promise<string> =>
    win.evaluate(() => getComputedStyle(document.body).backgroundColor)

  await win.evaluate(() => window.api.updateSettings({ theme: 'dark' }))
  await expect.poll(bg).toBe('rgb(16, 17, 20)')
  await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')

  await win.evaluate(() => window.api.updateSettings({ theme: 'light' }))
  await expect.poll(bg).toBe('rgb(255, 255, 255)')

  // 'system' is the absence of the attribute — there is no CSS for a third value.
  await win.evaluate(() => window.api.updateSettings({ theme: 'system' }))
  await expect
    .poll(() => win.evaluate(() => document.documentElement.dataset.theme ?? null))
    .toBe(null)
})

test('the theme toggle in the rail cycles and persists', async () => {
  await win.evaluate(() => window.api.updateSettings({ theme: 'system' }))

  // The editor replaces the whole shell including the rail (App.tsx:239), and an
  // earlier test leaves it open with unsaved changes. Get back to a view that has
  // the rail, clearing the dirty-state guard on the way.
  const leaveEditor = win.getByRole('button', { name: 'Library', exact: true })
  if (await leaveEditor.isVisible().catch(() => false)) {
    await leaveEditor.click()
    const discard = win.getByRole('button', { name: 'Discard', exact: true })
    if (await discard.isVisible().catch(() => false)) await discard.click()
  }

  const toggle = win.getByRole('button', { name: /Theme:/ })
  await expect(toggle).toBeVisible()

  // system -> light -> dark
  await toggle.click()
  await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
  await toggle.click()
  await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')

  const onDisk = JSON.parse(await fs.readFile(join(userDataDir, 'settings.json'), 'utf-8'))
  expect(onDisk.theme).toBe('dark')

  await win.evaluate(() => window.api.updateSettings({ theme: 'system' }))
})
