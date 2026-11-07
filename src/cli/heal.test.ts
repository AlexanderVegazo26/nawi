import { describe, expect, it } from 'vitest'
import { HealUsageError, RUN_ID_RE, isHealReport, parseHealArgs } from './heal'
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
