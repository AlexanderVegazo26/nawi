import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CdpClient } from '../cdp/client'
import { findBrowserExecutable, launchDebugBrowser, type LaunchedBrowser } from '../cdp/launcher'
import { parseFlow } from '@shared/flow'
import { replayFlow, type FlowRun } from './replay'

/**
 * F4b against a real Chromium: a local HTTP server (127.0.0.1, random port)
 * serves a page that fails a stylesheet while loading, logs an error that
 * contains a typed secret, throws, sends a request the server answers with 500,
 * and pushes a URL with a token in it. Everything is waited on by conditions
 * (assert steps), never by sleeps.
 */

const SECRET = 'hunter2-evidence-secret'

const PAGE = `<!doctype html>
<html><head><title>evidence</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/missing.css"></head>
<body>
  <input id="pw" type="text" aria-label="Password">
  <button id="boom">Save</button>
  <button id="go">Next</button>
  <p role="status" id="status">idle</p>
  <script>
    document.querySelector('#boom').addEventListener('click', async () => {
      console.error('save failed for ' + document.querySelector('#pw').value)
      setTimeout(() => { throw new Error('kaput') })
      const r = await fetch('/api/save?session=s3ss10n&page=1', { method: 'POST' })
      document.querySelector('#status').textContent = 'saved ' + r.status
    })
    document.querySelector('#go').addEventListener('click', () => {
      history.pushState({}, '', '/done?token=t0k3n&step=2#top')
      document.querySelector('#status').textContent = 'moved'
    })
  </script>
</body></html>`

const executable = findBrowserExecutable(['playwright-chromium'])
const TEST_BROWSER_ARGS = process.platform === 'linux' ? ['--no-sandbox'] : []
const describeWithBrowser = executable ? describe : describe.skip
if (!executable) console.warn('[evidence.integration] no Playwright Chromium found; evidence tests SKIPPED, not passed')

const why = (run: FlowRun): string => JSON.stringify(run, null, 1)

describeWithBrowser('replay evidence (F4b) against a real Chromium', () => {
  let server: Server
  let origin: string
  let browser: LaunchedBrowser
  let client: CdpClient
  let sessionId: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)
      } else if (req.url?.startsWith('/api/save')) {
        res.writeHead(500, { 'content-type': 'text/plain' }).end('nope')
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      }
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

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
    await client.send('Runtime.enable', {}, sessionId)
  }, 90_000)

  afterAll(async () => {
    client?.close()
    await browser?.close()
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
  })

  it('files console errors, exceptions and failed requests under their steps, with the URL after each, all scrubbed', async () => {
    const parsed = parseFlow(`version: 1
name: Evidence
target: { kind: browser, url: "${origin}/" }
steps:
  - { id: s1, action: fill, target: { selectors: [{ id: pw }] }, value: "\${secret.pw}" }
  - { id: s2, action: click, target: { selectors: [{ id: boom }] } }
  - { id: s3, action: assert, target: { selectors: [{ role: status }] }, expect: { text: "saved 500" } }
  - { id: s4, action: click, target: { selectors: [{ id: go }] } }
  - { id: s5, action: assert, target: { selectors: [{ role: status }] }, expect: { text: "moved" } }
`)
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
    const run = await replayFlow(client, parsed.flow, { sessionId, secret: (n) => (n === 'pw' ? SECRET : undefined) })

    expect(run.status, why(run)).toBe('passed')
    expect(JSON.stringify(run).includes(SECRET), `the typed secret leaked into the run: ${why(run)}`).toBe(false)
    expect(JSON.stringify(run), 'token-like URL parameters must be scrubbed').not.toMatch(/s3ss10n|t0k3n/)

    expect(run.opening?.failedRequests, `the stylesheet 404 while opening: ${why(run)}`).toEqual([
      { method: 'GET', url: `${origin}/missing.css`, resource_type: 'Stylesheet', status: 404 }
    ])
    const [s1, s2, s3, s4, s5] = run.steps
    expect(s1.consoleErrors, `s1 logged nothing: ${why(run)}`).toBeUndefined()
    expect(s1.url).toBe(`${origin}/`)
    expect(s2.failedRequests, `s2 sent the POST that got a 500: ${why(run)}`).toEqual([
      { method: 'POST', url: `${origin}/api/save?page=1`, resource_type: 'Fetch', status: 500 }
    ])
    // The console.error runs inside the click; the timer's exception can fire before or after s3 starts.
    expect(s2.consoleErrors?.[0], why(run)).toEqual({ source: 'console', message: 'save failed for \${secret.pw}' })
    const exceptions = [s2, s3].flatMap((s) => s.consoleErrors ?? []).filter((c) => c.source === 'exception')
    expect(exceptions.map((c) => c.message.split('\n')[0]), why(run)).toEqual(['Error: kaput'])
    expect(s4.url, 'the URL right after the pushState click').toBe(`${origin}/done?step=2#top`)
    expect(s5.url, why(run)).toBe(`${origin}/done?step=2#top`)
    expect(run.finalUrl).toBe(`${origin}/done?step=2#top`)
  }, 60_000)

  it("still files the failed request of a flow's last step, which answers after the click returned", async () => {
    const parsed = parseFlow(`version: 1
name: Submit last
target: { kind: browser, url: "${origin}/" }
steps:
  - { id: submit, action: click, target: { selectors: [{ id: boom }] } }
`)
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
    const run = await replayFlow(client, parsed.flow, { sessionId })
    expect(run.status, why(run)).toBe('passed')
    expect(run.steps[0].failedRequests, `the 500 after the last click: ${why(run)}`).toEqual([
      { method: 'POST', url: `${origin}/api/save?page=1`, resource_type: 'Fetch', status: 500 }
    ])
  }, 60_000)
})
