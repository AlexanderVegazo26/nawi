/**
 * The main-window screens the renderer suite visits, and how to reach each one
 * in a loaded, settled state.
 */
import { expect, type Page } from '@playwright/test'
import { sampleItems, stubApi, type Theme } from './api-stub'

export interface Screen {
  /** Stable id used in test names and in the a11y KNOWN table. */
  id: string
  rail: 'Capture' | 'Library' | 'Mobile'
  withItems: boolean
  /** A heading that only shows once the screen has its data. */
  ready: { level: 1 | 2 | 3; name: string }
}

export const SCREENS: Screen[] = [
  { id: 'capture', rail: 'Capture', withItems: false, ready: { level: 1, name: 'New capture' } },
  { id: 'library-empty', rail: 'Library', withItems: false, ready: { level: 1, name: 'Library' } },
  { id: 'library-filled', rail: 'Library', withItems: true, ready: { level: 1, name: 'Library' } },
  { id: 'mobile', rail: 'Mobile', withItems: false, ready: { level: 2, name: 'Open an Android app' } }
]

export const THEMES: Theme[] = ['light', 'dark']

/** Loads the app with the stub bridge, opens `screen` and waits until it is settled. */
export async function openScreen(page: Page, screen: Screen, theme: Theme): Promise<void> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await stubApi(page, { theme, items: screen.withItems ? sampleItems() : [] })
  await page.goto('/index.html')
  await expect(page.locator('html'), `theme ${theme} should be stamped on <html>`).toHaveAttribute(
    'data-theme',
    theme
  )
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('button', { name: screen.rail, exact: true }).click()
  await expect(
    page.getByRole('heading', { level: screen.ready.level, name: screen.ready.name, exact: true }),
    `screen ${screen.id} should show its "${screen.ready.name}" heading`
  ).toBeVisible()
  if (screen.withItems) {
    await expect(
      page.getByRole('listitem').filter({ hasText: sampleItems()[0].name }).first(),
      `screen ${screen.id} should list the fixture items`
    ).toBeVisible()
  }
  expect(errors, `screen ${screen.id} (${theme}) threw in the page`).toEqual([])
}
