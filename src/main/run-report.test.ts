import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FlowRun } from './replay/replay'
import { buildRunRecord, listRuns, newRunId, readRunRecord, writeRunRecord, type RunRecord } from './run-record'
import { MAX_REPORT_CONSOLE_PER_STEP, MAX_REPORT_REQUESTS_PER_STEP, htmlEscape, toHtmlReport } from './run-report'

const T0 = Date.UTC(2026, 10, 2, 10, 39, 0, 123)
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex')
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const b64 = (b: Buffer): string => b.toString('base64')

const RUN: FlowRun = {
  status: 'failed',
  startedAt: T0,
  durationMs: 2345,
  failedStepId: 's2',
  finalUrl: 'https://app.example/invoices',
  opening: { failedRequests: [{ method: 'GET', url: 'https://app.example/favicon.ico', status: 404 }] },
  steps: [
    { id: 's1', action: 'screenshot', status: 'passed', startedAt: T0, durationMs: 120, screenshotPng: b64(PNG), shots: { before: b64(JPG), after: b64(JPG) } },
    {
      id: 's2',
      action: 'click',
      status: 'failed',
      startedAt: T0 + 120,
      durationMs: 2000,
      misses: [{ index: 0, selector: { testid: 'save' }, found: 0 }],
      error: 'no locator matched <b>exactly</b> one element',
      url: 'https://app.example/invoices?x=<script>alert(1)</script>',
      consoleErrors: [{ source: 'exception', message: '</pre><script>alert(2)</script>' }],
      shots: { before: b64(JPG), after: b64(Buffer.concat([JPG, Buffer.from('01', 'hex')])) }
    },
    { id: 's3', action: 'press', status: 'not_run' }
  ]
}

const build = (run: FlowRun = RUN, name = 'Save invoice'): { record: RunRecord; assets: Map<string, Buffer> } =>
  buildRunRecord({
    runId: newRunId(run.startedAt, () => 'abc123'),
    flow: { name, file: '/home/u/flows/save.nawi.yaml', sha256: 'f'.repeat(64) },
    run,
    environment: { app_version: '0.1.0', os: { platform: 'linux', release: '7.0.0', arch: 'x64' } }
  })

describe('toHtmlReport', () => {
  it('is self-contained: no script, no external reference, a CSP that allows only inline style and data images', () => {
    const { record, assets } = build()
    const html = toHtmlReport(record, assets)
    expect(html, 'report starts as an HTML5 document').toMatch(/^<!doctype html>/)
    expect(html, 'CSP present').toContain(`default-src 'none'; img-src data:; style-src 'unsafe-inline'`)
    expect(html, 'no <script> element').not.toMatch(/<script/i)
    expect(html.match(/(?:src|href)="(?!data:|#)[^"]*"/g), 'no src/href that leaves the file').toBeNull()
    expect(html, 'every image is a data URI').toContain(`src="data:image/jpeg;base64,${b64(JPG)}"`)
    expect(html, 'screenshot-step PNG embedded').toContain(`src="data:image/png;base64,${b64(PNG)}"`)
  })

  it('shows the status, totals, the failing step and the locator that missed', () => {
    const { record, assets } = build()
    const html = toHtmlReport(record, assets)
    expect(html).toContain('<title>Save invoice: Failed</title>')
    expect(html).toContain('1 passed, 1 failed, 0 skipped, 1 not run')
    expect(html, 'link to the first failure').toContain('<a href="#step-2">s2</a>')
    expect(html).toContain('id="step-2" class="failed"')
    expect(html).toContain('Locator 0 testid=save: no match')
    expect(html, 'opening evidence').toContain('request GET https://app.example/favicon.ico: HTTP 404')
  })

  it('escapes every text the page or the flow supplied, so none of it becomes markup', () => {
    const { record, assets } = build(RUN, '<img src=x onerror=alert(1)>')
    const html = toHtmlReport(record, assets)
    expect(html, 'flow name escaped').toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html, 'error escaped').toContain('no locator matched &lt;b&gt;exactly&lt;/b&gt; one element')
    expect(html, 'console text escaped').toContain('&lt;/pre&gt;&lt;script&gt;alert(2)&lt;/script&gt;')
    expect(html, 'url escaped').toContain('x=&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html, 'no raw tag from the data').not.toMatch(/<img src=x|<b>exactly|<script/i)
  })

  it("embeds a shot once: a step's before that is the previous step's after is not shown again", () => {
    const { record, assets } = build()
    const html = toHtmlReport(record, assets)
    const s1After = record.steps[0].shots!.after!
    expect(record.steps[1].shots!.before, 'fixture: step 2 starts from step 1 end').toBe(s1After)
    expect(html.match(/alt="Before the step"/g)?.length, 'only step 1 shows a before image').toBe(1)
    expect(html.match(/alt="After the step"/g)?.length, 'every step with an after shows it').toBe(2)
  })

  it('says so when a screenshot file is missing instead of leaving a broken image', () => {
    const { record } = build()
    const html = toHtmlReport(record, new Map())
    expect(html).toContain('Before the step: file not available')
    expect(html).not.toContain('data:image')
  })

  it('has no failure link and says no step ran for a run that stopped before any step', () => {
    const { record, assets } = build({ status: 'failed', startedAt: T0, durationMs: 5, error: 'missing ${env.URL}', steps: [] })
    const html = toHtmlReport(record, assets)
    expect(html).toContain('No step ran.')
    expect(html).toContain('missing ${env.URL}')
    expect(html).not.toContain('first failure')
  })

  it('htmlEscape covers the five characters that matter in text and attributes', () => {
    expect(htmlEscape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})

describe('report.html, readRunRecord and listRuns', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nawi-report-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const save = async (startedAt: number, status: 'passed' | 'failed', file = '/home/u/flows/save.nawi.yaml'): Promise<string> => {
    const built = buildRunRecord({
      runId: newRunId(startedAt, () => 'abc123'),
      flow: { name: 'f', file, sha256: '0'.repeat(64) },
      run: { status, startedAt, durationMs: 10, steps: [{ id: 'a', action: 'press', status: status === 'passed' ? 'passed' : 'failed' }], ...(status === 'failed' ? { failedStepId: 'a' } : {}) },
      environment: { os: { platform: 'linux', release: '1', arch: 'x64' } }
    })
    await writeRunRecord(root, built.record, built.assets, toHtmlReport(built.record, built.assets))
    return built.record.run_id
  }

  it('writeRunRecord saves report.html next to run.json, and not when no report is given', async () => {
    const { record, assets } = build()
    const dir = await writeRunRecord(root, record, assets, toHtmlReport(record, assets))
    expect(existsSync(join(dir, 'report.html')), `report.html in ${dir}`).toBe(true)
    expect(readFileSync(join(dir, 'report.html'), 'utf8')).toContain('<h1>Save invoice')
    const second = buildRunRecord({ runId: newRunId(T0 + 5000, () => 'def456'), flow: record.flow, run: RUN, environment: record.environment })
    const dir2 = await writeRunRecord(root, second.record, second.assets)
    expect(existsSync(join(dir2, 'report.html'))).toBe(false)
  })

  it('readRunRecord returns the saved record and null for a missing, malformed, foreign-version or mismatched run', async () => {
    const id = await save(T0, 'passed')
    expect((await readRunRecord(root, id))?.run_id).toBe(id)
    expect(await readRunRecord(root, '20261102T103900124Z-000000'), 'no such run').toBeNull()
    mkdirSync(join(root, '20261102T103900125Z-000001'))
    writeFileSync(join(root, '20261102T103900125Z-000001', 'run.json'), '{not json')
    expect(await readRunRecord(root, '20261102T103900125Z-000001'), 'malformed').toBeNull()
    mkdirSync(join(root, '20261102T103900126Z-000002'))
    writeFileSync(join(root, '20261102T103900126Z-000002', 'run.json'), JSON.stringify({ version: 2, run_id: '20261102T103900126Z-000002', steps: [] }))
    expect(await readRunRecord(root, '20261102T103900126Z-000002'), 'newer format').toBeNull()
    mkdirSync(join(root, '20261102T103900127Z-000003'))
    writeFileSync(join(root, '20261102T103900127Z-000003', 'run.json'), JSON.stringify({ version: 1, run_id: id, steps: [] }))
    expect(await readRunRecord(root, '20261102T103900127Z-000003'), 'run.json of another run').toBeNull()
  })

  it('readRunRecord returns null for a record missing the fields list_runs reads', async () => {
    const id = '20261102T103900128Z-000004'
    mkdirSync(join(root, id))
    writeFileSync(join(root, id, 'run.json'), JSON.stringify({ version: 1, run_id: id, steps: [], status: 'passed' }))
    expect(await readRunRecord(root, id), 'no flow, totals, start time').toBeNull()
    expect(await listRuns(root), 'and list_runs skips it').toEqual([])
  })

  it.each(['../x', '..', 'a/b', '20261102T103900123Z-abc123/../../etc', ''])('readRunRecord refuses %j before touching the disk', async (bad) => {
    expect(await readRunRecord(root, bad)).toBeNull()
  })

  it('listRuns is newest first, honours limit, status and flow file, and skips folders that are not runs', async () => {
    const a = await save(T0, 'passed')
    const b = await save(T0 + 1000, 'failed')
    const c = await save(T0 + 2000, 'failed', '/home/u/flows/other.nawi.yaml')
    mkdirSync(join(root, 'notes'))
    mkdirSync(join(root, '.tmp-20261102T103900123Z-aaaaaa'))
    expect((await listRuns(root)).map((r) => r.run_id), 'newest first').toEqual([c, b, a])
    expect((await listRuns(root, { limit: 2 })).map((r) => r.run_id)).toEqual([c, b])
    expect((await listRuns(root, { status: 'failed' })).map((r) => r.run_id)).toEqual([c, b])
    expect((await listRuns(root, { flowFile: '/home/u/flows/save.nawi.yaml' })).map((r) => r.run_id)).toEqual([b, a])
    const first = (await listRuns(root, { limit: 1 }))[0]
    expect(first, 'summary has totals and the failing step, not the steps').toMatchObject({ status: 'failed', failed_step_id: 'a', totals: { failed: 1 } })
    expect(first).not.toHaveProperty('steps')
  })

  it('listRuns skips an unreadable run without counting it against the limit, and is empty without a runs folder', async () => {
    const a = await save(T0, 'passed')
    mkdirSync(join(root, '20261102T103910000Z-badbad'))
    expect((await listRuns(root, { limit: 1 })).map((r) => r.run_id), 'bad newest run skipped, older one returned').toEqual([a])
    expect(await listRuns(join(root, 'nope'))).toEqual([])
  })
})

describe('toHtmlReport: drift and intent (AI1)', () => {
  const DRIFTED: FlowRun = {
    status: 'passed',
    startedAt: T0,
    durationMs: 300,
    steps: [
      {
        id: 'open',
        action: 'click',
        status: 'passed',
        intent: 'Open the <invoices> list',
        matched: { index: 0, selector: { testid: 'invoices' }, layer: 'testid', fallback: false }
      },
      {
        id: 'save',
        action: 'click',
        status: 'passed',
        matched: { index: 1, selector: { text: 'Save' }, layer: 'text', fallback: true },
        misses: [{ index: 0, selector: { testid: 'save' }, found: 0 }]
      }
    ]
  }

  it('names the layer that matched, flags a fallback on the step and links it from a drift note at the top', () => {
    const { record, assets } = build(DRIFTED)
    const html = toHtmlReport(record, assets)
    expect(html, 'first step matched by its primary locator, no drift mark').toContain('Matched locator 0 by testid: testid=invoices</div>')
    expect(html, 'second step: layer and fallback mark').toContain('Matched locator 1 by text: text=Save <span class="drift">fallback')
    expect(html, 'drift note links the drifting step').toContain('1 step found its target only by a fallback locator: <a href="#step-2">save</a>')
    expect(html, 'intent shown and escaped').toContain('<div class="intent">Open the &lt;invoices&gt; list</div>')
  })

  it('marks no drift on a failed step even when its target came from a fallback', () => {
    const failedStep = { ...DRIFTED.steps[1], status: 'failed' as const, error: 'it is not visible' }
    const { record, assets } = build({ ...DRIFTED, status: 'failed', failedStepId: 'save', steps: [DRIFTED.steps[0], failedStep] })
    const html = toHtmlReport(record, assets)
    expect(html).toContain('Matched locator 1 by text: text=Save</div>')
    expect(html).not.toContain('class="drift"')
  })

  it('has no drift note when no step needed a fallback', () => {
    const { record, assets } = build({ ...DRIFTED, steps: [DRIFTED.steps[0]] })
    expect(toHtmlReport(record, assets)).not.toContain('class="drift"')
  })

  it('still renders a record written before AI1 (matched without layer) without inventing one', () => {
    const { record, assets } = build(DRIFTED)
    const old = { ...record, steps: record.steps.map((s) => (s.matched ? { ...s, matched: { index: s.matched.index, selector: s.matched.selector } } : s)) }
    delete (old as Partial<typeof old>).fallback_step_ids
    const html = toHtmlReport(old as typeof record, assets)
    expect(html).toContain('Matched locator 0: testid=invoices</div>')
    expect(html).not.toContain('class="drift"')
  })
})

describe('toHtmlReport: network by step (roadmap DT1)', () => {
  const entry = (step: Record<string, unknown>, url: string, status: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...step,
    _t_ms: 1500,
    time: 42,
    request: { method: 'GET', url },
    response: { status, ...extra }
  })
  const withHar = (entries: Array<Record<string, unknown>>): { record: RunRecord; assets: Map<string, Buffer> } =>
    build({
      ...RUN,
      steps: [{ id: 's1', action: 'click', status: 'passed' }, { id: 's2', action: 'click', status: 'passed' }],
      network: { log: { version: '1.2', creator: { name: 'Nawi', version: '0' }, pages: [], entries } } as unknown as NonNullable<FlowRun['network']>
    })

  it("lists each step's requests under that step, escaped, failures marked, and the opening's under the opening", () => {
    const { record, assets } = withHar([
      entry({ _opening: true }, 'https://app.example/', 200),
      entry({ _step_id: 's2' }, 'https://app.example/api?q=<script>alert(3)</script>', 500),
      entry({ _step_id: 's2' }, 'https://cdn.example/x.js', 0, { _error: 'net::ERR_BLOCKED_BY_CLIENT' })
    ])
    const html = toHtmlReport(record, assets)
    expect(html, 'page text never becomes markup').not.toContain('<script>alert(3)')
    const s1 = html.slice(html.indexOf('id="step-1"'), html.indexOf('id="step-2"'))
    const s2 = html.slice(html.indexOf('id="step-2"'))
    expect(s1, 'step 1 sent nothing').not.toContain('Network (')
    expect(s2).toContain('<summary>Network (2 requests)</summary>')
    expect(s2).toContain('<li class="failed">GET https://app.example/api?q=&lt;script&gt;alert(3)&lt;/script&gt; <span class="muted">500 · 42 ms · at 1.50 s</span></li>')
    expect(s2).toContain('<li class="failed">GET https://cdn.example/x.js <span class="muted">net::ERR_BLOCKED_BY_CLIENT · 42 ms · at 1.50 s</span></li>')
    const opening = html.slice(html.indexOf('While opening the target'), html.indexOf('id="step-1"'))
    expect(opening).toContain('<summary>Network (1 request)</summary><ul><li>GET https://app.example/ <span class="muted">200')
    expect(html).toContain('Every request of the run, by step, is in network.har')
  })

  it('shows a request still open when the run ended as open, not as a failure or a 0 ms answer', () => {
    const { record, assets } = withHar([entry({ _step_id: 's1', _unfinished: true }, 'https://app.example/poll', 0)])
    const html = toHtmlReport(record, assets)
    expect(html).toContain('<li>GET https://app.example/poll <span class="muted">no response yet · still open when the run ended · at 1.50 s</span></li>')
  })

  it('lists at most MAX_REPORT_REQUESTS_PER_STEP requests per step and points to network.har for the rest', () => {
    const { record, assets } = withHar(Array.from({ length: MAX_REPORT_REQUESTS_PER_STEP + 7 }, (_, i) => entry({ _step_id: 's1' }, `https://app.example/${i}`, 200)))
    const html = toHtmlReport(record, assets)
    expect(html.match(/https:\/\/app\.example\/\d+ </g), 'listed requests').toHaveLength(MAX_REPORT_REQUESTS_PER_STEP)
    expect(html).toContain('<li class="muted">7 more in network.har</li>')
  })

  it('still renders when network.har is not a HAR, and shows no network section without one', () => {
    const { record, assets } = withHar([entry({ _step_id: 's1' }, 'https://app.example/', 200)])
    assets.set('network.har', Buffer.from('{not json'))
    expect(toHtmlReport(record, assets)).not.toContain('Network (')
    expect(toHtmlReport(build().record, build().assets)).not.toContain('network.har')
  })
})

describe('toHtmlReport: the run trace (roadmap DT1b)', () => {
  it('points to trace.json when the run has one', () => {
    const { record, assets } = build({ ...RUN, trace: { traceEvents: [], metadata: { nawi: { dropped_events: 0, other_process_events: 0 } } } })
    expect(toHtmlReport(record, assets)).toContain("The run's performance trace is in trace.json next to this report")
  })

  it('says why there is none, escaped, when the browser would not trace', () => {
    const { record, assets } = build({ ...RUN, traceError: 'the browser would not start a trace: <b>busy</b>' })
    expect(toHtmlReport(record, assets)).toContain('No performance trace: the browser would not start a trace: &lt;b&gt;busy&lt;/b&gt;')
  })

  it('says nothing about traces for a run that did not ask for one', () => {
    expect(toHtmlReport(build().record, build().assets)).not.toMatch(/trace\.json|performance trace/i)
  })
})

describe('toHtmlReport: console and DOM changes by step (roadmap DT1c)', () => {
  const entry = (where: Record<string, unknown>, level: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    t_ms: 1500,
    ...where,
    level,
    source: 'console',
    message,
    ...extra
  })
  const withConsole = (entries: Array<Record<string, unknown>>, counts: Record<string, number> = {}): { record: RunRecord; assets: Map<string, Buffer> } =>
    build({
      ...RUN,
      steps: [
        { id: 's1', action: 'click', status: 'passed', domMutations: { added: 1, removed: 0, attributes: 2, text: 1 } },
        { id: 's2', action: 'click', status: 'passed', consoleCounts: counts, domMutations: { added: 0, removed: 0, attributes: 0, text: 0, navigated: true } }
      ],
      console: { version: 1, entries } as unknown as NonNullable<FlowRun['console']>
    })

  it("lists each step's console messages under it, escaped, errors marked, with counts by level, and the opening's under the opening", () => {
    const { record, assets } = withConsole(
      [
        entry({ opening: true }, 'debug', 'boot'),
        entry({ step_id: 's2' }, 'error', '<img src=x onerror=alert(1)>', { location: 'https://app.example/app.js:3:9' }),
        entry({ step_id: 's2' }, 'info', 'hello')
      ],
      { error: 1, info: 1 }
    )
    const html = toHtmlReport(record, assets)
    expect(html, 'page text never becomes markup').not.toContain('<img src=x')
    const s1 = html.slice(html.indexOf('id="step-1"'), html.indexOf('id="step-2"'))
    const s2 = html.slice(html.indexOf('id="step-2"'))
    expect(s1, 'step 1 logged nothing').not.toContain('Console (')
    expect(s1).toContain('DOM: 1 node added, 0 removed, 2 attribute changes, 1 text change')
    expect(s2).toContain('<summary>Console (1 error, 1 info)</summary>')
    expect(s2).toContain('<li class="failed"><span class="muted">error</span> &lt;img src=x onerror=alert(1)&gt; <span class="muted">at 1.50 s · https://app.example/app.js:3:9</span></li>')
    expect(s2).toContain('<li><span class="muted">info</span> hello <span class="muted">at 1.50 s</span></li>')
    expect(s2).toContain('DOM: 0 nodes added, 0 removed, 0 attribute changes, 0 text changes (a new page loaded: counts are from it)')
    const opening = html.slice(html.indexOf('While opening the target'), html.indexOf('id="step-1"'))
    expect(opening).toContain('<li><span class="muted">debug</span> boot')
    expect(html).toContain('Every console message of the run (all levels), by step, is in console.json')
  })

  it('lists at most MAX_REPORT_CONSOLE_PER_STEP messages per step, points to console.json for the rest, and says which were never kept', () => {
    const many = Array.from({ length: MAX_REPORT_CONSOLE_PER_STEP + 7 }, (_, i) => entry({ step_id: 's2' }, 'info', `line ${i}`))
    const { record, assets } = withConsole(many, { info: MAX_REPORT_CONSOLE_PER_STEP + 10 })
    const html = toHtmlReport(record, assets)
    expect(html.match(/line \d+ </g), 'listed messages').toHaveLength(MAX_REPORT_CONSOLE_PER_STEP)
    expect(html, 'the file holds 7 more of this step').toContain('<li class="muted">7 more in console.json</li>')
    expect(html, 'counted past the file cap').toContain(`<li class="muted">3 more not kept (past the run's console cap)</li>`)
  })

  it('still renders when console.json is not one, and says nothing about a console without one', () => {
    const { record, assets } = withConsole([entry({ step_id: 's2' }, 'info', 'x')])
    assets.set('console.json', Buffer.from('{not json'))
    expect(toHtmlReport(record, assets)).not.toContain('<li><span class="muted">info</span> x')
    expect(toHtmlReport(build().record, build().assets)).not.toMatch(/console\.json|Console \(|DOM: /)
  })
})

