import { describe, expect, it } from 'vitest'
import { parseFlow, type Flow } from '../../shared/flow'
import { replayAndroidFlow, type AndroidReplayRequest } from './flow-replay'
import { DEVICE_AHEAD_MS, device, ID, PKG, type Device } from './fixtures/shop-app'
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
