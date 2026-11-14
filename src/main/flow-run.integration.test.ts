import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findBrowserExecutable, launchDebugBrowser, type LaunchedBrowser } from './cdp/launcher'
import { defaultOpenPage, runFlowFile, type FlowRunReport, type RunFlowDeps } from './flow-run'
import { TEST_BROWSER_ARGS } from './cdp/test-browser-args'

/**
 * `run_flow` end to end against a real Chromium: the flow is read from disk,
 * the app's own launcher starts the browser (or attaches to one), and the
 * replayer drives the replay fixture page. Nothing is mocked.
 */

const APP = pathToFileURL(resolve(__dirname, 'replay/__fixtures__/app.html')).href
const PASSWORD = 'hunter2-run-flow-secret'
const executable = findBrowserExecutable(['playwright-chromium'])
const describeWithBrowser = executable ? describe : describe.skip
if (!executable) console.warn('[flow-run.integration] no Playwright Chromium found; run_flow tests SKIPPED, not passed')

const SIGN_IN = `version: 1
name: Sign in
target: { kind: browser, url: "${APP}" }
vars: { email: "\${env.TEST_EMAIL}", plan: Free }
steps:
  - { id: s1, action: fill, target: { selectors: [{ testid: login-email }] }, value: "\${vars.email}" }
  - { id: s2, action: fill, target: { selectors: [{ css: "#password" }] }, value: "\${secret.pw}" }
  - { id: s3, action: select, target: { selectors: [{ id: plan }] }, value: "\${vars.plan}" }
  - { id: s4, action: press, target: { selectors: [{ id: password }] }, key: Enter }
  - { id: s5, action: assert, target: { selectors: [{ role: status }] }, expect: { text: "Welcome a@b.example, plan pro" } }
  - { id: s6, action: screenshot }
`

const why = (r: FlowRunReport): string => JSON.stringify(r, null, 1)

describeWithBrowser('runFlowFile against a real Chromium', () => {
  let root: string
  const deps = (extra: Partial<RunFlowDeps> = {}): RunFlowDeps => ({
    roots: [root],
    launch: { prefer: ['playwright-chromium'], extraArgs: [...TEST_BROWSER_ARGS, '--window-size=1280,800'] },
    ...extra
  })
  const write = (name: string, text: string): string => {
    const file = join(root, name)
    writeFileSync(file, text)
    return file
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'nawi-run-flow-'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('launches a browser, runs the file with a --var override, env and a secret, and reports every step', async () => {
    const file = write('sign-in.nawi.yaml', SIGN_IN)
    const report = await runFlowFile(
      { file, headless: true, vars: { plan: 'Professional' }, env: { TEST_EMAIL: 'a@b.example' }, secrets: { pw: PASSWORD } },
      deps()
    )
    expect(report.status, why(report)).toBe('passed')
    expect(report.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['s1:passed', 's2:passed', 's3:passed', 's4:passed', 's5:passed', 's6:passed'])
    expect(report.flow).toBe('Sign in')
    expect(report.steps[5].screenshot_bytes, 'the screenshot is summarised, not inlined').toBeGreaterThan(1000)
    expect(JSON.stringify(report), 'no screenshot bytes and no secret in the reply').not.toMatch(new RegExp(`screenshotPng|${PASSWORD}`))
    expect(report.steps.filter((st) => st.shots), 'no run record, so no step screenshots').toEqual([])
  }, 60_000)

  it('keeps only the failing step\'s page with screenshots: failed', async () => {
    const file = write('sign-in-failed-shots.nawi.yaml', SIGN_IN)
    const runs = join(root, 'runs-failed')
    const report = await runFlowFile(
      { file, headless: true, env: { TEST_EMAIL: 'a@b.example' }, secrets: { pw: PASSWORD }, stepTimeoutMs: 1500, screenshots: 'failed' },
      deps({ record: { dir: runs } })
    )
    expect(report.failed_step_id, why(report)).toBe('s5')
    expect(report.steps.map((st) => st.shots ?? null)).toEqual([null, null, null, null, { after: 'steps/005-s5.after.jpg' }, null])
    expect(readdirSync(join(report.run_dir!, 'steps'))).toEqual(['005-s5.after.jpg'])
  }, 60_000)

  it('saves a run record: run.json, junit.xml and the screenshot step\'s PNG, with no secret in any file', async () => {
    const file = write('sign-in-record.nawi.yaml', SIGN_IN)
    const runs = join(root, 'runs')
    const report = await runFlowFile(
      { file, headless: true, env: { TEST_EMAIL: 'a@b.example' }, secrets: { pw: PASSWORD }, vars: { plan: 'Professional' } },
      deps({ record: { dir: runs, appVersion: '0.1.0-test' } })
    )
    expect(report.status, why(report)).toBe('passed')
    expect(report.run_dir, why(report)).toBe(join(runs, report.run_id!))
    const dir = report.run_dir!
    const record = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
    expect(record).toMatchObject({ version: 1, status: 'passed', flow: { name: 'Sign in' }, totals: { passed: 6, failed: 0 } })
    expect(record.environment.browser?.product, JSON.stringify(record.environment)).toMatch(/Chrom/)
    expect(record.environment.viewport?.width, JSON.stringify(record.environment)).toBeGreaterThan(0)
    const png = readFileSync(join(dir, record.steps[5].screenshot))
    expect(png.subarray(0, 8).toString('hex'), 'the screenshot file is a PNG').toBe('89504e470d0a1a0a')
    expect(png.length, 'same bytes the reply summarised').toBe(report.steps[5].screenshot_bytes)
    expect(readFileSync(join(dir, 'junit.xml'), 'utf8')).toContain('tests="6" failures="0" errors="0" skipped="0"')
    // F4b: the page URL after every step and at the end, in run.json and the reply.
    expect(record.steps.map((st: { url?: string }) => st.url), JSON.stringify(record.steps)).toEqual(Array(6).fill(APP))
    expect(record.final_url).toBe(APP)
    expect(report.final_url).toBe(APP)
    // F4c: the self-contained report is saved with the record.
    const html = readFileSync(join(dir, 'report.html'), 'utf8')
    expect(html, 'report.html names the flow and embeds the screenshots').toContain('<h1>Sign in')
    expect(html).toContain('data:image/jpeg;base64,')
    for (const name of ['run.json', 'junit.xml', 'report.html']) {
      expect(readFileSync(join(dir, name), 'utf8'), `${name} must not hold the secret`).not.toContain(PASSWORD)
    }
    expect(readdirSync(runs), 'no temporary folder left behind').toEqual([report.run_id])
    // F4b2 (default screenshots: all): the page before the first step and after every step, as JPEG files;
    // a step's before is the previous step's after file, stored once.
    const shots = record.steps.map((st: { shots?: { before?: string; after?: string } }) => st.shots)
    expect(shots[0], JSON.stringify(shots)).toEqual({ before: 'steps/001-s1.before.jpg', after: 'steps/001-s1.after.jpg' })
    for (let i = 1; i < 6; i++) {
      const id = `s${i + 1}`
      expect(shots[i].before, `step ${id} before = the previous after`).toBe(shots[i - 1].after)
      // An identical image (a step that changed nothing, like the assert) is stored once, under its first name.
      expect([`steps/00${i + 1}-${id}.after.jpg`, shots[i].before], `step ${id} after`).toContain(shots[i].after)
    }
    const referenced = new Set(shots.flatMap((sh: { before?: string; after?: string }) => [sh.before, sh.after]).filter(Boolean))
    const files = readdirSync(join(dir, 'steps')).sort()
    expect(files, 'every referenced shot plus the screenshot step PNG, nothing else').toEqual(
      [...referenced, record.steps[5].screenshot].map((f) => String(f).slice('steps/'.length)).sort()
    )
    for (const f of files.filter((f) => f.endsWith('.jpg'))) {
      expect(readFileSync(join(dir, 'steps', f)).subarray(0, 3).toString('hex'), `${f} is a JPEG`).toBe('ffd8ff')
    }
    expect(report.steps.map((st) => st.shots), 'the reply names the same files').toEqual(shots)
    expect(JSON.stringify(report), 'the reply carries no image bytes').not.toMatch(/\/9j\//)
  }, 60_000)

  it('DT1b: trace: true saves trace.json in the record, names it in run.json and the reply, never without a record', async () => {
    const file = write('sign-in-trace.nawi.yaml', SIGN_IN)
    const runs = join(root, 'runs-trace')
    const input = { file, headless: true, env: { TEST_EMAIL: 'a@b.example' }, secrets: { pw: PASSWORD }, vars: { plan: 'Professional' }, trace: true }
    const report = await runFlowFile(input, deps({ record: { dir: runs, appVersion: '0.1.0-test' } }))
    expect(report.status, why(report)).toBe('passed')
    expect(report.trace_json, why(report)).toBe('trace.json')
    expect(report.trace_error, why(report)).toBeUndefined()
    const dir = report.run_dir!
    expect(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).trace_json).toBe('trace.json')
    const text = readFileSync(join(dir, 'trace.json'), 'utf8')
    expect(text.includes(PASSWORD), 'the typed secret must not reach the trace').toBe(false)
    const trace = JSON.parse(text) as { traceEvents: Array<{ name?: string; ph?: string; cat?: string }> }
    expect(
      trace.traceEvents.filter((e) => e.cat === 'blink.user_timing' && e.ph === 'b').map((e) => e.name),
      'one measure per step'
    ).toEqual(['Step 1: s1 (fill)', 'Step 2: s2 (fill)', 'Step 3: s3 (select)', 'Step 4: s4 (press)', 'Step 5: s5 (assert)', 'Step 6: s6 (screenshot)'])
    expect(readFileSync(join(dir, 'report.html'), 'utf8')).toContain("The run's performance trace is in trace.json")

    const unrecorded = await runFlowFile(input, deps())
    expect(unrecorded.status, why(unrecorded)).toBe('passed')
    expect('trace_json' in unrecorded || 'trace_error' in unrecorded, 'the trace lives only in a record').toBe(false)
  }, 90_000)

  it('reports the failing step and leaves the rest not_run; the var default applies without an override', async () => {
    const file = write('sign-in-default.nawi.yaml', SIGN_IN)
    const report = await runFlowFile({ file, headless: true, env: { TEST_EMAIL: 'a@b.example' }, secrets: { pw: PASSWORD }, stepTimeoutMs: 1500 }, deps())
    expect(report.status, why(report)).toBe('failed')
    expect(report.failed_step_id).toBe('s5')
    expect(report.steps[4].error, why(report)).toMatch(/plan free/)
    expect(report.steps[5].status).toBe('not_run')
  }, 60_000)

  it('stops between steps when the signal fires (the agent kill switch)', async () => {
    const file = write('stop.nawi.yaml', `version: 1
name: Stop
target: { kind: browser, url: "${APP}" }
steps:
  - { id: c1, action: click, target: { selectors: [{ id: a-btn }] } }
  - { id: c2, action: click, target: { selectors: [{ id: b-btn }] } }
`)
    const stop = new AbortController()
    const open = defaultOpenPage(deps().launch)
    const report = await runFlowFile(
      { file, headless: true },
      deps({
        signal: stop.signal,
        // Pause as soon as the first click lands, while the run is in progress.
        openPage: async (o) => {
          const page = await open(o)
          const send = page.client.send.bind(page.client)
          page.client.send = (async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
            const out = await send(method, params, sessionId)
            if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') stop.abort('agent access was paused')
            return out
          }) as typeof page.client.send
          return page
        }
      })
    )
    expect(report.steps.map((s) => `${s.id}:${s.status}`), why(report)).toEqual(['c1:passed', 'c2:not_run'])
    expect(report.status).toBe('failed')
    expect(report.error).toBe('agent access was paused')
  }, 60_000)

  describe('attached to a browser that is already running', () => {
    let browser: LaunchedBrowser
    beforeAll(async () => {
      browser = await launchDebugBrowser({ prefer: ['playwright-chromium'], headless: true, extraArgs: [...TEST_BROWSER_ARGS], startUrl: 'about:blank' })
    }, 60_000)
    afterAll(async () => browser?.close())

    it('runs in a tab of its own and closes it, leaving the user\'s tabs alone', async () => {
      const pages = async (): Promise<string[]> => (await browser.endpoint.listTargets()).filter((t) => t.type === 'page').map((t) => t.id)
      const before = await pages()
      const file = write('attach.nawi.yaml', `version: 1
name: Attach
target: { kind: browser, url: "${APP}" }
steps:
  - { id: c1, action: click, target: { selectors: [{ id: a-btn }] } }
  - { id: a1, action: assert, target: { selectors: [{ testid: clicked }] }, expect: { text: a-btn } }
`)
      const report = await runFlowFile({ file, cdpEndpoint: `127.0.0.1:${browser.endpoint.port}` }, deps())
      expect(report.status, why(report)).toBe('passed')
      await expect.poll(pages, { message: 'the run closed its own tab and no other' }).toEqual(before)
    }, 60_000)
  })
})
