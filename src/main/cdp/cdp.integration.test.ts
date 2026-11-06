import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ALL_EVENTS, CdpClient, CdpProtocolError, type CdpEvent } from './client'
import {
  attachToEndpoint,
  findBrowserExecutable,
  launchDebugBrowser,
  type LaunchedBrowser
} from './launcher'
import { CaptureClock, calibrateBrowserClock } from './clock'
import { injectProbe, markAndResolveSecrets, rankSelectorsFor } from './probe'
import { distinctStrategies } from './selectors'
import { TEST_BROWSER_ARGS } from './test-browser-args'

/**
 * Playwright launches (or, in one case, merely provides) a real Chromium.
 * Everything after that is our own raw CDP code driving it — Playwright is
 * never the thing under test, and it stays a devDependency so electron-builder
 * never sees it.
 */

const FIXTURE_URL = pathToFileURL(resolve(__dirname, '__fixtures__/fixture.html')).href
const PASSWORD_VALUE = 'hunter2-must-never-leave-the-page'
const OTP_VALUE = '314159-otp-secret'
const NESTED_SECRET_VALUE = 'inherited-secret-value'

const executable = findBrowserExecutable(['playwright-chromium'])

/** A missing browser download is reported as a skip, never as a pass. */
const describeWithBrowser = executable ? describe : describe.skip
if (!executable) {
  console.warn('[cdp.integration] no Playwright Chromium found; integration tests SKIPPED, not passed')
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describeWithBrowser('CDP client against a real Chromium (launched by our own launcher)', () => {
  let browser: LaunchedBrowser
  let client: CdpClient
  let pageSessionId: string
  const events: CdpEvent[] = []

  beforeAll(async () => {
    browser = await launchDebugBrowser({
      prefer: ['playwright-chromium'],
      headless: true,
      // Test browser only: hosts that restrict unprivileged user namespaces (Ubuntu 24.04+
      // AppArmor, CI runners) abort Chromium's sandbox with SIGABRT. Playwright drops it the same way.
      extraArgs: [...TEST_BROWSER_ARGS],
      startUrl: FIXTURE_URL
    })

    const wsUrl = await browser.endpoint.browserWebSocketUrl()
    client = await CdpClient.connect(wsUrl, { commandTimeoutMs: 20_000 })
    client.on(ALL_EVENTS, (event) => events.push(event))

    // Flattened auto-attach with waitForDebuggerOnStart: the client is
    // responsible for resuming each frozen target, or this hangs forever.
    const attached = new Promise<string>((resolvePage) => {
      const off = client.on('Target.attachedToTarget', (event) => {
        const info = event.params.targetInfo as { type?: string } | undefined
        if (info?.type === 'page' && typeof event.params.sessionId === 'string') {
          off()
          resolvePage(event.params.sessionId)
        }
      })
    })
    await client.setAutoAttach()
    pageSessionId = await attached

    await client.send('Runtime.enable', {}, pageSessionId)
    await client.send('Page.enable', {}, pageSessionId)
    await client.send('DOM.enable', {}, pageSessionId)
    await client.send('DOMSnapshot.enable', {}, pageSessionId)
    await client.send('Network.enable', {}, pageSessionId)
    await client.send('Accessibility.enable', {}, pageSessionId)

    await injectProbe(client, { secretSelectors: ['#configured-secret'] }, pageSessionId)
    await client.send('Page.navigate', { url: FIXTURE_URL }, pageSessionId)
    await client.once('Page.loadEventFired', 15_000)
    // The auto-injected copy runs on the new document; give it a tick to install.
    await delay(200)
  }, 90_000)

  afterAll(async () => {
    client?.close()
    await browser?.close()
  })

  it('attached a page session and released it from the debugger pause', () => {
    expect(pageSessionId).toBeTruthy()
    expect(client.sessions()).toContain(pageSessionId)
  })

  it('speaks raw JSON-RPC and correlates replies', async () => {
    const version = await client.send<{ product?: string }>('Browser.getVersion')
    expect(version.product).toMatch(/Chrome|Chromium|HeadlessChrome/)
  })

  it('correlates concurrent commands to the right replies', async () => {
    const [doc, snapshot, ax] = await Promise.all([
      client.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 1 }, pageSessionId),
      client.send<{ documents: unknown[]; strings: string[] }>(
        'DOMSnapshot.captureSnapshot',
        { computedStyles: ['display', 'position', 'visibility'], includeDOMRects: true },
        pageSessionId
      ),
      client.send<{ nodes: unknown[] }>('Accessibility.getFullAXTree', {}, pageSessionId)
    ])
    expect(doc.root.nodeId).toBeGreaterThan(0)
    expect(snapshot.documents.length).toBeGreaterThan(0)
    expect(ax.nodes.length).toBeGreaterThan(0)
  })

  it('surfaces a CDP protocol error as a real rejection, not a silent undefined', async () => {
    const failure = await client
      .send('Runtime.evaluate', { expression: '(' }, pageSessionId)
      .then(() => null)
      .catch((error: unknown) => error)
    // A syntactically valid call with a bad argument comes back as {result},
    // so use a method that genuinely does not exist for the error path.
    const bogus = await client
      .send('Nawi.doesNotExist', {}, pageSessionId)
      .then(() => null)
      .catch((error: unknown) => error)
    expect(bogus).toBeInstanceOf(CdpProtocolError)
    expect((bogus as CdpProtocolError).cdpMethod).toBe('Nawi.doesNotExist')
    expect((bogus as CdpProtocolError).sessionId).toBe(pageSessionId)
    expect(failure === null || failure instanceof Error).toBe(true)
  })

  it('observed the fixture page console.error (FR-STA.3 source)', () => {
    const console = events.filter((e) => e.method === 'Runtime.consoleAPICalled')
    expect(console.length).toBeGreaterThan(0)
  })

  describe('FR-STA.6 ranked selectors, computed against a live DOM', () => {
    it('ranks data-testid first with three or more strategies', async () => {
      const ranked = await rankSelectorsFor(client, '#s1', pageSessionId)
      expect(ranked).not.toBeNull()
      const candidates = ranked as NonNullable<typeof ranked>
      expect(candidates[0]?.selector).toBe('[data-testid="submit"]')
      expect(distinctStrategies(candidates).length).toBeGreaterThanOrEqual(3)
      for (const candidate of candidates) {
        expect(candidate.stability).toBeGreaterThanOrEqual(0)
        expect(candidate.stability).toBeLessThanOrEqual(1)
      }
    })

    it('demotes a React-generated id below role+name on a real element', async () => {
      const ranked = await rankSelectorsFor(client, '#\\:r1a\\:', pageSessionId)
      expect(ranked).not.toBeNull()
      const candidates = ranked as NonNullable<typeof ranked>
      const id = candidates.find((c) => c.strategy === 'id')
      expect(id?.stability).toBeLessThanOrEqual(0.35)
      const roleName = candidates.find((c) => c.strategy === 'role-name')
      if (roleName) expect(roleName.stability).toBeGreaterThan(id?.stability ?? 1)
    })

    it('measures uniqueness in the document rather than assuming it', async () => {
      const ranked = await rankSelectorsFor(client, '#s1', pageSessionId)
      const testid = (ranked as NonNullable<typeof ranked>).find((c) => c.strategy === 'testid')
      expect(testid?.unique).toBe(true)
    })
    it('emits a css candidate that selects the element itself, anchored at an id', async () => {
      // Each case: the element, and the css path a replayer would use to find it again.
      for (const [target, expected] of [
        ['#own-id', 'input#own-id'],
        ['#anchor-section a', 'section#anchor-section > p.lead > a.link']
      ] as const) {
        const result = await client.send<{ result: { value: { css?: string; matchesSelf: boolean; count: number } } }>(
          'Runtime.evaluate',
          {
            expression: `(() => { const el = document.querySelector(${JSON.stringify(target)});
              const css = window.__nawiProbe.describeSelectors(el).find((c) => c.strategy === 'css')?.selector;
              const found = css ? document.querySelectorAll(css) : [];
              return { css, count: found.length, matchesSelf: found.length === 1 && found[0] === el } })()`,
            returnByValue: true
          },
          pageSessionId
        )
        const { css, matchesSelf, count } = result.result.value
        expect(css, `css candidate for ${target}`).toBe(expected)
        expect(matchesSelf, `css "${css}" for ${target} should select exactly that element, matched ${count}`).toBe(true)
      }
    })
  })

  describe('roadmap AI1 visible-text candidates, computed against a live DOM', () => {
    const textCandidateOf = async (target: string): Promise<string | null> => {
      const result = await client.send<{ result: { value: string | null } }>(
        'Runtime.evaluate',
        {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(target)});
            const c = window.__nawiProbe.describeSelectors(el).find((c) => c.strategy === 'text');
            return c ? c.selector : null })()`,
          returnByValue: true
        },
        pageSessionId
      )
      return result.result.value
    }

    it('emits the folded visible text of a short, unique label on the element that shows it', async () => {
      for (const [target, expected] of [
        ['#s1', 'Save'],
        ['#wrapped-link span', 'Open settings']
      ] as const) {
        expect(await textCandidateOf(target), `text candidate for ${target}`).toBe(expected)
      }
    })

    it('ranks the text candidate between role+name and css', async () => {
      const ranked = (await rankSelectorsFor(client, '#s1', pageSessionId)) ?? []
      expect(ranked.map((c) => c.strategy)).toEqual(['testid', 'id', 'role-name', 'text', 'css', 'nth-child'])
    })

    it('emits none for repeated text, counters, page copy, editable content, form fields or secret content', async () => {
      for (const [target, why] of [
        ['#dup-a', 'two buttons show "Edit"'],
        ['#count-btn', 'no letter: a counter'],
        ['#long-copy', 'longer than a label'],
        ['#wrapped-link', 'its text is shown by the span inside, which replay would act on instead'],
        ['#editable', 'contenteditable: user input'],
        ['#editor-wrap', 'its text is the editable content inside it'],
        ['#email', 'a form field: its value is user input'],
        ['#pw', 'a password field'],
        ['#pay-btn', 'contains a data-nawi-secret element'],
        ['#pay-btn span', 'is a data-nawi-secret element']
      ] as const) {
        expect(await textCandidateOf(target), `${target} should have no text candidate (${why})`).toBeNull()
      }
    })

    it('keeps text inside a secret element out of the accessible name and the role+name candidate (FR-SEC.2)', async () => {
      const result = await client.send<{ result: { value: { selectors: unknown; name: string; input: { target_name: unknown } } } }>(
        'Runtime.evaluate',
        {
          expression: `(() => { const el = document.querySelector('#pay-btn');
            return { selectors: window.__nawiProbe.describeSelectors(el), name: window.__nawiProbe.accessibleName(el),
              input: window.__nawiProbe.describeInput(el, 'click') } })()`,
          returnByValue: true
        },
        pageSessionId
      )
      const seen = JSON.stringify(result.result.value)
      expect(seen.includes('card-ending-4111'), `the secret span's text leaked into the probe's description: ${seen}`).toBe(false)
      expect(result.result.value.name, 'no name rather than a name carrying the secret').toBe('')
      expect(result.result.value.input.target_name).toBeNull()
    })
  })

  describe('accessible name from an aria-labelledby id list, against a live DOM', () => {
    // Built in the page per test and removed after, so the fixture-wide counts other specs assert stay put.
    const LABELLED_DOM = `
      <span id="ln-verb">Ship</span><span id="ln-object">to home</span>
      <span id="ln-secret">Card <span data-nawi-secret>4111-1111</span></span>
      <button id="ln-two" aria-labelledby="ln-verb  ln-object">x</button>
      <button id="ln-missing" aria-labelledby="ln-nope ln-verb">x</button>
      <button id="ln-secret-btn" aria-labelledby="ln-verb ln-secret">Pay</button>`

    const withLabelledDom = async <T>(run: () => Promise<T>): Promise<T> => {
      await client.send(
        'Runtime.evaluate',
        { expression: `(() => { const box = document.createElement('div'); box.id = 'ln-box';
            box.innerHTML = ${JSON.stringify(LABELLED_DOM)}; document.body.appendChild(box) })()` },
        pageSessionId
      )
      try {
        return await run()
      } finally {
        await client.send('Runtime.evaluate', { expression: `document.getElementById('ln-box')?.remove()` }, pageSessionId)
      }
    }

    const probeNameOf = async (target: string): Promise<{ name: string; roleName: string | null }> => {
      const result = await client.send<{ result: { value: { name: string; roleName: string | null } } }>(
        'Runtime.evaluate',
        {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(target)});
            const c = window.__nawiProbe.describeSelectors(el).find((c) => c.strategy === 'role-name');
            return { name: window.__nawiProbe.accessibleName(el), roleName: c ? c.name : null } })()`,
          returnByValue: true
        },
        pageSessionId
      )
      return result.result.value
    }

    const chromiumNameOf = async (target: string): Promise<string> => {
      const doc = await client.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 }, pageSessionId)
      const { nodeId } = await client.send<{ nodeId: number }>(
        'DOM.querySelector',
        { nodeId: doc.root.nodeId, selector: target },
        pageSessionId
      )
      const ax = await client.send<{ nodes: Array<{ name?: { value?: string } }> }>(
        'Accessibility.getPartialAXTree',
        { nodeId, fetchRelatives: false },
        pageSessionId
      )
      return ax.nodes[0]?.name?.value ?? ''
    }

    it('joins the text of every referenced element in order, as Chromium names it', async () => {
      await withLabelledDom(async () => {
        for (const target of ['#ln-two', '#ln-missing']) {
          const chromium = await chromiumNameOf(target)
          const probe = await probeNameOf(target)
          expect(probe.name, `probe name for ${target} vs Chromium's accessibility tree`).toBe(chromium)
          expect(probe.roleName, `role+name candidate for ${target}`).toBe(chromium)
        }
        expect(await chromiumNameOf('#ln-two'), 'fixture sanity: Chromium joins both labels').toBe('Ship to home')
        expect(await chromiumNameOf('#ln-missing'), 'fixture sanity: Chromium skips the missing id').toBe('Ship')
      })
    })

    it('gives no name when any referenced element carries a secret (FR-SEC.2)', async () => {
      await withLabelledDom(async () => {
        const probe = await probeNameOf('#ln-secret-btn')
        expect(JSON.stringify(probe).includes('4111'), `secret text leaked into the name: ${JSON.stringify(probe)}`).toBe(false)
        expect(probe.name, 'no name rather than a partial name stitched around a secret').toBe('')
      })
    })
  })

  describe('FR-SEC.2 — secret values never cross the CDP wire', () => {
    it('marks password, one-time-code, and inherited secret targets', async () => {
      const marking = await markAndResolveSecrets(client, pageSessionId)
      expect(marking.total).toBeGreaterThanOrEqual(3)
      expect(marking.backendNodeIds.length).toBe(marking.total)
      expect(new Set(marking.backendNodeIds).size).toBe(marking.backendNodeIds.length)
    })

    it('emits the acceptance shape for a password field with no value at all', async () => {
      const event = await client.send<{ result: { value: Record<string, unknown> } }>(
        'Runtime.evaluate',
        {
          expression:
            "window.__nawiProbe.describeInput(document.querySelector('#pw'), 'input')",
          returnByValue: true
        },
        pageSessionId
      )
      const payload = event.result.value
      expect(payload.type).toBe('input')
      expect(payload.target_role).toBe('textbox')
      expect(payload.value_redacted).toBe(true)
      // Not "blank" — absent. A blanked key means the value existed in the
      // message at some point, which is what FR-SEC.2 forbids.
      expect('value' in payload).toBe(false)
      expect(JSON.stringify(payload)).not.toContain(PASSWORD_VALUE)
    })

    it('redacts an autocomplete=one-time-code field and a secret subtree descendant', async () => {
      for (const selector of ['#otp', '#nested-secret']) {
        const event = await client.send<{ result: { value: Record<string, unknown> } }>(
          'Runtime.evaluate',
          {
            expression: `window.__nawiProbe.describeInput(document.querySelector(${JSON.stringify(selector)}), 'input')`,
            returnByValue: true
          },
          pageSessionId
        )
        expect(event.result.value.value_redacted).toBe(true)
        expect('value' in event.result.value).toBe(false)
      }
    })

    it('still captures a non-secret field, so the suppression is targeted not blanket', async () => {
      const event = await client.send<{ result: { value: Record<string, unknown> } }>(
        'Runtime.evaluate',
        {
          expression:
            "window.__nawiProbe.describeInput(document.querySelector('#email'), 'input')",
          returnByValue: true
        },
        pageSessionId
      )
      expect(event.result.value.value_redacted).toBe(false)
      expect(event.result.value.value).toBe('not-a-secret@example.com')
    })

    it('reports the browser-normalized input type of an <input>, and none for other elements', async () => {
      const event = await client.send<{ result: { value: Record<string, unknown>[] } }>(
        'Runtime.evaluate',
        {
          expression:
            "['#email', '#pw', '#cv', '#volume', '#odd', '#bio', '#s1'].map((s) => window.__nawiProbe.describeInput(document.querySelector(s), 'input'))",
          returnByValue: true
        },
        pageSessionId
      )
      const types = event.result.value.map((p) => ('input_type' in p ? p.input_type : '(none)'))
      // RANGE is lowercased and an unknown type reads as text, as the browser treats them.
      expect(types, 'input_type for #email #pw #cv #volume #odd #bio #s1').toEqual([
        'email',
        'password',
        'file',
        'range',
        'text',
        '(none)',
        '(none)'
      ])
      expect(event.result.value[1].value_redacted, 'the password stays redacted').toBe(true)
    })

    /**
     * The load-bearing fact behind `markAndResolveSecrets`. `captureSnapshot`
     * serializes input values into its string table, so the snapshot really
     * does carry the password — which is exactly why the backendNodeId set has
     * to exist and why the snapshot must be filtered before it is written.
     *
     * If this assertion ever flips, the mitigation is not therefore
     * unnecessary; it means the protocol changed and this test needs rewriting
     * with the new leak vector in mind.
     */
    it('captures the secret nodes that a raw DOM snapshot would otherwise expose', async () => {
      const marking = await markAndResolveSecrets(client, pageSessionId)
      const snapshot = await client.send<{ strings: string[] }>(
        'DOMSnapshot.captureSnapshot',
        { computedStyles: [], includeDOMRects: false },
        pageSessionId
      )
      const leaked = snapshot.strings.some((s) => s.includes(PASSWORD_VALUE))
      expect(leaked).toBe(true)
      // The set the later filtering step needs is non-empty and resolvable.
      expect(marking.backendNodeIds.length).toBeGreaterThanOrEqual(3)
      for (const id of marking.backendNodeIds) expect(id).toBeGreaterThan(0)
    })

    it('no secret value appears in any CDP event this test observed', () => {
      const wire = JSON.stringify(events)
      for (const secret of [PASSWORD_VALUE, OTP_VALUE, NESTED_SECRET_VALUE]) {
        expect(wire).not.toContain(secret)
      }
    })
  })

  describe('DC-1 / FR-STA.7 clock, against a real browser', () => {
    it('calibrates the browser clock and converts a real reading back to T', async () => {
      const clock = new CaptureClock()
      expect(clock.browserToTMs(Date.now())).toBeNull()

      for (let i = 0; i < 5; i++) {
        const rtt = await calibrateBrowserClock(clock, client, pageSessionId)
        expect(rtt).not.toBeNull()
        await delay(50)
      }
      expect(clock.isBrowserCalibrated).toBe(true)

      const before = clock.nowTMs()
      const browserNow = await client.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: 'performance.timeOrigin + performance.now()', returnByValue: true },
        pageSessionId
      )
      const after = clock.nowTMs()
      const converted = clock.browserToTMs(browserNow.result.value)
      expect(converted).not.toBeNull()
      // The reading was taken inside this window; allow the round trip either side.
      expect(converted as number).toBeGreaterThan(before - 250)
      expect(converted as number).toBeLessThan(after + 250)
    }, 30_000)

    it('bridges CDP MonotonicTime through Network.requestWillBeSent wallTime', async () => {
      const clock = new CaptureClock()
      for (let i = 0; i < 3; i++) {
        await calibrateBrowserClock(clock, client, pageSessionId)
        await delay(30)
      }

      const seen: Array<{ timestamp: number; wallTime: number }> = []
      const off = client.on('Network.requestWillBeSent', (event) => {
        const { timestamp, wallTime } = event.params as { timestamp?: number; wallTime?: number }
        if (typeof timestamp === 'number' && typeof wallTime === 'number') {
          seen.push({ timestamp, wallTime })
        }
      })

      await client.send('Page.navigate', { url: FIXTURE_URL }, pageSessionId)
      await client.once('Page.loadEventFired', 15_000)
      off()

      expect(seen.length).toBeGreaterThan(0)
      const sample = seen[0]!
      // The two really are different clocks: monotonic seconds since a Chrome
      // internal origin vs. epoch seconds. If these were ever the same number
      // the bridge would be untested.
      expect(Math.abs(sample.wallTime - sample.timestamp)).toBeGreaterThan(1e6)

      clock.addMonotonicBridge(sample.timestamp, sample.wallTime)
      const converted = clock.monotonicToTMs(sample.timestamp)
      expect(converted).not.toBeNull()
      expect(Math.abs((converted as number) - clock.nowTMs())).toBeLessThan(30_000)
    }, 45_000)
  })

  it('rejects every in-flight command when the socket goes away', async () => {
    const throwaway = await CdpClient.connect(await browser.endpoint.browserWebSocketUrl())
    const pending = throwaway.send('Browser.getVersion').catch((error: unknown) => error)
    throwaway.close()
    expect(await pending).toBeInstanceOf(Error)
  })
})

describeWithBrowser('attaching to an endpoint someone else started', () => {
  let context: BrowserContext
  let userDataDir: string

  beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'nawi-attach-'))
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: ['--remote-debugging-port=0']
    })
    // Give Chromium a moment to write DevToolsActivePort into the profile.
    await delay(500)
  }, 60_000)

  afterAll(async () => {
    await context?.close()
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 })
  })

  it('discovers the port the same way production does, and drives it', async () => {
    const { readFileSync } = await import('node:fs')
    const port = Number(readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]!.trim())
    expect(port).toBeGreaterThan(0)

    const endpoint = await attachToEndpoint(String(port))
    const target = await endpoint.firstPageTarget()
    expect(target.webSocketDebuggerUrl).toBeTruthy()

    const client = await CdpClient.connect(target.webSocketDebuggerUrl!)
    try {
      const version = await client.send<{ product?: string }>('Browser.getVersion')
      expect(version.product).toBeTruthy()
    } finally {
      client.close()
    }
  }, 45_000)

  it('explains an unreachable endpoint instead of hanging', async () => {
    const error = await attachToEndpoint('127.0.0.1:1')
      .then(() => null)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ name: 'AttachError', reason: 'unreachable' })
    // The message has to name the real cause, because "connection refused" does
    // not tell a user that their already-running Chrome ignored the flag.
    expect((error as Error).message).toContain('--remote-debugging-port')
  }, 30_000)

  it('rejects an unparseable endpoint', async () => {
    const error = await attachToEndpoint('not a host')
      .then(() => null)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ name: 'AttachError' })
  })
})
