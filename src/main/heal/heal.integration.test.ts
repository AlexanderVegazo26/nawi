import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findBrowserExecutable } from '../cdp/launcher'
import { TEST_BROWSER_ARGS } from '../cdp/test-browser-args'
import { resolveFlowFile, runFlowFile, type FlowRunReport, type RunFlowDeps } from '../flow-run'
import { readRunRecord, type RunRecord } from '../run-record'
import { applyHeal } from './apply'
import { healProposals, readRunFlow } from './proposals'

/**
 * Roadmap F6 done-when, first half: a real app whose Save button was renamed
 * heals to the right proposal. The flow was recorded against "Save"; the app
 * now says "Store". The run passes through the CSS fallback, the proposal moves
 * that locator to the front and drops the role + name one, `git apply` puts
 * the patch on the real file, and a replay of the healed flow passes without
 * any fallback (and proposes nothing more).
 *
 * Second half (apply_heal): the same proposal applied by Nawi after a real
 * replay of the proposed flow, and a wrong match rejected by that replay: a
 * restyle moved the `.primary` class to a Discard button, so the CSS fallback
 * clicks the wrong button, the later assert fails, and the file stays as it is.
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

/** 2.0 also restyled the form: `.primary` is now on Discard, which empties the note. */
const APP_V2_RESTYLED = `<!doctype html>
<meta charset="utf-8">
<title>Notes</title>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Saved ' + document.getElementById('body').value">
  <textarea id="body" data-testid="note-body"></textarea>
  <button class="primary" type="button" onclick="document.getElementById('body').value = ''">Discard</button>
  <button type="submit">Store</button>
</form>
<p id="out" role="status"></p>
`

const why = (r: FlowRunReport): string => JSON.stringify(r, null, 1)

/** 1.x, when the flow and its reference crop of the Save button were recorded. */
const APP_V1 = `<!doctype html>
<meta charset="utf-8">
<title>Notes</title>
<style>button { font: 16px sans-serif; width: 120px; height: 40px; }</style>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Saved ' + document.getElementById('body').value">
  <textarea id="body" data-testid="note-body"></textarea>
  <button id="save" data-testid="save-note" type="submit">Save</button>
</form>
<p id="out" role="status"></p>
`

/** 3.0: the button looks the same, but its test id and id were renamed: only the crop still finds it. */
const APP_V3 = APP_V1.replace('id="save" data-testid="save-note"', 'id="store" data-testid="store-note"')

const anchorFlow = (url: string): string => `version: 1
name: Save a note
target: { kind: browser, url: "${url}" }
steps:
  - id: type
    action: fill
    target:
      selectors:
        - { testid: note-body }
    value: hello
  - id: save
    intent: Save the note
    action: click
    target:
      selectors:
        - { testid: save-note }
        - { css: "#save" }
      image: notes.crops/000002.png
  - id: done
    action: assert
    target: { selectors: [{ role: status }] }
    expect: { text: Saved hello }
`

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

  /** apply_heal's wiring as tools.ts does it, against the test root and runs folder. */
  const applyDeps = (record: RunRecord, runs: string): Parameters<typeof applyHeal>[2] => ({
    readFlow: () => readRunFlow(record, [root]),
    realPath: () => resolveFlowFile(record.flow.file, [root]),
    replay: (source) => runFlowFile({ file: record.flow.file, headless: true, screenshots: 'off' }, { ...deps(runs), source, healOf: record.run_id })
  })

  it('apply_heal writes the proposal after its replay passes, and the healed file replays with no fallback', async () => {
    writeFileSync(join(root, 'app.html'), APP_V2)
    const file = join(root, 'apply.nawi.yaml')
    const original = flowText(pathToFileURL(join(root, 'app.html')).href)
    writeFileSync(file, original)
    const runs = join(root, 'runs-apply')

    const first = await runFlowFile({ file, headless: true, screenshots: 'off' }, deps(runs))
    expect(first.status, why(first)).toBe('passed')
    const record = (await readRunRecord(runs, first.run_id!))!
    const result = await applyHeal(record, undefined, applyDeps(record, runs))
    expect(result, JSON.stringify(result, null, 1)).toMatchObject({ applied: true, step_ids: ['save'], replay: { status: 'passed' } })
    expect(result.replay?.steps.find((s) => s.id === 'save')?.matched).toEqual({ index: 0, layer: 'css', fallback: false })
    expect(readFileSync(file, 'utf8'), 'only the dropped locator line is gone').toBe(original.replace('        - { role: button, name: Save }\n', ''))
    expect(readFileSync(file, 'utf8')).toContain('# Recorded against 1.x, when the button said Save.')

    const again = await runFlowFile({ file, headless: true, screenshots: 'off' }, deps(runs))
    expect(again.status, why(again)).toBe('passed')
    expect((await readRunRecord(runs, again.run_id!))?.fallback_step_ids, 'no drift left').toBeUndefined()
  }, 60_000)

  it('heals a step only its reference crop found to that element\'s own locators, and apply_heal writes it once the replay matches the first one', async () => {
    // Record the crop the way a recording stores it: the button's box, 1 px per CSS px.
    writeFileSync(join(root, 'v1.html'), APP_V1)
    const shotFlow = join(root, 'shot.nawi.yaml')
    writeFileSync(
      shotFlow,
      `version: 1\nname: Crop\ntarget: { kind: browser, url: "${pathToFileURL(join(root, 'v1.html')).href}" }\nsteps:\n  - { id: crop, action: screenshot, target: { selectors: [{ id: save }] } }\n`
    )
    const shotRuns = join(root, 'runs-shot')
    const shot = await runFlowFile({ file: shotFlow, headless: true, screenshots: 'off' }, deps(shotRuns))
    expect(shot.status, why(shot)).toBe('passed')
    const shotRecord = (await readRunRecord(shotRuns, shot.run_id!))!
    mkdirSync(join(root, 'notes.crops'), { recursive: true })
    writeFileSync(join(root, 'notes.crops', '000002.png'), readFileSync(join(shotRuns, shot.run_id!, shotRecord.steps[0].screenshot!)))

    writeFileSync(join(root, 'v3.html'), APP_V3)
    const file = join(root, 'anchor.nawi.yaml')
    const original = anchorFlow(pathToFileURL(join(root, 'v3.html')).href)
    writeFileSync(file, original)
    const runs = join(root, 'runs-anchor')

    const first = await runFlowFile({ file, headless: true, screenshots: 'off' }, deps(runs))
    expect(first.status, why(first)).toBe('passed')
    const record = (await readRunRecord(runs, first.run_id!))!
    const save = record.steps.find((s) => s.id === 'save')!
    expect(save.matched, 'only the crop found the renamed button').toMatchObject({ index: 2, layer: 'visual', fallback: true })
    expect(save.matched?.candidates, 'the run recorded the found element\'s own locators, best first').toEqual([
      { testid: 'store-note' },
      { id: 'store' },
      { role: 'button', name: 'Save' }
    ])

    const report = healProposals(record, await readRunFlow(record, [root]))
    expect(report.unhealed, JSON.stringify(report, null, 1)).toEqual([])
    expect(report.proposals.map((p) => [p.step_id, p.layer, p.selectors_after])).toEqual([
      ['save', 'visual', [{ testid: 'store-note' }, { id: 'store' }, { role: 'button', name: 'Save' }]]
    ])
    expect(report.proposals[0].dropped.map((d) => d.selector)).toEqual([{ testid: 'save-note' }, { css: '#save' }])

    const result = await applyHeal(record, undefined, applyDeps(record, runs))
    expect(result, JSON.stringify(result, null, 1)).toMatchObject({ applied: true, step_ids: ['save'], replay: { status: 'passed' } })
    expect(result.replay?.steps.find((s) => s.id === 'save')?.matched).toEqual({ index: 0, layer: 'testid', fallback: false })
    expect(readFileSync(file, 'utf8')).toBe(
      original.replace(
        '        - { testid: save-note }\n        - { css: "#save" }\n',
        '        - { testid: store-note }\n        - { id: store }\n        - { role: button, name: Save }\n'
      )
    )

    const again = await runFlowFile({ file, headless: true, screenshots: 'off' }, deps(runs))
    expect(again.status, why(again)).toBe('passed')
    expect((await readRunRecord(runs, again.run_id!))?.fallback_step_ids, 'no drift left').toBeUndefined()
  }, 60_000)

  it('apply_heal rejects a wrong match: the moved locator clicks Discard, the replay fails, nothing is written', async () => {
    writeFileSync(join(root, 'restyled.html'), APP_V2_RESTYLED)
    const file = join(root, 'wrong.nawi.yaml')
    const original = flowText(pathToFileURL(join(root, 'restyled.html')).href).replace('{ css: "#save" }', '{ css: ".primary" }')
    writeFileSync(file, original)
    const runs = join(root, 'runs-wrong')

    const first = await runFlowFile({ file, headless: true, screenshots: 'off' }, deps(runs))
    expect(first.status, why(first)).toBe('failed')
    const record = (await readRunRecord(runs, first.run_id!))!
    const report = healProposals(record, await readRunFlow(record, [root]))
    expect(report.proposals.map((p) => p.selectors_after), 'F6a still proposes the fallback that matched').toEqual([[{ css: '.primary' }]])

    const result = await applyHeal(record, undefined, applyDeps(record, runs))
    expect(result, JSON.stringify(result, null, 1)).toMatchObject({ applied: false, replay: { status: 'failed', failed_step_id: 'done' } })
    expect(result.reason).toMatch(/failed at step done when replayed/)
    expect(readFileSync(file, 'utf8'), 'the wrong heal was not written').toBe(original)

    // The rejected replay's record says what it was, instead of looking like a run of an edited file.
    const replayRecord = (await readRunRecord(runs, result.replay!.run_id!))!
    expect(replayRecord.heal_of, 'the replay names the run it healed').toBe(record.run_id)
    const fromReplay = healProposals(replayRecord, await readRunFlow(replayRecord, [root]))
    expect(fromReplay.flow_status).toBe('changed')
    expect(fromReplay.note, 'points back at the run to take proposals from').toContain(`proposals of run ${record.run_id}`)
  }, 60_000)
})
