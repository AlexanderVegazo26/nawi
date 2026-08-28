import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

/**
 * Annotation and redaction acceptance, against the built app.
 *
 * These live in their own file, with their own app instance, because they need
 * a real canvas and a real PNG encoder. The pure geometry and contrast maths
 * are unit-tested under vitest; everything here is a claim that could only be
 * checked by rendering actual pixels.
 */

let app: ElectronApplication
let win: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'nawi-ann-'))
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

const canvasSel = 'canvas[aria-label="Annotation canvas"]'

/** Bytes of the PNG produced by the real export path, shared between tests. */
let exportedFile: Buffer | null = null

/**
 * Lists a PNG's chunk types in order.
 *
 * Pure byte walking, no decoder: signature(8), then repeating
 * length(4) type(4) data(length) crc(4). This is how "including metadata"
 * in the FR-ANN.3 acceptance gets checked rather than assumed.
 */
function pngChunkNames(bytes: Buffer): string[] {
  const names: string[] = []
  let off = 8
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off)
    const type = bytes.toString('ascii', off + 4, off + 8)
    names.push(type)
    if (type === 'IEND') break
    off += 12 + len
  }
  return names
}

/**
 * Leaves the editor, discarding anything unsaved.
 *
 * The editor guards a dirty document with a modal, so a test that just clicks
 * "Library" and carries on is really asserting the guard does not exist.
 */
async function leaveEditor(): Promise<void> {
  const back = win.getByRole('button', { name: 'Library', exact: true })
  if (!(await back.isVisible().catch(() => false))) return
  await back.click()
  const discard = win.getByRole('button', { name: 'Discard' })
  if (await discard.isVisible().catch(() => false)) await discard.click()
}

/** Empties the library so a test starts from a known, single-item state. */
async function clearLibrary(): Promise<void> {
  await leaveEditor()
  await win.evaluate(async () => {
    const res = await window.api.listLibrary()
    if (!res.ok) return
    for (const item of res.value) await window.api.deleteLibraryItem(item.id)
  })
}

async function openEditorOnAFreshCapture(): Promise<void> {
  await win.getByRole('button', { name: 'Capture', exact: true }).click()
  await win.getByRole('button', { name: /Full screen/ }).click()
  await expect(win.locator(canvasSel)).toBeVisible({ timeout: 20_000 })
}

/** Image-pixel size of the editor canvas (not its CSS size). */
async function canvasPixelSize(): Promise<{ width: number; height: number }> {
  return win.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement
    return { width: c.width, height: c.height }
  }, canvasSel)
}

/** Converts an image-space point to page coordinates for the mouse. */
async function toPage(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await win.locator(canvasSel).boundingBox())!
  const size = await canvasPixelSize()
  return {
    x: box.x + (x / size.width) * box.width,
    y: box.y + (y / size.height) * box.height
  }
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const a = await toPage(from.x, from.y)
  const b = await toPage(to.x, to.y)
  await win.mouse.move(a.x, a.y)
  await win.mouse.down()
  await win.mouse.move(b.x, b.y, { steps: 14 })
  await win.mouse.up()
}

/* ------------------------------------------------------------------ *
 * FR-ANN.1 — the freehand tool
 * ------------------------------------------------------------------ */

test('FR-ANN.1 — freehand draws a multi-point stroke that persists', async () => {
  await openEditorOnAFreshCapture()
  await win.getByRole('button', { name: 'Freehand' }).click()

  // A curved path, so the stroke is genuinely a polyline and not two points.
  const start = await toPage(80, 80)
  await win.mouse.move(start.x, start.y)
  await win.mouse.down()
  for (let i = 1; i <= 20; i += 1) {
    const p = await toPage(80 + i * 8, 80 + Math.sin(i / 3) * 40)
    await win.mouse.move(p.x, p.y)
  }
  await win.mouse.up()

  await expect(win.getByText('Unsaved')).toBeVisible()
  await win.getByRole('button', { name: 'Save' }).click()
  await expect(win.getByText('Saved to library').first()).toBeVisible()

  const stroke = await win.evaluate(async () => {
    const r = await window.api.listLibrary()
    const s = r.ok ? r.value[0].annotations?.shapes.find((x) => x.kind === 'freehand') : null
    if (!s || s.kind !== 'freehand') return null
    return { points: s.points.length, x: s.x, y: s.y, width: s.width, height: s.height }
  })

  expect(stroke).not.toBeNull()
  expect(stroke!.points).toBeGreaterThan(5)
  // The bbox must track the points, or the stroke is unselectable and its
  // selection ring sits somewhere else entirely.
  expect(stroke!.width).toBeGreaterThan(50)
  expect(stroke!.height).toBeGreaterThan(10)
})

test('FR-ANN.1 — a freehand stroke is hit-testable and moves with its points', async () => {
  // Select the stroke by clicking ON the ink, then drag it.
  await win.getByRole('button', { name: 'Select' }).click()

  const before = await win.evaluate(async () => {
    const r = await window.api.listLibrary()
    const s = r.ok ? r.value[0].annotations?.shapes.find((x) => x.kind === 'freehand') : null
    return s && s.kind === 'freehand' ? { x: s.x, y: s.y, first: s.points[0] } : null
  })
  expect(before).not.toBeNull()

  // Click the stroke's first recorded point — that is where ink certainly is.
  const grab = await toPage(before!.first.x, before!.first.y)
  await win.mouse.move(grab.x, grab.y)
  await win.mouse.down()
  await win.mouse.move(grab.x + 40, grab.y + 25, { steps: 10 })
  await win.mouse.up()
  await win.getByRole('button', { name: 'Save' }).click()
  await expect(win.getByText('Saved to library').first()).toBeVisible()

  const after = await win.evaluate(async () => {
    const r = await window.api.listLibrary()
    const s = r.ok ? r.value[0].annotations?.shapes.find((x) => x.kind === 'freehand') : null
    return s && s.kind === 'freehand' ? { x: s.x, y: s.y, first: s.points[0] } : null
  })

  // The whole point of translateShape: the bbox AND the points move together.
  const dx = after!.x - before!.x
  const dy = after!.y - before!.y
  expect(Math.abs(dx)).toBeGreaterThan(5)
  expect(after!.first.x - before!.first.x).toBeCloseTo(dx, 3)
  expect(after!.first.y - before!.first.y).toBeCloseTo(dy, 3)
})

/* ------------------------------------------------------------------ *
 * FR-ANN.3 — the redaction acceptance, proved on real exported bytes
 * ------------------------------------------------------------------ */

test('FR-ANN.3 — exported PNG bytes contain no original pixels under a solid redaction', async () => {
  // Fresh capture, no leftover annotations.
  await clearLibrary()
  await openEditorOnAFreshCapture()

  const size = await canvasPixelSize()
  const rect = {
    x: Math.round(size.width * 0.2),
    y: Math.round(size.height * 0.2),
    width: Math.round(size.width * 0.3),
    height: Math.round(size.height * 0.2)
  }

  /**
   * Ground truth. Read the stored asset's own bytes back over IPC — the same
   * pristine source the editor renders from — and record every distinct colour
   * inside the region that is about to be redacted.
   */
  const original = await win.evaluate(async (r) => {
    const res = await window.api.readItemBytes((await window.api.listLibrary()).value![0].id)
    if (!res.ok) throw new Error(res.error)
    const view = res.value.data
    const buf = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
    const bitmap = await createImageBitmap(new Blob([buf], { type: res.value.mime }))
    const c = document.createElement('canvas')
    c.width = bitmap.width
    c.height = bitmap.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const px = ctx.getImageData(r.x, r.y, r.width, r.height).data
    const colours = new Set<number>()
    let nonBlack = 0
    for (let i = 0; i + 3 < px.length; i += 4) {
      const v = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2]
      colours.add(v)
      if (v !== 0) nonBlack += 1
    }
    return { distinct: colours.size, nonBlack, total: px.length / 4 }
  }, rect)

  // Guard against a vacuous pass: if the source region were already pure black,
  // "the region is black afterwards" would prove nothing at all.
  expect(
    original.nonBlack,
    'the region chosen for redaction was already blank in the source, so this test would prove nothing'
  ).toBeGreaterThan(original.total * 0.05)

  // Place a solid redaction over exactly that region.
  await win.getByRole('button', { name: 'Redact' }).click()
  // Redaction has exactly one mode, and the surface says so plainly rather than
  // offering blur/pixelate variants that would not be destructive (FR-ANN.3).
  await expect(win.getByText(/The pixels are replaced, not transformed/)).toBeVisible()
  await drag({ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height })
  await expect(win.getByText('Unsaved')).toBeVisible()

  /**
   * The real exported file.
   *
   * `Export` calls the editor's `flatten()` and hands those exact bytes to
   * main, which writes them to the path the save dialog returns. Stubbing only
   * `dialog.showSaveDialog` — a native dialog Playwright cannot drive — leaves
   * the whole render → encode → write path intact, so what lands on disk is the
   * artifact the acceptance criterion is written about, not a re-render staged
   * for the test.
   */
  const outPath = join(userDataDir, 'redaction-proof.png')
  await app.evaluate(async ({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: p,
      filePaths: [p]
    })) as unknown as typeof dialog.showSaveDialog
  }, outPath)

  await win.getByRole('button', { name: 'Export' }).click()
  await expect(win.getByText(/Exported to/)).toBeVisible({ timeout: 20_000 })

  const fileBytes = await fs.readFile(outPath)
  expect(fileBytes.length).toBeGreaterThan(0)
  exportedFile = fileBytes

  /* --- (a) metadata: nothing may hide in an ancillary chunk --- */
  const chunks = pngChunkNames(fileBytes)
  expect(chunks[0]).toBe('IHDR')
  expect(chunks).toContain('IDAT')
  expect(chunks[chunks.length - 1]).toBe('IEND')
  for (const forbidden of ['tEXt', 'iTXt', 'zTXt', 'eXIf']) {
    expect(chunks, `the exported PNG must not carry a ${forbidden} chunk`).not.toContain(forbidden)
  }

  /* --- (b) pixels: nothing of the original survives in the region --- */
  const exported = Array.from(fileBytes)

  // Decode the exported PNG and inspect the redacted region's pixels.
  const scan = await win.evaluate(
    async ({ bytes, r }) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const bitmap = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bitmap.width
      c.height = bitmap.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)

      // Interior only: the UX-ANN.4 marker (dashed border, shield glyph) is
      // deliberately drawn INSIDE the rect, so the fill is sampled clear of it.
      // The shield sits top-right, so sample the bottom-left quadrant.
      const inset = 14
      const ix = r.x + inset
      const iy = r.y + Math.round(r.height / 2)
      const iw = Math.max(1, Math.round(r.width / 2) - inset)
      const ih = Math.max(1, Math.round(r.height / 2) - inset)
      const interior = ctx.getImageData(ix, iy, iw, ih).data

      let nonBlackInterior = 0
      for (let i = 0; i + 3 < interior.length; i += 4) {
        if (interior[i] !== 0 || interior[i + 1] !== 0 || interior[i + 2] !== 0) nonBlackInterior += 1
      }

      // The marker itself: light pixels must exist near the region's edge, or
      // the redaction is indistinguishable from a plain black rectangle.
      const border = ctx.getImageData(r.x, r.y, r.width, Math.min(10, r.height)).data
      let lightOnBorder = 0
      for (let i = 0; i + 3 < border.length; i += 4) {
        if (border[i] > 200 && border[i + 1] > 200 && border[i + 2] > 200) lightOnBorder += 1
      }

      return {
        imageWidth: bitmap.width,
        imageHeight: bitmap.height,
        interiorSamples: interior.length / 4,
        nonBlackInterior,
        lightOnBorder
      }
    },
    { bytes: exported, r: rect }
  )

  // FR-ANN.3: no pixel data from the original region survives.
  expect(scan.interiorSamples).toBeGreaterThan(100)
  expect(scan.nonBlackInterior).toBe(0)

  // UX-ANN.4: and it is visibly a redaction, not an anonymous black box.
  expect(scan.lightOnBorder).toBeGreaterThan(0)
})

test('FR-ANN.3 — the exported file is a bare PNG with no ancillary chunks', () => {
  // Asserted against the file the previous test actually wrote to disk, so this
  // covers the real artifact rather than a canvas re-encode arranged here.
  expect(exportedFile, 'the export test must run first').not.toBeNull()
  const chunks = pngChunkNames(exportedFile!)
  expect(chunks.filter((c) => c === 'IHDR')).toHaveLength(1)
  expect(chunks.filter((c) => c === 'IEND')).toHaveLength(1)
  // No ancillary chunk at all — not just the text ones. Anything beyond the
  // critical chunks plus the colour-space hints a browser emits is somewhere
  // bytes could hide, and should be a deliberate decision rather than a
  // surprise.
  const allowed = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'iCCP'])
  const unexpected = chunks.filter((c) => !allowed.has(c))
  expect(unexpected, `unexpected PNG chunks: ${unexpected.join(', ')}`).toEqual([])
})

/* ------------------------------------------------------------------ *
 * UX-ANN.4 — redaction is not the same object as a decorative blur
 * ------------------------------------------------------------------ */

test('UX-ANN.4 — blur and redact are separate tools producing separate shape kinds', async () => {
  await clearLibrary()
  await openEditorOnAFreshCapture()

  // Decorative blur on B.
  await win.locator('nav[aria-label="Annotation tools"]').press('b')
  await drag({ x: 40, y: 40 }, { x: 160, y: 110 })
  // Redaction on X.
  await win.locator('nav[aria-label="Annotation tools"]').press('x')
  await drag({ x: 200, y: 40 }, { x: 330, y: 110 })

  await win.getByRole('button', { name: 'Save' }).click()
  await expect(win.getByText('Saved to library').first()).toBeVisible()

  const kinds = await win.evaluate(async () => {
    const r = await window.api.listLibrary()
    const shapes = r.ok ? (r.value[0].annotations?.shapes ?? []) : []
    return shapes.map((s) => ({
      kind: s.kind,
      mode: 'mode' in s ? s.mode : null
    }))
  })

  expect(kinds).toHaveLength(2)
  expect(kinds).toContainEqual({ kind: 'blur', mode: 'blur' })
  expect(kinds).toContainEqual({ kind: 'redact', mode: 'solid' })
})

/* ------------------------------------------------------------------ *
 * UX-ANN.2 — badge renumbering
 * ------------------------------------------------------------------ */

test('UX-ANN.2 — deleting badge 3 of 5 renumbers the rest, derived not stored', async () => {
  await clearLibrary()
  await openEditorOnAFreshCapture()

  await win.getByRole('button', { name: 'Step number' }).click()
  for (let i = 0; i < 5; i += 1) {
    const p = await toPage(80 + i * 90, 90)
    await win.mouse.click(p.x, p.y)
  }
  await win.getByRole('button', { name: 'Save' }).click()
  await expect(win.getByText('Saved to library').first()).toBeVisible()

  const ids = await win.evaluate(async () => {
    const r = await window.api.listLibrary()
    const shapes = r.ok ? (r.value[0].annotations?.shapes ?? []) : []
    return shapes.filter((s) => s.kind === 'step').map((s) => s.id)
  })
  expect(ids).toHaveLength(5)

  // Nothing in the stored model carries a number — that is what makes
  // renumbering automatic rather than a maintenance job.
  const hasStoredNumber = await win.evaluate(async () => {
    const r = await window.api.listLibrary()
    const shapes = r.ok ? (r.value[0].annotations?.shapes ?? []) : []
    return shapes.some((s) => 'index' in s || 'number' in s || 'label' in s)
  })
  expect(hasStoredNumber).toBe(false)

  // Delete the third badge by selecting it and pressing Delete.
  await win.getByRole('button', { name: 'Select' }).click()
  const third = await toPage(80 + 2 * 90, 90)
  await win.mouse.click(third.x, third.y)
  await win.locator(canvasSel).press('Delete')

  await win.getByRole('button', { name: 'Save' }).click()
  await expect(win.getByText('Saved to library').first()).toBeVisible()

  const remaining = await win.evaluate(async () => {
    const r = await window.api.listLibrary()
    const shapes = r.ok ? (r.value[0].annotations?.shapes ?? []) : []
    return shapes.filter((s) => s.kind === 'step').map((s) => s.id)
  })
  expect(remaining).toHaveLength(4)
  expect(remaining).toEqual([ids[0], ids[1], ids[3], ids[4]])
  // Badge 4 is now badge 3 and badge 5 is now badge 4, by position in this list.
  expect(remaining.indexOf(ids[3])).toBe(2)
  expect(remaining.indexOf(ids[4])).toBe(3)
})

/* ------------------------------------------------------------------ *
 * UX-ANN.3 — the pre-redaction chip, list and named-risk revert
 * ------------------------------------------------------------------ */

test('UX-ANN.3 — the chip, the list, and a revert that names what it exposes', async () => {
  await clearLibrary()
  await openEditorOnAFreshCapture()
  await win.getByRole('button', { name: 'Library', exact: true }).click()

  /*
   * Seeds a saved document that already contains auto-redactions.
   *
   * This is a REAL production path, not a simulated detector: reopening an item
   * whose automatic redactions were saved earlier is exactly how the chip will
   * be reached once FR-AI.2/3 lands. The detector seam itself still returns
   * nothing — see src/renderer/lib/detect.ts.
   */
  const itemId = await win.evaluate(async () => {
    const list = await window.api.listLibrary()
    const item = list.value![0]
    const mk = (id: string, label: string, x: number): unknown => ({
      id,
      kind: 'redact',
      x,
      y: 60,
      width: 180,
      height: 40,
      color: '#000000',
      strokeWidth: 4,
      mode: 'solid',
      auto: { label, confidence: 0.93 }
    })
    await window.api.saveAnnotations(item.id, {
      version: 1,
      crop: null,
      shapes: [mk('auto-1', 'an API key', 60), mk('auto-2', 'an email address', 300)] as never
    })
    return item.id
  })
  expect(itemId).toBeTruthy()

  // Reload so the renderer reads the seeded document off disk. Writing through
  // the IPC API does not update the list the React tree is already holding, and
  // the editor renders from that list — so without this the test would open an
  // item whose annotations the UI never saw.
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.getByRole('button', { name: 'Library', exact: true }).click()

  // Reopen the item from the library, through the card's own Open action.
  await win.getByRole('button', { name: 'Open', exact: true }).first().click()
  await expect(win.locator(canvasSel)).toBeVisible({ timeout: 20_000 })

  // UX-ANN.3's chip copy, exactly as the acceptance quotes it.
  const chip = win.getByRole('button', { name: '2 items redacted automatically' })
  await expect(chip).toBeVisible()

  // Clicking it lists them.
  await chip.click()
  await expect(win.getByText('an API key')).toBeVisible()
  await expect(win.getByText('an email address')).toBeVisible()

  // Reverting one requires a confirmation naming what will be exposed.
  await win.getByRole('listitem').filter({ hasText: 'an API key' }).getByRole('button', { name: 'Revert' }).click()
  const dialog = win.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('This will expose an API key in the shared image.')
  await expect(dialog).not.toContainText('Are you sure')

  // The safe choice is the focused one.
  await expect(win.getByRole('button', { name: 'Keep it redacted' })).toBeFocused()

  await win.getByRole('button', { name: 'Expose it' }).click()
  await expect(win.getByRole('button', { name: '1 item redacted automatically' })).toBeVisible()
})

/* ------------------------------------------------------------------ *
 * UX-A11Y.7 — the reduced-motion variant of the renumber
 * ------------------------------------------------------------------ */

test('UX-A11Y.7 — under reduced motion the renumber is instant and still announced', async () => {
  // The badge cross-fade is painted on canvas, so styles.css cannot suppress
  // it. This exercises the JS branch that actually honours the preference.
  await win.emulateMedia({ reducedMotion: 'reduce' })
  try {
    await clearLibrary()
    await openEditorOnAFreshCapture()

    await win.getByRole('button', { name: 'Step number' }).click()
    for (let i = 0; i < 3; i += 1) {
      const p = await toPage(90 + i * 120, 120)
      await win.mouse.click(p.x, p.y)
    }

    await win.getByRole('button', { name: 'Select' }).click()
    const second = await toPage(90 + 120, 120)
    await win.mouse.click(second.x, second.y)
    await win.locator(canvasSel).press('Delete')

    // The static replacement for the animation is the live-region message —
    // "no motion" must not mean "no feedback" (UX-A11Y.7, UX-A11Y.8).
    const live = win.locator('[role="status"][aria-live="polite"]').first()
    await expect(live).toContainText('renumbered')
    await expect(live).toContainText('2 badges now')

    await win.getByRole('button', { name: 'Save' }).click()
    await expect(win.getByText('Saved to library').first()).toBeVisible()

    const count = await win.evaluate(async () => {
      const r = await window.api.listLibrary()
      const shapes = r.ok ? (r.value[0].annotations?.shapes ?? []) : []
      return shapes.filter((s) => s.kind === 'step').length
    })
    expect(count).toBe(2)
  } finally {
    await win.emulateMedia({ reducedMotion: null })
  }
})

/* ------------------------------------------------------------------ *
 * UX-VIS.3 — the export must not follow the app's theme
 * ------------------------------------------------------------------ */

test('UX-VIS.3 — exported pixels are identical in dark and light themes', async () => {
  /*
   * render.ts draws annotation pixels with fixed literals rather than theme
   * tokens, precisely so a document does not export differently depending on
   * the user's app theme. That is a rule a future edit could quietly break by
   * "tokenising" a colour, and this is what would catch it.
   */
  await clearLibrary()
  await openEditorOnAFreshCapture()

  // One of each colour-bearing kind, including the redaction marker.
  await win.locator('nav[aria-label="Annotation tools"]').press('x')
  await drag({ x: 60, y: 60 }, { x: 260, y: 160 })
  await win.locator('nav[aria-label="Annotation tools"]').press('n')
  const badge = await toPage(320, 110)
  await win.mouse.click(badge.x, badge.y)

  const exportUnder = async (theme: 'dark' | 'light'): Promise<string> => {
    await win.evaluate(async (t) => {
      await window.api.updateSettings({ theme: t as 'dark' | 'light' })
    }, theme)
    // Wait for the attribute to actually land before re-rendering.
    await expect
      .poll(async () => win.evaluate(() => document.documentElement.dataset.theme))
      .toBe(theme)
    const target = join(userDataDir, `theme-${theme}.png`)
    await app.evaluate(async ({ dialog }, p) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: p,
        filePaths: [p]
      })) as unknown as typeof dialog.showSaveDialog
    }, target)
    await win.getByRole('button', { name: 'Export' }).click()
    // Wait on the file, not on the toast: a toast from the previous export is
    // still on screen, so asserting its visibility would pass instantly and
    // read a file that has not been written yet.
    await expect
      .poll(async () => fs.access(target).then(() => true, () => false), { timeout: 20_000 })
      .toBe(true)
    const bytes = await fs.readFile(target)
    return createHash('sha256').update(bytes).digest('hex')
  }

  const dark = await exportUnder('dark')
  const light = await exportUnder('light')
  expect(dark).toBe(light)
})
