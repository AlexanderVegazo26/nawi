import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CdpClient } from '../cdp/client'
import { findBrowserExecutable, launchDebugBrowser, type LaunchedBrowser } from '../cdp/launcher'
import { FlowSchema, parseFlow, type Flow, type FlowStep } from '@shared/flow'
import { replayFlow, type FlowRun, type ReplayOptions } from './replay'
import { TEST_BROWSER_ARGS } from '../cdp/test-browser-args'

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

  /** base64 JPEG → its first bytes as hex, for "is this a JPEG". */
  const magic = (b64: string | undefined): string => Buffer.from(b64 ?? '', 'base64').subarray(0, 3).toString('hex')

  it('takes the page before the first step and after every step with stepScreenshots: all', async () => {
    const run = await replay(
      flow([
        { id: 'a', action: 'click', target: { selectors: [{ id: 'a-btn' }] } },
        { id: 'off', action: 'click', disabled: true, target: { selectors: [{ id: 'nope' }] } },
        { id: 'b', action: 'click', target: { selectors: [{ id: 'b-btn' }] } }
      ]),
      { stepScreenshots: 'all' }
    )
    expect(run.status, why(run)).toBe('passed')
    const [a, off, b] = run.steps
    expect(magic(a.shots?.before), 'first step has a before JPEG').toBe('ffd8ff')
    expect(magic(a.shots?.after), 'first step has an after JPEG').toBe('ffd8ff')
    expect(a.shots?.before, 'the click changed the page, so before and after differ').not.toBe(a.shots?.after)
    expect(off.shots, 'a disabled step takes no screenshots').toBeUndefined()
    expect(b.shots?.before === a.shots?.after, "b's before is a's after (the disabled step did nothing)").toBe(true)
    expect(magic(b.shots?.after)).toBe('ffd8ff')
  })

  it('with stepScreenshots: failed, keeps only the page the failing step left; by default takes none', async () => {
    const steps: FlowStep[] = [
      { id: 'ok', action: 'click', target: { selectors: [{ id: 'a-btn' }] } },
      { id: 'bad', action: 'click', timeout_ms: 200, target: { selectors: [{ id: 'gone' }] } },
      { id: 'later', action: 'click', target: { selectors: [{ id: 'b-btn' }] } }
    ]
    const failed = await replay(flow(steps), { stepScreenshots: 'failed' })
    expect(failed.steps.map((s) => Object.keys(s.shots ?? {}).join('+'))).toEqual(['', 'after', ''])
    expect(magic(failed.steps[1].shots?.after)).toBe('ffd8ff')
    const none = await replay(flow(steps))
    expect(none.steps.some((s) => s.shots !== undefined), 'no shots unless asked for').toBe(false)
  })

  it('draws a field that received a secret (directly or through a var) as discs in every screenshot, then restores it', async () => {
    /** Fill #email, move focus away (no caret), then crop the field. */
    const shoot = async (value: string, secret: Record<string, string> = {}): Promise<{ crop: string; run: FlowRun }> => {
      const run = await replay(
        flow(
          [
            { id: 'f', action: 'fill', target: { selectors: [{ id: 'email' }] }, value },
            { id: 'blur', action: 'click', target: { selectors: [{ id: 'hover-me' }] } },
            { id: 'shot', action: 'screenshot', target: { selectors: [{ id: 'email' }] } }
          ],
          APP,
          { vars: { viaVar: '${secret.b}' } }
        ),
        { secret: (n) => secret[n], stepScreenshots: 'all' }
      )
      expect(run.status, why(run)).toBe('passed')
      return { crop: run.steps[2].screenshotPng ?? '', run }
    }
    const plainW = await shoot('WWWWWWWW', { b: 'x' })
    const plainI = await shoot('iiiiiiii', { b: 'x' })
    expect(plainW.crop, 'control: unmasked text shows in the crop').not.toBe(plainI.crop)

    const secretW = await shoot('${secret.a}', { a: 'WWWWWWWW', b: 'x' })
    const secretI = await shoot('${vars.viaVar}', { b: 'iiiiiiii' })
    expect(secretW.crop, 'a masked secret field shows only its length').toBe(secretI.crop)
    expect(secretW.crop, 'the masked crop is not the plain text').not.toBe(plainW.crop)
    // The page shots are masked the same way: two different secrets give the same after image.
    expect(secretW.run.steps[1].shots?.after === secretI.run.steps[1].shots?.after, 'after-shots identical when masked').toBe(true)
    expect(plainW.run.steps[1].shots?.after === plainI.run.steps[1].shots?.after, 'control: plain after-shots differ').toBe(false)
    expect(await read(`document.getElementById('email').style.getPropertyValue('-webkit-text-security')`), 'mask removed after capture').toBe('')
  })

  it('never takes a screenshot while a secret field cannot be masked (fails closed)', async () => {
    const run = await replay(
      flow([
        { id: 'f', action: 'fill', target: { selectors: [{ id: 'email' }] }, value: '${secret.pw}' },
        { id: 'clobber', action: 'press', key: 'F9' },
        { id: 'shot', action: 'screenshot' }
      ]),
      { stepScreenshots: 'all' }
    )
    expect(magic(run.steps[0].shots?.after), 'masking worked before the page lost the helpers').toBe('ffd8ff')
    expect(run.steps[1].shots?.after, 'no after-shot once the field cannot be masked').toBeUndefined()
    expect(run.steps[2].status).toBe('failed')
    expect(run.steps[2].error).toBe('the fields that received a secret could not be masked, so no screenshot was taken')
    expect(run.steps[2].screenshotPng).toBeUndefined()
  })

  it('a late unmask from an older capture leaves a newer mask in place', async () => {
    await replay(flow([{ id: 'c', action: 'click', target: { selectors: [{ id: 'a-btn' }] } }]))
    const prop = `document.getElementById('email').style.getPropertyValue('-webkit-text-security')`
    const g1 = await read(`window.__nawiReplay.mask([[{ id: 'email' }]]).generation`)
    const g2 = await read(`window.__nawiReplay.mask([[{ id: 'email' }]]).generation`)
    expect(g2, 'each mask call has its own generation').not.toBe(g1)
    await read(`window.__nawiReplay.unmask(${JSON.stringify(g1)})`)
    expect(await read(prop), 'the older capture finishing late must not unmask the newer one').toBe('disc')
    await read(`window.__nawiReplay.unmask(${JSON.stringify(g2)})`)
    expect(await read(prop), 'the current capture restores the field').toBe('')
  })

  it('stops taking step screenshots for the run once one times out, instead of waiting on every step', async () => {
    let jpegCalls = 0
    const hanging = {
      send: <T,>(method: string, params?: Record<string, unknown>, sid?: string): Promise<T> => {
        if (method === 'Page.captureScreenshot' && params?.format === 'jpeg') {
          jpegCalls++
          return new Promise<T>(() => undefined)
        }
        return client.send<T>(method, params, sid)
      },
      on: client.on.bind(client)
    }
    const run = await replayFlow(
      hanging,
      flow([
        { id: 'a', action: 'click', target: { selectors: [{ id: 'a-btn' }] } },
        { id: 'b', action: 'click', target: { selectors: [{ id: 'b-btn' }] } },
        { id: 'c', action: 'click', target: { selectors: [{ id: 'a-btn' }] } }
      ]),
      { sessionId, stepScreenshots: 'all' }
    )
    expect(run.status, why(run)).toBe('passed')
    expect(jpegCalls, 'one capture tried, then given up for the run').toBe(1)
    expect(run.steps.every((s) => s.shots === undefined), 'no shots at all').toBe(true)
  }, 20_000)

  /** The real client, except that commands `hangs` picks never answer; records every method sent. */
  const hangingOn = (hangs: (method: string, params?: Record<string, unknown>) => boolean) => {
    const sent: string[] = []
    return {
      sent,
      client: {
        send: <T,>(method: string, params?: Record<string, unknown>, sid?: string): Promise<T> => {
          sent.push(method === 'Input.dispatchMouseEvent' ? `${method}:${String(params?.type)}` : method)
          if (hangs(method, params)) return new Promise<T>(() => undefined)
          return client.send<T>(method, params, sid)
        },
        on: client.on.bind(client)
      }
    }
  }

  it("fails a step whose Input command hangs at its timeout_ms (+ grace), not the client's 20 s command timeout, and sends nothing after it", async () => {
    const { client: hanging, sent } = hangingOn(
      (method, params) => method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed'
    )
    const started = Date.now()
    const run = await replayFlow(
      hanging,
      flow([
        { id: 'a', action: 'click', timeout_ms: 500, target: { selectors: [{ id: 'a-btn' }] } },
        { id: 'b', action: 'click', target: { selectors: [{ id: 'b-btn' }] } }
      ]),
      { sessionId }
    )
    const took = Date.now() - started
    expect(statuses(run), why(run)).toEqual(['a:failed', 'b:not_run'])
    expect(run.steps[0].error).toBe(
      "the browser did not answer Input.dispatchMouseEvent within the step's 500 ms (+2000 ms grace)"
    )
    expect(took, `run took ${took} ms; a hung command must end the step at 500 + 2000 ms, not at the client's 20 s`).toBeLessThan(6_000)
    expect(
      sent.filter((m) => m.startsWith('Input.')),
      'mouseReleased must never follow the press the step gave up on'
    ).toEqual(['Input.dispatchMouseEvent:mouseMoved', 'Input.dispatchMouseEvent:mousePressed'])
  }, 15_000)

  it('gives a navigate step its timeout_ms for the load after the navigation commits, and fails it there when the page stops answering', async () => {
    let committed = false
    const { client: hanging } = hangingOn((method) => {
      if (method === 'Page.navigate') committed = true
      // Every readyState poll after the navigation hangs, like a renderer stuck in a script.
      return committed && method === 'Runtime.evaluate'
    })
    const started = Date.now()
    const run = await replayFlow(hanging, flow([{ id: 'go', action: 'navigate', url: PAGE2, timeout_ms: 400 }]), {
      sessionId,
      openTarget: false
    })
    const took = Date.now() - started
    expect(statuses(run), why(run)).toEqual(['go:failed'])
    expect(run.steps[0].error).toBe("the browser did not answer Runtime.evaluate within the step's 400 ms (+2000 ms grace)")
    expect(took, `run took ${took} ms`).toBeLessThan(6_000)
  }, 15_000)

  it('fails a select whose option is disabled or missing, with the reason', async () => {
    const run = await replay(
      flow([{ id: 'plan', action: 'select', timeout_ms: 300, target: { selectors: [{ id: 'plan' }] }, value: 'Legacy' }])
    )
    expect(run.status).toBe('failed')
    expect(run.steps[0].error).toBe('id=plan matched but that option is disabled (waited 300 ms)')
  })

  it('reports every step to onStep in order (skipped, passed, failed, then not_run so progress reaches the total), and a throwing listener changes nothing', async () => {
    const seen: string[] = []
    const run = await replay(
      flow([
        { id: 'off', action: 'click', disabled: true, target: { selectors: [{ id: 'nope' }] } },
        { id: 'ok', action: 'click', target: { selectors: [{ id: 'a-btn' }] } },
        { id: 'broken', action: 'click', timeout_ms: 300, target: { selectors: [{ testid: 'gone' }] } },
        { id: 'after', action: 'click', target: { selectors: [{ id: 'a-btn' }] } }
      ]),
      {
        onStep: (e) => {
          seen.push(`${e.index + 1}/${e.total} ${e.id} ${e.action} ${e.status}`)
          throw new Error('listener bug')
        }
      }
    )
    expect(seen, why(run)).toEqual(['1/4 off click skipped', '2/4 ok click passed', '3/4 broken click failed', '4/4 after click not_run'])
    expect(statuses(run), 'the listener throwing must not change any status').toEqual([
      'off:skipped',
      'ok:passed',
      'broken:failed',
      'after:not_run'
    ])
  })
})
