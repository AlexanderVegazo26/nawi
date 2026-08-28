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

/**
 * F1 — typed into a password field and then SUBMITTED in a request body.
 *
 * The characters are chosen, not decorative. A sentinel of plain letters and
 * digits is its own URL encoding and its own JSON encoding, so the "no encoded
 * rendering survives" assertions below would be searching for bytes identical to
 * the literal and would prove nothing. The space, the `!` and the `"` guarantee
 * that the urlencoded, form-encoded, JSON-escaped and base64 renderings are four
 * genuinely different byte strings — which is the entire reason a literal
 * `suppressedValues` scan is not an adequate fix for F1.
 */
const FORM_SENTINEL = 'ZZQFORM "hunter!2" plugh'
/** F2 — rendered text of a `<div data-nawi-secret>`, never an input value. */
const LAYOUT_SENTINEL = 'ZZQLAYOUTSENTINEL271828xyzzy'
/** F3 — a `one-time-code` field inside an open shadow root. */
const SHADOW_SENTINEL = 'ZZQSHADOWSENTINEL161803plugh'
/** F3 — a password field inside a same-origin iframe. */
const FRAME_SENTINEL = 'ZZQFRAMESENTINEL141421plover'

const ALL_SENTINELS = [
  PASSWORD_SENTINEL,
  OTP_SENTINEL,
  CONFIGURED_SENTINEL,
  PASSWORD_SENTINEL_2,
  FORM_SENTINEL,
  LAYOUT_SENTINEL,
  SHADOW_SENTINEL,
  FRAME_SENTINEL
]

/**
 * Every byte string one value can turn into on the way to a request body.
 *
 * F1's mitigation is field-name redaction, which never looks at the value — so
 * it is encoding-agnostic by construction, and this is how that gets proven
 * rather than asserted. A fix built on literal matching would clean the first
 * entry and leave the rest.
 */
function renderings(value: string): Array<{ label: string; bytes: Buffer }> {
  const formEncoded = new URLSearchParams([['v', value]]).toString().slice(2)
  return [
    { label: 'literal (utf8)', bytes: Buffer.from(value, 'utf8') },
    { label: 'literal (utf16le)', bytes: Buffer.from(value, 'utf16le') },
    { label: 'encodeURIComponent', bytes: Buffer.from(encodeURIComponent(value), 'utf8') },
    { label: 'form-urlencoded', bytes: Buffer.from(formEncoded, 'utf8') },
    { label: 'JSON-escaped', bytes: Buffer.from(JSON.stringify(value).slice(1, -1), 'utf8') },
    {
      label: 'base64',
      bytes: Buffer.from(Buffer.from(value, 'utf8').toString('base64'), 'utf8')
    }
  ]
}

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
  let rawBoundaryLeaked: Record<string, boolean>
  let secondDocTypedLength: number
  let boundaryLengths: Record<string, number>
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

    /**
     * Plant the F2 and F3 secrets in the CURRENT document and read back their
     * lengths.
     *
     * Called once per document. That is not incidental: `captureDom()` replaces
     * the harvester's snapshot, so the DOM/AX files that reach disk describe the
     * LAST document. A first-document-only version of this setup made every F2
     * and F3 assertion vacuous — they inspected a snapshot of a page where the
     * secret div was empty and the shadow/frame fields had never been typed
     * into. Planting per document also makes these cases inherit the existing
     * post-navigation guarantee: marking is per document, and a harvester that
     * marked only once leaks here.
     */
    const plantBoundarySecrets = async (): Promise<Record<string, number>> => {
      // F2: a secret rendered as real text with a real layout box. Written from
      // here so the sentinel never sits in the fixture file, matching the rule
      // the rest of this test follows.
      await client.send(
        'Runtime.evaluate',
        {
          expression: `document.querySelector('#secret-text').textContent = ${JSON.stringify(
            LAYOUT_SENTINEL
          )}`
        },
        sessionId
      )

      // F3: focus across a shadow boundary, then across a frame boundary.
      // `Input.insertText` follows focus, including into a child frame.
      const focusAndType = async (expression: string, text: string): Promise<void> => {
        await client.send('Runtime.evaluate', { expression }, sessionId)
        await client.send('Input.insertText', { text }, sessionId)
        await delay(80)
      }
      await focusAndType(
        "document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-otp').focus()",
        SHADOW_SENTINEL
      )
      await focusAndType(
        `(() => { const f = document.querySelector('#same-origin-frame');
          f.contentWindow.focus();
          f.contentDocument.querySelector('#frame-pw').focus() })()`,
        FRAME_SENTINEL
      )
      await delay(200)

      // NON-VACUITY: the values really are where the assertions assume. Lengths
      // only, never the values.
      return (
        await client.send<{ result: { value: Record<string, number> } }>(
          'Runtime.evaluate',
          {
            expression: `(() => ({
              layout: document.querySelector('#secret-text').textContent.length,
              shadow: document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-otp').value.length,
              frame: document.querySelector('#same-origin-frame').contentDocument.querySelector('#frame-pw').value.length
            }))()`,
            returnByValue: true
          },
          sessionId
        )
      ).result.value
    }

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

    // --- F1/F2/F3 sinks ----------------------------------------------------
    // The form whose body is actually submitted.
    await type('#form-pw', FORM_SENTINEL)
    await type('#form-user', USERNAME_VALUE)

    // F2/F3 are planted by a helper because they must be planted TWICE — see
    // the second-document leg below. A fresh document has a fresh (empty) secret
    // div and fresh, unmarked shadow/frame fields.
    boundaryLengths = await plantBoundarySecrets()

    // --- F1: SUBMIT the credentials --------------------------------------
    // Two bodies, both read out of the live fields rather than restated here.
    //
    //  - urlencoded, carrying `password` (caught by the static name set) and
    //    `recovery` (caught ONLY if the probe reported that name, because
    //    `#configured-secret` is a workspace-configured secret and no static
    //    list would guess the word "recovery");
    //  - JSON, carrying a nested `account.password` and an `otp_b64` whose value
    //    is base64 — the rendering a literal scanner cannot see.
    //
    // 127.0.0.1:9 is the discard port: the connection is refused, which is
    // irrelevant. `Network.requestWillBeSent` fires with the body regardless,
    // and that is the ingest point under test.
    await client.send(
      'Runtime.evaluate',
      {
        expression: `(async () => {
          const pw = document.querySelector('#form-pw').value
          const user = document.querySelector('#form-user').value
          const recovery = document.querySelector('#configured-secret').value
          try {
            await fetch('http://127.0.0.1:9/collect-form', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ username: user, password: pw, recovery: recovery }).toString()
            })
          } catch (e) {}
          try {
            await fetch('http://127.0.0.1:9/collect-json', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                account: { username: user, password: pw },
                otp_b64: btoa(pw)
              })
            })
          } catch (e) {}
          return true
        })()`,
        awaitPromise: true,
        returnByValue: true
      },
      sessionId
    )
    await delay(400)

    // NON-VACUITY: the values genuinely reached the fields. Lengths only — this
    // test must not itself echo the secrets into anything.
    const readBack = await client.send<{ result: { value: Record<string, number> } }>(
      'Runtime.evaluate',
      {
        expression: `(() => ({
          pw: document.querySelector('#pw').value.length,
          otp: document.querySelector('#otp').value.length,
          configured: document.querySelector('#configured-secret').value.length,
          username: document.querySelector('#username').value.length,
          formPw: document.querySelector('#form-pw').value.length
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
    // The same control for the boundary-crossing cases. If Chromium ever stops
    // serializing shadow / same-origin-frame content into the snapshot, F3's
    // assertions become vacuous — this makes that change fail loudly instead.
    rawBoundaryLeaked = {
      layout: rawSnapshot.strings.some((s) => s.includes(LAYOUT_SENTINEL)),
      shadow: rawSnapshot.strings.some((s) => s.includes(SHADOW_SENTINEL)),
      frame: rawSnapshot.strings.some((s) => s.includes(FRAME_SENTINEL))
    }

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
    // Re-plant F2/F3 in the SECOND document, and keep *these* lengths as the
    // non-vacuity control: `captureDom()` below replaces the harvester's
    // snapshot, so the DOM and AX files that actually reach disk describe this
    // document, and the assertions must be controlled against it.
    boundaryLengths = await plantBoundarySecrets()
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
      ['password typed after a navigation (second document)', PASSWORD_SENTINEL_2],
      ['submitted form password (F1)', FORM_SENTINEL],
      ['rendered secret text (F2)', LAYOUT_SENTINEL],
      ['one-time-code inside a shadow root (F3)', SHADOW_SENTINEL],
      ['password inside a same-origin iframe (F3)', FRAME_SENTINEL]
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

  /* ---------------- F1 / F2 / F3 ------------------------------------------ *
   *
   * These assert against `harvestResult.files` — Tier A's OUTPUT, before
   * `seal()` runs — as well as against the bytes on disk. That is deliberate.
   * The sentinels are handed to `seal()` as `suppressedValues`, so Tier B would
   * scrub a literal leak from the written bytes and the on-disk assertion would
   * pass while Tier A was broken. Asserting on the pre-seal files is what makes
   * these genuinely fail when the ingest control is removed, which is the only
   * property that makes a regression test worth having.
   * ------------------------------------------------------------------------ */

  const tierAFile = (path: string): string => {
    const file = harvestResult.files.find((f) => f.path === path)
    if (!file) throw new Error(`harvest produced no ${path}`)
    return file.contents as string
  }

  describe('F1 — a submitted request body does not carry the typed password', () => {
    it('the sentinel really does have distinct encoded renderings', () => {
      // Without this, three of the assertions below would be searching for
      // bytes identical to the literal and would be tautologies.
      const labels = new Map(renderings(FORM_SENTINEL).map((r) => [r.label, r.bytes.toString()]))
      const literal = labels.get('literal (utf8)')!
      expect(labels.get('encodeURIComponent')).not.toBe(literal)
      expect(labels.get('form-urlencoded')).not.toBe(literal)
      expect(labels.get('JSON-escaped')).not.toBe(literal)
      expect(labels.get('base64')).not.toBe(literal)
    })

    it('the form was really submitted and its body really was retained', () => {
      // NON-VACUITY, and the sharpest control in this file. If the body had
      // simply been dropped wholesale, every absence assertion below would pass
      // while proving nothing about field-wise redaction. The ordinary username
      // surviving in the same body is what proves the body is there and that
      // suppression is targeted.
      expect(typedBack.formPw).toBe(FORM_SENTINEL.length)
      const har = tierAFile(FILE_PATHS.har)
      expect(har).toContain('/collect-form')
      expect(har).toContain('/collect-json')
      expect(har).toContain(USERNAME_VALUE)
    })

    it('no rendering of the password survives in the Tier A HAR', () => {
      const har = Buffer.from(tierAFile(FILE_PATHS.har), 'utf8')
      const offenders = renderings(FORM_SENTINEL)
        .filter((r) => har.includes(r.bytes))
        .map((r) => r.label)
      expect(offenders).toEqual([])
    })

    it('no rendering of the password survives in any written byte', () => {
      const offenders: string[] = []
      for (const file of written) {
        for (const r of renderings(FORM_SENTINEL)) {
          if (file.bytes.includes(r.bytes)) offenders.push(`${file.relative} [${r.label}]`)
        }
      }
      expect(offenders).toEqual([])
    })

    it('redacts a field the probe named, which no static list could have guessed', () => {
      // `recovery` is the parameter name of `#configured-secret`, a
      // workspace-configured secret. Nothing but the probe reporting that name
      // can redact this — it is the layer that the review said was missing.
      const har = Buffer.from(tierAFile(FILE_PATHS.har), 'utf8')
      const offenders = renderings(CONFIGURED_SENTINEL)
        .filter((r) => har.includes(r.bytes))
        .map((r) => r.label)
      expect(offenders).toEqual([])
      // …and the parameter is still *present*, redacted rather than deleted, so
      // the HAR still says a recovery phrase was submitted.
      expect(har.toString('utf8')).toContain('recovery')
    })
  })

  describe('F2 — layout.text does not carry a rendered secret', () => {
    it('the secret div really rendered the sentinel, and an unfiltered snapshot leaks it', () => {
      expect(boundaryLengths.layout).toBe(LAYOUT_SENTINEL.length)
      expect(rawBoundaryLeaked.layout).toBe(true)
    })

    it('no string reachable from layout.text contains the sentinel', () => {
      const snapshot = JSON.parse(tierAFile(FILE_PATHS.dom)) as {
        documents?: Array<{ layout?: { text?: number[] } }>
        strings?: string[]
      }
      const strings = snapshot.strings ?? []

      let layoutTextEntries = 0
      const offenders: string[] = []
      for (const doc of snapshot.documents ?? []) {
        for (const index of doc.layout?.text ?? []) {
          if (index < 0) continue
          layoutTextEntries++
          if ((strings[index] ?? '').includes(LAYOUT_SENTINEL)) offenders.push(`strings[${index}]`)
        }
      }

      // NON-VACUITY: a snapshot with no layout text at all would pass trivially.
      expect(layoutTextEntries).toBeGreaterThan(0)
      expect(offenders).toEqual([])
    })

    it('the sentinel is absent from the whole Tier A snapshot, not just from layout.text', () => {
      // The string table is the other half: redirecting the reference while
      // leaving the bytes interned in `strings[]` would fail here.
      expect(tierAFile(FILE_PATHS.dom)).not.toContain(LAYOUT_SENTINEL)
    })
  })

  describe('F3 — secrets behind a shadow and a frame boundary are marked and filtered', () => {
    it('both boundary secrets really exist and an unfiltered snapshot leaks both', () => {
      expect(boundaryLengths.shadow).toBe(SHADOW_SENTINEL.length)
      expect(boundaryLengths.frame).toBe(FRAME_SENTINEL.length)
      // If either of these goes false, the fix is not proven unnecessary — the
      // vector moved, and this test needs rewriting against the new one.
      expect(rawBoundaryLeaked.shadow).toBe(true)
      expect(rawBoundaryLeaked.frame).toBe(true)
    })

    it('marking AND resolution both reached across the boundaries', () => {
      // The discriminating assertion. Marking alone is not the fix: if
      // `markSecrets` stamps a shadow/frame element but the main side cannot
      // resolve it to a backendNodeId, the counter climbs, nothing is filtered,
      // and the leak persists. The three original fields plus these two is five.
      expect(harvestResult.secretBackendNodeIds.length).toBeGreaterThanOrEqual(5)
      expect(harvestResult.domFilter!.unmatched).toEqual([])
    })

    it('neither boundary secret appears in the Tier A snapshot or AX tree', () => {
      for (const [label, sentinel] of [
        ['shadow root', SHADOW_SENTINEL],
        ['same-origin iframe', FRAME_SENTINEL]
      ] as const) {
        expect(`${label}: ${tierAFile(FILE_PATHS.dom)}`).not.toContain(sentinel)
        expect(`${label}: ${tierAFile(FILE_PATHS.ax)}`).not.toContain(sentinel)
      }
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
