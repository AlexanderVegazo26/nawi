import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDraft } from '@shared/sidecar/draft'
import type { Surface } from '@shared/sidecar/types'
import { CdpClient } from '../cdp/client'
import { CaptureClock } from '../cdp/clock'
import { findBrowserExecutable, launchDebugBrowser, type LaunchedBrowser } from '../cdp/launcher'
import { TEST_BROWSER_ARGS } from '../cdp/test-browser-args'
import { decodePng } from '../mobile/png'
import { findAnchor, scaleImage } from '../replay/visual-anchor'
import { seal } from '../sidecar/seal'
import { FILE_PATHS, Harvester, type HarvestClient } from './harvest'

/**
 * Roadmap AI1, recorder side, end to end in a real Chromium: real mouse presses
 * go through the injected listener and probe to the harvester, which shoots the
 * viewport and keeps the pressed element's crop. Then the crop is looked for
 * the way a replay does (fresh lossless shot, scaled to CSS px, findAnchor),
 * and every case where a crop would show a secret, or pixels the page can't
 * vouch for, must have none.
 */

const FIXTURE_URL = pathToFileURL(resolve(__dirname, '__fixtures__/crops.html')).href

const SURFACE: Surface = {
  type: 'browser',
  app: 'Chromium',
  url: FIXTURE_URL,
  os: process.platform,
  locale: 'en-US',
  viewport: { w: 800, h: 600, dpr: 1 },
  displays: []
}

const executable = findBrowserExecutable(['playwright-chromium'])
const describeWithBrowser = executable ? describe : describe.skip
if (!executable) console.warn('[crop.integration] no Playwright Chromium found; recorder crop tests SKIPPED')

type Line = { type: string; target: { selectors: Array<{ value: string }>; bounds: number[] | null; image?: string } | null }

describeWithBrowser('reference crops recorded from real presses (roadmap AI1)', () => {
  let browser: LaunchedBrowser
  let client: CdpClient
  let sessionId: string
  let lines: Line[]
  let files: Map<string, Uint8Array>
  let sealed: ReturnType<typeof seal>
  /** Each recorded click's element box, read from the page right before pressing. */
  const rects = new Map<string, number[]>()

  beforeAll(async () => {
    browser = await launchDebugBrowser({ prefer: ['playwright-chromium'], headless: true, extraArgs: [...TEST_BROWSER_ARGS], startUrl: 'about:blank' })
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
    await client.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId)

    // Counts screenshots in flight, so each press waits for its own shot (the harvester takes one at a time).
    let inFlight = 0
    let idle: Array<() => void> = []
    const counting: HarvestClient = {
      send: async (method, params, sid) => {
        if (method !== 'Page.captureScreenshot') return client.send(method, params, sid)
        inFlight++
        try {
          return await client.send(method, params, sid)
        } finally {
          inFlight--
          if (inFlight === 0) for (const done of idle.splice(0)) done()
        }
      },
      on: (method, listener) => client.on(method, listener)
    }
    const shotsDone = (): Promise<void> => (inFlight === 0 ? Promise.resolve() : new Promise((done) => idle.push(done)))

    const draft = createDraft({ capture_id: '11111111-2222-4333-8444-555555555555', kind: 'recording', surface: SURFACE, generator: 'crop-test' })
    const harvester = await Harvester.start({ client: counting, sessionId, clock: new CaptureClock(), draft })
    harvester.markRecordingStarted()
    const loaded = client.once('Page.loadEventFired', 15_000)
    await client.send('Page.navigate', { url: FIXTURE_URL }, sessionId)
    await loaded
    await harvester.calibrate()

    const evaluate = async <T,>(expression: string): Promise<T> =>
      (await client.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true }, sessionId)).result.value
    const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
      client.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra }, sessionId)

    /** A real press and release on `selector` (in the top document, or inside `#framed`): at its centre, or `dx` px from its left edge. */
    const press = async (selector: string, inFrame = false, dx?: number): Promise<void> => {
      const r = await evaluate<number[]>(`(() => {
        const el = ${inFrame ? `document.querySelector('#framed').contentDocument.querySelector(${JSON.stringify(selector)})` : `document.querySelector(${JSON.stringify(selector)})`}
        const b = el.getBoundingClientRect()
        const off = ${inFrame ? "document.querySelector('#framed').getBoundingClientRect()" : '{ left: 0, top: 0 }'}
        return [b.left, b.top, b.width, b.height, off.left, off.top]
      })()`)
      rects.set(selector, r.slice(0, 4))
      const x = r[4] + r[0] + (dx ?? r[2] / 2)
      const y = r[5] + r[1] + r[3] / 2
      await mouse('mouseMoved', x, y)
      await mouse('mousePressed', x, y, { clickCount: 1 })
      await mouse('mouseReleased', x, y, { clickCount: 1 })
      // The click event is delivered with the release; then the press's shot (if any) settles.
      await evaluate('new Promise((r) => requestAnimationFrame(() => r(1)))')
      await shotsDone()
    }

    for (const selector of ['#save', '#pw', '#covered', '#by-frame', '#region']) await press(selector)
    // On the button's own padding, left of the secret span: the target is the button that holds the secret.
    await press('#pay', false, 6)
    await press('#inner', true)
    // Both beside the element that ends up over them, so the click still lands on the button.
    await press('#reveal', false, 110)
    await press('#near-child', false, 100)
    // A press on #kbd released somewhere else, then a keyboard activation of #kbd: that click had no press of its own.
    {
      const r = await evaluate<number[]>(`(() => { const b = document.querySelector('#kbd').getBoundingClientRect(); return [b.left, b.top, b.width, b.height] })()`)
      rects.set('#kbd', r)
      await mouse('mouseMoved', r[0] + r[2] / 2, r[1] + r[3] / 2)
      await mouse('mousePressed', r[0] + r[2] / 2, r[1] + r[3] / 2, { clickCount: 1 })
      await mouse('mouseMoved', 790, 590)
      await mouse('mouseReleased', 790, 590, { clickCount: 1 })
      await shotsDone()
      await evaluate(`document.querySelector('#kbd').focus()`)
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, sessionId)
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId)
      await evaluate('new Promise((r) => requestAnimationFrame(() => r(1)))')
      await shotsDone()
    }
    // Move away so nothing is hovered when the replay-side shot is taken below.
    await mouse('mouseMoved', 790, 590)

    const result = await harvester.finish()
    sealed = seal(draft, result.files)
    files = new Map(result.files.map((f) => [f.path, typeof f.contents === 'string' ? Buffer.from(f.contents) : f.contents]))
    lines = Buffer.from(files.get(FILE_PATHS.input) ?? new Uint8Array())
      .toString('utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Line)
  }, 60_000)

  afterAll(async () => {
    client?.close()
    await browser?.close()
  })

  const clickOn = (id: string): Line => {
    const hit = lines.filter((l) => l.type === 'click' && l.target?.selectors.some((s) => s.value === `#${id}`))
    if (hit.length !== 1) throw new Error(`expected one click on #${id}, got ${hit.length}; clicks: ${JSON.stringify(lines.filter((l) => l.type === 'click').map((l) => l.target?.selectors[0]?.value))}`)
    return hit[0]
  }

  it('records the clicked element box as bounds, in top-viewport CSS px', () => {
    for (const id of ['save', 'pay', 'pw', 'covered', 'by-frame', 'region']) {
      const bounds = clickOn(id).target?.bounds
      const want = rects.get(`#${id}`)!
      expect(bounds, `bounds of #${id}`).toHaveLength(4)
      bounds!.forEach((v, i) => expect(Math.abs(v - want[i]), `#${id} bounds[${i}] = ${v}, page rect ${want[i]}`).toBeLessThanOrEqual(0.05))
    }
  })

  it('records no bounds for an element inside a frame (its box is not in the top viewport)', () => {
    expect(clickOn('inner').target?.bounds).toBeNull()
  })

  it('keeps a crop of a plain button, and a replay-side shot finds it at the button centre', async () => {
    const image = clickOn('save').target?.image
    expect(image, 'the click on #save names a crop').toMatch(/^input_crops\/\d{6}\.png$/)
    const crop = decodePng(files.get(image!)!)
    if (!crop.ok) throw new Error(`crop is not a PNG: ${crop.error}`)
    expect([crop.image.width, crop.image.height], 'crop size = button size in CSS px').toEqual([120, 32])

    const size = (await client.send<{ result: { value: number[] } }>('Runtime.evaluate', { expression: '[innerWidth, innerHeight]', returnByValue: true }, sessionId)).result.value
    const shot = await client.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sessionId)
    const screen = decodePng(Buffer.from(shot.data, 'base64'))
    if (!screen.ok) throw new Error(screen.error)
    const match = findAnchor(scaleImage(screen.image, size[0], size[1]), crop.image)
    expect(match, 'the recorded crop found again in the viewport').toMatchObject({ found: 1, x: 80, y: 36 })
  })

  it.each([
    ['pw', 'a password field'],
    ['pay', 'a button holding a secret-marked span'],
    ['covered', 'a button a password field overlaps'],
    ['by-frame', 'a button a frame with unreadable content overlaps'],
    ['region', 'an area larger than a control'],
    ['inner', 'a button inside a frame'],
    ['reveal', 'a button whose own press handler shows a secret over it before the screenshot'],
    ['near-child', 'a button an unmarked child of a secret element covers'],
    ['kbd', 'a keyboard click after a press that ended elsewhere']
  ])('keeps no crop of #%s (%s)', (id) => {
    expect(clickOn(id).target?.image, `#${id} must not have a crop`).toBeUndefined()
  })

  it('writes exactly one crop file, the one the #save click names', () => {
    expect([...files.keys()].filter((p) => p.startsWith(`${FILE_PATHS.crops}/`))).toEqual([clickOn('save').target?.image])
  })

  it('seals the harvest output: the crop passes the chokepoint byte-exact and is listed as unscanned binary', () => {
    const image = clickOn('save').target!.image!
    expect(sealed.report.binaryPassed).toEqual([image])
    expect(sealed.report.tierAFailures).toEqual([])
    expect(Buffer.compare(Buffer.from(sealed.files.find((f) => f.path === image)!.contents as Uint8Array), Buffer.from(files.get(image)!))).toBe(0)
  })
})
