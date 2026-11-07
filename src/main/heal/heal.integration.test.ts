import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findBrowserExecutable } from '../cdp/launcher'
import { TEST_BROWSER_ARGS } from '../cdp/test-browser-args'
import { runFlowFile, type FlowRunReport, type RunFlowDeps } from '../flow-run'
import { readRunRecord } from '../run-record'
import { healProposals, readRunFlow } from './proposals'

/**
 * Roadmap F6 done-when, first half: a real app whose Save button was renamed
 * heals to the right proposal. The flow was recorded against "Save"; the app
 * now says "Store". The run passes through the CSS fallback, the proposal moves
 * that locator to the front and drops the role + name one, `git apply` puts
 * the patch on the real file, and a replay of the healed flow passes without
 * any fallback (and proposes nothing more).
 */

const executable = findBrowserExecutable(['playwright-chromium'])
const describeWithBrowser = executable ? describe : describe.skip
if (!executable) console.warn('[heal.integration] no Playwright Chromium found; healing tests SKIPPED, not passed')

const APP_V2 = `<!doctype html>
<meta charset="utf-8">
<title>Notes</title>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Saved ' + document.getElementById('body').value">
  <textarea id="body" data-testid="note-body"></textarea>
  <button id="save" class="primary" type="submit">Store</button>
</form>
<p id="out" role="status"></p>
`

const flowText = (url: string): string => `version: 1
name: Save a note
target: { kind: browser, url: "${url}" }
steps:
  - id: type
    action: fill
    target:
      selectors:
        - { testid: note-body }
    value: hello
  # Recorded against 1.x, when the button said Save.
  - id: save
    intent: Save the note
    action: click
    target:
      selectors:
        - { role: button, name: Save }
        - { css: "#save" }
  - id: done
    action: assert
    target: { selectors: [{ role: status }] }
    expect: { text: Saved hello }
`

const why = (r: FlowRunReport): string => JSON.stringify(r, null, 1)

describeWithBrowser('healing proposals from a real run', () => {
  let root: string
  const deps = (runs: string): RunFlowDeps => ({
    roots: [root],
    launch: { prefer: ['playwright-chromium'], extraArgs: [...TEST_BROWSER_ARGS, '--window-size=1024,768'] },
    record: { dir: runs }
  })

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'nawi-heal-'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('heals a renamed button to the locator that still matches, and the healed flow replays with no fallback', async () => {
    writeFileSync(join(root, 'app.html'), APP_V2)
    const file = join(root, 'notes.nawi.yaml')
    const original = flowText(pathToFileURL(join(root, 'app.html')).href)
    writeFileSync(file, original)
    const runs = join(root, 'runs')

    const first = await runFlowFile({ file, headless: true, screenshots: 'off' }, deps(runs))
    expect(first.status, why(first)).toBe('passed')
    const record = await readRunRecord(runs, first.run_id!)
    expect(record?.fallback_step_ids, 'the renamed button is reported as drift').toEqual(['save'])

    const report = healProposals(record!, await readRunFlow(record!, [root]))
    expect(report.flow_status).toBe('current')
    expect(report.unhealed).toEqual([])
    expect(report.proposals.map((p) => [p.step_id, p.layer, p.selectors_after]), JSON.stringify(report, null, 1)).toEqual([
      ['save', 'css', [{ css: '#save' }]]
    ])
    expect(report.proposals[0].dropped).toEqual([{ selector: { role: 'button', name: 'Save' }, reason: 'no match' }])
    expect(report.diff).toBe(
      [
        '--- a/notes.nawi.yaml',
        '+++ b/notes.nawi.yaml',
        '@@ -14,7 +14,6 @@',
        '     action: click',
        '     target:',
        '       selectors:',
        '-        - { role: button, name: Save }',
        '         - { css: "#save" }',
        '   - id: done',
        '     action: assert',
        ''
      ].join('\n')
    )
    expect(readFileSync(file, 'utf8'), 'proposals never write the flow').toBe(original)

    writeFileSync(join(root, 'heal.diff'), report.diff)
    execFileSync('git', ['apply', 'heal.diff'], { cwd: root, stdio: 'pipe' })
    expect(readFileSync(file, 'utf8')).toContain('# Recorded against 1.x, when the button said Save.')

    const second = await runFlowFile({ file, headless: true, screenshots: 'off' }, deps(runs))
    expect(second.status, why(second)).toBe('passed')
    const healed = await readRunRecord(runs, second.run_id!)
    expect(healed?.fallback_step_ids, 'no drift left').toBeUndefined()
    expect(healed?.steps.find((s) => s.id === 'save')?.matched).toMatchObject({ index: 0, layer: 'css', fallback: false })
    expect(healProposals(healed!, await readRunFlow(healed!, [root]))).toMatchObject({ flow_status: 'current', proposals: [], unhealed: [], diff: '' })
  }, 60_000)
})
