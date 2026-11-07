import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFlow } from '../../shared/flow/yaml'
import type { RecordedStep, RunRecord } from '../run-record'
import { healProposals, readRunFlow } from './proposals'
import { isHealReport, renderHealReport } from '../../cli/heal'

const FLOW = `version: 1
name: Save a note
target: { kind: browser, url: "https://app.example/notes" }
vars: { label: Save }
steps:
  - id: type
    action: fill
    target:
      selectors:
        - { testid: note-body }
    value: hello
  # The save button was renamed in 2.0.
  - id: save
    intent: Save the note
    action: click
    target:
      selectors:
        - { testid: save-note } # gone since 2.0
        - { role: button, name: Save }
        - { css: "form > button.primary" }
        - { css: "#save" }
  - id: done
    action: assert
    target: { selectors: [{ role: status }] }
    expect: { text: Saved }
`

/** git apply of `patch` (made against notes.nawi.yaml) to a file holding `before`. */
function applyPatch(before: string, patch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nawi-heal-apply-'))
  try {
    writeFileSync(join(dir, 'notes.nawi.yaml'), before)
    writeFileSync(join(dir, 'p.diff'), patch)
    execFileSync('git', ['apply', 'p.diff'], { cwd: dir, stdio: 'pipe' })
    return readFileSync(join(dir, 'notes.nawi.yaml'), 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function record(steps: RecordedStep[], flowText = FLOW): RunRecord {
  return {
    version: 1,
    run_id: '20261107T130000000Z-abc123',
    flow: { name: 'Save a note', file: '/home/u/flows/notes.nawi.yaml', sha256: sha(flowText) },
    status: steps.some((s) => s.status === 'failed') ? 'failed' : 'passed',
    started_at: '2026-11-07T13:00:00.000Z',
    duration_ms: 900,
    totals: { passed: 0, failed: 0, skipped: 0, not_run: 0 },
    environment: { os: { platform: 'linux', release: '6', arch: 'x64' } },
    steps
  }
}

const typeStep: RecordedStep = { id: 'type', action: 'fill', status: 'passed', matched: { index: 0, selector: { testid: 'note-body' }, layer: 'testid', fallback: false } }
const doneStep: RecordedStep = { id: 'done', action: 'assert', status: 'passed', matched: { index: 0, selector: { role: 'status' }, layer: 'role', fallback: false } }
/** `save` matched by its 4th locator: the test id was gone, role+name found nothing, the first CSS matched 2 buttons. */
const saveDrifted: RecordedStep = {
  id: 'save',
  action: 'click',
  status: 'passed',
  intent: 'Save the note',
  url: 'https://app.example/notes/1',
  shots: { before: 'steps/001-type.after.jpg', after: 'steps/002-save.after.jpg' },
  matched: { index: 3, selector: { css: '#save' }, layer: 'css', fallback: true },
  misses: [
    { index: 0, selector: { testid: 'save-note' }, found: 0 },
    { index: 1, selector: { role: 'button', name: 'Save' }, found: 0 },
    { index: 2, selector: { css: 'form > button.primary' }, found: 2 }
  ]
}

describe('healProposals', () => {
  it('moves the locator that matched to the front, drops the ones that found nothing, keeps an ambiguous one', () => {
    const report = healProposals(record([typeStep, saveDrifted, doneStep]), FLOW)
    expect(report.flow_status).toBe('current')
    expect(report.proposals, JSON.stringify(report, null, 1)).toHaveLength(1)
    const [p] = report.proposals
    expect(p).toMatchObject({ step_id: 'save', action: 'click', intent: 'Save the note', layer: 'css' })
    expect(p.selectors_after, 'matched first, the ambiguous css kept after it, the two that found nothing gone').toEqual([{ css: '#save' }, { css: 'form > button.primary' }])
    expect(p.dropped).toEqual([
      { selector: { testid: 'save-note' }, reason: 'no match' },
      { selector: { role: 'button', name: 'Save' }, reason: 'no match' }
    ])
    expect(p.evidence).toMatchObject({ url: 'https://app.example/notes/1', shots: { after: 'steps/002-save.after.jpg' } })
    expect(p.evidence.misses).toHaveLength(3)
    expect(report.unhealed).toEqual([])
  })

  it('patches only the drifted lines, keeps comments, and the patched file parses with the new order', () => {
    const report = healProposals(record([typeStep, saveDrifted, doneStep]), FLOW)
    const diff = report.diff
    expect(diff, 'one hunk against the flow file').toMatch(/^--- a\/notes\.nawi\.yaml\n\+\+\+ b\/notes\.nawi\.yaml\n@@ /)
    const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    expect(removed.map((l) => l.trim()), diff).toEqual([
      '-        - { testid: save-note } # gone since 2.0',
      '-        - { role: button, name: Save }',
      '-        - { css: "form > button.primary" }'
    ].map((l) => l.trim()))
    expect(added.map((l) => l.trim()), diff).toEqual(['+        - { css: "form > button.primary" }'.trim()])
    expect(report.proposals[0].diff, 'one proposal: its own diff is the combined one').toBe(diff)
    expect(diff).not.toContain('The save button was renamed')
    // Apply by hand: the new file must be a valid flow with the healed order and the comment kept.
    const healed = FLOW.replace(
      '        - { testid: save-note } # gone since 2.0\n        - { role: button, name: Save }\n        - { css: "form > button.primary" }\n        - { css: "#save" }\n',
      '        - { css: "#save" }\n        - { css: "form > button.primary" }\n'
    )
    const parsed = parseFlow(healed)
    expect(parsed.ok).toBe(true)
    expect(healed).toContain('# The save button was renamed in 2.0.')
  })

  it('gives one diff per step and one combined diff when two steps drifted', () => {
    const typeDrifted: RecordedStep = {
      ...typeStep,
      matched: { index: 0, selector: { testid: 'note-body' }, layer: 'testid', fallback: false }
    }
    const flow = FLOW.replace('        - { testid: note-body }\n', '        - { id: body-old }\n        - { testid: note-body }\n')
    const typeFallback: RecordedStep = {
      ...typeDrifted,
      matched: { index: 1, selector: { testid: 'note-body' }, layer: 'testid', fallback: true },
      misses: [{ index: 0, selector: { id: 'body-old' }, found: 0, invalid: undefined }]
    }
    const report = healProposals(record([typeFallback, saveDrifted, doneStep], flow), flow)
    expect(report.proposals.map((p) => p.step_id)).toEqual(['type', 'save'])
    expect(report.proposals[0].diff).not.toContain('save-note')
    expect(report.proposals[1].diff).not.toContain('body-old')
    expect(report.diff).toContain('-        - { id: body-old }')
    expect(report.diff).toContain('-        - { testid: save-note } # gone since 2.0')
  })

  it('reorders an inline locator list in place, keeping the rest of that line as written', () => {
    const flow = FLOW.replace('    target: { selectors: [{ role: status }] }', '    target: { selectors: [{ testid: old-status }, {role: status},  { css: "p.status, #out" }] }')
    const step: RecordedStep = {
      ...doneStep,
      matched: { index: 1, selector: { role: 'status' }, layer: 'role', fallback: true },
      misses: [{ index: 0, selector: { testid: 'old-status' }, found: 0 }]
    }
    const diff = healProposals(record([typeStep, step], flow), flow).diff
    expect(diff, diff).toContain('-    target: { selectors: [{ testid: old-status }, {role: status},  { css: "p.status, #out" }] }\n+    target: { selectors: [{role: status}, { css: "p.status, #out" }] }\n')
    expect(diff.match(/^[-+] /gm), 'only that line changes').toHaveLength(2)
  })

  it('still gives a correct patch when comment lines sit between the locators (whole file written out)', () => {
    const flow = FLOW.replace('        - { role: button, name: Save }\n', '        # kept for the old theme\n        - { role: button, name: Save }\n')
    const report = healProposals(record([typeStep, saveDrifted, doneStep], flow), flow)
    expect(report.proposals).toHaveLength(1)
    const healed = applyPatch(flow, report.diff)
    const parsed = parseFlow(healed)
    expect(parsed.ok, healed).toBe(true)
    if (!parsed.ok) return
    const save = parsed.flow.steps.find((s) => s.id === 'save')!
    expect('target' in save && save.target?.selectors).toEqual([{ css: '#save' }, { css: 'form > button.primary' }])
  })

  it('gives a patch git apply accepts on the real file', () => {
    const report = healProposals(record([typeStep, saveDrifted, doneStep]), FLOW)
    const healed = applyPatch(FLOW, report.diff)
    expect(healed).toContain('# The save button was renamed in 2.0.')
    expect(healed).toContain('        - { css: "#save" }\n        - { css: "form > button.primary" }\n  - id: done')
  })

  it('keeps a locator with a ${...} placeholder that missed (one run\'s values cannot condemn it), after the match', () => {
    const flow = FLOW.replace('        - { role: button, name: Save }\n', '        - { role: button, name: "${vars.label}" }\n')
    const [p] = healProposals(record([typeStep, saveDrifted, doneStep], flow), flow).proposals
    expect(p.selectors_after).toEqual([{ css: '#save' }, { role: 'button', name: '${vars.label}' }, { css: 'form > button.primary' }])
    expect(p.dropped.map((d) => d.selector)).toEqual([{ testid: 'save-note' }])
  })

  it('refuses a locator list shared with another step through a YAML alias instead of changing both', () => {
    const flow = FLOW.replace('      selectors:\n        - { testid: save-note }', '      selectors: &save\n        - { testid: save-note }').replace(
      '  - id: done\n',
      '  - id: again\n    action: click\n    target: { selectors: *save }\n  - id: done\n'
    )
    expect(parseFlow(flow).ok, 'the fixture is a valid flow').toBe(true)
    const report = healProposals(record([typeStep, saveDrifted, doneStep], flow), flow)
    expect(report.proposals).toEqual([])
    expect(report.unhealed).toEqual([{ step_id: 'save', status: 'passed', reason: expect.stringMatching(/shared with another step/) }])
  })

  it('keeps CRLF line endings when the moved locator was the file\'s last line', () => {
    const flow =
      'version: 1\r\nname: n\r\ntarget: { kind: browser, url: "https://a.example" }\r\nsteps:\r\n  - id: save\r\n    action: click\r\n' +
      '    target:\r\n      selectors:\r\n        - { testid: gone }\r\n        - { css: button }\r\n        - { css: "#save" }'
    const step: RecordedStep = {
      id: 'save',
      action: 'click',
      status: 'passed',
      matched: { index: 2, selector: { css: '#save' }, layer: 'css', fallback: true },
      misses: [
        { index: 0, selector: { testid: 'gone' }, found: 0 },
        { index: 1, selector: { css: 'button' }, found: 3 }
      ]
    }
    const report = healProposals(record([step], flow), flow)
    const added = report.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    expect(added, report.diff).toEqual(['+        - { css: "#save" }\r', '+        - { css: button }'])
    expect(report.diff.trimEnd().endsWith('\\ No newline at end of file'), 'the new last line still has no newline').toBe(true)
  })

  it('compares the flow\'s bytes with the run\'s hash, so text that is not valid UTF-8 does not look edited', () => {
    const bytes = Buffer.concat([Buffer.from(FLOW.replace('# The save button', '# The \u00e9 save button'), 'utf8').subarray(0, 0), Buffer.from(FLOW, 'utf8'), Buffer.from([0x23, 0x20, 0xff, 0x0a])])
    const run = { ...record([typeStep, saveDrifted, doneStep]), flow: { name: 'n', file: '/home/u/flows/notes.nawi.yaml', sha256: createHash('sha256').update(bytes).digest('hex') } }
    expect(healProposals(run, bytes).flow_status).toBe('current')
  })

  it('does not list a failed step that has no locators (a navigation that failed) as unhealed', () => {
    const nav: RecordedStep = { id: 'done', action: 'navigate', status: 'failed', error: 'net::ERR_NAME_NOT_RESOLVED' }
    expect(healProposals(record([typeStep, nav]), FLOW).unhealed).toEqual([])
  })

  it('drops a broken locator with its reason', () => {
    const step: RecordedStep = {
      ...saveDrifted,
      matched: { index: 1, selector: { role: 'button', name: 'Save' }, layer: 'role', fallback: true },
      misses: [{ index: 0, selector: { testid: 'save-note' }, found: 0, invalid: 'selector is not valid CSS' }]
    }
    const [p] = healProposals(record([typeStep, step, doneStep]), FLOW).proposals
    expect(p.dropped).toEqual([{ selector: { testid: 'save-note' }, reason: 'invalid: selector is not valid CSS' }])
    expect(p.selectors_after).toEqual([{ role: 'button', name: 'Save' }, { css: 'form > button.primary' }, { css: '#save' }])
  })

  it('proposes nothing when no step drifted, or the match was not a fallback (only an ambiguous locator before it)', () => {
    expect(healProposals(record([typeStep, doneStep]), FLOW)).toMatchObject({ flow_status: 'current', proposals: [], unhealed: [], diff: '' })
    const ambiguousOnly: RecordedStep = {
      ...saveDrifted,
      matched: { index: 3, selector: { css: '#save' }, layer: 'css', fallback: false },
      misses: [{ index: 2, selector: { css: 'form > button.primary' }, found: 2 }]
    }
    expect(healProposals(record([typeStep, ambiguousOnly, doneStep]), FLOW).proposals).toEqual([])
  })

  it('lists a step matched only by its reference crop, and a failed step nothing matched, as unhealed with the reason', () => {
    const visual: RecordedStep = {
      ...saveDrifted,
      matched: { index: 4, selector: { image: 'notes.crops/000002.png' }, layer: 'visual', fallback: true, score: 0.98 },
      misses: [0, 1, 2, 3].map((index) => ({ index, selector: { css: 'x' }, found: 0 }))
    }
    const failed: RecordedStep = { id: 'done', action: 'assert', status: 'failed', error: 'no locator matched', misses: [{ index: 0, selector: { role: 'status' }, found: 0 }] }
    const report = healProposals(record([typeStep, visual, failed]), FLOW)
    expect(report.proposals).toEqual([])
    expect(report.unhealed.map((u) => [u.step_id, u.status])).toEqual([
      ['save', 'passed'],
      ['done', 'failed']
    ])
    expect(report.unhealed[0].reason).toMatch(/reference crop/)
    expect(report.unhealed[1].reason).toMatch(/nothing to propose/)
  })

  describe('a step matched only by its reference crop, with the found element\'s locators (F6c)', () => {
    /** Every locator of `save` found nothing; the crop found the button, whose own locators the run recorded. */
    const anchored = (candidates: RecordedStep['matched'] extends infer M ? (M extends { candidates?: infer C } ? C : never) : never, misses = [0, 1, 3]): RecordedStep => ({
      ...saveDrifted,
      matched: { index: 4, selector: { image: 'notes.crops/000002.png' }, layer: 'visual', fallback: true, score: 0.98, candidates },
      misses: [
        ...misses.map((index) => ({ index, selector: [{ testid: 'save-note' }, { role: 'button', name: 'Save' }, { css: 'form > button.primary' }, { css: '#save' }][index], found: 0 })),
        { index: 2, selector: { css: 'form > button.primary' }, found: 2 }
      ].sort((x, y) => x.index - y.index)
    })

    it('puts the element\'s own locators in front, drops the ones that found nothing, keeps an ambiguous one', () => {
      const report = healProposals(record([typeStep, anchored([{ testid: 'store-note' }, { role: 'button', name: 'Store' }]), doneStep]), FLOW)
      expect(report.unhealed, JSON.stringify(report, null, 1)).toEqual([])
      expect(report.proposals).toHaveLength(1)
      const p = report.proposals[0]
      expect(p.layer, 'matched through the crop').toBe('visual')
      expect(p.added).toEqual([{ testid: 'store-note' }, { role: 'button', name: 'Store' }])
      expect(p.selectors_after).toEqual([{ testid: 'store-note' }, { role: 'button', name: 'Store' }, { css: 'form > button.primary' }])
      expect(p.dropped.map((d) => [d.selector, d.reason])).toEqual([
        [{ testid: 'save-note' }, 'no match'],
        [{ role: 'button', name: 'Save' }, 'no match'],
        [{ css: '#save' }, 'no match']
      ])
      expect(p.evidence.matched.score).toBe(0.98)
    })

    it('writes the new locators in the file\'s own style, touching only that list, and the patch applies and parses', () => {
      const report = healProposals(record([typeStep, anchored([{ testid: 'store-note' }, { role: 'button', name: 'Store: now' }]), doneStep]), FLOW)
      const lines = report.diff.split('\n')
      expect(lines.filter((l) => /^[-+] /.test(l)), report.diff).toEqual([
        '-        - { testid: save-note } # gone since 2.0',
        '-        - { role: button, name: Save }',
        '+        - { testid: store-note }',
        '+        - { role: button, name: "Store: now" }',
        '-        - { css: "#save" }'
      ])
      const healed = applyPatch(FLOW, report.diff)
      expect(healed).toContain('# The save button was renamed in 2.0.')
      const parsed = parseFlow(healed)
      expect(parsed.ok && parsed.flow.steps[1]).toMatchObject({
        id: 'save',
        target: { selectors: [{ testid: 'store-note' }, { role: 'button', name: 'Store: now' }, { css: 'form > button.primary' }] }
      })
    })

    it('adds to an inline locator list in place', () => {
      const flow = FLOW.replace('    target: { selectors: [{ role: status }] }', '    target: { selectors: [{ testid: old-status }, { css: "p.status" }] }')
      const step: RecordedStep = {
        ...doneStep,
        matched: { index: 2, selector: { image: 'a.png' }, layer: 'visual', fallback: true, candidates: [{ id: 'out' }] },
        misses: [
          { index: 0, selector: { testid: 'old-status' }, found: 0 },
          { index: 1, selector: { css: 'p.status' }, found: 0 }
        ]
      }
      const diff = healProposals(record([typeStep, step], flow), flow).diff
      expect(diff, diff).toContain('-    target: { selectors: [{ testid: old-status }, { css: "p.status" }] }\n+    target: { selectors: [{ id: out }] }\n')
      expect(diff.match(/^[-+] /gm), 'only that line changes').toHaveLength(2)
    })

    it('moves a flow locator that is the same as a candidate instead of adding a copy (it missed while the page loaded)', () => {
      const report = healProposals(record([typeStep, anchored([{ css: '#save' }, { testid: 'store-note' }]), doneStep]), FLOW)
      const p = report.proposals[0]
      expect(p.added).toEqual([{ testid: 'store-note' }])
      expect(p.selectors_after).toEqual([{ css: '#save' }, { testid: 'store-note' }, { css: 'form > button.primary' }])
      expect(p.dropped.map((d) => d.selector)).toEqual([{ testid: 'save-note' }, { role: 'button', name: 'Save' }])
    })

    it('keeps a ${...} locator that missed, after the added ones', () => {
      const flow = FLOW.replace('        - { role: button, name: Save }', '        - { role: button, name: "${vars.label}" }')
      const step = { ...anchored([{ testid: 'store-note' }]), misses: [0, 1, 3].map((index) => ({ index, selector: { css: 'x' }, found: 0 })) }
      const p = healProposals(record([typeStep, step, doneStep], flow), flow).proposals[0]
      expect(p.selectors_after).toEqual([{ testid: 'store-note' }, { role: 'button', name: '${vars.label}' }, { css: 'form > button.primary' }])
    })

    it('writes a long new locator on one line (no YAML folding), so only the list lines change', () => {
      const long = { css: 'div.some-long-class-name > section.another-long-class-name > ul.list > li.item > button.primary' }
      const report = healProposals(record([typeStep, anchored([long]), doneStep]), FLOW)
      expect(report.diff, report.diff).toContain(`+        - { css: ${long.css} }\n`)
      expect(report.diff.match(/^[-+] /gm), report.diff).toHaveLength(4)
    })

    it('leaves out a candidate in a layer the flow fills from a placeholder (it is this run\'s value, not a locator for every run)', () => {
      const flow = FLOW.replace('        - { role: button, name: Save }', '        - { role: button, name: "${vars.label}" }')
      const step = { ...anchored([{ role: 'button', name: 'Save' }, { testid: 'store-note' }]), misses: [0, 1, 3].map((index) => ({ index, selector: { css: 'x' }, found: 0 })) }
      const p = healProposals(record([typeStep, step, doneStep], flow), flow).proposals[0]
      expect(p.added, 'the role + name the run saw is vars.label of that run').toEqual([{ testid: 'store-note' }])
    })

    it('says which flow locator moves to the front when every candidate is already in the flow', () => {
      const text = renderHealReport(healProposals(record([typeStep, anchored([{ css: '#save' }]), doneStep]), FLOW))
      expect(text).toContain('  save: matched by its reference crop; move {"css":"#save"} to the front; drop {"testid":"save-note"} (no match), {"role":"button","name":"Save"} (no match)')
    })

    it('leaves the step unhealed when the run recorded no candidate, or only ones that are not locators', () => {
      for (const candidates of [undefined, [], [{ css: '' }], [{ nth: 3 }]] as unknown[]) {
        const report = healProposals(record([typeStep, anchored(candidates as never), doneStep]), FLOW)
        expect(report.proposals, JSON.stringify(candidates)).toEqual([])
        expect(report.unhealed.map((u) => u.step_id)).toEqual(['save'])
        expect(report.unhealed[0].reason).toMatch(/only its reference crop matched, and the run recorded no locator/)
      }
    })

    it('prints the added locators in nawi heal', () => {
      const text = renderHealReport(healProposals(record([typeStep, anchored([{ testid: 'store-note' }]), doneStep]), FLOW))
      expect(text).toContain(
        '  save: matched by its reference crop; add {"testid":"store-note"} (unverified until replayed); drop {"testid":"save-note"} (no match), {"role":"button","name":"Save"} (no match), {"css":"#save"} (no match)'
      )
    })
  })

  it("names the healed run when asked about apply_heal's replay of text that is not in the file", () => {
    const healedRun = '20261107T120000000Z-def456'
    // The replay ran the proposed text (its sha); the file still holds FLOW because the heal was rejected.
    const replay = { ...record([typeStep, saveDrifted, doneStep], FLOW.replace('hello', 'hi')), heal_of: healedRun }
    const report = healProposals(replay, FLOW)
    expect(report).toMatchObject({ flow_status: 'changed', proposals: [], diff: '' })
    expect(report.note, 'not the generic "file changed" note').toContain(`replay of the proposals of run ${healedRun}`)
    expect(report.note).toContain(`Ask for proposals from run ${healedRun}`)
    // Once the heal was written, the replay is a run of the file like any other.
    expect(healProposals(replay, FLOW.replace('hello', 'hi')).flow_status).toBe('current')
  })

  it('refuses to patch a flow file that changed since the run, is gone, or no longer parses', () => {
    const run = record([typeStep, saveDrifted, doneStep])
    const changed = healProposals(run, FLOW.replace('hello', 'hi'))
    expect(changed).toMatchObject({ flow_status: 'changed', proposals: [], diff: '' })
    expect(changed.note).toMatch(/Run the flow again/)
    expect(healProposals(run, null)).toMatchObject({ flow_status: 'missing', proposals: [], diff: '' })
    const broken = 'version: 1\nname: x\n'
    expect(healProposals(record([typeStep, saveDrifted], broken), broken)).toMatchObject({ flow_status: 'invalid', proposals: [] })
  })

  it('does not trust a record whose matched index is past the file\'s locators', () => {
    const step: RecordedStep = { ...saveDrifted, matched: { index: 9, selector: { css: '#save' }, layer: 'css', fallback: true } }
    const report = healProposals(record([typeStep, step, doneStep]), FLOW)
    expect(report.proposals).toEqual([])
    expect(report.unhealed.map((u) => u.step_id)).toEqual(['save'])
  })
})

describe('readRunFlow', () => {
  it('reads the flow file inside the allowed roots and answers null outside them or when it is gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nawi-heal-'))
    try {
      const file = join(root, 'notes.nawi.yaml')
      writeFileSync(file, FLOW)
      const run = { ...record([]), flow: { name: 'n', file, sha256: sha(FLOW) } }
      expect((await readRunFlow(run, [root]))?.toString('utf8')).toBe(FLOW)
      expect(await readRunFlow(run, [join(root, 'elsewhere')]), 'outside the roots').toBeNull()
      expect(await readRunFlow({ ...run, flow: { ...run.flow, file: join(root, 'gone.nawi.yaml') } }, [root])).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('nawi heal output', () => {
  it('prints one line per proposal and per unhealed step, then the diff', () => {
    const visual: RecordedStep = { id: 'done', action: 'assert', status: 'passed', matched: { index: 1, selector: { image: 'a.png' }, layer: 'visual', fallback: true } }
    const report = healProposals(record([typeStep, saveDrifted, visual]), FLOW)
    expect(isHealReport(report)).toBe(true)
    const text = renderHealReport(report)
    expect(text).toContain('Run 20261107T130000000Z-abc123 of Save a note (/home/u/flows/notes.nawi.yaml)')
    expect(text).toContain('  save: matched by css {"css":"#save"}; drop {"testid":"save-note"} (no match), {"role":"button","name":"Save"} (no match)')
    expect(text).toMatch(/ {2}done: not healed, only its reference crop matched/)
    expect(text).toContain('\n--- a/notes.nawi.yaml\n')
  })

  it('says when there is nothing to heal, and passes the note through for a changed flow', () => {
    expect(renderHealReport(healProposals(record([typeStep, doneStep]), FLOW))).toContain('No step drifted: nothing to heal.')
    expect(renderHealReport(healProposals(record([typeStep, saveDrifted]), 'x'))).toContain('The flow file changed since this run')
  })
})
