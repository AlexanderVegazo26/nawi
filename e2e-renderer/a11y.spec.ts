/**
 * WCAG 2.2 AA (axe-core) on every main-window screen, light and dark.
 *
 * A ratchet: KNOWN lists the violations that existed when the check landed,
 * keyed by `<screen>/<theme> <rule> <target>`. A violation not in the table
 * fails (a regression); a table entry that no longer occurs fails too, so the
 * table only ever shrinks — delete the line when you fix one.
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { openScreen, SCREENS, THEMES } from './views'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

// label-content-name-mismatch (WCAG 2.5.3): the card's preview button is
// named by aria-label = the item name, but its visible text also holds the
// kind badge and the size/date line. Fixing it changes what screen readers
// announce for every card, so it is tracked here instead of in this commit.
const CARD_NAME = [
  'label-content-name-mismatch button[aria-label="Checkout page"]',
  'label-content-name-mismatch button[aria-label="Sign-up flow"]'
]

const KNOWN: Record<string, string[]> = {
  'library-filled/light': CARD_NAME,
  'library-filled/dark': CARD_NAME
}

for (const screen of SCREENS) {
  for (const theme of THEMES) {
    const key = `${screen.id}/${theme}`
    test(`${key} has no new WCAG 2.2 AA violations`, async ({ page }) => {
      await page.setViewportSize({ width: 1360, height: 860 })
      await openScreen(page, screen, theme)
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      const found = violations
        .flatMap((v) => v.nodes.map((n) => `${v.id} ${n.target.join(' > ')}`))
        .sort()
      const details = violations
        .flatMap((v) =>
          v.nodes.map((n) => `${v.id} ${n.target.join(' > ')}\n    ${v.help}: ${n.failureSummary?.replace(/\n/g, ' ')}`)
        )
        .join('\n')
      const known = [...(KNOWN[key] ?? [])].sort()
      const added = found.filter((f) => !known.includes(f))
      const fixed = known.filter((k) => !found.includes(k))
      expect(
        added,
        `new axe violations on ${key} (fix them; KNOWN may only shrink):\n${details}`
      ).toEqual([])
      expect(fixed, `${key}: these KNOWN entries no longer occur, delete them from a11y.spec.ts`).toEqual([])
    })
  }
}
