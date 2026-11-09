import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { E2E_TOOL_NAMES } from '../../../e2e/tool-names'
import { TOOL_NAMES } from './tools'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '9.9.9', getLocale: () => 'en-US' },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }) },
  desktopCapturer: {}
}))

/**
 * e2e/mcp.spec.ts asserts that the built app publishes exactly E2E_TOOL_NAMES.
 * That suite needs a display and runs only on the weekly CI, so a tool added to
 * TOOLS without updating the list stayed invisible for a week (2026-11-09:
 * get_heal_proposals, apply_heal and mobile_record turned the weekly E2E red on
 * both OSes). This keeps the two lists in step in every local run.
 */
describe('E2E tool list', () => {
  it('names exactly the tools TOOLS publishes', () => {
    const published = new Set(TOOL_NAMES)
    const listed = new Set(E2E_TOOL_NAMES)
    const missing = TOOL_NAMES.filter((n) => !listed.has(n))
    const extra = E2E_TOOL_NAMES.filter((n) => !published.has(n))
    expect(
      { missing, extra },
      `e2e/tool-names.ts is out of step with TOOLS in src/main/mcp/tools.ts: add the missing names to E2E_TOOL_NAMES and drop the extra ones`
    ).toEqual({ missing: [], extra: [] })
  })

  it('has no duplicates, so the kill-switch test calls each tool once', () => {
    const dupes = E2E_TOOL_NAMES.filter((n, i) => E2E_TOOL_NAMES.indexOf(n) !== i)
    expect(dupes, 'duplicate names in e2e/tool-names.ts').toEqual([])
  })
})
