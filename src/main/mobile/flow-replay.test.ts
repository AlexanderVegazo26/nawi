import { describe, expect, it } from 'vitest'
import { parseFlow, type Flow } from '../../shared/flow'
import type { ExecResult } from './doctor'
import { replayAndroidFlow, type AndroidReplayHost, type AndroidReplayRequest } from './flow-replay'

/**
 * The Android replayer (roadmap M5a) against a simulated shop app behind a fake adb: every screen is a uiautomator
 * dump built from the spec below, a tap lands on the topmost tappable control whose bounds hold the point, typed text
 * goes into the focused field, Back closes the keyboard or pops the screen. Each test reads like the flow a person
 * would record, and checks both what reached the device's shell and what the run reports.
 */

const PKG = 'dev.nawi.shop'
const ID = (name: string): string => `${PKG}:id/${name}`
type Box = [number, number, number, number]

interface Control {
  cls?: string
  id?: string
  text?: string
  desc?: string
  pkg?: string
  enabled?: boolean
  bounds: Box
  /** Where a tap leads: a screen name, or 'up'. */
  go?: string
  children?: Control[]
  /** Shown only from the n-th read of the screen on (1-based): a list that loads. */
  fromRead?: number
}

interface ScreenSpec {
  controls: Control[]
  /** A top-level window of another package drawn over part of the screen (a prompt). */
  overlay?: { pkg: string; bounds: Box }
}

const field = (name: string, bounds: Box, hint: string): Control => ({ cls: 'android.widget.EditText', id: ID(name), desc: hint, bounds })
const button = (name: string, text: string, bounds: Box, go?: string, extra: Partial<Control> = {}): Control => ({ cls: 'android.widget.Button', id: ID(name), text, bounds, go, ...extra })

function app(): Record<string, ScreenSpec> {
  return {
    login: {
      controls: [
        field('email', [40, 300, 1040, 450], 'Email'),
        field('password', [40, 500, 1040, 650], 'Password'),
        button('sign_in', 'Sign in', [40, 700, 1040, 850], 'orders')
      ]
    },
    orders: {
      controls: [
        { id: ID('title'), text: 'Your orders', bounds: [40, 100, 1040, 250] },
        { cls: 'android.widget.ImageButton', id: ID('cart'), desc: 'Cart', bounds: [900, 100, 1060, 250], go: 'cart' },
        button('order_1', 'Order #1', [0, 300, 1080, 450], 'order', { fromRead: 3 }),
        button('order_2', 'Order #2', [0, 450, 1080, 600], 'order', { fromRead: 3 })
      ]
    },
    order: {
      controls: [
        { id: ID('status'), text: 'Shipped  to   Ana', bounds: [40, 100, 1040, 250] },
        button('track', 'Track', [40, 300, 1040, 450])
      ]
    },
    cart: { controls: [{ id: ID('empty'), text: 'Your cart is empty', bounds: [40, 100, 1040, 250] }] }
  }
}

const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const box = (b: Box): string => `[${b[0]},${b[1]}][${b[2]},${b[3]}]`

function node(pkg: string, c: Control, text: string, inner = ''): string {
  const tappable = c.go !== undefined || /Button|EditText/.test(c.cls ?? '')
  const open =
    `<node index="0" text="${attr(text)}" resource-id="${c.id ?? ''}" class="${c.cls ?? 'android.widget.TextView'}" package="${c.pkg ?? pkg}" ` +
    `content-desc="${attr(c.desc ?? '')}" checkable="false" checked="false" clickable="${tappable}" enabled="${c.enabled ?? true}" ` +
    `focusable="${tappable}" focused="false" scrollable="false" long-clickable="false" password="${c.id === ID('password')}" selected="false" ` +
    `bounds="${box(c.bounds)}"`
  const kids = inner + (c.children ?? []).map((k) => node(pkg, k, k.text ?? '')).join('')
  return kids ? `${open}>${kids}</node>` : `${open}/>`
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })

interface DeviceOptions {
  /** Changes the app before a screen read (1-based count of reads so far). */
  onRead?: (reads: number, screens: Record<string, ScreenSpec>) => void
  /** The keyboard comes up when a text field is tapped. */
  keyboardOnFocus?: boolean
  /** What `am start -a VIEW` prints for a deep link. */
  deepLink?: (url: string) => { stdout: string; go?: string }
  /** `input text` fails in adb. */
  typeFails?: boolean
}

interface Device {
  host: AndroidReplayHost
  /** Every shell line, in order, minus the screen reads and keyboard checks. */
  lines: string[]
  /** Text typed into each field, by resource id name. */
  typed: Record<string, string>
  stack: string[]
}

function device(start = 'login', over: DeviceOptions = {}): Device {
  const screens = app()
  const stack = [start]
  const lines: string[] = []
  const typed: Record<string, string> = {}
  const readsOf: Record<string, number> = {}
  let reads = 0
  let clock = 1_000_000
  let keyboard = false
  let focused: string | null = null
  const top = (): string => stack[stack.length - 1]
  const visible = (name: string): Control[] => screens[name].controls.filter((c) => (c.fromRead ?? 0) <= (readsOf[name] ?? 0))
  const textOf = (c: Control): string => (c.id && c.cls === 'android.widget.EditText' ? (c.id === ID('password') ? '•'.repeat((typed[c.id] ?? '').length) : (typed[c.id] ?? '')) : (c.text ?? ''))
  const dump = (): string => {
    reads++
    over.onRead?.(reads, screens)
    readsOf[top()] = (readsOf[top()] ?? 0) + 1
    const spec = screens[top()]
    const inner = visible(top()).map((c) => node(PKG, c, textOf(c))).join('')
    let windows = node(PKG, { cls: 'android.widget.FrameLayout', bounds: [0, 0, 1080, 2400] }, '', inner)
    if (spec.overlay) windows += node(spec.overlay.pkg, { cls: 'android.widget.FrameLayout', bounds: spec.overlay.bounds }, '', node(spec.overlay.pkg, { cls: 'android.widget.Button', text: 'Allow', bounds: spec.overlay.bounds }, 'Allow'))
    return `UI hierchary dumped to: /data/local/tmp/x.xml\n<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${windows}</hierarchy>`
  }
  const host: AndroidReplayHost = {
    exec: async (_file, args) => {
      const line = args[3] ?? ''
      if (line.startsWith('uiautomator dump')) return ok(dump())
      if (line.startsWith('dumpsys input_method')) return ok(`    mInputShown=${keyboard}\n`)
      lines.push(line)
      if (line === 'input keyevent KEYCODE_BACK') {
        if (keyboard) keyboard = false
        else stack.pop()
        return ok()
      }
      if (line.startsWith('input keyevent')) {
        if (focused && line.includes('KEYCODE_DEL')) typed[focused] = ''
        return ok()
      }
      const text = /^input text '(.*)'$/s.exec(line)
      if (text) {
        if (over.typeFails) return { code: 1, stdout: '', stderr: `Error typing ${text[1]}`, error: 'failed' }
        if (focused) typed[focused] = (typed[focused] ?? '') + text[1].replace(/'\\''/g, "'")
        return ok()
      }
      const am = /^am start -W -a android\.intent\.action\.VIEW -d '(.*)' 'dev\.nawi\.shop'$/.exec(line)
      if (am) {
        const answer = over.deepLink?.(am[1]) ?? { stdout: 'Starting: Intent { act=android.intent.action.VIEW }\nStatus: ok\nTotalTime: 120\n' }
        if (answer.go) stack.push(answer.go)
        return ok(answer.stdout)
      }
      const tap = /^input tap (\d+) (\d+)$/.exec(line)
      if (!tap) return { code: 1, stdout: '', stderr: `unexpected ${line}`, error: 'failed' }
      const [x, y] = [Number(tap[1]), Number(tap[2])]
      const hit = visible(top())
        .filter((c) => c.enabled !== false && x >= c.bounds[0] && x < c.bounds[2] && y >= c.bounds[1] && y < c.bounds[3])
        .pop()
      focused = hit?.cls === 'android.widget.EditText' ? (hit.id ?? null) : null
      if (focused && over.keyboardOnFocus) keyboard = true
      if (hit?.go === 'up') stack.pop()
      else if (hit?.go) stack.push(hit.go)
      return ok()
    },
    delay: async (ms) => {
      clock += ms
    },
    now: () => clock
  }
  return { host, lines, typed, stack }
}

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
