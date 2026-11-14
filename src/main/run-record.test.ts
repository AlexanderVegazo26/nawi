import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FlowRun } from './replay/replay'
import { toHtmlReport } from './run-report'
import {
  HEAL_REPLAY_MARKER,
  KEPT_HEAL_REPLAYS,
  NETWORK_HAR,
  TRACE_JSON,
  RUN_ASSET_RE,
  RUN_ID_RE,
  buildRunRecord,
  readRunRecord,
  summarizeRun,
  matchedLine,
  missReason,
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

describe('visual-anchor layer in text output (AI1)', () => {
  it('prints a visual match with its score, and each kind of anchor miss in words', () => {
    expect(matchedLine({ index: 2, selector: { image: 'save.png' }, layer: 'visual', fallback: true, score: 0.987 })).toBe(
      'matched locator 2 (visual, fallback) image=save.png score=0.987'
    )
    expect(matchedLine({ index: 0, selector: { id: 'a' }, layer: 'id', fallback: false }), 'no score for DOM layers').toBe('matched locator 0 (id) id=a')
    const image = { image: 'save.png' }
    expect(missReason({ index: 1, selector: image, found: 2, score: 1 })).toBe('matches in 2+ places (ambiguous), best score 1')
    expect(missReason({ index: 1, selector: image, found: 0, score: 0.81 })).toBe('no close match, best score 0.81')
    expect(missReason({ index: 1, selector: image, found: 0, at: [10, 20] })).toBe('found on screen at (10, 20) but no element is there')
    expect(missReason({ index: 1, selector: image, found: 0, invalid: 'not a usable PNG' })).toBe('invalid: not a usable PNG')
    expect(missReason({ index: 0, selector: { css: '.x' }, found: 3 }), 'DOM locators keep their wording').toBe('3 matches')
  })
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

const WITH_EVIDENCE: FlowRun = {
  status: 'failed',
  startedAt: T0,
  durationMs: 900,
  failedStepId: 's2',
  opening: { failedRequests: [{ method: 'GET', url: 'https://app.example/missing.css', resource_type: 'Stylesheet', status: 404 }] },
  finalUrl: 'https://app.example/invoices',
  steps: [
    {
      id: 's1',
      action: 'click',
      status: 'passed',
      startedAt: T0,
      durationMs: 300,
      url: 'https://app.example/invoices',
      consoleErrors: [{ source: 'console', message: 'save <failed> & retried' }],
      consoleErrorsDropped: 2,
      failedRequests: [{ method: 'POST', url: 'https://app.example/api/save', resource_type: 'Fetch', status: 500 }]
    },
    {
      id: 's2',
      action: 'assert',
      status: 'failed',
      startedAt: T0 + 300,
      durationMs: 600,
      error: 'assertion failed',
      url: 'https://app.example/invoices',
      failedRequests: [{ method: 'GET', url: 'https://cdn.example/x.js', error: 'net::ERR_NAME_NOT_RESOLVED' }],
      failedRequestsDropped: 1
    }
  ]
}

describe('page evidence in the record (F4b)', () => {
  it('spells console errors, failed requests and URLs the run.json way, and leaves them out when there are none', () => {
    const { record: r } = record(WITH_EVIDENCE)
    expect(r.opening, 'evidence from opening the target').toEqual({
      failed_requests: [{ method: 'GET', url: 'https://app.example/missing.css', resource_type: 'Stylesheet', status: 404 }]
    })
    expect(r.final_url).toBe('https://app.example/invoices')
    expect(r.steps[0]).toEqual({
      id: 's1',
      action: 'click',
      status: 'passed',
      started_at: '2026-11-02T10:39:00.123Z',
      duration_ms: 300,
      url: 'https://app.example/invoices',
      console_errors: [{ source: 'console', message: 'save <failed> & retried' }],
      console_errors_dropped: 2,
      failed_requests: [{ method: 'POST', url: 'https://app.example/api/save', resource_type: 'Fetch', status: 500 }]
    })
    expect(Object.keys(r.steps[1]), 'no camelCase evidence keys in run.json').not.toEqual(
      expect.arrayContaining(['consoleErrors', 'failedRequests', 'failedRequestsDropped'])
    )
    expect(r.steps[1].failed_requests_dropped).toBe(1)
    const plain = record().record
    expect('opening' in plain || 'final_url' in plain, 'a run without evidence has no opening/final_url').toBe(false)
    expect(plain.steps.some((st) => 'console_errors' in st || 'failed_requests' in st || 'url' in st)).toBe(false)
  })

  it('puts evidence in JUnit: <system-err> on a passing step, the failure text on a failed one', () => {
    const xml = toJUnitXml(record(WITH_EVIDENCE).record)
    expect(xml).toContain(
      '<testcase classname="Save invoice" name="s1 (click)" time="0.300">\n' +
        '      <system-err>console console: save &lt;failed&gt; &amp; retried\n(2 more console errors not kept)\n' +
        'request POST https://app.example/api/save: HTTP 500</system-err>\n    </testcase>'
    )
    expect(xml).toContain(
      'type="step_failed">assertion failed\n  page: https://app.example/invoices\n' +
        '  request GET https://cdn.example/x.js: net::ERR_NAME_NOT_RESOLVED\n  (1 more failed requests not kept)</failure>'
    )
  })

  it('puts what failed while opening the target in the suite <system-err> when the run reached its steps', () => {
    const xml = toJUnitXml(record(WITH_EVIDENCE).record)
    expect(xml).toContain(
      '    </properties>\n    <system-err>while opening the target:\nrequest GET https://app.example/missing.css: HTTP 404</system-err>'
    )
  })

  it("adds what failed while opening the target to the (run) error of a run that never reached a step", () => {
    const run: FlowRun = {
      status: 'failed',
      startedAt: T0,
      durationMs: 30_000,
      error: "could not open the flow's target: did not finish loading",
      opening: { consoleErrors: [{ source: 'exception', message: 'ReferenceError: boot is not defined' }] },
      steps: [{ id: 's1', action: 'click', status: 'not_run' }]
    }
    expect(toJUnitXml(record(run).record)).toContain(
      'type="run_failed">could not open the flow&apos;s target: did not finish loading\n  console exception: ReferenceError: boot is not defined</error>'
    )
  })
})

describe('buildRunRecord: android device evidence (M5b-2)', () => {
  const png = (tag: string): string => Buffer.concat([PNG, Buffer.from(tag, 'hex')]).toString('base64')
  const LOG = { at: '2026-11-08T11:42:43.237Z', level: 'E' as const, tag: 'AndroidRuntime', message: 'FATAL EXCEPTION: main' }
  const run: FlowRun = {
    status: 'failed',
    startedAt: T0,
    durationMs: 900,
    failedStepId: 'tap',
    steps: [{ id: 'tap', action: 'click', status: 'failed', error: 'gone', shots: { before: png('01'), after: png('02') }, logcat: [LOG], logcatDropped: 4 }]
  }

  it('writes a device screen as .before/.after.png, which writeRunRecord and the asset pattern accept', async () => {
    const { record: r, assets } = record(run)
    expect(r.steps[0].shots).toEqual({ before: 'steps/001-tap.before.png', after: 'steps/001-tap.after.png' })
    for (const name of assets.keys()) expect(RUN_ASSET_RE.test(name), `${name} is a run asset`).toBe(true)
    expect(RUN_ASSET_RE.test('steps/001-tap.after.gif'), 'only jpg and png').toBe(false)
    const runs = join(mkdtempSync(join(tmpdir(), 'nawi-android-shots-')), 'runs')
    try {
      const dir = await writeRunRecord(runs, r, assets)
      expect(readdirSync(join(dir, 'steps')).sort()).toEqual(['001-tap.after.png', '001-tap.before.png'])
      expect(readFileSync(join(dir, 'steps', '001-tap.after.png')).subarray(0, 8)).toEqual(PNG.subarray(0, 8))
    } finally {
      rmSync(join(runs, '..'), { recursive: true, force: true })
    }
  })

  it('keeps the device log as logcat / logcat_dropped, and puts it in JUnit and the HTML report', () => {
    const { record: r, assets } = record(run)
    expect(r.steps[0]).toMatchObject({ logcat: [LOG], logcat_dropped: 4 })
    expect(Object.keys(r.steps[0]), 'no camelCase evidence keys in run.json').not.toContain('logcatDropped')
    expect(toJUnitXml(r)).toContain(
      'gone\n  screenshot after the step: steps/001-tap.after.png (in the run folder)\n  logcat E AndroidRuntime: FATAL EXCEPTION: main\n  (4 more device log lines not kept)</failure>'
    )
    const html = toHtmlReport(r, assets)
    expect(html).toContain('<li>logcat E AndroidRuntime: FATAL EXCEPTION: main</li>')
    expect(html, 'the device screen embedded as a PNG').toContain('data:image/png;base64,')
  })
})

describe('buildRunRecord: page screenshots around steps (F4b2)', () => {
  const jpeg = (tag: string): string => Buffer.from(`ffd8ff${tag}`, 'hex').toString('base64')
  const A = jpeg('01')
  const B = jpeg('02')
  const C = jpeg('03')
  const run: FlowRun = {
    status: 'failed',
    startedAt: T0,
    durationMs: 900,
    failedStepId: 'bad',
    steps: [
      { id: 'one', action: 'click', status: 'passed', shots: { before: A, after: B } },
      { id: 'same', action: 'assert', status: 'passed', shots: { before: B, after: B } },
      { id: 'bad', action: 'click', status: 'failed', error: 'gone', shots: { before: B, after: C } },
      { id: 'later', action: 'click', status: 'not_run' }
    ]
  }

  it('writes each distinct image once as NNN-<id>.before/after.jpg and points later steps at the same file', () => {
    const { record: r, assets } = record(run)
    expect(r.steps.map((s) => s.shots)).toEqual([
      { before: 'steps/001-one.before.jpg', after: 'steps/001-one.after.jpg' },
      { before: 'steps/001-one.after.jpg', after: 'steps/001-one.after.jpg' },
      { before: 'steps/001-one.after.jpg', after: 'steps/003-bad.after.jpg' },
      undefined
    ])
    expect([...assets.keys()].sort()).toEqual(['steps/001-one.after.jpg', 'steps/001-one.before.jpg', 'steps/003-bad.after.jpg'])
    expect(assets.get('steps/003-bad.after.jpg')?.toString('hex')).toBe('ffd8ff03')
    expect(JSON.stringify(r), 'no base64 image inside run.json').not.toContain(A)
  })

  it("names the failing step's after screenshot in its JUnit failure, and writeRunRecord accepts the .jpg names", async () => {
    const { record: r, assets } = record(run)
    expect(toJUnitXml(r)).toContain('gone\n  screenshot after the step: steps/003-bad.after.jpg (in the run folder)</failure>')
    const runs = join(mkdtempSync(join(tmpdir(), 'nawi-shots-')), 'runs')
    try {
      const dir = await writeRunRecord(runs, r, assets)
      expect(readdirSync(join(dir, 'steps')).sort()).toEqual(['001-one.after.jpg', '001-one.before.jpg', '003-bad.after.jpg'])
      await expect(
        writeRunRecord(runs, { ...r, run_id: newRunId(T0 + 1, () => 'def456') }, new Map([['steps/001-x.middle.jpg', PNG]]))
      ).rejects.toThrow(/unsafe asset name/)
    } finally {
      rmSync(join(runs, '..'), { recursive: true, force: true })
    }
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

  /** Saves a passed one-step run started at T0 + i seconds; a heal replay of `healOf` when given. */
  const saveRun = async (i: number, healOf?: string): Promise<string> => {
    const built = buildRunRecord({
      runId: newRunId(T0 + i * 1000, () => (healOf ? 'eeeeee' : 'aaaaaa')),
      flow: { name: 'f', file: '/home/u/flows/save.nawi.yaml', sha256: 'f'.repeat(64) },
      run: { status: 'passed', startedAt: T0 + i * 1000, durationMs: 5, steps: [{ id: 's1', action: 'press', status: 'passed' }] },
      environment: { os: { platform: 'linux', release: '7.0.0', arch: 'x64' } },
      ...(healOf !== undefined ? { healOf } : {})
    })
    await writeRunRecord(runs, built.record, built.assets)
    return built.record.run_id
  }

  it('marks an apply_heal replay: heal_of in run.json, list summary and report, plus the marker file', async () => {
    const healed = await saveRun(0)
    const replay = await saveRun(1, healed)
    const back = await readRunRecord(runs, replay)
    expect(back?.heal_of, 'run.json names the healed run').toBe(healed)
    expect(summarizeRun(back!).heal_of, 'list_runs shows it').toBe(healed)
    expect(existsSync(join(runs, replay, HEAL_REPLAY_MARKER)), 'pruneRuns reads the marker, not run.json').toBe(true)
    expect(existsSync(join(runs, healed, HEAL_REPLAY_MARKER)), 'an ordinary run has no marker').toBe(false)
    const ordinary = await readRunRecord(runs, healed)
    expect(ordinary && 'heal_of' in ordinary, 'an ordinary run has no heal_of key').toBe(false)
    const html = toHtmlReport(back!, new Map())
    expect(html).toContain(`Replay of the healing proposals of run ${healed}`)
    expect(html).toContain('Proposed flow SHA-256')
    expect(toHtmlReport(ordinary!, new Map())).not.toContain('healing proposals')
  })

  it('refuses to write, and will not read, a heal_of that is not a run id', async () => {
    const id = await saveRun(0)
    const { record: r, assets } = record()
    await expect(writeRunRecord(runs, { ...r, heal_of: '../x' }, assets)).rejects.toThrow(/not a run id/)
    const file = join(runs, id, 'run.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), heal_of: '../../etc' }))
    expect(await readRunRecord(runs, id), 'a record with a malformed heal_of is not whole').toBeNull()
  })

  it('does not count heal replays toward keep, and keeps only the newest KEPT_HEAL_REPLAYS of them', async () => {
    const ordinary = [await saveRun(0), await saveRun(1)]
    const replays: string[] = []
    for (let i = 0; i < KEPT_HEAL_REPLAYS + 3; i++) replays.push(await saveRun(10 + i, ordinary[1]))
    const newest = await saveRun(100)

    // keep 20 of 26 run folders: counted together, the 2 ordinary runs older than the replays would go.
    const deleted = await pruneRuns(runs, KEPT_HEAL_REPLAYS)
    expect(deleted, 'only the 3 oldest replays').toEqual(replays.slice(0, 3))
    expect(readdirSync(runs).sort(), 'every ordinary run survives a burst of heal replays').toEqual([...ordinary, ...replays.slice(3), newest].sort())
    expect(await pruneRuns(runs, 1), 'replays never outnumber keep').toEqual([...ordinary, ...replays.slice(3, -1)])
    expect(readdirSync(runs).sort()).toEqual([replays.at(-1), newest].sort())
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

describe('buildRunRecord: matched layer, fallback and intent (AI1)', () => {
  const DRIFT: FlowRun = {
    status: 'failed',
    startedAt: T0,
    durationMs: 900,
    failedStepId: 's3',
    steps: [
      {
        id: 's1',
        action: 'click',
        status: 'passed',
        intent: 'Open the invoice list',
        matched: { index: 0, selector: { testid: 'invoices' }, layer: 'testid', fallback: false }
      },
      {
        id: 's2',
        action: 'click',
        status: 'passed',
        matched: { index: 2, selector: { text: 'Save' }, layer: 'text', fallback: true },
        misses: [
          { index: 0, selector: { testid: 'save' }, found: 0 },
          { index: 1, selector: { role: 'button', name: 'Save draft' }, found: 0 }
        ]
      },
      {
        id: 's3',
        action: 'fill',
        status: 'failed',
        intent: 'Name the invoice',
        matched: { index: 1, selector: { css: '#name' }, layer: 'css', fallback: true },
        misses: [{ index: 0, selector: { id: 'title' }, found: 0 }],
        error: 'css=#name matched but it is not a text field (div#name)'
      }
    ]
  }

  it('lists every step found only by a fallback locator, in step order, as the run\'s drift signal', () => {
    const { record: r } = record(DRIFT)
    expect(r.fallback_step_ids, 'passed steps whose primary locator missed (s1 matched its first locator; s3 failed: its error is the news)').toEqual(['s2'])
    expect(r.steps[1].matched, 'layer + fallback kept on the step').toEqual({ index: 2, selector: { text: 'Save' }, layer: 'text', fallback: true })
    expect(r.steps[0].intent).toBe('Open the invoice list')
  })

  it('leaves fallback_step_ids out when every step matched its first locator', () => {
    const { record: r } = record({ ...DRIFT, steps: [DRIFT.steps[0]], status: 'passed', failedStepId: undefined })
    expect('fallback_step_ids' in r, JSON.stringify(r)).toBe(false)
  })

  it('puts the intent and the matched layer into the JUnit failure text', () => {
    const { record: r } = record(DRIFT)
    const xml = toJUnitXml(r)
    expect(xml, xml).toContain('  intent: Name the invoice\n')
    expect(xml, xml).toContain('  matched locator 1 (css, fallback) css=#name')
  })
})

describe('buildRunRecord: the run HAR (roadmap DT1)', () => {
  const har = {
    log: {
      version: '1.2' as const,
      creator: { name: 'Nawi', version: '0.1.0' },
      pages: [] as never[],
      entries: [{ _step_id: 's1', _t_ms: 12 }, { _opening: true, _t_ms: 3 }]
    }
  } as unknown as NonNullable<FlowRun['network']>
  const run: FlowRun = {
    status: 'passed',
    startedAt: T0,
    durationMs: 300,
    opening: { requests: 1 },
    steps: [{ id: 's1', action: 'click', status: 'passed', requests: 1 }],
    network: har
  }

  it('writes network.har next to run.json, names it in network_har, and counts requests per step and while opening', async () => {
    const { record: r, assets } = record(run)
    expect(r.network_har).toBe(NETWORK_HAR)
    expect(r.steps[0].requests, JSON.stringify(r.steps[0])).toBe(1)
    expect(r.opening, 'opening requests are evidence too').toEqual({ requests: 1 })
    expect(JSON.parse(assets.get(NETWORK_HAR)?.toString('utf8') ?? 'null'), 'the HAR as the run built it').toEqual(har)
    expect(RUN_ASSET_RE.test(NETWORK_HAR), 'network.har is a run asset').toBe(true)
    for (const bad of ['steps/network.har', '../network.har', 'network.har.exe', 'networkxhar']) {
      expect(RUN_ASSET_RE.test(bad), `${bad} is not a run asset`).toBe(false)
    }
    const runs = join(mkdtempSync(join(tmpdir(), 'nawi-run-har-')), 'runs')
    try {
      const dir = await writeRunRecord(runs, r, assets)
      expect(readdirSync(dir).sort(), 'no empty steps/ folder for a run with no screenshots').toEqual(['junit.xml', 'network.har', 'run.json'])
      expect(JSON.parse(readFileSync(join(dir, NETWORK_HAR), 'utf8')).log.entries).toHaveLength(2)
    } finally {
      rmSync(join(runs, '..'), { recursive: true, force: true })
    }
  })

  it('has no network_har and writes no file when the run sent no request', () => {
    const { record: r, assets } = record({ ...run, network: undefined, opening: undefined, steps: [{ id: 's1', action: 'click', status: 'passed' }] })
    expect(r.network_har).toBeUndefined()
    expect(assets.has(NETWORK_HAR)).toBe(false)
    expect('requests' in r.steps[0], 'no zero count either').toBe(false)
  })
})

describe('buildRunRecord: the run trace (roadmap DT1b)', () => {
  const trace = {
    traceEvents: [{ name: 'TracingStartedInBrowser', ph: 'I', pid: 1, tid: 1, ts: 5 }],
    metadata: { nawi: { dropped_events: 0, other_process_events: 3 } }
  }
  const run: FlowRun = { status: 'passed', startedAt: T0, durationMs: 300, steps: [{ id: 's1', action: 'click', status: 'passed' }], trace }

  it('writes trace.json next to run.json and names it in trace_json', async () => {
    const { record: r, assets } = record(run)
    expect(r.trace_json).toBe(TRACE_JSON)
    expect(r.trace_error).toBeUndefined()
    expect(JSON.parse(assets.get(TRACE_JSON)?.toString('utf8') ?? 'null'), 'the trace as the run built it').toEqual(trace)
    expect(RUN_ASSET_RE.test(TRACE_JSON), 'trace.json is a run asset').toBe(true)
    for (const bad of ['steps/trace.json', '../trace.json', 'trace.json.exe', 'tracexjson', 'run.trace.json']) {
      expect(RUN_ASSET_RE.test(bad), `${bad} is not a run asset`).toBe(false)
    }
    const runs = join(mkdtempSync(join(tmpdir(), 'nawi-run-trace-')), 'runs')
    try {
      const dir = await writeRunRecord(runs, r, assets)
      expect(readdirSync(dir).sort()).toEqual(['junit.xml', 'run.json', 'trace.json'])
      expect(JSON.parse(readFileSync(join(dir, TRACE_JSON), 'utf8')).traceEvents).toHaveLength(1)
    } finally {
      rmSync(join(runs, '..'), { recursive: true, force: true })
    }
  })

  it('says why in trace_error, and writes no file, when the browser would not trace', () => {
    const { record: r, assets } = record({ ...run, trace: undefined, traceError: 'the browser would not start a trace: busy' })
    expect(r.trace_json).toBeUndefined()
    expect(r.trace_error).toBe('the browser would not start a trace: busy')
    expect(assets.has(TRACE_JSON)).toBe(false)
  })

  it('keeps the record, without the trace and saying why, when the trace cannot be serialized', () => {
    const huge = { ...trace, toJSON: () => { throw new RangeError('Invalid string length') } }
    const { record: r, assets } = record({ ...run, trace: huge })
    expect(r.trace_json).toBeUndefined()
    expect(r.trace_error).toBe('the trace could not be saved: Invalid string length')
    expect(assets.has(TRACE_JSON)).toBe(false)
    expect(r.status, 'the rest of the record is intact').toBe('passed')
  })

  it('has neither field for a run that did not ask for a trace', () => {
    const { record: r } = record({ ...run, trace: undefined })
    expect('trace_json' in r || 'trace_error' in r, JSON.stringify(r)).toBe(false)
  })
})
