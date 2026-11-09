import { describe, expect, it } from 'vitest'
import { parseFlow, stringifyFlow } from '../../shared/flow'
import { keyLines, touchLines } from './fixtures/getevent'
import { device, ID, PKG, type Device } from './fixtures/shop-app'
import { replayAndroidFlow } from './flow-replay'
import { dumpLine, parseUiDump, type UiScreen } from './hierarchy'
import {
  classifyStroke,
  flowFromAndroidRecording,
  GestureReader,
  parseTouchPanels,
  toScreen,
  type DisplayInfo,
  type RawInput,
  type RecordedEvent,
  type Snapshot,
  type Stroke,
  type TouchPanel
} from './record'

/**
 * The Android recorder's engine (roadmap M5c, first slice): `getevent` lines + the screen before each gesture -> an
 * android flow. The parser cases use output captured from the loop's API 36 emulator (kernel events injected with
 * `sendevent`, read back with `getevent -lt`); the end-to-end case records a session on the fake shop app and
 * replays the recorded flow on it.
 */

const DISPLAY: DisplayInfo = { width: 1080, height: 2400, density: 420 }

/** `getevent -lp` on the API 36 emulator, trimmed to one device of each kind. */
const GETEVENT_LP = `add device 1: /dev/input/event1
  name:     "AT Translated Set 2 keyboard"
  events:
    KEY (0001): KEY_ESC               KEY_1                 KEY_2                 KEY_3
                KEY_BACK              KEY_HOMEPAGE
    MSC (0004): MSC_SCAN
  input props:
    <none>
add device 2: /dev/input/event0
  name:     "Power Button"
  events:
    KEY (0001): KEY_POWER
  input props:
    <none>
add device 3: /dev/input/event2
  name:     "virtio_input_multi_touch_1"
  events:
    KEY (0001): BTN_TOOL_RUBBER       BTN_STYLUS
    ABS (0003): ABS_X                 : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
                ABS_Y                 : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
                ABS_MT_SLOT           : value 0, min 0, max 10, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
                ABS_MT_TRACKING_ID    : value 0, min 0, max 65535, fuzz 0, flat 0, resolution 0
                ABS_MT_PRESSURE       : value 0, min 0, max 1024, fuzz 0, flat 0, resolution 0
    SW  (0005): SW_LID
  input props:
    <none>
`

/** `getevent -lt` on the API 36 emulator: a tap at the screen's centre that drifts 1 px, then Back on the keyboard device. */
const GETEVENT_TAP_BACK = `add device 3: /dev/input/event2
  name:     "virtio_input_multi_touch_1"
[      70.313094] /dev/input/event2: EV_ABS       ABS_MT_TRACKING_ID   00000007
[      70.313094] /dev/input/event2: EV_ABS       ABS_MT_POSITION_X    00003fff
[      70.313094] /dev/input/event2: EV_ABS       ABS_MT_POSITION_Y    00003fff
[      70.313094] /dev/input/event2: EV_ABS       ABS_MT_PRESSURE      00000050
[      70.313094] /dev/input/event2: EV_SYN       SYN_REPORT           00000000
[      70.361999] /dev/input/event2: EV_ABS       ABS_MT_POSITION_X    00004010
[      70.361999] /dev/input/event2: EV_SYN       SYN_REPORT           00000000
[      70.421052] /dev/input/event2: EV_ABS       ABS_MT_TRACKING_ID   ffffffff
[      70.421052] /dev/input/event2: EV_SYN       SYN_REPORT           00000000
[      70.486653] /dev/input/event1: EV_REP       REP_DELAY            00000000
[      70.486653] /dev/input/event1: EV_REP       REP_PERIOD           00000000
[      70.486653] /dev/input/event1: EV_KEY       KEY_BACK             DOWN
[      70.486653] /dev/input/event1: EV_SYN       SYN_REPORT           00000000
[      70.539206] /dev/input/event1: EV_KEY       KEY_BACK             UP
[      70.539206] /dev/input/event1: EV_SYN       SYN_REPORT           00000000
`

const PANEL: TouchPanel = { path: '/dev/input/event2', x: { min: 0, max: 32767 }, y: { min: 0, max: 32767 } }
const read = (text: string): RawInput[] => new GestureReader([PANEL], DISPLAY).push(text)

describe('getevent parsing', () => {
  it('finds the multi-touch panels in getevent -lp and leaves keyboards and buttons out', () => {
    expect(parseTouchPanels(GETEVENT_LP)).toEqual([PANEL])
    expect(parseTouchPanels('add device 1: /dev/input/event5\n  name: "broken"\n    ABS (0003): ABS_MT_POSITION_X : value 0, min 5, max 5\n'), 'an empty axis range is no panel').toEqual([])
  })

  it('reads the emulator\'s tap and Back as one stroke in display pixels and one key, skipping key repeat settings', () => {
    const inputs = new GestureReader(parseTouchPanels(GETEVENT_LP), DISPLAY).push(GETEVENT_TAP_BACK)
    expect(inputs).toHaveLength(2)
    const [tap, back] = inputs as [Stroke, RawInput]
    expect(tap).toMatchObject({ kind: 'stroke', start: { x: 539, y: 1199 }, end: { x: 540, y: 1199 }, pointers: 1, dropped: false })
    expect(tap.t1 - tap.t0, 'down to up, in ms').toBeCloseTo(107.958, 3)
    expect(tap.travel).toBe(1)
    expect(classifyStroke(tap, DISPLAY), 'a 1 px drift for 108 ms is a tap').toBe('tap')
    expect(back).toEqual({ kind: 'key', t: 70486.653, key: 'KEY_BACK' })
  })

  it('tells taps, long presses, swipes and two-finger gestures apart by time, travel and fingers', () => {
    const kinds = (text: string): string[] => read(text).map((i) => (i.kind === 'stroke' ? classifyStroke(i, DISPLAY) : i.key))
    // Touch slop at 420 dpi: 8 dp = 21 px.
    expect(kinds(touchLines(1000, [100, 100], 499, [[110, 110]]))).toEqual(['tap'])
    expect(kinds(touchLines(1000, [100, 100], 500))).toEqual(['long_press'])
    expect(kinds(touchLines(1000, [100, 100], 300, [[100, 300], [100, 120]])), 'a swipe that comes back is still a swipe').toEqual(['swipe'])
    const two = touchLines(1000, [100, 100], 200).replace(/\n\[.*TRACKING_ID {3}ffffffff\n.*\n$/, '\n') + touchLines(1050, [600, 600], 100, [], 1, 2) + `[      1.300000] /dev/input/event2: EV_ABS       ABS_MT_SLOT          00000000\n[      1.300000] /dev/input/event2: EV_ABS       ABS_MT_TRACKING_ID   ffffffff\n[      1.300000] /dev/input/event2: EV_SYN       SYN_REPORT           00000000\n`
    const strokes = read(two)
    expect(strokes, 'one gesture until the last finger lifts').toHaveLength(1)
    expect(strokes[0]).toMatchObject({ pointers: 2, start: { x: 100, y: 100 } })
    expect(classifyStroke(strokes[0] as Stroke, DISPLAY)).toBe('multi')
  })

  it('marks a stroke whose events the kernel dropped, ignores other devices and keeps a stroke split across reads', () => {
    const lines = touchLines(1000, [10, 10], 50).split('\n')
    lines.splice(5, 0, '[      1.010000] /dev/input/event2: EV_SYN       SYN_DROPPED          00000000')
    expect(read(lines.join('\n'))[0]).toMatchObject({ dropped: true })
    expect(read(touchLines(1000, [10, 10], 50).replace(/event2/g, 'event9')), 'a device not in the panel list').toEqual([])
    const reader = new GestureReader([PANEL], DISPLAY)
    const all = touchLines(1000, [10, 10], 50).split('\n')
    expect(reader.push(`${all.slice(0, 4).join('\n')}\n`)).toEqual([])
    expect(reader.push(all.slice(4).join('\n'))).toHaveLength(1)
  })

  it('reads a second tap where the slot\'s last finger lifted, which the kernel sends without a position', () => {
    const first = touchLines(1000, [540, 1200], 80)
    // Same slot, same place: only the tracking id and the report, as the kernel sends unchanged axes once.
    const second = first.split('\n').filter((l) => !/POSITION|ABS_MT_SLOT/.test(l)).join('\n').replace(/\[\s*1\.0/g, '[      2.0').replace(/\[\s*1\.08/g, '[      2.08')
    const strokes = read(first + second)
    expect(strokes.map((st) => (st.kind === 'stroke' ? st.start : st)), 'two taps at the same point').toEqual([
      { x: 540, y: 1200 },
      { x: 540, y: 1200 }
    ])
  })

  it('waits for the rest of a line cut off mid-value instead of reading the cut value', () => {
    const text = touchLines(1000, [540, 300], 80)
    const cut = text.indexOf('ABS_MT_POSITION_X') + 'ABS_MT_POSITION_X    0000'.length
    const reader = new GestureReader([PANEL], DISPLAY)
    expect([...reader.push(text.slice(0, cut)), ...reader.push(text.slice(cut, -1)), ...reader.end()]).toMatchObject([{ kind: 'stroke', start: { x: 540, y: 300 } }])
  })

  it('ends a stroke whose lift the kernel dropped, and reads the next touch normally', () => {
    const lost = touchLines(1000, [10, 10], 50).split('\n').filter((l) => !l.includes('ffffffff'))
    const lines = [...lost.slice(0, 5), '[      1.020000] /dev/input/event2: EV_SYN       SYN_DROPPED          00000000', '[      1.020000] /dev/input/event2: EV_SYN       SYN_REPORT           00000000']
    const inputs = read(`${lines.join('\n')}\n${touchLines(2000, [700, 700], 50)}`)
    expect(inputs).toMatchObject([
      { kind: 'stroke', start: { x: 10, y: 10 }, dropped: true },
      { kind: 'stroke', start: { x: 700, y: 700 }, dropped: false }
    ])
  })

  it('maps a point of the natural orientation onto each rotation of the screen', () => {
    const p = { x: 100, y: 300 }
    expect([0, 1, 2, 3].map((r) => toScreen(p, r, DISPLAY))).toEqual([
      { x: 100, y: 300 },
      { x: 300, y: 979 },
      { x: 979, y: 2099 },
      { x: 2099, y: 100 }
    ])
  })
})

/* ------------------------------------------------------------------ *
 * Recording a session on the fake shop app
 * ------------------------------------------------------------------ */

const KEYBOARD = { left: 0, top: 1517, right: 1080, bottom: 2400 }

interface Session {
  d: Device
  events: RecordedEvent[]
  t: number
  reader: GestureReader
}

async function snapshot(d: Device): Promise<Snapshot> {
  const dump = await d.host.exec('adb', ['-s', 'emulator-5560', 'shell', dumpLine('rec')], 30_000)
  const shown = await d.host.exec('adb', ['-s', 'emulator-5560', 'shell', 'dumpsys input_method'], 30_000)
  return { screen: parseUiDump(dump.stdout), keyboard: /mInputShown=true/.test(shown.stdout) ? [KEYBOARD] : null }
}

/** A person's gesture: the screen is read first, the kernel's lines go through the reader, then the fake app acts. */
async function gesture(s: Session, lines: string, act: () => Promise<unknown>): Promise<void> {
  const before = await snapshot(s.d)
  const inputs = s.reader.push(lines)
  expect(inputs, 'each gesture of the session is one input').toHaveLength(1)
  s.events.push({ input: inputs[0], before })
  await act()
}

const shell = (d: Device, line: string): Promise<unknown> => d.host.exec('adb', ['-s', 'emulator-5560', 'shell', line], 30_000)

async function tap(s: Session, x: number, y: number): Promise<void> {
  s.t += 1000
  await gesture(s, touchLines(s.t, [x, y], 80, [[x + 2, y + 1]]), () => shell(s.d, `input tap ${x} ${y}`))
}

/** Typing on the on-screen keyboard: one tap on its area per character; the fake app gets the text. */
async function type(s: Session, text: string): Promise<void> {
  for (const [i, ch] of [...text].entries()) {
    s.t += 150
    await gesture(s, touchLines(s.t, [100 + ((i * 97) % 900), 1700 + ((i * 53) % 600)], 60), () => shell(s.d, `input text '${ch.replace(/'/g, "'\\''")}'`))
  }
}

async function key(s: Session, name: string, keyevent: string): Promise<void> {
  s.t += 1000
  await gesture(s, keyLines(s.t, name), () => shell(s.d, `input keyevent ${keyevent}`))
}

async function recordShopSession(): Promise<{ result: ReturnType<typeof flowFromAndroidRecording>; recorded: Device }> {
  const s: Session = { d: device('login', { keyboardOnFocus: true }), events: [], t: 5000, reader: new GestureReader([PANEL], DISPLAY) }
  await tap(s, 300, 360) // the email field
  await type(s, 'ana@example.com')
  await tap(s, 500, 560) // the password field, keyboard still up
  await type(s, "s3cr3t 'pw'")
  await key(s, 'KEY_BACK', 'KEYCODE_BACK') // closes the keyboard only
  await tap(s, 200, 800) // Sign in
  // The order list loads late: the person waits until it shows, and the screen read before the tap has it.
  for (let i = 0; i < 2; i++) await snapshot(s.d)
  await tap(s, 700, 500) // Order #2
  await key(s, 'KEY_BACK', 'KEYCODE_BACK')
  await tap(s, 980, 170) // the cart icon
  const result = flowFromAndroidRecording({ package: PKG, name: 'Shop sign-in', display: DISPLAY, events: s.events, after: await snapshot(s.d) })
  return { result, recorded: s.d }
}

describe('flowFromAndroidRecording on the fake shop app', () => {
  it('records sign-in -> order -> back -> cart as a flow that replays green three times, the password only as a secret', async () => {
    const { result, recorded } = await recordShopSession()
    expect(result.warnings).toEqual(['The password typed into "Password" is not in the flow: it types ${secret.password} at run time (NAWI_SECRET_password for nawi run).'])
    expect(result.flow.steps).toEqual([
      { id: 's1', action: 'fill', intent: 'Type into the Email field', target: { selectors: [{ id: ID('email') }, { desc: 'Email' }] }, value: 'ana@example.com' },
      { id: 's2', action: 'fill', intent: 'Type into the Password field', target: { selectors: [{ id: ID('password') }, { desc: 'Password' }] }, value: '${secret.password}' },
      { id: 's3', action: 'click', intent: 'Tap "Sign in"', target: { selectors: [{ id: ID('sign_in') }, { text: 'Sign in' }] } },
      { id: 's4', action: 'click', intent: 'Tap "Order #2"', target: { selectors: [{ id: ID('order_2') }, { text: 'Order #2' }] } },
      { id: 's5', action: 'press', key: 'Back' },
      { id: 's6', action: 'click', intent: 'Tap "Cart"', target: { selectors: [{ id: ID('cart') }, { desc: 'Cart' }] } }
    ])
    const yaml = stringifyFlow(result.flow)
    expect(yaml, 'the password never reaches the flow file').not.toContain('s3cr3t')
    const reparsed = parseFlow(yaml)
    if (!reparsed.ok) throw new Error(`recorded flow does not parse: ${JSON.stringify(reparsed.errors)}`)

    const runs: string[] = []
    for (let i = 0; i < 3; i++) {
      const d = device('login', { keyboardOnFocus: true })
      const r = await replayAndroidFlow({ adb: 'adb', serial: 'emulator-5560', flow: reparsed.flow, secret: (n) => (n === 'password' ? "s3cr3t 'pw'" : undefined) }, d.host)
      expect(r.status, `replay ${i + 1}: ${JSON.stringify(r.steps.find((st) => st.status !== 'passed'))}`).toBe('passed')
      expect(d.typed, 'the replay typed what the person typed').toEqual(recorded.typed)
      expect(d.stack, 'and ended on the same screen').toEqual(recorded.stack)
      runs.push(JSON.stringify(d.lines))
    }
    expect(recorded.stack).toEqual(['login', 'orders', 'cart'])
    expect(new Set(runs).size, 'three replays send the same commands').toBe(1)
  })

  it('records the same flow from the same session every time', async () => {
    const a = await recordShopSession()
    const b = await recordShopSession()
    expect(stringifyFlow(b.result.flow)).toBe(stringifyFlow(a.result.flow))
  })
})

/* ------------------------------------------------------------------ *
 * Single screens
 * ------------------------------------------------------------------ */

interface V {
  cls?: string
  id?: string
  text?: string
  desc?: string
  hint?: string
  pkg?: string
  clickable?: boolean
  longClickable?: boolean
  focused?: boolean
  password?: boolean
  b: [number, number, number, number]
  kids?: V[]
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const nodeXml = (v: V): string => {
  const open =
    `<node index="0" text="${esc(v.text ?? '')}" resource-id="${v.id ?? ''}" class="${v.cls ?? 'android.widget.TextView'}" package="${v.pkg ?? 'com.example.app'}" ` +
    `content-desc="${esc(v.desc ?? '')}" checkable="false" checked="false" clickable="${v.clickable ?? false}" enabled="true" focusable="false" ` +
    `focused="${v.focused ?? false}" scrollable="false" long-clickable="${v.longClickable ?? false}" password="${v.password ?? false}" selected="false" hint="${esc(v.hint ?? '')}" ` +
    `bounds="[${v.b[0]},${v.b[1]}][${v.b[2]},${v.b[3]}]"`
  return v.kids ? `${open}>${v.kids.map(nodeXml).join('')}</node>` : `${open}/>`
}
const screenOf = (views: V[], rotation = 0): UiScreen =>
  parseUiDump(`<hierarchy rotation="${rotation}">${nodeXml({ cls: 'android.widget.FrameLayout', b: [0, 0, 1080, 2400], kids: views })}</hierarchy>`)
const snap = (views: V[], keyboard = false): Snapshot => ({ screen: screenOf(views), keyboard: keyboard ? [KEYBOARD] : null })
const stroke = (x: number, y: number, ms = 80, to?: [number, number], pointers = 1): Stroke => ({
  kind: 'stroke',
  t0: 0,
  t1: ms,
  start: { x, y },
  end: to ? { x: to[0], y: to[1] } : { x, y },
  travel: to ? Math.hypot(to[0] - x, to[1] - y) : 0,
  pointers,
  dropped: false
})
const pressKey = (k: string): RawInput => ({ kind: 'key', t: 0, key: k })
const rec = (events: RecordedEvent[], after: Snapshot) => flowFromAndroidRecording({ package: 'com.example.app', display: DISPLAY, events, after })

const SAVE: V = { cls: 'android.widget.Button', id: 'com.example.app:id/save', text: 'Save', clickable: true, b: [0, 100, 1080, 200] }
const NAME = (text = '', focused = false): V => ({ cls: 'android.widget.EditText', id: 'com.example.app:id/name', hint: 'Name', text, clickable: true, focused, b: [0, 300, 1080, 400] })

describe('flowFromAndroidRecording on single screens', () => {
  it('taps the row a label sits in through the label\'s text when the row has no locator of its own', () => {
    const row: V = { cls: 'android.widget.LinearLayout', clickable: true, b: [0, 500, 1080, 700], kids: [{ text: 'Settings', b: [40, 550, 400, 650] }, { text: '>', b: [1000, 550, 1060, 650] }] }
    const r = rec([{ input: stroke(700, 600), before: snap([row]) }], snap([row]))
    expect(r.flow.steps).toEqual([])
    expect(r.warnings, 'the finger was not on the label: no single view names the row').toEqual(['A tap at (700, 600) is not recorded: no resource id, description or text finds that view alone.'])
    const onLabel = rec([{ input: stroke(100, 600), before: snap([row]) }], snap([row]))
    expect(onLabel.flow.steps).toEqual([{ id: 's1', action: 'click', intent: 'Tap "Settings"', target: { selectors: [{ text: 'Settings' }] } }])
    expect(onLabel.warnings).toEqual([])
  })

  it('keeps only locators that find the view alone, and never a field\'s typed text', () => {
    const twins: V[] = [
      { cls: 'android.widget.Button', id: 'com.example.app:id/act', text: 'Share', clickable: true, b: [0, 100, 500, 200] },
      { cls: 'android.widget.Button', id: 'com.example.app:id/act', text: 'Save', desc: 'Save', clickable: true, b: [500, 100, 1080, 200] }
    ]
    const r = rec([{ input: stroke(700, 150), before: snap(twins) }], snap(twins))
    expect(r.flow.steps[0]).toMatchObject({ action: 'click', target: { selectors: [{ desc: 'Save' }, { text: 'Save' }] } })
  })

  it('turns a tap on a field and typing into one fill, and a tap with no typing into a click', () => {
    const typed = rec(
      [
        { input: stroke(500, 350), before: snap([SAVE, NAME()]) },
        { input: stroke(500, 1800), before: snap([SAVE, NAME('A', true)], true) },
        { input: stroke(500, 150), before: snap([SAVE, NAME('Ada', true)], true) }
      ],
      snap([SAVE, NAME('Ada')])
    )
    expect(typed.flow.steps).toEqual([
      { id: 's1', action: 'fill', intent: 'Type into the Name field', target: { selectors: [{ id: 'com.example.app:id/name' }] }, value: 'Ada' },
      { id: 's2', action: 'click', intent: 'Tap "Save"', target: { selectors: [{ id: 'com.example.app:id/save' }, { text: 'Save' }] } }
    ])
    const untouched = rec([{ input: stroke(500, 350), before: snap([SAVE, NAME()]) }, { input: stroke(500, 150), before: snap([SAVE, NAME('', true)]) }], snap([SAVE, NAME()]))
    expect(untouched.flow.steps.map((s) => s.action)).toEqual(['click', 'click'])
    expect(untouched.flow.steps[0]).toMatchObject({ intent: 'Tap the Name field' })
  })

  it('keeps typing that continues after a tap back into the same field in one fill, and a cleared field as an empty fill', () => {
    const r = rec(
      [
        { input: stroke(500, 350), before: snap([SAVE, NAME()]) },
        { input: stroke(500, 350), before: snap([SAVE, NAME('Ad', true)], true) },
        { input: stroke(500, 1800), before: snap([SAVE, NAME('Ad', true)], true) }
      ],
      snap([SAVE, NAME('Ada', true)], true)
    )
    expect(r.flow.steps).toEqual([{ id: 's1', action: 'fill', intent: 'Type into the Name field', target: { selectors: [{ id: 'com.example.app:id/name' }] }, value: 'Ada' }])
    const cleared = rec([{ input: stroke(500, 350), before: snap([NAME('Old')]) }], snap([NAME('Name', true)]))
    expect(cleared.flow.steps, 'an old image shows the hint as the text of an empty field').toMatchObject([{ action: 'fill', value: '' }])
  })

  it('ignores text the app changed in a field nobody was typing in', () => {
    const total = (t: string): V => ({ cls: 'android.widget.EditText', id: 'com.example.app:id/total', text: t, b: [0, 600, 1080, 700] })
    const r = rec([{ input: stroke(500, 150), before: snap([SAVE, total('0')]) }], snap([SAVE, total('42')]))
    expect(r.flow.steps.map((s) => s.action)).toEqual(['click'])
  })

  it('drops Back that only closed the keyboard, keeps Back, Home and Enter, and names device keys it leaves out', () => {
    const s = snap([SAVE])
    const r = rec(
      [
        { input: pressKey('KEY_BACK'), before: snap([SAVE], true) },
        { input: pressKey('KEY_BACK'), before: s },
        { input: pressKey('KEY_HOMEPAGE'), before: s },
        { input: pressKey('KEY_ENTER'), before: s },
        { input: pressKey('KEY_A'), before: s },
        { input: pressKey('KEY_VOLUMEUP'), before: s }
      ],
      s
    )
    expect(r.flow.steps.map((st) => (st.action === 'press' ? st.key : st.action))).toEqual(['Back', 'Home', 'Enter'])
    expect(r.warnings).toEqual(['The volumeup key is not recorded: it changes the device, not the app.'])
  })

  it('leaves out taps on other apps\' windows, Android\'s permission prompt, swipes and dropped strokes, saying why', () => {
    const prompt: V = { pkg: 'com.google.android.permissioncontroller', cls: 'android.widget.Button', text: 'Allow', clickable: true, b: [100, 1000, 980, 1200] }
    const launcher: V = { pkg: 'com.android.launcher3', cls: 'android.widget.TextView', text: 'Clock', clickable: true, b: [0, 2200, 300, 2400] }
    const s = snap([SAVE, prompt, launcher])
    const r = rec(
      [
        { input: stroke(500, 1100), before: s },
        { input: stroke(100, 2300), before: s },
        { input: stroke(500, 150, 200, [500, 900]), before: s },
        { input: stroke(500, 150, 100, undefined, 2), before: s },
        { input: { ...stroke(500, 150), dropped: true }, before: s },
        { input: stroke(500, 2000), before: { screen: parseUiDump('<hierarchy rotation="0"></hierarchy>'), keyboard: null } }
      ],
      s
    )
    expect(r.flow.steps).toEqual([])
    expect(r.warnings).toEqual([
      'A tap on "Allow" in Android\'s permission prompt is not recorded: grant the permission before the run (the profile\'s permissions.grant).',
      'A tap at (100, 2300) on "Clock" is not recorded: it landed on com.android.launcher3, not com.example.app.',
      'A swipe at (500, 150) on "Save" is not recorded: the recorder does not turn swipes into scroll steps yet (add a scroll step to the flow by hand).',
      'A 2-finger gesture at (500, 150) on "Save" is not recorded: android flows have no step for it yet.',
      'A touch at (500, 150) is not recorded: the device dropped some of its events.',
      'A tap at (500, 2000) is not recorded: no view is there on the screen it landed on.'
    ])
  })

  it('records a long press as a click holding as long as the finger rested (rounded up to 100 ms, 600 ms to 10 s), on the view a tap would get (M5d-3)', () => {
    // A label that takes no touches inside a long-clickable row: the row gets the press. A clickable label gets it itself.
    const label: V = { cls: 'android.widget.TextView', text: 'Order #1', b: [40, 520, 600, 580] }
    const row: V = { cls: 'android.widget.LinearLayout', id: 'com.example.app:id/order_row', longClickable: true, b: [0, 500, 1080, 600], kids: [label] }
    const link: V = { cls: 'android.widget.TextView', id: 'com.example.app:id/details', text: 'Details', clickable: true, b: [700, 720, 1000, 780] }
    const row2: V = { cls: 'android.widget.LinearLayout', id: 'com.example.app:id/order_row2', longClickable: true, b: [0, 700, 1080, 800], kids: [link] }
    const s = snap([SAVE, row, row2])
    const r = rec(
      [
        { input: stroke(500, 150, 820), before: s },
        { input: stroke(500, 150, 510), before: s },
        { input: stroke(300, 550, 1500), before: s },
        { input: stroke(800, 750, 900), before: s },
        { input: stroke(500, 150, 15_000), before: s }
      ],
      s
    )
    expect(r.flow.steps).toEqual([
      { id: 's1', action: 'click', intent: 'Long press "Save"', target: { selectors: [{ id: 'com.example.app:id/save' }, { text: 'Save' }] }, hold_ms: 900 },
      { id: 's2', action: 'click', intent: 'Long press "Save"', target: { selectors: [{ id: 'com.example.app:id/save' }, { text: 'Save' }] }, hold_ms: 600 },
      { id: 's3', action: 'click', intent: 'Long press "Order #1"', target: { selectors: [{ id: 'com.example.app:id/order_row' }] }, hold_ms: 1500 },
      { id: 's4', action: 'click', intent: 'Long press "Details"', target: { selectors: [{ id: 'com.example.app:id/details' }, { text: 'Details' }] }, hold_ms: 900 },
      { id: 's5', action: 'click', intent: 'Long press "Save"', target: { selectors: [{ id: 'com.example.app:id/save' }, { text: 'Save' }] }, hold_ms: 10_000 }
    ])
    expect(r.warnings).toEqual(['A long press at (500, 150) on "Save" lasted 15.0 s: the step holds 10 s, the longest a flow holds.'])
  })

  it('splits taps from long presses at the device\'s own touch & hold delay, and holds past it on replay', () => {
    const s = snap([SAVE])
    const at = (longPressTimeoutMs: number, ms: number) =>
      flowFromAndroidRecording({ package: 'com.example.app', display: DISPLAY, longPressTimeoutMs, events: [{ input: stroke(500, 150, ms), before: s }], after: s })
    expect(at(1000, 700).flow.steps, 'a 1 s delay: 700 ms is a tap').toMatchObject([{ action: 'click', intent: 'Tap "Save"' }])
    expect(at(1000, 700).flow.steps[0]).not.toHaveProperty('hold_ms')
    expect(at(1000, 1020).flow.steps, 'held past the delay: replayed 100 ms past it').toMatchObject([{ intent: 'Long press "Save"', hold_ms: 1100 }])
    expect(at(400, 450).flow.steps, 'Android 12\'s 400 ms: 450 ms is a long press, replayed for the 600 ms minimum').toMatchObject([{ hold_ms: 600 }])
    const tooSlow = at(9950, 12_000)
    expect(tooSlow.flow.steps).toEqual([])
    expect(tooSlow.warnings).toEqual(['A long press at (500, 150) on "Save" is not recorded: the device takes a touch for a long press only after 9950 ms, longer than a flow holds (10000 ms).'])
  })

  it('leaves out a long press it cannot replay, saying why in long-press words', () => {
    const off: V = { ...SAVE, id: 'com.example.app:id/off', text: 'Off' }
    const prompt: V = { pkg: 'com.google.android.permissioncontroller', cls: 'android.widget.Button', text: 'Allow', clickable: true, b: [100, 1000, 980, 1200] }
    const s = snap([prompt])
    const disabled: Snapshot = { screen: screenOf([off]), keyboard: null }
    disabled.screen.nodes.forEach((n) => (n.enabled = n.text !== 'Off'))
    const r = rec([{ input: stroke(500, 1100, 900), before: s }, { input: stroke(500, 150, 900), before: disabled }], s)
    expect(r.flow.steps).toEqual([])
    expect(r.warnings).toEqual([
      'A long press on "Allow" in Android\'s permission prompt is not recorded: grant the permission before the run (the profile\'s permissions.grant).',
      'A long press at (500, 150) on "Off" is not recorded: that view was disabled, so the long press did nothing.'
    ])
  })

  it('resolves a tap on a rotated screen at the rotated point, after turning the screen there first', () => {
    // Landscape (rotation 1): the natural point (2000 px down, 100 px from the left) is (2000, 979) on screen.
    const wide: V = { cls: 'android.widget.Button', id: 'com.example.app:id/play', clickable: true, b: [1900, 900, 2100, 1050] }
    const before: Snapshot = { screen: screenOf([wide], 1), keyboard: null }
    const r = rec([{ input: stroke(100, 2000), before }], before)
    expect(r.flow.steps, 'a recording that starts sideways replays sideways').toMatchObject([
      { action: 'rotate', orientation: 'landscape' },
      { action: 'click', target: { selectors: [{ id: 'com.example.app:id/play' }] } }
    ])
  })

  it('records the screen turning between two touches as a rotate step, in order, and only when it turned, starting from where it started (M5d-4)', () => {
    const at = (views: V[], rotation: number): Snapshot => ({ screen: screenOf(views, rotation), keyboard: null })
    // Save is at the top of the natural screen: (540, 150) in portrait.
    const r = rec(
      [
        { input: stroke(540, 150), before: at([SAVE], 0) },
        { input: stroke(540, 150), before: at([SAVE], 0) },
        { input: pressKey('KEY_BACK'), before: at([SAVE], 2) },
        { input: pressKey('KEY_BACK'), before: at([SAVE], 3) }
      ],
      at([SAVE], 0)
    )
    expect(r.flow.steps.map((s) => (s.action === 'rotate' ? `rotate ${s.orientation}: ${s.intent}` : s.action))).toEqual([
      'rotate portrait: Turn the screen to portrait',
      'click',
      'click',
      'rotate reverse-portrait: Turn the screen to reverse-portrait',
      'press',
      'rotate reverse-landscape: Turn the screen to reverse-landscape',
      'press',
      'rotate portrait: Turn the screen to portrait'
    ])
    expect(r.flow.steps.map((s) => s.id), 'rotate steps are numbered with the rest').toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'])
    expect(r.warnings).toEqual([])
  })

  it('names orientations by the device\'s natural size: a landscape tablet at three quarter turns is in portrait', () => {
    const tablet = (rotation: number): Snapshot => ({ screen: screenOf([], rotation), keyboard: null })
    const r = flowFromAndroidRecording({ package: 'com.example.app', display: { width: 2560, height: 1600, density: 320 }, events: [{ input: pressKey('KEY_BACK'), before: tablet(0) }], after: tablet(3) })
    expect(r.flow.steps).toMatchObject([{ action: 'rotate', orientation: 'landscape' }, { action: 'press' }, { action: 'rotate', orientation: 'portrait' }])
  })

  it('keeps a fill whole when the screen turns while the person types into the field', () => {
    const typed = (text: string, rotation: number): Snapshot => ({ screen: screenOf([NAME(text, true), SAVE], rotation), keyboard: null })
    const r = rec(
      [
        { input: stroke(540, 350), before: typed('', 0) },
        // Sideways (rotation 1) the natural point (929, 540) is (540, 150) on screen: on Save.
        { input: stroke(929, 540), before: typed('Ana', 1) }
      ],
      typed('Ana', 1)
    )
    expect(r.flow.steps.map((s) => s.action)).toEqual(['rotate', 'fill', 'rotate', 'click'])
    expect(r.flow.steps[1]).toMatchObject({ action: 'fill', value: 'Ana' })
  })

  it('keeps typing that goes on after the screen turned in the same fill, and a tapped field\'s click whole', () => {
    // Sideways the keyboard lies along the bottom of the turned screen; the natural point (179, 1000) is (1000, 900) on it.
    const SIDEWAYS_KEYBOARD = { left: 0, top: 600, right: 2400, bottom: 1080 }
    const at = (text: string, rotation: number, keyboard: boolean): Snapshot => ({ screen: screenOf([NAME(text, true), SAVE], rotation), keyboard: keyboard ? [rotation === 0 ? KEYBOARD : SIDEWAYS_KEYBOARD] : null })
    const r = rec(
      [
        { input: stroke(540, 350), before: at('', 0, false) },
        { input: stroke(179, 1000), before: at('An', 1, true) }
      ],
      at('Ana', 1, true)
    )
    expect(r.flow.steps.map((s) => (s.action === 'fill' ? `fill ${s.value}` : s.action === 'rotate' ? `rotate ${s.orientation}` : s.action)), 'one fill with the whole text').toEqual([
      'rotate portrait',
      'fill Ana',
      'rotate landscape'
    ])
    expect(r.warnings).toEqual([])
  })

  it('never uses a blank text or description as a locator, so the flow still parses', () => {
    const blank: V = { cls: 'android.widget.Button', text: ' ', desc: '\u00a0', clickable: true, b: [0, 100, 1080, 200] }
    const r = rec([{ input: stroke(500, 150), before: snap([blank]) }], snap([blank]))
    expect(r.flow.steps).toEqual([])
    expect(r.warnings).toEqual(['A tap at (500, 150) is not recorded: no resource id, description or text finds that view alone.'])
  })

  it('types into an AutoCompleteTextView like any text field, and leaves out a tap on a disabled button', () => {
    const search: V = { cls: 'android.widget.AutoCompleteTextView', id: 'com.example.app:id/q', clickable: true, b: [0, 300, 1080, 400] }
    const off: V = { ...SAVE, b: [0, 100, 1080, 200] }
    const disabled = screenOf([{ ...off }, search]).nodes.map((n) => (n.text === 'Save' ? { ...n, enabled: false } : n))
    const before: Snapshot = { screen: { rotation: 0, nodes: disabled }, keyboard: null }
    const r = rec([{ input: stroke(500, 150), before }, { input: stroke(500, 350), before }], snap([SAVE, { ...search, text: 'cafe', focused: true }]))
    expect(r.flow.steps).toEqual([{ id: 's1', action: 'fill', intent: 'Type into the q field', target: { selectors: [{ id: 'com.example.app:id/q' }] }, value: 'cafe' }])
    expect(r.warnings).toEqual(['A tap at (500, 150) on "Save" is not recorded: that view was disabled, so the tap did nothing.'])
  })

  it('says nothing about a keyboard tap whose events were dropped (it could tell where a password key is)', () => {
    const r = rec([{ input: { ...stroke(412, 1903), dropped: true }, before: snap([SAVE], true) }], snap([SAVE]))
    expect(r.warnings).toEqual([])
  })

  it('does not record typed text a flow would read as a placeholder, even one that looks like a secret', () => {
    const r = rec([{ input: stroke(500, 350), before: snap([NAME()]) }], snap([NAME('${secret.api}', true)]))
    expect(r.flow.steps).toEqual([])
    expect(r.warnings).toEqual(['The text typed into a field contains "${", which a flow reads as a placeholder; that fill is not recorded.'])
  })

  it('does not record typed text a flow would read as a placeholder, and says when nothing was recorded', () => {
    const r = rec([{ input: stroke(500, 350), before: snap([NAME()]) }], snap([NAME('${env.HOME}', true)]))
    expect(r.flow.steps).toEqual([])
    expect(r.warnings).toEqual(['The text typed into a field contains "${", which a flow reads as a placeholder; that fill is not recorded.'])
    const empty = rec([], snap([SAVE]))
    expect(empty.flow.steps).toEqual([])
    expect(empty.warnings).toEqual(['Nothing was recorded: no touches or keys reached the device.'])
  })
})
