import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDraft } from '@shared/sidecar/draft'
import type { Surface } from '@shared/sidecar/types'
import { CdpClient } from '../cdp/client'
import { findBrowserExecutable, launchDebugBrowser, type LaunchedBrowser } from '../cdp/launcher'
import { CaptureClock } from '../cdp/clock'
import { markAndResolveSecrets } from '../cdp/probe'
import { seal } from '../sidecar/seal'
import { writeSealedRevision } from '../sidecar/writer'
import { capturesRoot } from '../sidecar/paths'
import { FILE_PATHS, Harvester } from './harvest'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RELEASE GATE — FR-SEC.2 / DC-3.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The requirement's acceptance clause is the design of this test:
 *
 *   GIVEN a recording during which the user types into an <input type="password">
 *   WHEN the state layer is inspected **by any means, including raw file access**
 *   THEN no keystroke values from that field appear in input_events, DOM
 *        snapshot, HAR, or transcript
 *   AND the event is present as {type:"input", target_role:"textbox", value_redacted:true}
 *
 * "By any means, including raw file access" is why the assertions are on
 * **bytes**, not on a parsed object. A parsed-object assertion only proves the
 * shape you thought to look at is clean; the requirement is about what a person
 * with a hex editor can find.
 *
 * The full pipeline runs for real: our own launcher starts a Chromium (supplied
 * by the Playwright devDependency — Playwright is never the code under test),
 * our own raw-CDP client drives it, the sentinels are **typed** through
 * `Input.insertText` rather than baked into the fixture markup, then harvest →
 * seal → write a genuine revision into a temp userData, then walk every byte of
 * every file written.
 *
 * **Guarding against a vacuous pass.** A byte scan finds nothing in an empty
 * directory, so this test also asserts the positive half throughout: the values
 * really reached the fields, the files really exist and are non-trivial, the
 * input event really is present in the acceptance shape, and a deliberately
 * unfiltered snapshot really does trip the Tier-A-leak signal. Without those, a
 * broken harvester would report a green gate.
 */

const FIXTURE_URL = pathToFileURL(resolve(__dirname, '__fixtures__/gate.html')).href

/** Distinctive, unlikely to occur naturally, and not matching any Tier B pattern. */
const PASSWORD_SENTINEL = 'ZZQPASSWORDSENTINELhunter2xyzzy'
const OTP_SENTINEL = 'ZZQOTPSENTINEL314159plugh'
const CONFIGURED_SENTINEL = 'ZZQCONFIGUREDSENTINELrecoveryxyzzy'
const USERNAME_VALUE = 'ordinary-username-not-a-secret'
/**
 * Typed into a SECOND document after a navigation. A navigation resets the
 * secret marking — `markSecrets` stamps attributes on a document that no longer
 * exists — so this sentinel is only ever suppressed if the harvester genuinely
 * re-marks per document rather than once at startup.
 */
const PASSWORD_SENTINEL_2 = 'ZZQSECONDDOCSENTINELplughplover'

const ALL_SENTINELS = [
  PASSWORD_SENTINEL,
  OTP_SENTINEL,
  CONFIGURED_SENTINEL,
  PASSWORD_SENTINEL_2
]

const SURFACE: Surface = {
  type: 'browser',
  app: 'Chromium',
  url: FIXTURE_URL,
  os: process.platform,
  locale: 'en-US',
  viewport: { w: 1280, h: 800, dpr: 1 },
  displays: []
}

const executable = findBrowserExecutable(['playwright-chromium'])
/** A missing browser download is reported as a SKIP, never as a pass. */
const describeGate = executable ? describe : describe.skip
if (!executable) {
  console.warn('[redaction.gate] no Playwright Chromium found; THE RELEASE GATE DID NOT RUN')
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface ScannedFile {
  path: string
  relative: string
  bytes: Buffer
}

/** Every byte of every file under a directory, recursively. */
async function readAllFiles(root: string, base = root): Promise<ScannedFile[]> {
  const out: ScannedFile[] = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...(await readAllFiles(full, base)))
    else out.push({ path: full, relative: full.slice(base.length + 1), bytes: await fs.readFile(full) })
  }
  return out
}

describeGate('RELEASE GATE — FR-SEC.2 secret suppression, verified on raw bytes', () => {
  let browser: LaunchedBrowser
  let client: CdpClient
  let sessionId: string
  let libraryRoot: string
  let captureId: string
  let revision: string
  let written: ScannedFile[]
  let sealReport: ReturnType<typeof seal>['report']
  let typedBack: Record<string, number>
  let rawSnapshotLeaked: boolean
  let secondDocTypedLength: number
  let harvestResult: Awaited<ReturnType<Harvester['finish']>>

  beforeAll(async () => {
    libraryRoot = mkdtempSync(join(tmpdir(), 'nawi-gate-'))
    captureId = randomUUID()

    browser = await launchDebugBrowser({
      prefer: ['playwright-chromium'],
      headless: true,
      startUrl: 'about:blank'
    })
    client = await CdpClient.connect(await browser.endpoint.browserWebSocketUrl(), {
      commandTimeoutMs: 20_000
    })

    const attached = new Promise<string>((res) => {
      const off = client.on('Target.attachedToTarget', (event) => {
        const info = event.params.targetInfo as { type?: string } | undefined
        if (info?.type === 'page' && typeof event.params.sessionId === 'string') {
          off()
          res(event.params.sessionId)
        }
      })
    })
    await client.setAutoAttach()
    sessionId = await attached

    const clock = new CaptureClock()
    const draft = createDraft({
      capture_id: captureId,
      kind: 'screenshot',
      surface: SURFACE,
      generator: 'nawi-gate-test'
    })

    // Enables domains, injects probe + input listener, takes a first clock
    // calibration, then subscribes.
    const harvester = await Harvester.start({
      client,
      sessionId,
      clock,
      draft,
      probe: { secretSelectors: ['#configured-secret'] }
    })
    harvester.markRecordingStarted()

    // --- navigation settles BEFORE anything is typed or marked --------------
    await client.send('Page.navigate', { url: FIXTURE_URL }, sessionId)
    await client.once('Page.loadEventFired', 15_000)
    await delay(300)

    // --- type the sentinels ------------------------------------------------
    // Typed, not baked into the fixture, and typed BEFORE marking/snapshotting.
    // Marking stamps attributes; it does not retroactively filter a value that
    // arrives afterwards, so typing after the snapshot would make this vacuous.
    const type = async (selector: string, text: string): Promise<void> => {
      await client.send(
        'Runtime.evaluate',
        { expression: `document.querySelector(${JSON.stringify(selector)}).focus()` },
        sessionId
      )
      await client.send('Input.insertText', { text }, sessionId)
      await delay(60)
    }
    await type('#pw', PASSWORD_SENTINEL)
    await type('#otp', OTP_SENTINEL)
    await type('#configured-secret', CONFIGURED_SENTINEL)
    await type('#username', USERNAME_VALUE)
    await delay(200)

    // NON-VACUITY: the values genuinely reached the fields. Lengths only — this
    // test must not itself echo the secrets into anything.
    const readBack = await client.send<{ result: { value: Record<string, number> } }>(
      'Runtime.evaluate',
      {
        expression: `(() => ({
          pw: document.querySelector('#pw').value.length,
          otp: document.querySelector('#otp').value.length,
          configured: document.querySelector('#configured-secret').value.length,
          username: document.querySelector('#username').value.length
        }))()`,
        returnByValue: true
      },
      sessionId
    )
    typedBack = readBack.result.value

    // CONTROL: with the marking done but no filtering, the raw snapshot really
    // does carry the password. If this ever stops being true the mitigation is
    // not therefore unnecessary — the leak vector moved and this test needs
    // rewriting against the new one.
    await markAndResolveSecrets(client, sessionId)
    const rawSnapshot = await client.send<{ strings: string[] }>(
      'DOMSnapshot.captureSnapshot',
      { computedStyles: [], includeDOMRects: false },
      sessionId
    )
    rawSnapshotLeaked = rawSnapshot.strings.some((s) => s.includes(PASSWORD_SENTINEL))

    // --- the real capture: mark → snapshot → AX, in that order -------------
    await harvester.captureDom()
    await client.send('Runtime.evaluate', { expression: "console.log('post-capture marker')" }, sessionId)
    await delay(200)

    // --- SECOND DOCUMENT: the navigation reset ------------------------------
    // The handover calls this out as load-bearing and it is the likeliest thing
    // to regress: `injectProbe` survives a navigation (it is registered with
    // `addScriptToEvaluateOnNewDocument`), but the *marking* does not — the new
    // document's fields carry no marker attribute until something re-marks them.
    // A harvester that marked once at startup passes every assertion above and
    // leaks here.
    await client.send('Page.navigate', { url: FIXTURE_URL }, sessionId)
    await client.once('Page.loadEventFired', 15_000)
    await delay(400)
    await type('#pw', PASSWORD_SENTINEL_2)
    await delay(200)

    secondDocTypedLength = (
      await client.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: "document.querySelector('#pw').value.length", returnByValue: true },
        sessionId
      )
    ).result.value

    await harvester.captureDom()
    await delay(200)

    harvestResult = await harvester.finish()

    // --- seal, then write --------------------------------------------------
    // The sentinels are handed in as `suppressedValues` so a Tier B hit on one
    // is reported as a TIER A FAILURE rather than as a routine redaction.
    const sealedRevision = seal(draft, harvestResult.files, {
      suppressedValues: ALL_SENTINELS
    })
    sealReport = sealedRevision.report

    const result = await writeSealedRevision(libraryRoot, sealedRevision)
    revision = result.revision

    written = await readAllFiles(join(capturesRoot(libraryRoot), captureId))
  }, 180_000)

  afterAll(async () => {
    client?.close()
    await browser?.close()
    if (libraryRoot) rmSync(libraryRoot, { recursive: true, force: true, maxRetries: 5 })
  })

  /* ---------------- non-vacuity: the test really exercised the thing ------- */

  describe('the gate is not vacuous', () => {
    it('the second document really received its own typed sentinel', () => {
      // Otherwise the navigation leg asserts nothing.
      expect(secondDocTypedLength).toBe(PASSWORD_SENTINEL_2.length)
    })

    it('the sentinels genuinely reached the input fields', () => {
      expect(typedBack.pw).toBe(PASSWORD_SENTINEL.length)
      expect(typedBack.otp).toBe(OTP_SENTINEL.length)
      expect(typedBack.configured).toBe(CONFIGURED_SENTINEL.length)
      expect(typedBack.username).toBe(USERNAME_VALUE.length)
    })

    it('an UNFILTERED snapshot of the same page does leak the password', () => {
      // The control that makes the negative assertions below meaningful.
      expect(rawSnapshotLeaked).toBe(true)
    })

    it('the filter matched real nodes rather than doing nothing', () => {
      expect(harvestResult.secretBackendNodeIds.length).toBeGreaterThanOrEqual(3)
      expect(harvestResult.domFilter).not.toBeNull()
      expect(harvestResult.domFilter!.redirected).toBeGreaterThan(0)
      expect(harvestResult.domFilter!.unmatched).toEqual([])
    })

    it('a real revision was written with all five state-layer files', () => {
      expect(revision).toBe('v1')
      const relatives = written.map((f) => f.relative.replace(/\\/g, '/'))
      expect(relatives).toContain(`${revision}/${FILE_PATHS.dom}`)
      expect(relatives).toContain(`${revision}/${FILE_PATHS.ax}`)
      expect(relatives).toContain(`${revision}/${FILE_PATHS.har}`)
      expect(relatives).toContain(`${revision}/${FILE_PATHS.console}`)
      expect(relatives).toContain(`${revision}/${FILE_PATHS.input}`)
      expect(relatives.some((r) => r.endsWith(`sidecar.${revision}.json`))).toBe(true)
    })

    it('the DOM snapshot on disk is substantial, not an empty stub', () => {
      const dom = written.find((f) => f.relative.replace(/\\/g, '/').endsWith(FILE_PATHS.dom))!
      expect(dom.bytes.byteLength).toBeGreaterThan(2000)
      // And it is a real snapshot of THIS page.
      expect(dom.bytes.toString('utf8')).toContain('Sign in')
    })

    it('nothing written is compressed, so a byte scan really sees everything', () => {
      // If compression is ever added, this fails loudly rather than the scan
      // silently stopping being able to find anything.
      for (const file of written) {
        expect(file.bytes[0] === 0x1f && file.bytes[1] === 0x8b).toBe(false)
      }
    })
  })

  /* ---------------- THE NEGATIVE HALF: raw bytes -------------------------- */

  describe('no secret value appears anywhere under captures/<id>/ (raw bytes)', () => {
    for (const [name, sentinel] of [
      ['password', PASSWORD_SENTINEL],
      ['one-time-code', OTP_SENTINEL],
      ['configured-secret', CONFIGURED_SENTINEL],
      ['password typed after a navigation (second document)', PASSWORD_SENTINEL_2]
    ] as const) {
      it(`the ${name} value is absent from every byte of every file`, () => {
        const offenders: string[] = []
        for (const file of written) {
          // Byte-level, on the raw buffer — not on a parsed object, and not on
          // a decoded string that could normalise something away.
          if (file.bytes.includes(Buffer.from(sentinel, 'utf8'))) offenders.push(file.relative)
          // Belt: UTF-16 in case anything ever writes a different encoding.
          if (file.bytes.includes(Buffer.from(sentinel, 'utf16le'))) {
            offenders.push(`${file.relative} (utf16)`)
          }
        }
        expect(offenders).toEqual([])
      })
    }

    it('every file was actually scanned', () => {
      expect(written.length).toBeGreaterThanOrEqual(6)
      for (const file of written) expect(file.bytes.byteLength).toBeGreaterThanOrEqual(0)
    })
  })

  /* ---------------- THE POSITIVE HALF ------------------------------------- */

  describe('the input event IS present in the acceptance shape', () => {
    it('records {type:"input", target_role:"textbox", value_redacted:true}', () => {
      const inputFile = written.find((f) =>
        f.relative.replace(/\\/g, '/').endsWith(FILE_PATHS.input)
      )!
      const lines = inputFile.bytes
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)

      expect(lines.length).toBeGreaterThan(0)

      const redactedInputs = lines.filter(
        (l) =>
          l.type === 'input' &&
          l.value_redacted === true &&
          (l.target as { role?: string } | null)?.role === 'textbox'
      )
      // One per secret field.
      expect(redactedInputs.length).toBeGreaterThanOrEqual(3)

      const event = redactedInputs[0]!
      expect(event.value_redacted).toBe(true)
      // Not "blank" — the value key must never have existed.
      expect('value' in event).toBe(false)
      expect((event.target as { text?: unknown }).text).toBeNull()
      expect(typeof event.t_ms).toBe('number')
    })

    it('carries FR-STA.6 ranked selectors on the redacted event', () => {
      const inputFile = written.find((f) =>
        f.relative.replace(/\\/g, '/').endsWith(FILE_PATHS.input)
      )!
      const lines = inputFile.bytes
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
      const redacted = lines.find((l) => l.value_redacted === true)!
      const selectors = (redacted.target as { selectors: Array<{ strategy: string; stability: number }> })
        .selectors
      expect(selectors.length).toBeGreaterThan(0)
      for (const s of selectors) {
        expect(s.stability).toBeGreaterThanOrEqual(0)
        expect(s.stability).toBeLessThanOrEqual(1)
        // DC-4 spells these with underscores.
        expect(s.strategy).not.toContain('-')
      }
    })

    it('still captures the NON-secret field, so suppression is targeted not blanket', () => {
      const inputFile = written.find((f) =>
        f.relative.replace(/\\/g, '/').endsWith(FILE_PATHS.input)
      )!
      const text = inputFile.bytes.toString('utf8')
      // The ordinary username survived the whole pipeline.
      expect(text).toContain(USERNAME_VALUE)
      const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      expect(lines.some((l) => l.value_redacted === false)).toBe(true)
    })
  })

  /* ---------------- Tier A held --------------------------------------------*/

  describe('Tier A held — a Tier-B hit on a secret would mean it did not', () => {
    it('reports zero Tier A failures', () => {
      // This is the assertion that distinguishes "Tier B cleaned up a leak"
      // from "Tier A worked". A non-empty list is a P0 security bug even
      // though the bytes on disk would still be clean.
      if (sealReport.tierAFailures.length > 0) {
        // The report carries no secret values, so printing it is safe and is
        // the difference between a useful failure and a bare `[] !== [...]`.
        console.error('TIER A FAILURES:', JSON.stringify(sealReport.tierAFailures, null, 2))
      }
      expect(sealReport.tierAFailures).toEqual([])
    })

    it('had no uncompilable redaction rules', () => {
      expect(sealReport.invalidRules).toEqual([])
    })

    it('actually scanned the files it claims to have', () => {
      expect(sealReport.filesScanned).toBe(harvestResult.files.length)
      expect(sealReport.bytesScanned).toBeGreaterThan(2000)
    })
  })
})

/* ------------------------------------------------------------------------- *
 * The failure signal itself must work, or the assertion above proves nothing.
 * ------------------------------------------------------------------------- */

describeGate('a Tier A leak IS detected as a Tier A failure, not a routine redaction', () => {
  let browser: LaunchedBrowser
  let client: CdpClient
  let sessionId: string

  beforeAll(async () => {
    browser = await launchDebugBrowser({
      prefer: ['playwright-chromium'],
      headless: true,
      startUrl: 'about:blank'
    })
    client = await CdpClient.connect(await browser.endpoint.browserWebSocketUrl(), {
      commandTimeoutMs: 20_000
    })
    const attached = new Promise<string>((res) => {
      const off = client.on('Target.attachedToTarget', (event) => {
        const info = event.params.targetInfo as { type?: string } | undefined
        if (info?.type === 'page' && typeof event.params.sessionId === 'string') {
          off()
          res(event.params.sessionId)
        }
      })
    })
    await client.setAutoAttach()
    sessionId = await attached
    for (const d of ['Runtime', 'Page', 'DOM', 'DOMSnapshot']) {
      await client.send(`${d}.enable`, {}, sessionId)
    }
    await client.send('Page.navigate', { url: FIXTURE_URL }, sessionId)
    await client.once('Page.loadEventFired', 15_000)
    await delay(300)
    await client.send(
      'Runtime.evaluate',
      { expression: `document.querySelector('#pw').focus()` },
      sessionId
    )
    await client.send('Input.insertText', { text: PASSWORD_SENTINEL }, sessionId)
    await delay(150)
  }, 120_000)

  afterAll(async () => {
    client?.close()
    await browser?.close()
  })

  it('flags an UNFILTERED snapshot as a Tier A failure and strips it anyway', async () => {
    // Deliberately skipping the backendNodeId filter — this is what a Tier A
    // regression looks like from seal()'s point of view.
    const raw = await client.send<{ strings: string[] }>(
      'DOMSnapshot.captureSnapshot',
      { computedStyles: [], includeDOMRects: false },
      sessionId
    )
    expect(raw.strings.some((s) => s.includes(PASSWORD_SENTINEL))).toBe(true)

    const draft = createDraft({
      capture_id: randomUUID(),
      kind: 'screenshot',
      surface: SURFACE,
      generator: 'nawi-gate-test'
    })
    for (const source of ['accessibility_tree', 'console_log', 'network_har', 'input_events'] as const) {
      // Not attempted in this narrow scenario — DC-2 wants that said out loud.
      draft.state_layer.unavailable.push({ source, reason: 'capture_failed' })
    }
    draft.state_layer.dom_snapshot = { t_ms: 0, path: FILE_PATHS.dom }

    const sealed = seal(
      draft,
      [{ path: FILE_PATHS.dom, contents: JSON.stringify(raw) }],
      { suppressedValues: [PASSWORD_SENTINEL] }
    )

    // The distinct failure signal fires …
    expect(sealed.report.tierAFailures.length).toBeGreaterThan(0)
    expect(sealed.report.tierAFailures[0]!.site).toBe(FILE_PATHS.dom)
    // … it is NOT filed away as an ordinary pattern hit …
    expect(sealed.report.hits.some((h) => h.site === FILE_PATHS.dom)).toBe(false)
    // … the report does not itself carry the secret …
    expect(JSON.stringify(sealed.report)).not.toContain(PASSWORD_SENTINEL)
    // … and Tier B still removed the bytes, because assurance is not optional.
    expect(sealed.files[0]!.contents as string).not.toContain(PASSWORD_SENTINEL)
  }, 60_000)
})
