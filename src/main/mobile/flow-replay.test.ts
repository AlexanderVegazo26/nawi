import { describe, expect, it } from 'vitest'
import { parseFlow, type Flow } from '../../shared/flow'
import { planSwipes, PROMPT_GONE_TIMEOUT_MS, replayAndroidFlow, type AndroidReplayRequest } from './flow-replay'
import { crashLogLine } from './crash'
import { anr, javaCrash, nativeCrash } from './fixtures/crash-logs'
import { DEVICE_AHEAD_MS, device, ID, PKG, PROMPT_BUTTONS, promptButtonBox, SHOP_LAUNCHER, type Device } from './fixtures/shop-app'
import { decodePng } from './png'

/**
 * The Android replayer (roadmap M5a) against a simulated shop app behind a fake adb: every screen is a uiautomator
 * dump built from the spec in fixtures/shop-app.ts, a tap lands on the topmost tappable control whose bounds hold the point, typed text
 * goes into the focused field, Back closes the keyboard or pops the screen. Each test reads like the flow a person
 * would record, and checks both what reached the device's shell and what the run reports.
 */

function flow(steps: string, extra = ''): Flow {
  const text = `version: 1\nname: Shop\ntarget: { kind: android, package: ${PKG} }\n${extra}steps:\n${steps}`
  const r = parseFlow(text)
  if (!r.ok) throw new Error(`fixture flow does not parse: ${JSON.stringify(r.errors)}\n${text}`)
  return r.flow
}

const REQ = { adb: '/sdk/platform-tools/adb', serial: 'emulator-5560' }
const run = (f: Flow, d: Device, more: Partial<AndroidReplayRequest> = {}) => replayAndroidFlow({ ...REQ, flow: f, secret: (n) => (n === 'pw' ? "s3cr3t 'pw'" : undefined), ...more }, d.host)

const SIGN_IN = flow(
  `  - { id: s1, action: fill, intent: Type the email, target: { selectors: [{ id: "${ID('email')}" }] }, value: ana@example.com }
  - { id: s2, action: fill, target: { selectors: [{ id: "${ID('password')}" }] }, value: "\${secret.pw}" }
  - { id: s3, action: click, target: { selectors: [{ text: Sign in }] } }
  - { id: s4, action: click, target: { selectors: [{ text: "Order #2" }] } }
  - { id: s5, action: assert, target: { selectors: [{ id: "${ID('status')}" }] }, expect: { text: Shipped to Ana } }
  - { id: s6, action: press, key: Back }
  - { id: s7, action: assert, target: { selectors: [{ desc: Cart }] }, expect: { visible: true, enabled: true } }
`
)

describe('replayAndroidFlow', () => {
  it('replays a recorded sign-in → order flow green, three runs alike, typing only through quoted input text', async () => {
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) {
      const d = device()
      const r = await run(SIGN_IN, d)
      expect(r.status, `run ${i + 1}: ${JSON.stringify(r.steps.find((s) => s.status === 'failed'))}`).toBe('passed')
      expect(d.typed, 'the fields hold what the flow typed').toEqual({ [ID('email')]: 'ana@example.com', [ID('password')]: "s3cr3t 'pw'" })
      expect(d.stack, 'Back returned to the order list').toEqual(['login', 'orders'])
      outcomes.push(JSON.stringify({ lines: d.lines, steps: r.steps.map((s) => [s.id, s.status, s.matched?.layer, s.matched?.fallback]) }))
    }
    expect(new Set(outcomes).size, 'three replays must send the same commands and report the same matches').toBe(1)
    const d = device()
    const r = await run(SIGN_IN, d)
    expect(d.lines).toEqual([
      'input tap 540 375',
      'input text \'ana@example.com\'',
      'input tap 540 575',
      "input text 's3cr3t '\\''pw'\\'''",
      'input tap 540 775',
      'input tap 540 525',
      'input keyevent KEYCODE_BACK'
    ])
    expect(r.steps.map((s) => s.matched?.layer ?? null)).toEqual(['id', 'id', 'text', 'text', 'id', null, 'desc'])
    expect(r.steps[0].intent).toBe('Type the email')
    expect(JSON.stringify(r), 'the run record must not hold the secret').not.toContain('s3cr3t')
  })

  it('waits for a list that loads after the tap (auto-wait), without a fixed sleep in the flow', async () => {
    const d = device('orders')
    const r = await run(flow(`  - { id: open, action: click, target: { selectors: [{ text: "Order #1" }] } }\n`), d)
    expect(r.status).toBe('passed')
    expect(d.stack).toEqual(['orders', 'order'])
  })

  it('falls back to a later locator when the first finds nothing, and says so', async () => {
    const r = await run(flow(`  - { id: cart, action: click, target: { selectors: [{ id: "${ID('basket')}" }, { desc: Cart }] } }\n`), device('orders'))
    expect(r.steps[0]).toMatchObject({ status: 'passed', matched: { index: 1, layer: 'desc', fallback: true }, misses: [{ index: 0, found: 0 }] })
  })

  it('treats a locator matching two views as no match, and an earlier ambiguous locator as no drift', async () => {
    const twin = device('orders', { onRead: (_n, s) => (s.orders.controls[3].text = 'Order #1') })
    const r = await run(flow(`  - { id: pick, action: click, target: { selectors: [{ text: "Order #1" }, { id: "${ID('order_2')}" }] } }\n`), twin)
    expect(r.steps[0]).toMatchObject({ status: 'passed', matched: { index: 1, layer: 'id', fallback: false }, misses: [{ index: 0, found: 2 }] })
    expect(twin.lines).toEqual(['input tap 540 525'])
  })

  it('fails a step whose view never shows with every locator\'s result, and leaves the rest not run', async () => {
    const d = device('orders')
    const r = await run(
      flow(`  - { id: gone, action: click, timeout_ms: 2000, target: { selectors: [{ id: "${ID('checkout')}" }, { text: Checkout }] } }\n  - { id: next, action: press, key: Back }\n`),
      d
    )
    expect(r).toMatchObject({ status: 'failed', failedStepId: 'gone' })
    expect(r.steps[0].error).toBe(`no view of ${PKG} matched: id=${ID('checkout')} found nothing; text="Checkout" found nothing`)
    expect(r.steps[0].misses).toEqual([
      { index: 0, selector: { id: ID('checkout') }, found: 0 },
      { index: 1, selector: { text: 'Checkout' }, found: 0 }
    ])
    expect(r.steps[0].durationMs, 'it waited out its own timeout').toBeGreaterThanOrEqual(2000)
    expect(r.steps[1].status).toBe('not_run')
    expect(d.lines, 'nothing was tapped').toEqual([])
  })

  it('waits for a disabled button to turn enabled before tapping it, and fails naming why when it never does', async () => {
    const d = device('order', { onRead: (n, s) => (s.order.controls[1].enabled = n >= 4) })
    const r = await run(flow(`  - { id: track, action: click, target: { selectors: [{ text: Track }] } }\n`), d)
    expect(r.status).toBe('passed')
    expect(d.lines).toEqual(['input tap 540 375'])
    const never = device('order', { onRead: (_n, s) => (s.order.controls[1].enabled = false) })
    const f = await run(flow(`  - { id: track, action: click, timeout_ms: 1000, target: { selectors: [{ text: Track }] } }\n`), never)
    expect(f.steps[0].error).toBe('text="Track" is disabled')
    expect(never.lines).toEqual([])
  })

  it('never taps a view another app\'s window covers (a permission prompt), and ignores views of other packages', async () => {
    const d = device('order', { onRead: (_n, s) => (s.order.overlay = { pkg: 'com.android.permissioncontroller', bounds: [0, 200, 1080, 600] }) })
    const r = await run(flow(`  - { id: track, action: click, timeout_ms: 500, target: { selectors: [{ text: Track }] } }\n`), d)
    expect(r.steps[0].error).toBe('text="Track" is covered by com.android.permissioncontroller')
    expect(d.lines).toEqual([])
    const allow = await run(flow(`  - { id: allow, action: click, timeout_ms: 500, target: { selectors: [{ text: Allow }] } }\n`), d)
    expect(allow.steps[0].error, 'the prompt\'s own button is not the app\'s').toBe(`no view of ${PKG} matched: text="Allow" found nothing`)
  })

  it('hides the keyboard a fill left up before pressing Back, so Back leaves the screen as recorded', async () => {
    const d = device('orders', { keyboardOnFocus: true })
    d.stack.unshift('login')
    const r = await run(flow(`  - { id: open, action: click, target: { selectors: [{ desc: Cart }] } }\n  - { id: back, action: press, key: Back }\n`), d)
    expect(r.status).toBe('passed')
    expect(d.stack, 'no keyboard: one Back').toEqual(['login', 'orders'])
    const typing = device('login', { keyboardOnFocus: true })
    typing.stack.unshift('orders')
    const t = await run(flow(`  - { id: email, action: fill, target: { selectors: [{ id: "${ID('email')}" }] }, value: a }\n  - { id: back, action: press, key: Back }\n`), typing)
    expect(t.status).toBe('passed')
    expect(typing.lines.slice(-2), 'the first Back closes the keyboard, the second leaves the screen').toEqual(['input keyevent KEYCODE_BACK', 'input keyevent KEYCODE_BACK'])
    expect(typing.stack).toEqual(['orders'])
  })

  it('hides the on-screen keyboard before the next tap, since the dump does not show what it covers', async () => {
    const d = device('login', { keyboardOnFocus: true })
    const r = await run(SIGN_IN, d)
    expect(r.status).toBe('passed')
    expect(d.lines.slice(0, 5)).toEqual(['input tap 540 375', "input text 'ana@example.com'", 'input keyevent KEYCODE_BACK', 'input tap 540 575', "input text 's3cr3t '\\''pw'\\'''"])
  })

  it('clears what a field holds before typing, and refuses values input text cannot type or a view that is not a field', async () => {
    const d = device()
    const twice = flow(`  - { id: a, action: fill, target: { selectors: [{ desc: Email }] }, value: first }\n  - { id: b, action: fill, target: { selectors: [{ desc: Email }] }, value: second }\n`)
    expect((await run(twice, d)).status).toBe('passed')
    expect(d.lines.slice(2, 6), 'the second fill first empties the 5 characters the first typed, both sides of the caret').toEqual([
      'input tap 540 375',
      'input keyevent KEYCODE_MOVE_END',
      'input keyevent KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL',
      'input keyevent KEYCODE_FORWARD_DEL KEYCODE_FORWARD_DEL KEYCODE_FORWARD_DEL KEYCODE_FORWARD_DEL KEYCODE_FORWARD_DEL'
    ])
    expect(d.typed[ID('email')]).toBe('second')
    const accents = await run(flow(`  - { id: a, action: fill, target: { selectors: [{ desc: Email }] }, value: José }\n`), device())
    expect(accents.steps[0].error).toBe('the value has characters a device cannot type with `input text` (only printable ASCII)')
    const onButton = device()
    const button = await run(flow(`  - { id: a, action: fill, target: { selectors: [{ text: Sign in }] }, value: x }\n`), onButton)
    expect(button.steps[0].error).toBe('text="Sign in" is a Button, not a text field')
    expect(onButton.lines, 'a fill whose locator found a button must not press it').toEqual([])
  })

  it('reports a failed input text without the device\'s words, which could echo a secret', async () => {
    const d = device('login', { typeFails: true })
    const r = await run(flow(`  - { id: pw, action: fill, target: { selectors: [{ id: "${ID('password')}" }] }, value: "\${secret.pw}" }\n`), d)
    expect(r.steps[0].error).toBe('could not type into the field on emulator-5560: adb exited with code 1')
    expect(JSON.stringify(r)).not.toContain('s3cr3t')
  })

  it('opens a deep link in the flow\'s own app, quoted for the shell, and fails with am start\'s reason (secrets scrubbed)', async () => {
    const d = device('orders', { deepLink: () => ({ stdout: 'Status: ok\nTotalTime: 90\n', go: 'order' }) })
    const r = await run(flow(`  - { id: open, action: navigate, url: "shop://orders/2?a=1&b='x'" }\n  - { id: see, action: assert, target: { selectors: [{ text: Track }] }, expect: { visible: true } }\n`), d)
    expect(r.status).toBe('passed')
    expect(d.lines).toEqual([`am start -W -a android.intent.action.VIEW -d 'shop://orders/2?a=1&b='\\''x'\\''' '${PKG}'`])
    const bad = device('orders', { deepLink: (url) => ({ stdout: `Error: Activity not started, unable to resolve Intent { dat=${url} }\n` }) })
    const f = await run(flow(`  - { id: open, action: navigate, url: "shop://login?token=\${secret.tok}" }\n`), bad, { secret: (n) => (n === 'tok' ? 'tok123' : undefined) })
    expect(f.steps[0].error).toBe('dev.nawi.shop did not open the deep link: Error: Activity not started, unable to resolve Intent { dat=shop://login?token=${secret.tok} }')
    const http = await run(flow(`  - { id: open, action: navigate, url: "not a link" }\n`), device())
    expect(http.steps[0].error).toBe('not a link is not a deep link (a URI with a scheme, such as myapp://orders/42)')
  })

  it('passes visible: false only once every locator finds nothing, and fails it while the view stays', async () => {
    const d = device('orders')
    const gone = await run(flow(`  - { id: g, action: assert, target: { selectors: [{ text: Sign in }] }, expect: { visible: false } }\n`), d)
    expect(gone.status).toBe('passed')
    const there = await run(flow(`  - { id: g, action: assert, timeout_ms: 500, target: { selectors: [{ desc: Cart }] }, expect: { visible: false } }\n`), device('orders'))
    expect(there.steps[0].error).toBe('desc="Cart": expected it to be gone, but it is on screen')
    const secretText = await run(
      flow(`  - { id: t, action: assert, timeout_ms: 500, target: { selectors: [{ id: "${ID('status')}" }] }, expect: { text: "\${secret.st}" } }\n`),
      device('order'),
      { secret: (n) => (n === 'st' ? 'Shipped  to   Ana now' : undefined) }
    )
    expect(secretText.steps[0].error, 'a secret is scrubbed before the text is folded').toBe(`id=${ID('status')}: expected text containing "\${secret.st}", got "Shipped to Ana"`)
    const shownByChild = await run(flow(`  - { id: t, action: assert, target: { selectors: [{ id: "${ID('row')}" }] }, expect: { text: Shipped } }\n`), device('order', { onRead: (_n, s) => (s.order.controls[0] = { id: ID('row'), bounds: [0, 0, 1080, 300], children: [{ id: ID('status'), text: 'Shipped', bounds: [40, 100, 1040, 250] }] }) }))
    expect(shownByChild.status, 'a row with no text of its own shows its children\'s').toBe('passed')
    const wrongText = await run(flow(`  - { id: t, action: assert, timeout_ms: 500, target: { selectors: [{ id: "${ID('status')}" }] }, expect: { text: Delivered } }\n`), device('order'))
    expect(wrongText.steps[0].error).toBe(`id=${ID('status')}: expected text containing "Delivered", got "Shipped to Ana"`)
  })

  it('stops before running anything when the flow needs an input the run lacks', async () => {
    const d = device()
    const r = await replayAndroidFlow({ ...REQ, flow: SIGN_IN }, d.host)
    expect(r).toMatchObject({ status: 'failed', error: 'the flow needs a value the run did not provide: ${secret.pw}' })
    expect(r.steps.every((s) => s.status === 'not_run')).toBe(true)
    expect(d.lines).toEqual([])
  })

  it('stops a step that is still waiting when the run is cancelled, as stopped rather than failed', async () => {
    const ctl = new AbortController()
    const d = device('orders', { onRead: (n) => n === 2 && ctl.abort('user stop') })
    const r = await run(flow(`  - { id: gone, action: click, target: { selectors: [{ text: Checkout }] } }\n  - { id: next, action: press, key: Back }\n`), d, { signal: ctl.signal })
    expect(r).toMatchObject({ status: 'failed', error: 'stopped during step gone: user stop' })
    expect(r.failedStepId).toBeUndefined()
    expect(r.steps.map((s) => [s.status, s.misses])).toEqual([['not_run', undefined], ['not_run', undefined]])
    expect(d.lines).toEqual([])
  })

  it('stops between steps when the run is cancelled, reporting every step', async () => {
    const d = device()
    const ctl = new AbortController()
    const progress: string[] = []
    const r = await run(SIGN_IN, d, {
      signal: ctl.signal,
      onStep: (e) => {
        progress.push(`${e.index}:${e.status}`)
        if (e.index === 1) ctl.abort('user stop')
      }
    })
    expect(r).toMatchObject({ status: 'failed', error: 'stopped before step s3: user stop' })
    expect(progress).toEqual(['0:passed', '1:passed', '2:not_run', '3:not_run', '4:not_run', '5:not_run', '6:not_run'])
    expect(d.lines).toHaveLength(4)
  })

  it('skips disabled steps and refuses a flow that is not an android flow', async () => {
    const r = await run(flow(`  - { id: off, action: press, key: Home, disabled: true }\n  - { id: on, action: press, key: Home }\n`), device())
    expect(r.steps.map((s) => s.status)).toEqual(['skipped', 'passed'])
    const web = parseFlow('version: 1\nname: Web\ntarget: { kind: browser, url: "https://example.com" }\nsteps: []\n')
    if (!web.ok) throw new Error('fixture')
    const w = await replayAndroidFlow({ ...REQ, flow: web.flow }, device().host)
    expect(w.error).toBe('this replayer runs android flows; the flow targets a browser')
  })
})

/** The colour at (x, y) of a base64 PNG shot. */
function pixel(shot: string | undefined, x: number, y: number): number[] {
  const png = decodePng(Buffer.from(shot ?? '', 'base64'))
  if (!png.ok) throw new Error(`shot is not a PNG: ${png.error}`)
  const at = (y * png.image.width + x) * 3
  return [...png.image.rgb.subarray(at, at + 3)]
}

describe('replayAndroidFlow evidence (roadmap M5b-2)', () => {
  const RED = [255, 0, 0]
  const MASK = [0x5f, 0x63, 0x68]

  it('records the screen before the first step and after every step, a step\'s before being the previous after', async () => {
    const d = device('login', { evidence: {} })
    const r = await run(SIGN_IN, d, { stepScreenshots: 'all' })
    expect(r.status).toBe('passed')
    for (const [i, s] of r.steps.entries()) {
      expect(s.shots?.after, `step ${s.id} has an after shot`).toMatch(/^iVBORw0KGgo/)
      if (i > 0) expect(s.shots?.before, `step ${s.id}'s before is step ${r.steps[i - 1].id}'s after`).toBe(r.steps[i - 1].shots?.after)
    }
    expect(r.steps[0].shots?.before, 'the first step has its own before shot').toMatch(/^iVBORw0KGgo/)
    expect(d.evidenceLines.filter((l) => l.startsWith('exec-out screencap')), 'one screencap per step plus the first before').toHaveLength(r.steps.length + 1)
    expect(pixel(r.steps[2].shots?.before, 540, 375), 'the email field (no secret) is shown as it is').toEqual(RED)
    expect(d.lines, 'evidence commands never mix with the steps\' own').not.toContain(expect.stringMatching(/screencap|logcat/))
  })

  it('paints over a field the run typed a secret into, in every shot from that step on, but not before', async () => {
    const d = device('login', { evidence: {} })
    const r = await run(SIGN_IN, d, { stepScreenshots: 'all' })
    const [, s2] = r.steps
    expect(pixel(s2.shots?.before, 540, 575), 'before the secret is typed the password field is unmasked').toEqual(RED)
    expect(pixel(s2.shots?.after, 540, 575), 'after the secret is typed the password field is masked').toEqual(MASK)
    expect(pixel(s2.shots?.after, 540, 375), 'the email field next to it stays visible').toEqual(RED)
  })

  it('paints over the on-screen keyboard after a secret was typed (its suggestions repeat it), and skips the shot when its area is unknown', async () => {
    const steps = flow(`  - { id: pw, action: fill, target: { selectors: [{ id: "${ID('password')}" }] }, value: "\${secret.pw}" }\n`)
    const d = device('login', { evidence: {}, keyboardOnFocus: true })
    const r = await run(steps, d, { stepScreenshots: 'all' })
    expect(r.status).toBe('passed')
    expect(pixel(r.steps[0].shots?.after, 540, 2000), 'keyboard area (touchable region from the window manager)').toEqual(MASK)
    expect(pixel(r.steps[0].shots?.after, 540, 1400), 'above the keyboard stays visible').toEqual([255, 255, 255])
    const unknown = device('login', { evidence: { keyboardWindow: 'no region here\n' }, keyboardOnFocus: true })
    const r2 = await run(steps, unknown, { stepScreenshots: 'all' })
    expect(r2.steps[0].shots?.after, 'keyboard up, area unknown: no shot').toBeUndefined()
  })

  it('masks the keyboard from the first shot when the flow uses a secret anywhere, before any secret field is filled', async () => {
    const steps = flow(`  - { id: email, action: click, target: { selectors: [{ id: "${ID('email')}" }] } }
  - { id: pw, action: fill, target: { selectors: [{ id: "${ID('password')}" }] }, value: "\${secret.pw}" }
`)
    const r = await run(steps, device('login', { evidence: {}, keyboardOnFocus: true }), { stepScreenshots: 'all' })
    expect(pixel(r.steps[0].shots?.after, 540, 2000), 'keyboard up after the first tap, flow has a secret: masked').toEqual(MASK)
    const plain = await run(flow(`  - { id: email, action: click, target: { selectors: [{ id: "${ID('email')}" }] } }\n`), device('login', { evidence: {}, keyboardOnFocus: true }), { stepScreenshots: 'all' })
    expect(pixel(plain.steps[0].shots?.after, 540, 2000), 'a flow without secrets is shot as it is').toEqual([255, 255, 255])
  })

  it('collects nothing more once the run is cancelled during a step', async () => {
    const stop = new AbortController()
    const d = device('login', { evidence: {} })
    const exec = d.host.exec
    d.host.exec = async (file, args, t) => {
      if ((args[3] ?? '').startsWith('input tap')) stop.abort('paused')
      return exec(file, args, t)
    }
    const r = await run(SIGN_IN, d, { stepScreenshots: 'all', logcat: true, signal: stop.signal })
    expect(r.error).toMatch(/stopped before step s2/)
    expect(d.evidenceLines.filter((l) => l.startsWith('exec-out screencap')), 'only the before shot of the first step').toHaveLength(1)
    expect(d.evidenceLines.some((l) => l.startsWith('logcat ')), 'no log read after the stop').toBe(false)
    expect(r.steps[0].shots?.after).toBeUndefined()
  })

  it('takes no shot it cannot mask: a screen that cannot be read after a secret was typed leaves the step without one', async () => {
    let failReads = false
    const d = device('login', { evidence: {} })
    const exec = d.host.exec
    d.host.exec = async (file, args, t) => (failReads && (args[3] ?? '').startsWith('uiautomator dump') ? { code: 1, stdout: '', stderr: 'ERROR: null root node', error: 'failed' } : exec(file, args, t))
    const steps = flow(`  - { id: pw, action: fill, target: { selectors: [{ id: "${ID('password')}" }] }, value: "\${secret.pw}" }
  - { id: wait, action: wait, ms: 10 }
`)
    const onStep = (e: { id: string }): void => {
      if (e.id === 'pw') failReads = true
    }
    const r = await run(steps, d, { stepScreenshots: 'all', onStep })
    expect(r.status).toBe('passed')
    expect(r.steps[0].shots?.after, 'the screen could be read when the secret step ended').toBeDefined()
    expect(r.steps[1].shots?.before, 'the next step starts from that shot').toBe(r.steps[0].shots?.after)
    expect(r.steps[1].shots?.after, 'with a secret typed and no readable screen, no shot').toBeUndefined()
  })

  it('with screenshots "failed" keeps only the screen the failing step left', async () => {
    const d = device('login', { evidence: {} })
    const r = await run(
      flow(`  - { id: ok, action: click, target: { selectors: [{ text: Sign in }] } }
  - { id: gone, action: click, timeout_ms: 500, target: { selectors: [{ text: Nowhere }] } }
`),
      d,
      { stepScreenshots: 'failed' }
    )
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed'])
    expect(r.steps[0].shots, 'a passed step has none').toBeUndefined()
    expect(r.steps[1].shots?.before).toBeUndefined()
    expect(r.steps[1].shots?.after, 'the failed step has the screen it left').toMatch(/^iVBORw0KGgo/)
  })

  it('keeps each step\'s device log from the step\'s start on the device clock: the app\'s lines and ANRs naming it, secrets scrubbed', async () => {
    const logcat = [
      '--------- beginning of crash',
      "  1794138163.237 10234  4000  4000 E AndroidRuntime: FATAL EXCEPTION: main, password s3cr3t 'pw'",
      '  1794138163.238  1000   700   712 E ActivityManager: ANR in dev.nawi.shop (dev.nawi.shop/.Main)',
      '  1794138163.239  1000   700   712 W WifiService: Empty or null ScanResult list',
      '  1794138163.240 10235  4100  4100 E Shop: from dev.nawi.shop.debug, another app'
    ].join('\n')
    const d = device('login', { evidence: { logcat } })
    const r = await run(SIGN_IN, d, { logcat: true })
    expect(r.status).toBe('passed')
    expect(r.steps[0].shots, 'logcat alone takes no screenshots').toBeUndefined()
    expect(r.steps[0].logcat).toEqual([
      { at: '2026-11-08T11:42:43.237Z', level: 'E', tag: 'AndroidRuntime', message: 'FATAL EXCEPTION: main, password ${secret.pw}' },
      { at: '2026-11-08T11:42:43.238Z', level: 'E', tag: 'ActivityManager', message: 'ANR in dev.nawi.shop (dev.nawi.shop/.Main)' }
    ])
    const logs = d.evidenceLines.filter((l) => l.startsWith('logcat '))
    expect(logs, 'one log read per step').toHaveLength(r.steps.length)
    // The step's start on the device's clock: the host's plus the offset read once (the fake answers instantly).
    const device0 = (r.steps[0].startedAt ?? 0) + DEVICE_AHEAD_MS
    expect(logs[0]).toBe(`logcat -d -v epoch,uid -t ${Math.floor(device0 / 1000)}.${String(device0 % 1000).padStart(3, '0')} '*:W'`)
    // Each later step's log starts where the previous read began, so nothing logged between two steps is lost.
    const since = (l: string): number => Math.round(Number(/-t (\d+\.\d{3})/.exec(l)?.[1]) * 1000)
    for (let i = 1; i < logs.length; i++) {
      expect(since(logs[i]), `step ${i + 1}'s log starts no later than the step`).toBeLessThanOrEqual((r.steps[i].startedAt ?? 0) + DEVICE_AHEAD_MS)
      expect(since(logs[i]), `step ${i + 1}'s log starts no earlier than step ${i}'s`).toBeGreaterThanOrEqual(since(logs[i - 1]))
    }
  })
})

describe('replayAndroidFlow crashes and ANRs (roadmap M5d-1)', () => {
  const TRACK = flow(
    `  - { id: t1, action: click, target: { selectors: [{ id: "${ID('track')}" }] } }
  - { id: t2, action: assert, target: { selectors: [{ id: "${ID('status')}" }] }, expect: { text: Shipped to Ana } }
`
  )
  const crashing = (more: Partial<NonNullable<Parameters<typeof device>[1]>['crashOn']> = {}) =>
    device('order', { crashOn: { control: 'track', log: (sec) => javaCrash(sec, PKG), ...more } })

  it('fails the step whose tap crashed the app, with the exception and the crash report as its log', async () => {
    const d = crashing()
    const r = await run(TRACK, d)
    expect(r.status).toBe('failed')
    expect(r.failedStepId).toBe('t1')
    const t1 = r.steps[0]
    expect(t1.error).toBe(`${PKG} crashed: java.lang.IllegalStateException: tracking id missing`)
    expect(t1.crash).toMatchObject({ kind: 'crash', process: PKG, pid: 3475, summary: 'java.lang.IllegalStateException: tracking id missing' })
    expect(t1.logcat?.slice(0, 2).map((l) => l.message), 'the report is kept even with the step log off').toEqual(['FATAL EXCEPTION: main', `Process: ${PKG}, PID: 3475`])
    expect(r.steps[1].status).toBe('not_run')
    expect(d.crashReads[0], 'read from the run start on the device clock').toBe(crashLogLine(1_000_000 + DEVICE_AHEAD_MS))
  })

  it('fails a waiting step as soon as the app is gone and its crash is logged, long before the step timeout', async () => {
    // The report reaches the log only after the tap's step ended: the next step sees the launcher, not the app.
    const d = crashing({ logAfterReads: 8 })
    const r = await run(TRACK, d)
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed'])
    const t2 = r.steps[1]
    expect(t2.error).toBe(`${PKG} crashed: java.lang.IllegalStateException: tracking id missing`)
    expect(t2.crash?.kind).toBe('crash')
    expect(t2.durationMs, `the step must not wait out its 10 s timeout (took ${t2.durationMs} ms)`).toBeLessThanOrEqual(2_500)
    // 8 screen reads (~2 s) before the report: one check after t1, then one per CRASH_POLL_MS (at ~1 s and ~2 s), not one per read.
    expect(d.crashReads.length, 'checks while waiting are spaced CRASH_POLL_MS apart, not one per screen read').toBe(3)
  })

  it('fails the step after which the app stopped responding (ANR), though its screen stays', async () => {
    const d = crashing({ hang: true, log: (sec) => anr(sec, PKG) })
    const r = await run(TRACK, d)
    expect(r.failedStepId).toBe('t1')
    expect(r.steps[0].error).toMatch(/^dev\.nawi\.shop stopped responding \(ANR\): Input dispatching timed out/)
    expect(r.steps[0].crash).toMatchObject({ kind: 'anr', pid: 5874 })
    expect(r.steps[0].logcat?.map((l) => l.tag)).toEqual(Array(6).fill('ActivityManager'))
  })

  it('fails a waiting step on an ANR within seconds, though the frozen app\'s views stay on screen', async () => {
    // The ANR is declared ~5 s after the tap (20 screen reads): a step that waits 30 s must not run out its timeout.
    const d = crashing({ hang: true, logAfterReads: 20, log: (sec) => anr(sec, PKG) })
    const steps = flow(`  - { id: t1, action: click, target: { selectors: [{ id: "${ID('track')}" }] } }
  - { id: t2, action: wait, timeout_ms: 30000, target: { selectors: [{ text: Delivered }] } }
`)
    const r = await run(steps, d)
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed'])
    expect(r.steps[1].error).toMatch(/^dev\.nawi\.shop stopped responding \(ANR\): Input dispatching timed out/)
    expect(r.steps[1].durationMs, `found at the next ANR_POLL_MS check after it was declared (took ${r.steps[1].durationMs} ms)`).toBeLessThanOrEqual(10_000)
    expect(d.crashReads.length, 'while the app is on screen, one check per ANR_POLL_MS').toBeLessThanOrEqual(4)
  })

  it('names the crash first when the step failed too, keeping the step\'s own reason', async () => {
    const d = crashing({ hang: true, logAfterReads: 3, log: (sec) => nativeCrash(sec, PKG) })
    const steps = flow(`  - { id: t1, action: click, target: { selectors: [{ id: "${ID('track')}" }] } }
  - { id: t2, action: assert, timeout_ms: 500, target: { selectors: [{ id: "${ID('status')}" }] }, expect: { text: Delivered } }
`)
    const r = await run(steps, d)
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed'])
    expect(r.steps[1].error).toBe(`${PKG} crashed in native code: signal 11 (SIGSEGV), code 1 (SEGV_MAPERR) (the step: id=${ID('status')}: expected text containing "Delivered", got "Shipped to Ana")`)
    expect(r.steps[1].crash?.kind).toBe('native_crash')
  })

  it('waits a moment after the last step before its crash check, so a crash its action caused cannot pass the run', async () => {
    // The app dies half a second after the tap: the run must not report it passed.
    const d = crashing({ logAfterMs: 500 })
    const r = await run(flow(`  - { id: t1, action: click, target: { selectors: [{ id: "${ID('track')}" }] } }\n`), d)
    expect(r.status).toBe('failed')
    expect(r.steps[0].error).toBe(`${PKG} crashed: java.lang.IllegalStateException: tracking id missing`)
  })

  it('counts a crash from the moment the caller launched the app (crashesSince), not only from the first step', async () => {
    const d = crashing()
    await run(TRACK, d, { crashesSince: 990_000 })
    expect(d.crashReads[0]).toBe(crashLogLine(990_000 + DEVICE_AHEAD_MS))
  })

  it('stops a waiting step that is cancelled without reading the crash log first, as stopped and not crashed', async () => {
    // The app dies after t1's check; t2 waits on the launcher. The run is cancelled on the read that comes
    // CRASH_POLL_MS after that check, where a crash check is due: the cancel wins, the log is not read.
    const controller = new AbortController()
    const d = device('order', {
      crashOn: { control: 'track', logAfterReads: 1, log: (sec) => javaCrash(sec, PKG) },
      onRead: (reads) => {
        if (reads === 6) controller.abort('user stop')
      }
    })
    const r = await run(TRACK, d, { signal: controller.signal })
    expect(r.error).toBe('stopped during step t2: user stop')
    expect(r.steps[1].crash, 'a cancelled step reports no crash').toBeUndefined()
    expect(d.crashReads, 'only the check after t1').toHaveLength(1)
  })

  it('does not repeat in the step log the crash lines beyond its cap, nor count them twice', async () => {
    const sec = Math.floor((1_000_000 + DEVICE_AHEAD_MS) / 1000)
    const report = javaCrash(sec, PKG, { frames: 45 })
    const d = device('order', { evidence: { logcat: report }, crashOn: { control: 'track', log: () => report } })
    const r = await run(TRACK, d, { logcat: true })
    const t1 = r.steps[0]
    expect(t1.logcat, 'the report\'s first 30 lines, nothing after them from the step log').toHaveLength(30)
    expect(t1.logcatDropped, '3 + 45 + 1 = 49 report lines, 19 not kept, counted once').toBe(19)
  })

  it('ignores another app\'s crash, and passes a run whose app never crashed', async () => {
    const d = device('order', { crashOn: { control: 'nothing', log: () => '', before: javaCrash(1_794_138_000, 'com.android.settings') + anr(1_794_138_000, `${PKG}.debug`) } })
    const r = await run(TRACK, d)
    expect(r.status, JSON.stringify(r.steps)).toBe('passed')
    expect(r.steps.every((s) => s.crash === undefined && s.logcat === undefined)).toBe(true)
    expect(d.crashReads, 'one check after each step').toHaveLength(2)
  })

  it('leads the step log with the crash report and keeps the step\'s other lines once (no duplicates)', async () => {
    const sec = Math.floor((1_000_000 + DEVICE_AHEAD_MS) / 1000)
    const report = javaCrash(sec, PKG)
    const other = `         ${sec}.100 10234  3475  3480 W ShopNet : retrying /orders/1/track\n`
    const d = device('order', { evidence: { logcat: other + report }, crashOn: { control: 'track', log: () => report } })
    const r = await run(TRACK, d, { logcat: true })
    const messages = r.steps[0].logcat?.map((l) => l.message) ?? []
    expect(messages[0]).toBe('FATAL EXCEPTION: main')
    expect(messages.filter((m) => m === 'FATAL EXCEPTION: main'), 'the device log repeats the report: kept once').toHaveLength(1)
    expect(messages.at(-1)).toBe('retrying /orders/1/track')
    expect(d.evidenceLines.filter((l) => l.startsWith('date ')), 'one clock read serves the crash watch and the step logs').toHaveLength(1)
  })
})

describe('replayAndroidFlow scroll (roadmap M5d-2)', () => {
  const LIST = `RecyclerView ${ID('list')}`
  // The catalog list is 1080 x 1500 at y 300 (centre 540, 1050): a full swipe covers 80% of it, 1200 px, at 0.6 px/ms.
  const SCROLL_DOWN = 'input swipe 540 1650 540 450 2000'
  const SCROLL_UP = 'input swipe 540 450 540 1650 2000'
  const swipes = (d: Device): string[] => d.lines.filter((l) => l.startsWith('input swipe'))

  it('scrolls a list until a view below the fold is on screen, then taps it where it now is, three runs alike', async () => {
    const f = flow(
      `  - { id: find, action: scroll, intent: Find item 25, target: { selectors: [{ text: "Item 25" }] } }
  - { id: open, action: click, target: { selectors: [{ text: "Item 25" }] } }
`
    )
    const outcomes = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const d = device('catalog')
      const r = await run(f, d)
      expect(r.status, `run ${i + 1}: ${JSON.stringify(r.steps.find((s) => s.status === 'failed'))}`).toBe('passed')
      expect(d.lines, 'two swipes bring item 25 (3600-3750 px into the list) on screen, the tap lands on its centre').toEqual([SCROLL_DOWN, SCROLL_DOWN, 'input tap 540 1575'])
      expect(d.stack).toEqual(['catalog', 'order'])
      expect(r.steps[0].matched, 'the scroll step reports the locator that found the view').toMatchObject({ index: 0, layer: 'text', fallback: false })
      outcomes.add(JSON.stringify([d.lines, r.steps.map((s) => [s.status, s.matched])]))
    }
    expect(outcomes.size, 'three replays must send the same swipes and report the same matches').toBe(1)
  })

  it('does not swipe when the view is already on screen, nor pull a list at its start toward its top edge (a pull-to-refresh)', async () => {
    for (const item of ['Item 2', 'Item 1']) {
      const d = device('catalog')
      const r = await run(flow(`  - { id: find, action: scroll, target: { selectors: [{ text: "${item}" }] } }\n`), d)
      expect(r.status).toBe('passed')
      expect(d.lines, item).toEqual([])
    }
  })

  it('brings a view found at the list\'s bottom edge a third of the way in, so a tap on it cannot miss', async () => {
    const d = device('catalog')
    const r = await run(flow(`  - { id: find, action: scroll, target: { selectors: [{ text: "Item 10" }] } }\n  - { id: open, action: click, target: { selectors: [{ text: "Item 10" }] } }\n`), d)
    expect(r.status, JSON.stringify(r.steps)).toBe('passed')
    // Item 10 is at 1650-1800 on screen, against the list's bottom (1800): its top goes to 300 + 1500 / 3 = 800.
    expect(d.lines).toEqual(['input swipe 540 1475 540 625 1417', 'input tap 540 875'])
  })

  it('turns back toward the start of the list once a swipe moves nothing, to find a view above', async () => {
    const d = device('catalog')
    const r = await run(
      flow(
        `  - { id: last, action: scroll, target: { selectors: [{ text: "Item 30" }] } }
  - { id: first, action: scroll, target: { selectors: [{ text: "Item 1" }] } }
`
      ),
      d
    )
    expect(r.status, JSON.stringify(r.steps)).toBe('passed')
    expect(swipes(d), 'down to the end (+ the edge nudge), one swipe that moves nothing, three up to the start (+ the edge nudge)').toEqual([
      SCROLL_DOWN,
      SCROLL_DOWN,
      SCROLL_DOWN,
      'input swipe 540 1475 540 625 1417',
      SCROLL_DOWN,
      SCROLL_UP,
      SCROLL_UP,
      SCROLL_UP,
      'input swipe 540 625 540 1475 1417'
    ])
    expect(d.offsets[ID('list')]).toBe(0)
  })

  it('fails a view that is in neither end of the list, naming the list and every locator, long before its timeout', async () => {
    const d = device('catalog')
    const r = await run(flow(`  - { id: find, action: scroll, target: { selectors: [{ id: "${ID('item_99')}" }, { text: "Item 99" }] } }\n`), d)
    expect(r.status).toBe('failed')
    expect(r.steps[0].error).toBe(`scrolled the ${LIST} to both ends; no view of ${PKG} matched: id=${ID('item_99')} found nothing; text="Item 99" found nothing`)
    expect(r.steps[0].misses?.map((m) => m.found)).toEqual([0, 0])
    expect(swipes(d), 'down to the end and back to the start, each end seen by one swipe that moved nothing').toEqual([...Array(4).fill(SCROLL_DOWN), ...Array(4).fill(SCROLL_UP)])
    expect(r.steps[0].durationMs, 'it stops at the second end, not at the 60 s scroll timeout').toBeLessThan(30_000)
  })

  it('still sees the end of a list whose views change by themselves (a ticking text does not count as movement)', async () => {
    const d = device('catalog', { onRead: (n, s) => (s.catalog.controls[1].scroll!.content[28].text = `Item 29 (${n} s)`) })
    const r = await run(flow(`  - { id: find, action: scroll, target: { selectors: [{ text: "Item 99" }] } }\n`), d)
    expect(r.steps[0].error).toMatch(/^scrolled the RecyclerView dev\.nawi\.shop:id\/list to both ends;/)
    expect(swipes(d).length).toBe(8)
  })

  it('fails a scroll to a view when the screen has no list to look in, after waiting for one', async () => {
    const d = device('order')
    const r = await run(flow(`  - { id: find, action: scroll, timeout_ms: 1000, target: { selectors: [{ text: Refund }] } }\n`), d)
    expect(r.steps[0].error).toBe(`no view of ${PKG} matched: text="Refund" found nothing, and no scrollable view of ${PKG} is on screen to look further`)
    expect(d.lines).toEqual([])
  })

  it('gives a scroll to a view 60 s by default, and the step\'s timeout_ms when it has one', async () => {
    // A list that grows by ten rows at every read (endless loading): only the clock ends the search.
    const endless = (): Device =>
      device('catalog', {
        onRead: (_n, s) => {
          const content = s.catalog.controls[1].scroll!.content
          for (let k = 0; k < 10; k++) content.push({ text: `More ${content.length}`, bounds: [0, content.length * 150, 1080, content.length * 150 + 150] })
        }
      })
    const d = endless()
    const r = await run(flow(`  - { id: find, action: scroll, target: { selectors: [{ text: Nowhere }] } }\n`), d)
    expect(r.steps[0].error).toMatch(/^no view of dev\.nawi\.shop matched: text="Nowhere" found nothing \(searched the RecyclerView dev\.nawi\.shop:id\/list with 2\d swipes\)$/)
    expect(r.steps[0].durationMs).toBeGreaterThanOrEqual(60_000)
    const short = await run(flow(`  - { id: find, action: scroll, timeout_ms: 2000, target: { selectors: [{ text: Nowhere }] } }\n`), endless())
    expect(short.steps[0].error).toMatch(/\(searched the RecyclerView dev\.nawi\.shop:id\/list with 1 swipes\)$/)
  })

  it('swipes inside the step\'s view by its delta (a pager), and fails a swipe that moves nothing there', async () => {
    const d = device('catalog')
    const banner = (id: string, dx: number): string => `  - { id: ${id}, action: scroll, target: { selectors: [{ id: "${ID('banner')}" }] }, delta: [${dx}, 0] }\n`
    const r = await run(flow(`${banner('next', 1080)}${banner('third', 1080)}  - { id: shown, action: assert, target: { selectors: [{ text: "Deal 3" }] }, expect: { visible: true } }\n`), d)
    expect(r.status, JSON.stringify(r.steps)).toBe('passed')
    // The banner is 1080 x 300 at y 1850: 1080 px is two swipes of 540 px (80% of it is 864), centred on it.
    expect(d.lines).toEqual(Array(4).fill('input swipe 810 2000 270 2000 900'))
    expect(d.offsets).toEqual({ [ID('banner')]: 2160 })
    expect(r.steps[0].matched).toMatchObject({ layer: 'id' })
    const end = await run(flow(banner('past', 864)), d)
    expect(end.steps[0].error).toBe(`the swipe moved nothing in id=${ID('banner')}: it is already at that end, or it springs back (a pager turns a page only when one swipe covers most of its width)`)
  })

  it('scrolls the app\'s largest list by a delta when the step has no target, and its window when it shows no list', async () => {
    const d = device('catalog')
    const r = await run(
      flow(
        `  - { id: by, action: scroll, delta: [0, 1200] }
  - { id: shown, action: assert, target: { selectors: [{ text: "Item 9" }] }, expect: { visible: true } }
  - { id: back, action: scroll, delta: [0, -300] }
`
      ),
      d
    )
    expect(r.status, JSON.stringify(r.steps)).toBe('passed')
    expect(d.lines).toEqual([SCROLL_DOWN, 'input swipe 540 900 540 1200 500'])
    expect(d.offsets[ID('list')]).toBe(900)
    expect(r.steps[0].matched, 'no target, no match').toBeUndefined()
    const page = device('order')
    const p = await run(flow(`  - { id: by, action: scroll, delta: [0, 500] }\n`), page)
    expect(page.lines, 'the window is 2400 px high: one swipe from below its centre').toEqual(['input swipe 540 1450 540 950 833'])
    expect(p.steps[0].error, 'a screen that does not scroll fails the step that tried').toMatch(/^the swipe moved nothing in the window of dev\.nawi\.shop:/)
  })

  it('hides the on-screen keyboard before a swipe, so the swipe cannot land on a key', async () => {
    const d = device('catalog', { keyboardOnFocus: true })
    const r = await run(flow(`  - { id: search, action: fill, target: { selectors: [{ id: "${ID('search')}" }] }, value: a }\n  - { id: by, action: scroll, delta: [0, 300] }\n`), d)
    expect(r.status, JSON.stringify(r.steps)).toBe('passed')
    expect(d.lines.slice(-2)).toEqual(['input keyevent KEYCODE_BACK', 'input swipe 540 1200 540 900 500'])
    expect(d.stack, 'Back only closed the keyboard').toEqual(['catalog'])
  })

  it('never swipes where another app\'s window covers the list (a permission prompt)', async () => {
    const prompt = { pkg: 'com.android.permissioncontroller', bounds: [0, 1450, 1080, 1900] as [number, number, number, number] }
    const d = device('catalog', { onRead: (_n, s) => (s.catalog.overlay = prompt) })
    const r = await run(flow(`  - { id: find, action: scroll, timeout_ms: 1000, target: { selectors: [{ text: "Item 25" }] } }\n`), d)
    expect(r.steps[0].error).toBe(`no view of ${PKG} matched: text="Item 25" found nothing; the ${LIST} is covered by com.android.permissioncontroller`)
    const by = device('catalog', { onRead: (_n, s) => (s.catalog.overlay = prompt) })
    const b = await run(flow(`  - { id: by, action: scroll, timeout_ms: 1000, delta: [0, 900] }\n`), by)
    expect(b.steps[0].error).toBe(`the ${LIST} is covered by com.android.permissioncontroller`)
    expect([...d.lines, ...by.lines]).toEqual([])
  })

  it('refuses a delta the view is too small for instead of swiping it a hundred times', async () => {
    const d = device('catalog')
    const r = await run(flow(`  - { id: far, action: scroll, timeout_ms: 1000, target: { selectors: [{ id: "${ID('banner')}" }] }, delta: [100000, 0] }\n`), d)
    expect(r.steps[0].error).toBe(`id=${ID('banner')} is too small to scroll [100000, 0] in at most 30 swipes`)
    expect(d.lines).toEqual([])
  })

  it('counts a view the dump keeps with unreadable bounds (a row scrolled past the top) as not on screen in waits and assertions', async () => {
    const scrolledPast = (): Device => device('order', { onRead: (_n, s) => (s.order.controls[0].bounds = [40, 300, 1040, 120]) })
    const target = `target: { selectors: [{ id: "${ID('status')}" }] }`
    const gone = await run(flow(`  - { id: gone, action: assert, ${target}, expect: { visible: false } }\n`), scrolledPast())
    expect(gone.status, JSON.stringify(gone.steps)).toBe('passed')
    const shown = await run(flow(`  - { id: shown, action: assert, timeout_ms: 500, ${target}, expect: { visible: true } }\n`), scrolledPast())
    expect(shown.steps[0].error).toBe(`id=${ID('status')} is not on screen (it has no size there)`)
    const text = await run(flow(`  - { id: text, action: assert, timeout_ms: 500, ${target}, expect: { text: Shipped } }\n`), scrolledPast())
    expect(text.status, 'its text is not shown either').toBe('failed')
    const wait = await run(flow(`  - { id: wait, action: wait, timeout_ms: 500, ${target} }\n`), scrolledPast())
    expect(wait.steps[0].error, 'a wait agrees with the assertion').toBe(`id=${ID('status')} is not on screen (it has no size there)`)
  })

  it('stops a scroll to a view that is cancelled mid-search, as stopped rather than failed', async () => {
    const ctl = new AbortController()
    const d = device('catalog', { onRead: (n) => n === 3 && ctl.abort('user stop') })
    const r = await run(flow(`  - { id: find, action: scroll, target: { selectors: [{ text: "Item 99" }] } }\n`), d, { signal: ctl.signal })
    expect(r).toMatchObject({ status: 'failed', error: 'stopped during step find: user stop' })
    expect(r.steps[0].status).toBe('not_run')
    expect(swipes(d).length, 'no swipe after the stop').toBe(2)
  })
})

describe('replayAndroidFlow long press (roadmap M5d-3)', () => {
  // Order #1 is 1080 x 150 at y 300 (centre 540, 375); a long press on it opens the order's menu.
  const MENU = flow(
    `  - { id: s1, action: click, hold_ms: 800, intent: Open the order's menu, target: { selectors: [{ text: "Order #1" }] } }
  - { id: s2, action: assert, target: { selectors: [{ text: Cancel order }] }, expect: { visible: true } }
  - { id: s3, action: click, target: { selectors: [{ id: "${ID('cancel_order')}" }] } }
  - { id: s4, action: click, hold_ms: 1000, target: { selectors: [{ text: "Order #1" }] } }
`
  )
  const READ_TIMEOUT = 'settings get secure long_press_timeout'

  it('holds the finger on the view for hold_ms (a swipe that does not move), three runs alike, reading the device\'s delay once', async () => {
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) {
      const d = device('orders')
      const r = await run(MENU, d)
      expect(r.status, `run ${i + 1}: ${JSON.stringify(r.steps.find((s) => s.status === 'failed'))}`).toBe('passed')
      expect(d.stack, 'the second long press opened the menu again').toEqual(['orders', 'order_menu'])
      outcomes.push(JSON.stringify({ lines: d.lines, steps: r.steps.map((s) => [s.id, s.status, s.matched?.layer]) }))
    }
    expect(new Set(outcomes).size, 'three replays must send the same commands').toBe(1)
    const d = device('orders')
    await run(MENU, d)
    expect(d.lines, 'a long press is input swipe on one point for hold_ms; a plain click stays a tap').toEqual([
      READ_TIMEOUT,
      'input swipe 540 375 540 375 800',
      'input tap 540 375',
      'input swipe 540 375 540 375 1000'
    ])
  })

  it('refuses a hold the device could read as a tap (its touch & hold delay is longer) before touching anything', async () => {
    const d = device('orders', { longPressTimeout: '1000' })
    const r = await run(MENU, d)
    expect(r.steps.map((s) => s.status)).toEqual(['failed', 'not_run', 'not_run', 'not_run'])
    expect(r.steps[0].error).toBe(
      'the step holds 800 ms, but emulator-5560 takes a touch for a long press only after 1000 ms (its touch & hold delay), so it could read this as a tap: set hold_ms to at least 1100'
    )
    expect(d.lines, 'nothing pressed').toEqual([READ_TIMEOUT])
    expect(d.stack).toEqual(['orders'])

    const slow = device('orders', { longPressTimeout: '1000' })
    const ok = await run(flow(`  - { id: s1, action: click, hold_ms: 1100, target: { selectors: [{ text: "Order #1" }] } }\n`), slow)
    expect(ok.status, JSON.stringify(ok.steps[0])).toBe('passed')
    expect(slow.stack).toEqual(['orders', 'order_menu'])
  })

  it('assumes Android\'s older 500 ms delay when the device does not say (null, junk), so 600 ms is the shortest hold', async () => {
    for (const said of ['null', 'n/a', '', '-1']) {
      const d = device('orders', { longPressTimeout: said })
      const r = await run(flow(`  - { id: s1, action: click, hold_ms: 600, target: { selectors: [{ text: "Order #1" }] } }\n`), d)
      expect(r.status, `device said ${JSON.stringify(said)}: ${JSON.stringify(r.steps[0])}`).toBe('passed')
      expect(d.lines.at(-1)).toBe('input swipe 540 375 540 375 600')
    }
  })

  it('fails the step without pressing when the device\'s delay cannot be read, rather than assume a default', async () => {
    const d = device('orders', { longPressTimeoutFails: true })
    const r = await run(MENU, d)
    expect(r.steps[0].status).toBe('failed')
    expect(r.steps[0].error).toBe('could not read the touch & hold delay of emulator-5560 (settings get secure long_press_timeout): adb exited with code 1')
    expect(d.lines, 'nothing pressed').toEqual([READ_TIMEOUT])
  })

  it('says so when the device\'s delay is longer than any hold a flow allows, instead of asking for a longer hold_ms', async () => {
    const d = device('orders', { longPressTimeout: '9950' })
    const r = await run(MENU, d)
    expect(r.steps[0].error).toBe('emulator-5560 takes a touch for a long press only after 9950 ms (its touch & hold delay), longer than a flow holds (10000 ms): shorten that delay on the device')
    expect(d.lines).toEqual([READ_TIMEOUT])
  })

  it('a long press on a view with no long-press action clicks it on lift, as on Android', async () => {
    const d = device('orders')
    const r = await run(flow(`  - { id: s1, action: click, hold_ms: 700, target: { selectors: [{ text: "Order #2" }] } }\n`), d)
    expect(r.status, JSON.stringify(r.steps[0])).toBe('passed')
    expect(d.stack).toEqual(['orders', 'order'])
  })

  it('waits for the view like a tap does, and fails a long press on a view that never shows', async () => {
    const d = device('orders')
    const r = await run(flow(`  - { id: s1, action: click, hold_ms: 800, timeout_ms: 2000, target: { selectors: [{ text: "Order #9" }] } }\n`), d)
    expect(r.steps[0].status).toBe('failed')
    expect(r.steps[0].error).toBe('no view of dev.nawi.shop matched: text="Order #9" found nothing')
    expect(d.lines.filter((l) => l.startsWith('input')), 'nothing pressed').toEqual([])
  })
})

describe('replayAndroidFlow rotate (roadmap M5d-4)', () => {
  const TURN = flow(
    `  - { id: s1, action: rotate, orientation: landscape, intent: Turn the phone sideways }
  - { id: s2, action: click, target: { selectors: [{ text: "Order #2" }] } }
  - { id: s3, action: rotate, orientation: reverse-portrait }
  - { id: s4, action: rotate, orientation: portrait }
`
  )
  const START = ['wm size', 'settings get system accelerometer_rotation', 'settings get system user_rotation']
  const RESTORE = ['settings delete system user_rotation', 'settings put system accelerometer_rotation 1']

  it('turns the screen by locking the rotation, waits until the screen shows it, three runs alike', async () => {
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) {
      const d = device('orders', { rotation: { lagReads: 2 } })
      const seen: number[] = []
      const r = await run(TURN, d, { onStep: () => seen.push(d.rotation()) })
      expect(r.status, `run ${i + 1}: ${JSON.stringify(r.steps.find((s) => s.status === 'failed'))}`).toBe('passed')
      expect(seen, 'the screen after each step: landscape (1), still landscape, upside down (2), upright (0)').toEqual([1, 1, 2, 0])
      outcomes.push(JSON.stringify({ lines: d.lines, steps: r.steps.map((s) => [s.id, s.status]) }))
    }
    expect(new Set(outcomes).size, 'three replays must send the same commands').toBe(1)
    const d = device('orders')
    await run(TURN, d)
    expect(d.lines, 'size and settings read once, before the first change; settings put back when the run ends').toEqual([
      ...START,
      'settings put system accelerometer_rotation 0',
      'settings put system user_rotation 1',
      'input tap 540 525',
      'settings put system accelerometer_rotation 0',
      'settings put system user_rotation 2',
      'settings put system accelerometer_rotation 0',
      'settings put system user_rotation 0',
      ...RESTORE
    ])
    expect(d.settings, 'auto-rotate on again, no locked rotation, as the device was').toEqual({ accelerometer_rotation: '1', user_rotation: 'null' })
  })

  it('maps orientations through the natural size: on a landscape tablet portrait is three quarter turns', async () => {
    const d = device('orders', { rotation: { wmSize: 'Physical size: 2560x1600\n' } })
    const r = await run(flow(`  - { id: s1, action: rotate, orientation: portrait }\n  - { id: s2, action: rotate, orientation: reverse-landscape }\n`), d)
    expect(r.status, JSON.stringify(r.steps)).toBe('passed')
    expect(d.lines.filter((l) => l.startsWith('settings put system user_rotation'))).toEqual(['settings put system user_rotation 3', 'settings put system user_rotation 2'])
  })

  it('puts back the settings the device had (auto-rotate off, locked sideways), not a default', async () => {
    const d = device('orders', { rotation: { auto: '0', user: '3' } })
    const r = await run(flow(`  - { id: s1, action: rotate, orientation: portrait }\n`), d)
    expect(r.status, JSON.stringify(r.steps)).toBe('passed')
    expect(d.lines.slice(-2)).toEqual(['settings put system user_rotation 3', 'settings put system accelerometer_rotation 0'])
    expect(d.settings).toEqual({ accelerometer_rotation: '0', user_rotation: '3' })
  })

  it('fails the step at its timeout when the app keeps its own orientation, naming it, and still restores the device', async () => {
    const d = device('orders', { rotation: { fixed: 0 } })
    const r = await run(flow(`  - { id: s1, action: rotate, orientation: landscape, timeout_ms: 2000 }\n  - { id: s2, action: click, target: { selectors: [{ text: "Order #2" }] } }\n`), d)
    expect(r.steps.map((s) => s.status)).toEqual(['failed', 'not_run'])
    expect(r.steps[0].error).toBe(
      'the screen is still portrait, not landscape: dev.nawi.shop may fix its own orientation (android:screenOrientation), which Android keeps whatever the device\'s rotation'
    )
    expect(r.error, 'a restore that worked adds nothing to the run').toBeUndefined()
    expect(d.lines.slice(-2)).toEqual(RESTORE)
    expect(d.settings).toEqual({ accelerometer_rotation: '1', user_rotation: 'null' })
  })

  it('changes nothing when a setting or the screen size cannot be read: a value it cannot read it could not put back', async () => {
    for (const getFails of ['accelerometer_rotation', 'user_rotation'] as const) {
      const d = device('orders', { rotation: { getFails } })
      const r = await run(TURN, d)
      expect(r.steps[0].status).toBe('failed')
      expect(r.steps[0].error).toBe(`could not read the screen rotation setting of emulator-5560 (settings get system ${getFails}): adb exited with code 1`)
      expect(d.lines.filter((l) => !l.startsWith('settings get') && l !== 'wm size'), `${getFails}: nothing changed, nothing to restore`).toEqual([])
    }
    const junk = device('orders', { rotation: { user: '7' } })
    expect((await run(TURN, junk)).steps[0].error).toBe('could not read the screen rotation setting of emulator-5560 (settings get system user_rotation): unexpected value')
    const noSize = device('orders', { rotation: { wmSize: 'no display\n' } })
    expect((await run(TURN, noSize)).steps[0].error).toBe('could not read the screen size of emulator-5560 (wm size)')
    expect(noSize.lines).toEqual(['wm size'])
  })

  it('restores the settings when a change fails halfway, and when the run is cancelled mid-wait', async () => {
    const half = device('orders', { rotation: { writeFails: [{ name: 'user_rotation', nth: 1 }] } })
    const r = await run(TURN, half)
    expect(r.steps[0].error).toBe('could not turn the screen to landscape on emulator-5560: adb exited with code 1')
    expect(half.settings, 'auto-rotate was turned off before the failure, and back on after').toEqual({ accelerometer_rotation: '1', user_rotation: 'null' })

    // Cancelled while the first step waits for a rotation that never shows (the app keeps portrait).
    const stop = new AbortController()
    const d = device('orders', { rotation: { fixed: 0 } })
    let reads = 0
    const exec = d.host.exec
    d.host.exec = async (file, args, t) => {
      if ((args[3] ?? '').startsWith('uiautomator dump') && ++reads === 3) stop.abort('person pressed Stop')
      return exec(file, args, t)
    }
    const c = await run(TURN, d, { signal: stop.signal })
    expect(c.error).toBe('stopped during step s1: person pressed Stop')
    expect(d.lines.slice(-2), 'a cancelled run still puts the device back').toEqual(RESTORE)
  })

  it('fails the run, after its steps, when the settings cannot be put back, naming each setting it could not restore', async () => {
    // TURN writes user_rotation 3 times; the 4th write is the restore.
    const d = device('orders', { rotation: { writeFails: [{ name: 'user_rotation', nth: 4 }] } })
    const r = await run(TURN, d)
    expect(r.steps.map((s) => s.status), 'every step passed').toEqual(['passed', 'passed', 'passed', 'passed'])
    expect(r.status).toBe('failed')
    expect(r.error).toBe(
      'could not put the screen rotation of emulator-5560 back (settings delete system user_rotation: adb exited with code 1); its rotation stays as the run left it until it is set by hand'
    )
    expect(d.settings.accelerometer_rotation, 'auto-rotate is put back even though the locked rotation was not').toBe('1')

    const both = device('orders', { rotation: { writeFails: [{ name: 'user_rotation', nth: 4 }, { name: 'accelerometer_rotation', nth: 4 }] } })
    expect((await run(TURN, both)).error).toBe(
      'could not put the screen rotation of emulator-5560 back (settings delete system user_rotation: adb exited with code 1; settings put system accelerometer_rotation 1: adb exited with code 1); its rotation stays as the run left it until it is set by hand'
    )
  })

  it('keeps a run\'s own error when putting the settings back throws too, and still tries both settings', async () => {
    const d = device('orders')
    const exec = d.host.exec
    d.host.exec = async (file, args, t) => {
      if ((args[3] ?? '').startsWith('settings delete')) throw new Error('adb went away')
      return exec(file, args, t)
    }
    const r = await run(TURN, d)
    expect(r.error).toBe('could not put the screen rotation of emulator-5560 back (settings delete system user_rotation: adb exited with code unknown); its rotation stays as the run left it until it is set by hand')
    expect(d.settings.accelerometer_rotation).toBe('1')
  })

  it('needs no settings and no screen size in a flow without rotate steps', async () => {
    const d = device('orders')
    await run(flow(`  - { id: s1, action: click, target: { selectors: [{ text: "Order #2" }] } }\n`), d)
    expect(d.lines).toEqual(['input tap 540 525'])
  })
})

describe('replayAndroidFlow background (roadmap M5d-5)', () => {
  const AWAY = flow(
    `  - { id: b1, action: background, ms: 3000, intent: Leave the app for a while }
  - { id: b2, action: assert, target: { selectors: [{ id: "${ID('status')}" }] }, expect: { text: Shipped to Ana } }
  - { id: b3, action: click, target: { selectors: [{ text: Track }] } }
`
  )
  const RESOLVE = `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER '${PKG}'`
  const RESTORE = `am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000 -n '${SHOP_LAUNCHER}'`

  it('sends the app home, leaves it away for ms, brings its task back as it was, three runs alike', async () => {
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) {
      const d = device('order', { background: { returnReads: 2 } })
      const awayAfter: boolean[] = []
      const r = await run(AWAY, d, { onStep: () => awayAfter.push(d.away()) })
      expect(r.status, `run ${i + 1}: ${JSON.stringify(r.steps.find((s) => s.status === 'failed'))}`).toBe('passed')
      expect(awayAfter, 'the app is back in front after the background step and stays there').toEqual([false, false, false])
      expect(d.stack, 'the order screen was kept while away (the task came back, not a fresh start)').toEqual(['order'])
      outcomes.push(JSON.stringify({ lines: d.lines, steps: r.steps.map((s) => [s.id, s.status, s.durationMs]) }))
    }
    expect(new Set(outcomes).size, 'three replays must send the same commands and take the same time').toBe(1)
    const d = device('order')
    const r = await run(AWAY, d)
    expect(d.lines, 'launcher read before Home, then Home, then the launcher intent that brings the task back').toEqual([RESOLVE, 'input keyevent KEYCODE_HOME', RESTORE, 'input tap 540 375'])
    const b1 = r.steps[0].durationMs ?? 0
    expect(b1, `the app stays away the step's 3000 ms, plus a few screen reads (took ${b1} ms)`).toBeGreaterThanOrEqual(3_000)
    expect(b1).toBeLessThan(3_000 + 1_000)
  })

  it('stays away 1 s when the step has no ms, and reads the launcher only once per run', async () => {
    const d = device('order')
    // A last step's duration also holds the run's final crash settle (1 s), so the steps measured here are not last.
    const r = await run(flow(`  - { id: b1, action: background }\n  - { id: b2, action: background, ms: 0 }\n  - { id: b3, action: click, target: { selectors: [{ text: Track }] } }\n`), d)
    expect(r.status, JSON.stringify(r.steps)).toBe('passed')
    expect(r.steps[0].durationMs ?? 0, 'DEFAULT_BACKGROUND_MS').toBeGreaterThanOrEqual(1_000)
    expect(r.steps[1].durationMs ?? 0, 'ms: 0 goes straight back once the app has left').toBeLessThan(1_000)
    expect(d.lines.filter((l) => l === RESOLVE), 'the launcher component is read once per run').toHaveLength(1)
    expect(d.lines.filter((l) => l === RESTORE)).toHaveLength(2)
  })

  it('fails at its timeout without trying to bring the app back when Home leaves it on screen (pinned)', async () => {
    const d = device('order', { background: { pinned: true } })
    const r = await run(flow('  - { id: b1, action: background, ms: 500, timeout_ms: 2000 }\n  - { id: b2, action: click, target: { selectors: [{ text: Track }] } }\n'), d)
    expect(r.failedStepId).toBe('b1')
    expect(r.steps[0].error).toBe(
      `${PKG} is still on screen after Home: the device may be pinned to it (screen pinning, a kiosk app), or it went on in picture-in-picture, which background steps do not handle yet`
    )
    expect(r.steps[1].status).toBe('not_run')
    expect(d.lines, 'no restore when the app never left').toEqual([RESOLVE, 'input keyevent KEYCODE_HOME'])
    const blank = device('order', { background: { pinned: true, emptyReads: 2 } })
    const r2 = await run(flow('  - { id: b1, action: background, ms: 500, timeout_ms: 2000 }\n'), blank)
    expect(r2.steps[0].status, 'an empty screen read right after Home is not the app gone').toBe('failed')
    expect(blank.lines).toEqual([RESOLVE, 'input keyevent KEYCODE_HOME'])
    const unpinned = device('order', { background: { emptyReads: 2 } })
    const r3 = await run(flow('  - { id: b1, action: background, ms: 500 }\n'), unpinned)
    expect(r3.status, 'empty reads, then the launcher: the app left').toBe('passed')
  })

  it('does not send the app away when its launcher cannot be named (none, or several = the system chooser)', async () => {
    const chooser = device('order', { background: { launcher: { code: 0, stdout: 'android/com.android.internal.app.ResolverActivity\n', stderr: '' } } })
    const r = await run(flow('  - { id: b1, action: background }\n'), chooser)
    expect(r.steps[0].error).toBe(`${PKG} has several launcher activities on emulator-5560, so Nawi could not tell how to bring it back from the background`)
    expect(chooser.lines, 'Home is never pressed: the app stays in front').toEqual([RESOLVE])
    expect(chooser.away()).toBe(false)
    const broken = device('order', { background: { launcher: { code: 1, stdout: '', stderr: 'cmd: Failure calling service package', error: 'failed' } } })
    const r2 = await run(flow('  - { id: b1, action: background }\n'), broken)
    expect(r2.steps[0].error).toBe(`could not find the launcher activity of ${PKG} on emulator-5560: adb exited with code 1`)
    expect(broken.lines).toEqual([RESOLVE])
  })

  it('passes when Android ended the app while it was away: it starts again on its first screen, as for a person', async () => {
    const login = device('login', { background: { restore: { killed: true } } })
    login.stack.push('orders')
    const r2 = await run(flow(`  - { id: b1, action: background }\n  - { id: b2, action: assert, target: { selectors: [{ text: Sign in }] }, expect: { visible: true } }\n`), login)
    expect(r2.status, JSON.stringify(r2.steps)).toBe('passed')
    expect(login.stack, 'a process death drops the screens the person had opened').toEqual(['login'])
  })

  it('fails with the reason when the app does not come back: am start says why, adb fails, or it never shows', async () => {
    const said = device('order', { background: { restore: { stays: true, stdout: 'Starting: Intent {}\nError: Activity not started, unable to resolve Intent\n' } } })
    const r1 = await run(flow('  - { id: b1, action: background }\n'), said)
    expect(r1.steps[0].error).toBe(`${PKG} did not come back from the background: Error: Activity not started, unable to resolve Intent`)
    const adbDown = device('order', { background: { restore: { fails: true } } })
    const r2 = await run(flow('  - { id: b1, action: background }\n'), adbDown)
    expect(r2.steps[0].error).toBe(`could not bring ${PKG} back from the background on emulator-5560: adb exited with code 1`)
    const refused = device('order', { background: { restore: { fails: true, stdout: 'Starting: Intent {}\nError: Activity class {dev.nawi.shop/.MainActivity} does not exist.\n' } } })
    const r4 = await run(flow('  - { id: b1, action: background }\n'), refused)
    expect(r4.steps[0].error, 'am start\'s own reason wins over its exit code').toBe(`${PKG} did not come back from the background: Error: Activity class {dev.nawi.shop/.MainActivity} does not exist.`)
    const hidden = device('order', { background: { restore: { stays: true } } })
    const r3 = await run(flow('  - { id: b1, action: background, ms: 0, timeout_ms: 1500 }\n'), hidden)
    expect(r3.steps[0].error).toBe(`${PKG} is not back on screen after it was brought back from the background`)
    expect(r3.steps[0].durationMs ?? 0, 'waits its timeout for the app to show').toBeGreaterThanOrEqual(1_500)
  })

  it('a stop while the app is away ends the run there, without bringing it back', async () => {
    const d = device('order')
    const stop = new AbortController()
    const host = { ...d.host, delay: async (ms: number, signal?: AbortSignal) => {
      if (ms === 5_000) stop.abort('user stop')
      return d.host.delay(ms, signal)
    } }
    const r = await replayAndroidFlow({ ...REQ, flow: flow('  - { id: b1, action: background, ms: 5000 }\n  - { id: b2, action: click, target: { selectors: [{ text: Track }] } }\n'), signal: stop.signal }, host)
    expect(r).toMatchObject({ status: 'failed', error: 'stopped during step b1: user stop' })
    expect(r.steps.map((s) => s.status)).toEqual(['not_run', 'not_run'])
    expect(d.lines).toEqual([RESOLVE, 'input keyevent KEYCODE_HOME'])
  })
})

describe('replayAndroidFlow permission (roadmap M5d-6)', () => {
  const LOCATION = 'Allow Shop to access this device’s location?'
  const CAMERA = 'Allow Shop to take pictures and record video?'
  const tapIn = (b: [number, number, number, number]): string => `input tap ${Math.floor((b[0] + b[2]) / 2)} ${Math.floor((b[1] + b[3]) / 2)}`
  const asks = (...answers: Array<Array<'allow' | 'while_using' | 'once' | 'deny'>>) =>
    answers.map((a, i) => ({ message: i === 0 ? LOCATION : CAMERA, answers: a, accuracy: i === 0 }))
  const TRACK_THEN = (steps: string): Flow => flow(`  - { id: p0, action: click, target: { selectors: [{ text: Track }] } }\n${steps}`)

  it('taps the answer button of the prompt the app showed, by its id, then goes on in the app; three runs alike', async () => {
    const f = TRACK_THEN(
      `  - { id: p1, action: permission, answer: while_using, intent: Let the app use the location while in use }\n  - { id: p2, action: assert, target: { selectors: [{ id: "${ID('status')}" }] }, expect: { visible: true } }\n`
    )
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) {
      const d = device('order', { permission: { on: 'track', asks: asks(['while_using', 'once', 'deny']), showAfterReads: 2 } })
      const r = await run(f, d)
      expect(r.status, `run ${i + 1}: ${JSON.stringify(r.steps.find((s) => s.status === 'failed'))}`).toBe('passed')
      expect(d.answered, 'the prompt got the step\'s answer, once').toEqual(['while_using'])
      expect(d.prompting(), 'and closed').toBe(false)
      outcomes.push(JSON.stringify({ lines: d.lines, steps: r.steps.map((s) => [s.id, s.status, s.durationMs]) }))
    }
    expect(new Set(outcomes).size, 'three replays must send the same commands and take the same time').toBe(1)
    const d = device('order', { permission: { on: 'track', asks: asks(['while_using', 'once', 'deny']) } })
    await run(f, d)
    expect(d.lines, 'Track, then only the "While using the app" button (never the Precise choice above it)').toEqual(['input tap 540 375', tapIn(promptButtonBox(0))])
  })

  it('answers prompts that come one after another, each step its own, told apart by what they ask', async () => {
    const d = device('order', { permission: { on: 'track', asks: asks(['while_using', 'once', 'deny'], ['allow', 'deny']) } })
    const r = await run(
      TRACK_THEN(
        `  - { id: p1, action: permission, answer: once }\n  - { id: p2, action: permission, answer: deny }\n  - { id: p3, action: assert, target: { selectors: [{ text: Track }] }, expect: { enabled: true } }\n`
      ),
      d
    )
    expect(r.status, JSON.stringify(r.steps.find((s) => s.status === 'failed'))).toBe('passed')
    expect(d.answered).toEqual(['once', 'deny'])
    expect(d.lines).toEqual(['input tap 540 375', tapIn(promptButtonBox(1)), tapIn(promptButtonBox(1))])
  })

  it('finds "allow" and "deny" by their other ids too (Allow all; Don\'t allow and don\'t ask again)', async () => {
    for (const [answer, id] of [
      ['allow', 'permission_allow_all_button'],
      ['deny', 'permission_deny_and_dont_ask_again_button'],
      ['allow', 'permission_allow_always_button'],
      ['deny', 'permission_no_upgrade_button']
    ] as const) {
      const d = device('order', { permission: { on: 'track', asks: asks([answer]) } })
      const dump = d.host.exec
      // The same prompt, with the other id the answer can have on a device.
      d.host.exec = async (file, args, ms) => {
        const r = await dump(file, args, ms)
        return (args[3] ?? '').startsWith('uiautomator dump') ? { ...r, stdout: r.stdout.replace(`:id/${PROMPT_BUTTONS[answer].id}"`, `:id/${id}"`) } : r
      }
      const r = await run(TRACK_THEN(`  - { id: p1, action: permission, answer: ${answer} }\n`), d)
      expect(r.status, `${answer} by ${id}: ${JSON.stringify(r.steps.find((s) => s.status === 'failed'))}`).toBe('passed')
      expect(d.answered).toEqual([answer])
    }
  })

  it('fails naming what the prompt offers when it has no button for the answer, and taps nothing', async () => {
    const d = device('order', { permission: { on: 'track', asks: asks(['while_using', 'once', 'deny']) } })
    const r = await run(TRACK_THEN('  - { id: p1, action: permission, answer: allow, timeout_ms: 1000 }\n'), d)
    expect(r.steps[1]).toMatchObject({
      status: 'failed',
      error: `Android's permission prompt (${JSON.stringify(LOCATION)}) has no "Allow" button: it offers "While using the app", "Only this time", "Don’t allow"`
    })
    expect(d.lines, 'no tap on the prompt').toEqual(['input tap 540 375'])
    expect(d.answered).toEqual([])
  })

  it('fails when no prompt shows (the app did not ask), without tapping anything', async () => {
    const d = device('order')
    const r = await run(flow('  - { id: p1, action: permission, answer: deny, timeout_ms: 1000 }\n'), d)
    expect(r.steps[0]).toMatchObject({
      status: 'failed',
      error: `Android's permission prompt is not on screen: ${PKG} has not asked for a permission (Android asks only while it is neither granted nor denied for good: an earlier run, or mobile_open's grant, may have settled it; reset it with pm clear or pm revoke)`
    })
    expect(d.lines).toEqual([])
  })

  it('never taps a disabled answer button', async () => {
    const d = device('order', { permission: { on: 'track', asks: asks(['allow', 'deny']), disabled: true } })
    const r = await run(TRACK_THEN('  - { id: p1, action: permission, answer: allow, timeout_ms: 1000 }\n'), d)
    expect(r.steps[1].error).toBe(`the "Allow" button of Android's permission prompt (${JSON.stringify(LOCATION)}) is disabled`)
    expect(d.lines).toEqual(['input tap 540 375'])
  })

  it('fails when the prompt is still up after its answer was tapped', async () => {
    const d = device('order', { permission: { on: 'track', asks: asks(['allow', 'deny']), stays: true } })
    const r = await run(TRACK_THEN('  - { id: p1, action: permission, answer: deny, timeout_ms: 1000 }\n'), d)
    expect(r.steps[1].error).toBe(`Android's permission prompt (${JSON.stringify(LOCATION)}) is still on screen after tapping "Don’t allow"`)
    expect(r.steps[1].durationMs ?? 0, 'it waits PROMPT_GONE_TIMEOUT_MS for the prompt to go, past a shorter step timeout').toBeGreaterThanOrEqual(PROMPT_GONE_TIMEOUT_MS)
    expect(d.lines, 'one tap only').toEqual(['input tap 540 375', tapIn(promptButtonBox(1))])
  })

  /** The fake device with each screen read passed through `edit` from the answer tap at `box` on. */
  const editedAfter = (d: Device, box: [number, number, number, number] | null, edit: (dump: string) => string): void => {
    const exec = d.host.exec
    let on = box === null
    d.host.exec = async (file, args, ms) => {
      const line = args[3] ?? ''
      if (box !== null && line === tapIn(box)) on = true
      const r = await exec(file, args, ms)
      return on && line.startsWith('uiautomator dump') ? { ...r, stdout: edit(r.stdout) } : r
    }
  }

  it('answers an app that asks again with the same message, told apart by the "don\'t ask again" button it then shows', async () => {
    const same = [0, 1].map(() => ({ message: LOCATION, answers: ['while_using', 'once', 'deny'] as Array<'while_using' | 'once' | 'deny'> }))
    const d = device('order', { permission: { on: 'track', asks: same } })
    // From the first answer on, the prompt's deny button is the "don't ask again" one, as Android 11+ shows on a re-ask.
    editedAfter(d, promptButtonBox(2), (dump) => dump.replace(':id/permission_deny_button"', ':id/permission_deny_and_dont_ask_again_button"'))
    const r = await run(TRACK_THEN('  - { id: p1, action: permission, answer: deny }\n  - { id: p2, action: permission, answer: deny }\n'), d)
    expect(r.status, JSON.stringify(r.steps.find((s) => s.status === 'failed'))).toBe('passed')
    expect(d.answered).toEqual(['deny', 'deny'])
  })

  it('does not take a half-drawn prompt (no message) after the answer for the next question', async () => {
    const d = device('order', { permission: { on: 'track', asks: asks(['allow', 'deny']), stays: true } })
    editedAfter(d, promptButtonBox(0), (dump) => dump.replace(/<node [^>]*:id\/permission_message"[^>]*\/>/, ''))
    const r = await run(TRACK_THEN('  - { id: p1, action: permission, answer: allow, timeout_ms: 1000 }\n'), d)
    expect(r.steps[1].error).toBe('Android\'s permission prompt ("' + LOCATION + '") is still on screen after tapping "Allow"')
  })

  it('taps the plain "Don\'t allow" when the prompt also shows its "don\'t ask again" form', async () => {
    const d = device('order', { permission: { on: 'track', asks: asks(['deny', 'deny']) } })
    // The first of the two buttons becomes the "don't ask again" one: the step must take the second.
    editedAfter(d, null, (dump) => dump.replace(':id/permission_deny_button"', ':id/permission_deny_and_dont_ask_again_button"'))
    const r = await run(TRACK_THEN('  - { id: p1, action: permission, answer: deny }\n'), d)
    expect(r.status, JSON.stringify(r.steps.find((s) => s.status === 'failed'))).toBe('passed')
    expect(d.lines).toEqual(['input tap 540 375', tapIn(promptButtonBox(1))])
  })

  it('does not take an empty screen read after the answer for the prompt gone', async () => {
    const d = device('order', { permission: { on: 'track', asks: asks(['allow', 'deny']), stays: true } })
    const exec = d.host.exec
    let answeredAt: number | null = null
    // Every read after the answer is empty (between two windows), as a dump can be while windows change.
    d.host.exec = async (file, args, ms) => {
      const line = args[3] ?? ''
      if (line === tapIn(promptButtonBox(0))) answeredAt = d.lines.length
      const r = await exec(file, args, ms)
      return answeredAt !== null && line.startsWith('uiautomator dump') ? { ...r, stdout: '<hierarchy rotation="0"></hierarchy>' } : r
    }
    const r = await run(TRACK_THEN('  - { id: p1, action: permission, answer: allow, timeout_ms: 1000 }\n'), d)
    expect(r.steps[1], 'an empty read says nothing about the prompt: the step waits, then fails as still answering').toMatchObject({ status: 'failed' })
    expect(r.steps[1].error).toMatch(/^Android's permission prompt \(.*\) is still on screen after tapping "Allow"$/)
  })
})

describe('planSwipes', () => {
  const box = { left: 0, top: 300, right: 1080, bottom: 1800 }

  it('splits a delta into equal whole-px swipes that add up to it exactly, stay inside the area and last 1 ms per 0.6 px', () => {
    const plan = planSwipes(box, 0, 2000)
    if (typeof plan === 'string') throw new Error(plan)
    expect(plan).toHaveLength(2)
    for (const w of plan) {
      for (const p of [w.from, w.to]) expect(p.x >= box.left && p.x < box.right && p.y >= box.top && p.y < box.bottom, `${JSON.stringify(p)} inside ${JSON.stringify(box)}`).toBe(true)
    }
    expect(plan.reduce((sum, w) => sum + w.from.y - w.to.y, 0)).toBe(2000)
    expect(plan.map((w) => w.ms)).toEqual([1667, 1667])
    expect(planSwipes(box, 0, -60), 'short swipes last at least 150 ms').toEqual([{ from: { x: 540, y: 1020 }, to: { x: 540, y: 1080 }, ms: 150 }])
  })

  it('refuses what it cannot swipe: too many swipes, an area too thin, a piece Android would take for a tap', () => {
    expect(planSwipes(box, 0, 1200 * 31)).toBe('is too small to scroll [0, 37200] in at most 30 swipes')
    expect(planSwipes({ left: 0, top: 0, right: 50, bottom: 100 }, 100, 0)).toBe('is too small to swipe in (50x100 px)')
    expect(planSwipes(box, 0, 40)).toMatch(/each swipe would move under 48 px, which Android takes for a tap/)
    expect(planSwipes(box, 0, 0)).toBe('has nothing to scroll by ([0, 0])')
  })
})
