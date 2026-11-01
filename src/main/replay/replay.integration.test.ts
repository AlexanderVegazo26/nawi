import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CdpClient } from '../cdp/client'
import { findBrowserExecutable, launchDebugBrowser, type LaunchedBrowser } from '../cdp/launcher'
import { FlowSchema, parseFlow, type Flow, type FlowStep } from '@shared/flow'
import { replayFlow, type FlowRun, type ReplayOptions } from './replay'

/**
 * The replayer against a real Chromium, launched by our own launcher and
 * driven only by our own CDP client (Playwright merely downloads the browser).
 * The fixture page delays elements, covers a button and disables another for
 * ~300 ms, so auto-waiting is exercised by conditions, never by sleeps.
 */

const APP = pathToFileURL(resolve(__dirname, '__fixtures__/app.html')).href
const PAGE2 = pathToFileURL(resolve(__dirname, '__fixtures__/page2.html')).href
const PASSWORD = 'hunter2-replay-secret'
/** Quote, backslash, double space and an ampersand: changed by JSON escaping, whitespace folding and URL encoding. */
const ODD_SECRET = 'odd"pass\\word  & more'
const SECRETS: Record<string, string> = { pw: PASSWORD, odd: ODD_SECRET }

const executable = findBrowserExecutable(['playwright-chromium'])
const TEST_BROWSER_ARGS = process.platform === 'linux' ? ['--no-sandbox'] : []
const describeWithBrowser = executable ? describe : describe.skip
if (!executable) console.warn('[replay.integration] no Playwright Chromium found; replay tests SKIPPED, not passed')

function flow(steps: FlowStep[], url = APP, extra: Partial<Flow> = {}): Flow {
  return FlowSchema.parse({ version: 1, name: 'test', target: { kind: 'browser', url }, steps, ...extra })
}

/** Every step's status, for one readable assertion. */
const statuses = (run: FlowRun): string[] => run.steps.map((s) => `${s.id}:${s.status}`)
const why = (run: FlowRun): string => JSON.stringify({ error: run.error, steps: run.steps }, null, 1)

describeWithBrowser('replayFlow against a real Chromium', () => {
  let browser: LaunchedBrowser
  let client: CdpClient
  let sessionId: string

  const replay = (f: Flow, options: ReplayOptions = {}): Promise<FlowRun> =>
    replayFlow(client, f, { sessionId, secret: (n) => SECRETS[n], ...options })

  /** Read something off the page after a run, through the same session. */
  const read = async (expression: string): Promise<unknown> => {
    const r = await client.send<{ result: { value: unknown } }>('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
    return r.result.value
  }

  beforeAll(async () => {
    browser = await launchDebugBrowser({
      prefer: ['playwright-chromium'],
      headless: true,
      extraArgs: [...TEST_BROWSER_ARGS, '--window-size=1280,800'],
      startUrl: 'about:blank'
    })
    client = await CdpClient.connect(await browser.endpoint.browserWebSocketUrl(), { commandTimeoutMs: 20_000 })
    const attached = new Promise<string>((done) => {
      const off = client.on('Target.attachedToTarget', (event) => {
        const info = event.params.targetInfo as { type?: string } | undefined
        if (info?.type === 'page' && typeof event.params.sessionId === 'string') {
          off()
          done(event.params.sessionId)
        }
      })
    })
    await client.setAutoAttach()
    sessionId = await attached
    await client.send('Page.enable', {}, sessionId)
    await client.send('Runtime.enable', {}, sessionId)
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId)
  }, 90_000)

  afterAll(async () => {
    client?.close()
    await browser?.close()
  })

  it('replays a flow file end to end: fill, secret fill, select by label, Enter submits, assert text', async () => {
    const parsed = parseFlow(`version: 1
name: Sign in
target: { kind: browser, url: "${APP}" }
vars: { email: "\${env.TEST_EMAIL}" }
steps:
  - { id: s1, action: fill, target: { selectors: [{ testid: login-email }] }, value: "\${vars.email}" }
  - { id: s2, action: fill, target: { selectors: [{ css: "#password" }] }, value: "\${secret.pw}" }
  - { id: s3, action: select, target: { selectors: [{ id: plan }] }, value: Professional }
  - { id: s4, action: press, target: { selectors: [{ id: password }] }, key: Enter }
  - { id: s5, action: assert, target: { selectors: [{ role: status }] }, expect: { text: "Welcome a@b.example, plan pro" } }
`)
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
    if (!parsed.ok) return
    const run = await replay(parsed.flow, { env: { TEST_EMAIL: 'a@b.example' } })
    expect(run.status, why(run)).toBe('passed')
    expect(statuses(run)).toEqual(['s1:passed', 's2:passed', 's3:passed', 's4:passed', 's5:passed'])
    expect(await read(`document.getElementById('echo').textContent`), 'the secret reached the field').toBe(`pw:${PASSWORD}`)
    expect(JSON.stringify(run), 'the run record never carries the secret').not.toContain(PASSWORD)
    expect(run.steps[0].matched).toEqual({ index: 0, selector: { testid: 'login-email' } })
  })

  it('falls back to the next locator when the first is gone, and records the miss', async () => {
    const run = await replay(
      flow([{ id: 'c', action: 'click', target: { selectors: [{ testid: 'renamed' }, { id: 'a-btn' }] } }])
    )
    expect(run.status, why(run)).toBe('passed')
    expect(run.steps[0].matched).toEqual({ index: 1, selector: { id: 'a-btn' } })
    expect(run.steps[0].misses).toEqual([{ index: 0, selector: { testid: 'renamed' }, found: 0 }])
    expect(await read(`document.getElementById('clicked').textContent`), 'a trusted click reached #a-btn').toBe('a-btn')
  })

  it('skips an ambiguous locator (2 matches) instead of clicking the first match', async () => {
    const run = await replay(
      flow([{ id: 'c', action: 'click', target: { selectors: [{ css: '.btn' }, { role: 'button', name: 'B' }] } }])
    )
    expect(run.status, why(run)).toBe('passed')
    expect(run.steps[0].misses).toEqual([{ index: 0, selector: { css: '.btn' }, found: 2 }])
    expect(await read(`document.getElementById('clicked').textContent`)).toBe('b-btn')
  })

  it('auto-waits for an element that appears later, one that is disabled, and one under an overlay', async () => {
    const run = await replay(
      flow(
        [
          { id: 'late', action: 'click', target: { selectors: [{ id: 'late' }] } },
          { id: 'covered', action: 'click', target: { selectors: [{ id: 'covered' }] } },
          { id: 'count', action: 'assert', target: { selectors: [{ testid: 'covered-count' }] }, expect: { text: '1' } },
          { id: 'enabled', action: 'click', target: { selectors: [{ id: 'enable-me' }] } },
          { id: 'check', action: 'assert', target: { selectors: [{ testid: 'clicked' }] }, expect: { text: 'enabled' } }
        ],
        `${APP}?overlay=1`
      )
    )
    expect(run.status, why(run)).toBe('passed')
  })

  it('fails the first broken step with what every locator found, stops there, and skips disabled steps', async () => {
    const run = await replay(
      flow([
        { id: 'off', action: 'click', disabled: true, target: { selectors: [{ id: 'nope' }] } },
        { id: 'broken', action: 'click', timeout_ms: 300, target: { selectors: [{ testid: 'gone' }, { css: '.btn' }] } },
        { id: 'after', action: 'click', target: { selectors: [{ id: 'a-btn' }] } }
      ])
    )
    expect(run.status).toBe('failed')
    expect(run.failedStepId).toBe('broken')
    expect(statuses(run)).toEqual(['off:skipped', 'broken:failed', 'after:not_run'])
    expect(run.steps[1].error).toBe(
      'no locator matched exactly one element within 300 ms — testid=gone: no element; css=.btn: 2 elements (ambiguous)'
    )
    expect(await read(`document.getElementById('clicked').textContent`), 'the step after the failure never ran').toBe('')
  })

  it('fails fast (no waiting out the timeout) when the element can never take the action', async () => {
    const run = await replay(
      flow([{ id: 'f', action: 'fill', timeout_ms: 4_000, target: { selectors: [{ id: 'a-btn' }] }, value: 'x' }])
    )
    expect(run.status).toBe('failed')
    expect(run.steps[0].error).toBe('id=a-btn matched but it is not a text field (button#a-btn)')
    expect(run.steps[0].durationMs!, 'a permanent mismatch should not wait for the 4 s timeout').toBeLessThan(2_000)
  })

  it('scrubs secret values out of a failed assertion message', async () => {
    const run = await replay(
      flow([
        { id: 'pw', action: 'fill', target: { selectors: [{ id: 'password' }] }, value: '${secret.pw}' },
        { id: 'go', action: 'press', target: { selectors: [{ id: 'password' }] }, key: 'Enter' },
        { id: 'a', action: 'assert', timeout_ms: 300, target: { selectors: [{ testid: 'echo' }] }, expect: { text: 'something else' } }
      ])
    )
    expect(run.status).toBe('failed')
    expect(run.steps[2].error).toBe(
      'assertion failed after 300 ms: expected text containing "something else", got "pw:${secret.pw}"'
    )
    expect(JSON.stringify(run)).not.toContain(PASSWORD)
  })

  it('refuses to start when an input is missing, naming each one, and runs nothing', async () => {
    const run = await replay(
      flow(
        [
          { id: 'a', action: 'fill', target: { selectors: [{ id: 'email' }] }, value: '${env.NOPE_EMAIL}' },
          { id: 'b', action: 'fill', target: { selectors: [{ id: 'password' }] }, value: '${secret.other}' }
        ]
      ),
      { env: {} }
    )
    expect(run.status).toBe('failed')
    expect(run.error).toBe('the flow needs values the run did not provide: ${env.NOPE_EMAIL}, ${secret.other}')
    expect(statuses(run)).toEqual(['a:not_run', 'b:not_run'])
  })

  it('navigates, follows a link click to a new document, and asserts the URL and a heading', async () => {
    const run = await replay(
      flow([
        { id: 'go', action: 'click', target: { selectors: [{ role: 'link', name: 'Next page' }] } },
        { id: 'url', action: 'assert', expect: { url: PAGE2 } },
        { id: 'h1', action: 'assert', target: { selectors: [{ role: 'heading', name: 'Second page' }] }, expect: { visible: true } },
        { id: 'back', action: 'navigate', url: APP },
        { id: 'gone', action: 'assert', target: { selectors: [{ role: 'heading', name: 'Second page' }] }, expect: { visible: false } }
      ])
    )
    expect(run.status, why(run)).toBe('passed')
  })

  it('hovers, scrolls the page, waits for an element, and takes page and element screenshots', async () => {
    const run = await replay(
      flow([
        { id: 'hover', action: 'hover', target: { selectors: [{ id: 'hover-me' }] } },
        { id: 'hovered', action: 'assert', target: { selectors: [{ testid: 'hovered' }] }, expect: { text: 'yes' } },
        { id: 'scroll', action: 'scroll', delta: [0, 900] },
        { id: 'wait', action: 'wait', target: { selectors: [{ id: 'late' }] } },
        { id: 'page', action: 'screenshot' },
        { id: 'el', action: 'screenshot', target: { selectors: [{ id: 'far' }] } }
      ])
    )
    expect(run.status, why(run)).toBe('passed')
    expect(Number(await read('Math.round(window.scrollY)')), 'scrolled down').toBeGreaterThan(0)
    const page = Buffer.from(run.steps[4].screenshotPng ?? '', 'base64')
    const el = Buffer.from(run.steps[5].screenshotPng ?? '', 'base64')
    expect(page.subarray(1, 4).toString(), 'page screenshot is a PNG').toBe('PNG')
    expect(el.subarray(1, 4).toString(), 'element screenshot is a PNG').toBe('PNG')
    // PNG IHDR width at byte 16: the element crop is narrower than the 1280 px page.
    expect(el.readUInt32BE(16)).toBeLessThan(page.readUInt32BE(16))
  })

  it('never lets a secret into the run record in any form (raw, JSON-escaped, URL-encoded, whitespace-folded)', async () => {
    const run = await replay(
      flow([
        { id: 'pw', action: 'fill', target: { selectors: [{ id: 'password' }] }, value: '${secret.odd}' },
        { id: 'go', action: 'press', target: { selectors: [{ id: 'password' }] }, key: 'Enter' },
        { id: 'a', action: 'assert', timeout_ms: 200, target: { selectors: [{ testid: 'echo' }] }, expect: { text: 'nope' } }
      ])
    )
    expect(run.steps[2].error).toBe('assertion failed after 200 ms: expected text containing "nope", got "pw:${secret.odd}"')

    const nav = await replay(
      flow([
        { id: 'nav', action: 'navigate', url: `${APP}?token=\${secret.odd}` },
        { id: 'u', action: 'assert', timeout_ms: 200, expect: { url: APP } }
      ])
    )
    expect(nav.steps[1].error).toBe(
      `assertion failed after 200 ms: expected URL ${JSON.stringify(APP)}, got ${JSON.stringify(`${APP}?token=\${secret.odd}`)}`
    )
    for (const r of [run, nav]) {
      const text = JSON.stringify(r)
      for (const form of [ODD_SECRET, JSON.stringify(ODD_SECRET).slice(1, -1), encodeURIComponent(ODD_SECRET), encodeURI(ODD_SECRET), 'odd"pass']) {
        expect(text.includes(form), `run record contains the secret as ${form}`).toBe(false)
      }
    }
  })

  it('says why a wait on a present-but-hidden element timed out', async () => {
    const run = await replay(flow([{ id: 'w', action: 'wait', timeout_ms: 200, target: { selectors: [{ id: 'hidden-thing' }] } }]))
    expect(run.steps[0].error).toBe('id=hidden-thing matched but it is not visible (waited 200 ms)')
  })

  it('uses a wait step\'s ms as its timeout when it also has a target', async () => {
    const steps: FlowStep[] = [{ id: 'w', action: 'wait', ms: 4_000, target: { selectors: [{ id: 'late' }] } }]
    const run = await replay(flow(steps, `${APP}?late=600`), { defaultTimeoutMs: 100 })
    expect(run.status, why(run)).toBe('passed')
  })

  it('clicks a visually hidden checkbox through the element its label draws on top', async () => {
    const run = await replay(flow([{ id: 'agree', action: 'click', timeout_ms: 1_000, target: { selectors: [{ id: 'agree' }] } }]))
    expect(run.status, why(run)).toBe('passed')
    expect(await read(`document.getElementById('agree').checked`)).toBe(true)
  })

  it('fills a date input by setting its value, and refuses a value in the wrong format without waiting', async () => {
    const ok = await replay(flow([{ id: 'd', action: 'fill', target: { selectors: [{ id: 'dob' }] }, value: '1990-01-31' }]))
    expect(ok.status, why(ok)).toBe('passed')
    expect(await read(`document.getElementById('dob').value`)).toBe('1990-01-31')

    const bad = await replay(flow([{ id: 'd', action: 'fill', target: { selectors: [{ id: 'dob' }] }, value: '01/31/1990' }]))
    expect(bad.steps[0].error).toBe(
      'id=dob matched but it rejected the value (a date input expects its own format, e.g. 2026-01-31 for a date)'
    )
  })

  it('dismisses a confirm() the step opened and records it on the step, instead of hanging', async () => {
    const run = await replay(
      flow([
        { id: 'del', action: 'click', target: { selectors: [{ id: 'delete' }] } },
        { id: 'r', action: 'assert', target: { selectors: [{ testid: 'confirmed' }] }, expect: { text: 'false' } }
      ])
    )
    expect(run.status, why(run)).toBe('passed')
    expect(run.steps[0].dialogs).toEqual([{ type: 'confirm', message: 'Delete it?' }])
    expect(run.steps[1].dialogs).toBeUndefined()
  })

  it('removes its page helpers when the run ends, so replays do not pile up on the session', async () => {
    await replay(flow([{ id: 'c', action: 'click', target: { selectors: [{ id: 'a-btn' }] } }]))
    await client.send('Page.navigate', { url: PAGE2 }, sessionId)
    await expect.poll(() => read('document.readyState')).toBe('complete')
    expect(await read('typeof window.__nawiReplay'), 'helpers still injected into a new document').toBe('undefined')
  })

  it('runs on the already-open page with openTarget: false, without needing the target URL\'s inputs', async () => {
    await client.send('Page.navigate', { url: APP }, sessionId)
    await expect.poll(() => read('document.readyState')).toBe('complete')
    const f = flow([{ id: 'c', action: 'click', target: { selectors: [{ id: 'b-btn' }] } }], '${env.UNSET_BASE}/app.html')
    const run = await replay(f, { openTarget: false, env: {} })
    expect(run.status, why(run)).toBe('passed')
    expect(await read(`document.getElementById('clicked').textContent`)).toBe('b-btn')
  })

  it('fails a select whose option is disabled or missing, with the reason', async () => {
    const run = await replay(
      flow([{ id: 'plan', action: 'select', timeout_ms: 300, target: { selectors: [{ id: 'plan' }] }, value: 'Legacy' }])
    )
    expect(run.status).toBe('failed')
    expect(run.steps[0].error).toBe('id=plan matched but that option is disabled (waited 300 ms)')
  })
})
