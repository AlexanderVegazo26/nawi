import { describe, expect, it } from 'vitest'
import { HealUsageError, RUN_ID_RE, isApplyHealResult, isHealReport, parseHealApplyArgs, parseHealArgs, renderApplyHeal } from './heal'
import type { ApplyHealResult } from '../main/heal/apply'
import { RUN_ID_RE as APP_RUN_ID_RE, newRunId } from '../main/run-record'

const RUN = '20261107T130000000Z-abc123'

describe('nawi heal arguments', () => {
  it('uses the app\'s run id pattern (the CLI keeps its own copy)', () => {
    expect(RUN_ID_RE.source).toBe(APP_RUN_ID_RE.source)
    expect(parseHealArgs([newRunId(Date.UTC(2026, 10, 7))]).run_id).toMatch(APP_RUN_ID_RE)
  })

  it('takes the run id as a positional or --run_id, and --json', () => {
    expect(parseHealArgs([RUN])).toEqual({ run_id: RUN, json: false })
    expect(parseHealArgs(['--run_id', RUN, '--json'])).toEqual({ run_id: RUN, json: true })
    expect(parseHealArgs(['--json', RUN])).toEqual({ run_id: RUN, json: true })
  })

  it.each([
    [[], /needs a run id/],
    [['nope'], /is not a run id/],
    [[RUN, RUN], /one run id/],
    [['--run_id'], /needs a value/],
    [['--apply', RUN], /Unknown flag --apply/]
  ])('refuses %j as a usage error', (argv, message) => {
    expect(() => parseHealArgs(argv as string[])).toThrow(HealUsageError)
    expect(() => parseHealArgs(argv as string[])).toThrow(message)
  })

  it('accepts only a report shaped like get_heal_proposals\' result', () => {
    expect(isHealReport({ run_id: RUN, flow: { name: 'n', file: '/f.nawi.yaml' }, flow_status: 'current', proposals: [], unhealed: [], diff: '' })).toBe(true)
    expect(isHealReport({ run_id: RUN, flow_status: 'current', proposals: [], unhealed: [], diff: '' }), 'no flow: renderHealReport would crash').toBe(false)
    expect(isHealReport({ run_id: RUN, steps: [] })).toBe(false)
    expect(isHealReport(null)).toBe(false)
  })
})

describe('nawi heal-apply arguments', () => {
  it('takes the run id, repeatable --step, run inputs, and ignores --apply (nawi heal <id> --apply)', () => {
    expect(parseHealApplyArgs([RUN])).toEqual({ run_id: RUN, vars: {}, headless: false, json: false })
    expect(
      parseHealApplyArgs([RUN, '--apply', '--step', 'save', '--step', 'open', '--headless', '--var', 'who=a=b', '--cdp-endpoint', '9222', '--step-timeout-ms', '2500', '--json'])
    ).toEqual({ run_id: RUN, step_ids: ['save', 'open'], vars: { who: 'a=b' }, headless: true, cdp_endpoint: '9222', step_timeout_ms: 2500, json: true })
  })

  it.each([
    [[], /needs a run id/],
    [['nope'], /is not a run id/],
    [[RUN, RUN], /one run id/],
    [[RUN, '--step'], /--step needs a value/],
    [[RUN, '--var', 'novalue'], /--var takes name=value/],
    [[RUN, '--step-timeout-ms', '50'], /whole number from 100 to 600000/],
    [[RUN, '--step-timeout-ms', '2.5e2x'], /whole number/],
    [[RUN, '--force'], /Unknown flag --force/]
  ])('refuses %j as a usage error', (argv, message) => {
    expect(() => parseHealApplyArgs(argv as string[])).toThrow(HealUsageError)
    expect(() => parseHealApplyArgs(argv as string[])).toThrow(message)
  })
})

describe('nawi heal-apply output', () => {
  const base: ApplyHealResult = {
    run_id: RUN,
    flow: { name: 'Save a note', file: '/home/u/notes.nawi.yaml' },
    flow_status: 'current',
    applied: true,
    step_ids: ['save'],
    diff: '--- a/notes.nawi.yaml\n+++ b/notes.nawi.yaml\n@@ -1 +1 @@\n-a\n+b\n',
    replay: {
      status: 'passed',
      run_id: '20261107T130100000Z-def456',
      steps: [{ id: 'save', status: 'passed', matched: { index: 0, layer: 'css', fallback: false } }]
    }
  }

  it('says what was written, how the replay went step by step, and the patch', () => {
    expect(renderApplyHeal(base)).toBe(
      [
        `Healed save in /home/u/notes.nawi.yaml (run ${RUN}).`,
        'Replay of the proposed flow: passed (run 20261107T130100000Z-def456)',
        '  save: passed, locator 1 (css)',
        '',
        '--- a/notes.nawi.yaml\n+++ b/notes.nawi.yaml\n@@ -1 +1 @@\n-a\n+b'
      ].join('\n')
    )
  })

  it('leads with the reason when nothing was written, and shows the failing step', () => {
    const out = renderApplyHeal({
      ...base,
      applied: false,
      reason: 'The proposed flow failed at step done when replayed.',
      replay: { status: 'failed', failed_step_id: 'done', steps: [{ id: 'save', status: 'passed', matched: { index: 0, layer: 'css', fallback: false } }, { id: 'done', status: 'failed', error: 'expected text' }] }
    })
    expect(out.split('\n')[0]).toBe(`Not applied (run ${RUN}, /home/u/notes.nawi.yaml): The proposed flow failed at step done when replayed.`)
    expect(out).toContain('  done: failed: expected text')
  })

  it('accepts only a result shaped like apply_heal\'s', () => {
    expect(isApplyHealResult(base)).toBe(true)
    expect(isApplyHealResult({ ...base, applied: 'yes' })).toBe(false)
    expect(isApplyHealResult({ run_id: RUN, applied: true, step_ids: [], diff: '' }), 'no flow').toBe(false)
    expect(isApplyHealResult(null)).toBe(false)
  })
})
