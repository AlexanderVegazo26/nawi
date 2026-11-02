import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FlowRun } from './replay/replay'
import {
  RUN_ID_RE,
  buildRunRecord,
  newRunId,
  pruneRuns,
  toJUnitXml,
  writeRunRecord,
  xmlEscape,
  type RunRecord
} from './run-record'

const T0 = Date.UTC(2026, 10, 2, 10, 39, 0, 123)
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

const FAILED: FlowRun = {
  status: 'failed',
  startedAt: T0,
  durationMs: 2345,
  failedStepId: 's2',
  steps: [
    { id: 's1', action: 'screenshot', status: 'passed', startedAt: T0, durationMs: 120, screenshotPng: PNG.toString('base64') },
    {
      id: 's2',
      action: 'click',
      status: 'failed',
      startedAt: T0 + 120,
      durationMs: 2000,
      misses: [
        { index: 0, selector: { testid: 'save' }, found: 0 },
        { index: 1, selector: { css: 'button.primary' }, found: 3 }
      ],
      error: 'no locator matched exactly one element within 2000 ms'
    },
    { id: 's3', action: 'press', status: 'not_run' },
    { id: 's4', action: 'press', status: 'skipped' }
  ]
}

const record = (run: FlowRun = FAILED, name = 'Save invoice'): { record: RunRecord; assets: Map<string, Buffer> } =>
  buildRunRecord({
    runId: newRunId(run.startedAt, () => 'abc123'),
    flow: { name, file: '/home/u/flows/save.nawi.yaml', sha256: 'f'.repeat(64) },
    run,
    environment: { app_version: '0.1.0', os: { platform: 'linux', release: '7.0.0', arch: 'x64' } }
  })

describe('newRunId', () => {
  it('is the UTC start time to the millisecond plus a random suffix, and sorts by start time', () => {
    expect(newRunId(T0, () => 'abc123')).toBe('20261102T103900123Z-abc123')
    const ids = [T0 + 1000, T0, T0 + 1].map((t) => newRunId(t))
    for (const id of ids) expect(id, `run id ${id}`).toMatch(RUN_ID_RE)
    expect([...ids].sort(), 'string order is time order').toEqual([ids[1], ids[2], ids[0]])
  })
})

describe('buildRunRecord', () => {
  it('turns the replayer report into the v1 record: ISO times, totals, screenshots moved out to files', () => {
    const { record: r, assets } = record()
    expect(r).toMatchObject({
      version: 1,
      run_id: '20261102T103900123Z-abc123',
      status: 'failed',
      started_at: '2026-11-02T10:39:00.123Z',
      duration_ms: 2345,
      failed_step_id: 's2',
      totals: { passed: 1, failed: 1, skipped: 1, not_run: 1 }
    })
    expect(r.steps[0]).toEqual({
      id: 's1',
      action: 'screenshot',
      status: 'passed',
      started_at: '2026-11-02T10:39:00.123Z',
      duration_ms: 120,
      screenshot: 'steps/001-s1.png'
    })
    expect(r.steps[2], 'a step that never ran has no times').toEqual({ id: 's3', action: 'press', status: 'not_run' })
    expect([...assets.keys()]).toEqual(['steps/001-s1.png'])
    expect(assets.get('steps/001-s1.png')?.equals(PNG), 'asset holds the decoded PNG bytes').toBe(true)
    expect(JSON.stringify(r), 'no base64 screenshot inside run.json').not.toContain('screenshotPng')
  })

  it('names a screenshot by position only when the step id is not file-name safe', () => {
    const run: FlowRun = { ...FAILED, steps: [{ ...FAILED.steps[0], id: '../evil' }] }
    expect([...record(run).assets.keys()]).toEqual(['steps/001.png'])
  })
})

describe('toJUnitXml', () => {
  it('has one testcase per step: failure with every locator miss, skipped for disabled and not-run steps', () => {
    const xml = toJUnitXml(record().record)
    expect(xml).toContain('<testsuite name="Save invoice" tests="4" failures="1" errors="0" skipped="2" time="2.345" timestamp="2026-11-02T10:39:00">')
    expect(xml).toContain('<testcase classname="Save invoice" name="s1 (screenshot)" time="0.120"/>')
    expect(xml).toContain(
      '<failure message="no locator matched exactly one element within 2000 ms" type="step_failed">no locator matched exactly one element within 2000 ms\n' +
        '  locator 0 testid=save: no match\n  locator 1 css=button.primary: 3 matches</failure>'
    )
    expect(xml).toContain('<skipped message="not run: an earlier step failed or the run stopped"/>')
    expect(xml).toContain('<skipped message="disabled in the flow"/>')
    expect(xml).toContain('<property name="nawi.run_id" value="20261102T103900123Z-abc123"/>')
    expect(xml, 'a step failure is not a run error').not.toContain('name="(run)"')
  })

  it('adds a (run) error case when the run failed before any step, so the report is never green', () => {
    const run: FlowRun = {
      status: 'failed',
      startedAt: T0,
      durationMs: 0,
      error: 'the flow needs values the run did not provide: ${env.X}',
      steps: [{ id: 's1', action: 'click', status: 'not_run' }]
    }
    const xml = toJUnitXml(record(run).record)
    expect(xml).toContain('tests="2" failures="0" errors="1" skipped="1"')
    expect(xml).toContain('<testcase classname="Save invoice" name="(run)" time="0.000">')
    expect(xml).toContain('<error message="the flow needs values the run did not provide: ${env.X}" type="run_failed">')
  })

  it('escapes markup and replaces characters XML cannot carry in names and messages', () => {
    const run: FlowRun = { ...FAILED, steps: [{ ...FAILED.steps[1], error: 'expected "<b>" & \'x\'\u0000\u001b\uD800 end' }] }
    const xml = toJUnitXml(record(run, 'A <b> & "c"').record)
    expect(xml).toContain('<testsuite name="A &lt;b&gt; &amp; &quot;c&quot;"')
    expect(xml).toContain('message="expected &quot;&lt;b&gt;&quot; &amp; &apos;x&apos;��� end"')
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml), 'no C0 control characters in the XML').toBe(false)
  })

  it('keeps a valid surrogate pair (emoji) as is', () => {
    expect(xmlEscape('ok \u{1F600}')).toBe('ok \u{1F600}')
  })
})

describe('writeRunRecord and pruneRuns', () => {
  let runs: string
  beforeEach(() => {
    runs = join(mkdtempSync(join(tmpdir(), 'nawi-runs-')), 'runs')
  })
  afterEach(() => rmSync(join(runs, '..'), { recursive: true, force: true }))

  it('writes run.json, junit.xml and the screenshots into runs/<run-id>/, creating the folder', async () => {
    const { record: r, assets } = record()
    const dir = await writeRunRecord(runs, r, assets)
    expect(dir).toBe(join(runs, r.run_id))
    expect(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))).toEqual(r)
    expect(readFileSync(join(dir, 'junit.xml'), 'utf8')).toBe(toJUnitXml(r))
    expect(readFileSync(join(dir, 'steps', '001-s1.png')).equals(PNG)).toBe(true)
    expect(readdirSync(runs), 'only the finished run, no temporary folder').toEqual([r.run_id])
  })

  it('refuses a run id that is not one, and leaves no temporary folder when a write fails', async () => {
    const { record: r, assets } = record()
    await expect(writeRunRecord(runs, { ...r, run_id: '../x' }, assets)).rejects.toThrow(/not a run id/)
    await expect(writeRunRecord(runs, r, new Map([['../../escape.png', PNG]]))).rejects.toThrow(/unsafe asset name/)
    expect(readdirSync(runs), 'nothing half-written').toEqual([])
    expect(existsSync(join(runs, '..', 'escape.png'))).toBe(false)
  })

  it('keeps the newest runs and never touches folders or files that are not runs', async () => {
    mkdirSync(runs, { recursive: true })
    const ids = [0, 1, 2, 3].map((i) => newRunId(T0 + i * 1000, () => 'aaaaaa'))
    for (const id of ids) mkdirSync(join(runs, id))
    mkdirSync(join(runs, 'my-notes'))
    writeFileSync(join(runs, '20200101T000000000Z-ffffff'), 'a file named like a run')
    expect(await pruneRuns(runs, 2)).toEqual([ids[0], ids[1]])
    expect(readdirSync(runs).sort()).toEqual(['20200101T000000000Z-ffffff', ids[2], ids[3], 'my-notes'].sort())
    expect(await pruneRuns(join(runs, 'missing')), 'a missing folder is nothing to prune').toEqual([])
  })

  it('removes temporary folders a crashed write left behind, but not one younger than an hour', async () => {
    mkdirSync(runs, { recursive: true })
    const stale = `.tmp-${newRunId(T0, () => 'bbbbbb')}`
    const fresh = `.tmp-${newRunId(T0 + 1, () => 'cccccc')}`
    mkdirSync(join(runs, stale))
    mkdirSync(join(runs, fresh))
    mkdirSync(join(runs, '.tmp-not-a-run'))
    const { utimesSync } = await import('node:fs')
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(join(runs, stale), twoHoursAgo, twoHoursAgo)
    expect(await pruneRuns(runs)).toEqual([stale])
    expect(readdirSync(runs).sort()).toEqual(['.tmp-not-a-run', fresh].sort())
  })
})
