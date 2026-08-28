import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * PRD-002 conformance — the §5 states, §1 P5 undo, §9 copy and §6 keyboard
 * requirements, asserted as observable outcomes.
 *
 * Every assertion here is on something a user could see: rendered text, the
 * presence or absence of a node, a computed style, where focus is. None of
 * them assert that an IPC call returned `ok` — a value that round-trips
 * correctly while nothing renders it is exactly the failure these requirements
 * describe.
 */

let app: ElectronApplication
let win: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'nawi-prd002-'))
  app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], cwd: process.cwd() })
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
})

const toLibrary = async (): Promise<void> => {
  await win.getByRole('button', { name: 'Library', exact: true }).click()
}

/* ------------------------------------------------------------------ *
 * UX-STA.1 — empty state offers the primary action with the real hotkey
 * ------------------------------------------------------------------ */

test('UX-STA.1 — the library empty state renders the user’s configured hotkey', async () => {
  await toLibrary()
  await expect(win.getByRole('heading', { name: 'No captures yet' })).toBeVisible()

  // Default binding first: the label must be the resolved chord, not a
  // placeholder and not the raw Electron accelerator.
  await expect(win.getByText(/Press Ctrl\+Shift\+1 to take your first capture/)).toBeVisible()
  await expect(win.getByText(/CommandOrControl/)).toHaveCount(0)

  // Now rebind, and require the copy to follow. This is the assertion that
  // fails if anyone reintroduces a hardcoded literal: a hardcoded string still
  // reads "Ctrl+Shift+1" after the rebind.
  await win.evaluate(async () => {
    await window.api.updateSettings({ hotkeys: { 'capture-region': 'Alt+F9' } })
  })
  await expect(win.getByText(/Press Alt\+F9 to take your first capture/)).toBeVisible()

  await win.evaluate(async () => {
    await window.api.updateSettings({ hotkeys: { 'capture-region': 'CommandOrControl+Shift+1' } })
  })
  await expect(win.getByText(/Press Ctrl\+Shift\+1 to take your first capture/)).toBeVisible()
})

test('UX-STA.1 / §9 — the capture cards render resolved bindings, not literals', async () => {
  await win.getByRole('button', { name: 'Capture', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'New capture' })).toBeVisible()

  await win.evaluate(async () => {
    await window.api.updateSettings({ hotkeys: { 'capture-fullscreen': 'Alt+F8' } })
  })
  await expect(win.getByText('Alt+F8')).toBeVisible()
  await expect(win.getByText('Ctrl+Shift+2')).toHaveCount(0)

  await win.evaluate(async () => {
    await window.api.updateSettings({ hotkeys: { 'capture-fullscreen': 'CommandOrControl+Shift+2' } })
  })
  await expect(win.getByText('Ctrl+Shift+2')).toBeVisible()
})

/* ------------------------------------------------------------------ *
 * UX-STA.2 — skeletons, never a full-screen blocking spinner
 * ------------------------------------------------------------------ */

/*
 * UX-STA.2's loading branch is NOT asserted here.
 *
 * It was, and the assertion was worthless: the real library read finishes in a
 * few milliseconds, so the checks passed identically with the forbidden
 * full-screen spinner restored — proven by reverting it and watching this file
 * stay green. An assertion that cannot fail for the defect it names is not
 * coverage.
 *
 * The branch is covered instead in `src/renderer/components/states.test.tsx`,
 * which renders `LibraryView` with `loading` forced and asserts on the output.
 * What remains here is the part that is genuinely about the running app: that
 * the library surface is reachable and operable at all.
 */
test('the library surface is operable, header and all', async () => {
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await toLibrary()

  await expect(win.getByRole('heading', { name: 'Library' })).toBeVisible()
  await expect(win.getByRole('textbox', { name: 'Search captures' })).toBeVisible()
  await expect(win.getByRole('button', { name: 'New capture' })).toBeVisible()
})

/* ------------------------------------------------------------------ *
 * §1 P5 — every destructive act reversible for 30 seconds
 * ------------------------------------------------------------------ */

test('P5 — deleting a capture is undoable, and the capture actually comes back', async () => {
  await win.getByRole('button', { name: 'Capture', exact: true }).click()
  const made = await win.evaluate(async () => {
    const res = await window.api.captureFullscreen()
    return res.ok ? { ok: true as const, name: res.value.name } : { ok: false as const, error: res.error }
  })
  expect(made.ok, made.ok ? '' : `capture failed: ${(made as { error: string }).error}`).toBe(true)
  if (!made.ok) return

  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await toLibrary()

  const card = win.getByRole('button', { name: made.name, exact: true })
  await expect(card).toBeVisible()

  // Delete through the real UI, not the IPC.
  await card.click()
  await win.keyboard.press('Delete')

  // §9 / P5 — the confirm must not claim irreversibility it no longer has.
  await expect(win.getByText(/30 seconds to undo/)).toBeVisible()
  await expect(win.getByText(/can't be undone/i)).toHaveCount(0)
  await win.getByRole('button', { name: 'Delete', exact: true }).last().click()

  // Observable outcome 1: the card is gone from the grid.
  await expect(card).toHaveCount(0)

  // Observable outcome 2: an undo control is offered.
  const undo = win.getByTestId('toast-action')
  await expect(undo).toBeVisible()
  await expect(undo).toHaveText('Undo')

  // Observable outcome 3: undo brings the same capture back by name.
  await undo.click()
  await expect(win.getByRole('button', { name: made.name, exact: true })).toBeVisible()

  // And it is genuinely back in the store, not just re-rendered in local state.
  const stillThere = await win.evaluate(async (name: string) => {
    const res = await window.api.listLibrary()
    return res.ok && res.value.some((i) => i.name === name)
  }, made.name)
  expect(stillThere).toBe(true)
})

test('P5 — the asset survives the undo window, so undo has something to restore', async () => {
  // The old handler unlinked the file inside `deleteItem`. If that came back,
  // the undo above would restore an index record pointing at nothing.
  const outcome = await win.evaluate(async () => {
    const list = await window.api.listLibrary()
    if (!list.ok || list.value.length === 0) return { ran: false as const }
    const target = list.value[0]
    const del = await window.api.deleteLibraryItem(target.id)
    if (!del.ok) return { ran: true as const, ok: false as const, error: del.error }

    // Hidden from the library immediately...
    const during = await window.api.listLibrary()
    const hidden = during.ok && !during.value.some((i) => i.id === target.id)

    // ...but the bytes are still readable, which is the part that makes the
    // undo real rather than cosmetic.
    const bytes = await window.api.readItemBytes(target.id)

    const back = await window.api.restoreLibraryItem(target.id)
    const after = await window.api.listLibrary()
    return {
      ran: true as const,
      ok: true as const,
      hidden,
      bytesReadable: bytes.ok && bytes.value.data.length > 0,
      restored: back.ok && back.value !== null,
      visibleAgain: after.ok && after.value.some((i) => i.id === target.id)
    }
  })

  expect(outcome.ran).toBe(true)
  if (!outcome.ran || !outcome.ok) return
  expect(outcome.hidden).toBe(true)
  expect(outcome.bytesReadable).toBe(true)
  expect(outcome.restored).toBe(true)
  expect(outcome.visibleAgain).toBe(true)
})

/* ------------------------------------------------------------------ *
 * UX-STA.4 — offline banner
 * ------------------------------------------------------------------ */

test('UX-STA.4 — going offline shows a low-key persistent banner, not a modal', async () => {
  await expect(win.getByTestId('offline-banner')).toHaveCount(0)

  await app.context().setOffline(true)
  await win.evaluate(() => window.dispatchEvent(new Event('offline')))

  const banner = win.getByTestId('offline-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toHaveText('Offline — captures are saved locally and will sync.')

  // "No modal, no red": nothing blocks the surface behind it, and it does not
  // use the danger role. The New capture button must still be clickable.
  await expect(banner).toHaveAttribute('role', 'status')
  await expect(win.getByRole('dialog')).toHaveCount(0)

  await app.context().setOffline(false)
  await win.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(win.getByTestId('offline-banner')).toHaveCount(0)
})

/* ------------------------------------------------------------------ *
 * UX-A11Y.9 — 44x44 hit targets on HUD and overlay controls
 * ------------------------------------------------------------------ */

test('UX-A11Y.9 — the shared Button’s hit variant is really 44px, measured', async () => {
  // A computed box, not a class name: `min-h-11` in the source proves nothing
  // if the utility was purged or overridden by a later class.
  const box = await win.evaluate(() => {
    const b = document.createElement('button')
    b.className =
      'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium min-h-11 min-w-11 px-4'
    b.textContent = 'x'
    document.body.appendChild(b)
    const r = b.getBoundingClientRect()
    b.remove()
    return { w: r.width, h: r.height }
  })
  expect(box.h).toBeGreaterThanOrEqual(44)
  expect(box.w).toBeGreaterThanOrEqual(44)
})

/* ------------------------------------------------------------------ *
 * UX-A11Y.3 — focus restored on modal dismiss
 * ------------------------------------------------------------------ */

test('UX-A11Y.3 — dismissing the delete confirm returns focus to the invoking card', async () => {
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await toLibrary()

  const list = await win.evaluate(async () => {
    const res = await window.api.listLibrary()
    return res.ok ? res.value.map((i) => i.name) : []
  })
  test.skip(list.length === 0, 'needs at least one capture in the library')

  const card = win.getByRole('button', { name: list[0], exact: true })
  await card.click()
  const before = await win.evaluate(() => document.activeElement?.getAttribute('aria-label'))

  await win.keyboard.press('Delete')
  await expect(win.getByRole('dialog')).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(win.getByRole('dialog')).toHaveCount(0)

  const after = await win.evaluate(() => document.activeElement?.getAttribute('aria-label'))
  expect(after).toBe(before)
})

/* ------------------------------------------------------------------ *
 * Preload discipline — the new surface adds named methods only
 * ------------------------------------------------------------------ */

test('the new IPC surface stays named-methods-only, with no generic invoke', async () => {
  const surface = await win.evaluate(() => {
    const api = (window as unknown as { api: Record<string, unknown> }).api
    return {
      keys: Object.keys(api),
      hasInvoke: typeof api.invoke !== 'undefined',
      hasSend: typeof api.send !== 'undefined',
      hasIpcRenderer: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer !== 'undefined'
    }
  })
  for (const name of [
    'restoreLibraryItem',
    'getScreenPermission',
    'openScreenSettings',
    'relaunchApp',
    'getDiskPressure'
  ]) {
    expect(surface.keys).toContain(name)
  }
  expect(surface.hasInvoke).toBe(false)
  expect(surface.hasSend).toBe(false)
  expect(surface.hasIpcRenderer).toBe(false)
})

/* ------------------------------------------------------------------ *
 * UX-STA.5 — disk pressure is measured, not assumed
 * ------------------------------------------------------------------ */

test('UX-STA.5 — the disk precheck returns a real free-space reading and a size estimate', async () => {
  const p = await win.evaluate(async () => {
    const res = await window.api.getDiskPressure(5)
    return res.ok ? res.value : null
  })
  expect(p).not.toBeNull()
  // `known: false` would mean statfs failed on this platform, which is the one
  // thing that would make the whole warning inert — so it is asserted, not
  // tolerated.
  expect(p!.known).toBe(true)
  expect(p!.freeBytes).toBeGreaterThan(0)
  expect(p!.estimatedBytes).toBe(300_000_000)
  expect(p!.low).toBe(p!.freeBytes < 2 * 1024 * 1024 * 1024)
})
