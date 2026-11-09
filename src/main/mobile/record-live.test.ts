import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFlow } from '../../shared/flow'
import type { ExecResult } from './doctor'
import { keyLines, touchLines } from './fixtures/getevent'
import { device, ID, PKG, type Device } from './fixtures/shop-app'
import { replayAndroidFlow } from './flow-replay'
import { recordAndroidLive, spawnStream, type LiveRecordRequest, type RecordLiveHost } from './record-live'
import { DISPLAY_ROTATION_LINE, parseWmSize } from './rotation'

/**
 * Roadmap M5c, second slice: the live recorder. A simulated person uses the fake shop app while the recorder streams
 * `getevent -lt` from a fake adb: each gesture is delivered as kernel lines at its time on a fake clock and then
 * acted on by the app, and every screen read takes DUMP_MS of that clock, so a person who taps faster than the
 * screen can be read is simulated exactly. Each test checks the flow, the warnings and what reached the device.
 */

const DUMP_MS = 2000
const SERIAL = 'emulator-5560'
const LAUNCHER = 'com.android.launcher3'

const GETEVENT_LP = `add device 1: /dev/input/event1
  name:     "AT Translated Set 2 keyboard"
  events:
    KEY (0001): KEY_ESC               KEY_BACK              KEY_HOMEPAGE
add device 3: /dev/input/event2
  name:     "virtio_input_multi_touch_1"
  events:
    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 10, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
                ABS_MT_TRACKING_ID    : value 0, min 0, max 65535, fuzz 0, flat 0, resolution 0
`

let root: string
let sdkDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nawi-record-live-'))
  mkdirSync(join(root, 'home'))
  sdkDir = join(root, 'sdk')
  const adb = join(sdkDir, 'platform-tools', 'adb')
  mkdirSync(join(adb, '..'), { recursive: true })
  writeFileSync(adb, '#!/bin/sh\n')
  chmodSync(adb, 0o755)
  writeFileSync(join(root, 'kvm'), '')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr, error: 'failed' })

/** What the person does, at a time on the fake clock (ms after the stream started). */
interface Act {
  at: number
  lines: string
  /** What the app does with it (through the fake app's own adb answers). */
  act?: (d: Device) => Promise<unknown>
}

interface Options {
  /** The shop app's options (keyboard on focus by default). */
  keyboardOnFocus?: boolean
  /** Lines of `dumpsys window InputMethod`; default: the keyboard's touchable region. */
  keyboardWindow?: string
  /** `getevent -lp` output. */
  getevent?: ExecResult
  wmSize?: ExecResult
  /** `settings get secure long_press_timeout` (default `null`: never changed). */
  longPressTimeout?: ExecResult
  /** The app in front before anything runs (the launcher shows its own package). */
  inFront?: 'app' | 'launcher'
  /** The stream ends by itself at this time (device unplugged), with this exit. */
  streamEnds?: { at: number; code: number | null; stderr: string }
  /** `dumpsys input_method` answer instead of the app's (e.g. a timeout). */
  keyboardShown?: ExecResult
  /** Whether the n-th screen read (1-based, the recorder's own) fails. */
  dumpFails?: (n: number) => boolean
  /** Output still in the pipe when the stream is stopped: delivered before the process has exited. */
  tailOnStop?: string
}

interface Sim {
  host: RecordLiveHost
  d: Device
  /** Shell lines other than screen reads, keyboard checks and the doctor's, in order. */
  shell: string[]
  /** What the stream was started with, and whether it was stopped. */
  stream: { args: string[] | null; stopped: boolean; startedAt: number | null }
  reads: () => number
  /** When each screen read started, ms after the stream started (before it: negative). */
  readTimes: number[]
  /** When each quick look at the rotation (M5d-4) was taken, ms after the stream started. */
  probes: number[]
}

function sim(acts: Act[], opts: Options = {}): Sim {
  const d = device('login', { keyboardOnFocus: opts.keyboardOnFocus ?? true })
  let clock = 1_000_000
  let reads = 0
  let onData: ((chunk: string) => void) | null = null
  let startedAt: number | null = null
  let ended: ((r: { code: number | null; stderr: string; error?: 'failed' }) => void) | null = null
  const pending = [...acts].sort((a, b) => a.at - b.at)
  const shell: string[] = []
  const stream: Sim['stream'] = { args: null, stopped: false, startedAt: null }
  let inFront = opts.inFront ?? 'app'
  const readTimes: number[] = []
  const probes: number[] = []

  /** Deliver every gesture whose time has come, in order: kernel lines first, then the app reacts. */
  const deliver = async (): Promise<void> => {
    if (onData === null || startedAt === null) return
    if (opts.streamEnds && !stream.stopped && clock - startedAt >= opts.streamEnds.at && ended) {
      const e = opts.streamEnds
      ended({ code: e.code, stderr: e.stderr, ...(e.code === 0 ? {} : { error: 'failed' as const }) })
      ended = null
      return
    }
    while (pending.length > 0 && clock - startedAt >= pending[0].at) {
      const a = pending.shift()!
      onData(a.lines)
      await a.act?.(d)
    }
  }

  const launcherDump = (): string =>
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="${LAUNCHER}" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]"/></hierarchy>`

  const host: RecordLiveHost = {
    env: { ANDROID_HOME: sdkDir },
    platform: 'linux',
    arch: 'x64',
    home: join(root, 'home'),
    kvmPath: join(root, 'kvm'),
    now: () => clock,
    delay: async (ms) => {
      clock += ms
      await deliver()
    },
    exec: async (file, args) => {
      clock += 5
      if (args[0] === 'version') return ok('Android Debug Bridge version 1.0.41\n')
      if (args[0] === 'devices') return ok(`List of devices attached\n${SERIAL}\tdevice\n`)
      if (args[0] !== '-s' || args[1] !== SERIAL) return fail(`unexpected ${args.join(' ')}`)
      if (args[2] === 'emu') return ok('loop-api36\nOK\n')
      const line = args[3] ?? ''
      if (line.startsWith('getprop ro.build')) return ok('36\nx86_64\n')
      if (line.startsWith('uiautomator dump')) {
        reads++
        readTimes.push(startedAt === null ? -1 : clock - startedAt)
        // The screen as it is when the read starts; the person may act while it takes.
        const failsNow = startedAt !== null && opts.dumpFails?.(readTimes.filter((t) => t >= 0).length)
        const r = failsNow ? { code: null, stdout: '', stderr: '', error: 'timeout' as const } : inFront === 'launcher' ? ok(launcherDump()) : await d.host.exec(file, args, 30_000)
        clock += DUMP_MS
        await deliver()
        return r
      }
      if (line.startsWith('dumpsys input_method')) return opts.keyboardShown ?? d.host.exec(file, args, 30_000)
      if (line === 'dumpsys window InputMethod') return ok(opts.keyboardWindow ?? '      touchable region=SkRegion((0,1517,1080,2400))\n')
      if (line === DISPLAY_ROTATION_LINE) {
        probes.push(startedAt === null ? -1 : clock - startedAt)
        return d.host.exec(file, args, 30_000)
      }
      shell.push(line)
      if (line.startsWith('cmd package resolve-activity') && line.includes('category.HOME')) return ok(`priority=0\n${LAUNCHER}/.Launcher\n`)
      if (line === `pm path '${PKG}'`) return ok(`package:/data/app/${PKG}/base.apk\n`)
      if (line.startsWith('cmd package resolve-activity')) return ok(`priority=0\n${PKG}/.MainActivity\n`)
      if (line === `am force-stop '${PKG}'`) return ok()
      if (line.startsWith('am start -W -n ')) {
        inFront = 'app'
        return ok(`Status: ok\nActivity: ${PKG}/.MainActivity\nTotalTime: 300\nComplete\n`)
      }
      if (line === `pidof '${PKG}'`) return ok('4321\n')
      if (line === 'wm size') return opts.wmSize ?? ok('Physical size: 1080x2400\n')
      if (line === 'wm density') return ok('Physical density: 420\n')
      if (line === 'getevent -lp') return opts.getevent ?? ok(GETEVENT_LP)
      if (line === 'settings get secure long_press_timeout') return opts.longPressTimeout ?? ok('null\n')
      return fail(`unexpected shell ${line}`)
    },
    stream: (file, args, cb) => {
      stream.args = [file.replace(sdkDir, '<sdk>'), ...args]
      onData = cb
      startedAt = clock
      stream.startedAt = clock
      return {
        stop: () => {
          stream.stopped = true
          const end = ended
          ended = null
          // Like a real pipe: what is still buffered arrives after the kill, before the process has exited.
          setTimeout(() => {
            if (opts.tailOnStop !== undefined) cb(opts.tailOnStop)
            end?.({ code: null, stderr: '' })
          }, 0)
        },
        done: new Promise((resolve) => {
          ended = resolve
        })
      }
    }
  }
  return { host, d, shell, stream, reads: () => reads, readTimes, probes }
}

const sh = (d: Device, line: string): Promise<ExecResult> => d.host.exec('adb', ['-s', SERIAL, 'shell', line], 30_000)

/** Builds a person's session: each call schedules a gesture `gap` ms after the previous one. */
class Person {
  readonly acts: Act[] = []
  /** Time of the last act on the fake clock, ms after the stream started. */
  private t: number
  /** Kernel timestamps (getevent's clock, unrelated to the host clock). */
  private k = 70_000

  constructor(start = 3000) {
    this.t = start
  }

  tap(x: number, y: number, gap = 3500): this {
    this.t += gap
    this.k += gap
    this.acts.push({ at: this.t, lines: touchLines(this.k, [x, y], 80, [[x + 2, y + 1]]), act: (d) => sh(d, `input tap ${x} ${y}`) })
    return this
  }

  /** One tap on the keyboard's area per character, `gap` ms apart and the first `first` ms after the last act. */
  type(text: string, gap = 150, first = 1000): this {
    for (const [i, ch] of [...text].entries()) {
      this.t += i === 0 ? first : gap
      this.k += gap
      this.acts.push({ at: this.t, lines: touchLines(this.k, [100 + ((i * 97) % 900), 1700 + ((i * 53) % 600)], 60), act: (d) => sh(d, `input text '${ch.replace(/'/g, "'\\''")}'`) })
    }
    return this
  }

  key(name: string, keyevent: string, gap = 3500): this {
    this.t += gap
    this.k += gap
    this.acts.push({ at: this.t, lines: keyLines(this.k, name), act: (d) => sh(d, `input keyevent ${keyevent}`) })
    return this
  }
}

const record = (s: Sim, req: Partial<LiveRecordRequest> = {}): ReturnType<typeof recordAndroidLive> =>
  recordAndroidLive({ package: PKG, idleMs: 10_000, maxMs: 600_000, ...req }, s.host)

/** The shop sign-in session, at a person's pace: a pause after typing and after each tap that changes the screen. */
const shopSession = (): Person =>
  new Person()
    .tap(300, 360) // the email field
    .type('ana@example.com')
    .tap(500, 560) // the password field, keyboard still up
    .type("s3cr3t 'pw'")
    .key('KEY_BACK', 'KEYCODE_BACK') // closes the keyboard only
    .tap(200, 800) // Sign in
    .tap(700, 500, 18_000) // Order #2: the list loads late (third read of the screen), the person waits for it
    .key('KEY_BACK', 'KEYCODE_BACK')
    .tap(980, 170) // the cart icon

describe('recordAndroidLive', () => {
  it('records a sign-in session at a person\'s pace into a flow that replays green three times, the password only as a secret', async () => {
    const s = sim(shopSession().acts)
    const ready: number[] = []
    const r = await record(s, { name: 'Shop sign-in', idleMs: 30_000, onReady: (n) => ready.push(n) })
    expect(r.error, `fix: ${r.fix}`).toBeNull()
    expect(r.ok).toBe(true)
    expect(r.stopped).toBe('idle')
    expect(r.target).toEqual({ kind: 'avd', name: 'loop-api36', serial: SERIAL, api: 36 })
    expect(r.launched).toEqual({ activity: '.MainActivity' })
    expect(r.warnings).toEqual(['The password typed into "Password" is not in the flow: it types ${secret.password} at run time (NAWI_SECRET_password for nawi run).'])
    expect(r.flow?.steps).toEqual([
      { id: 's1', action: 'fill', intent: 'Type into the Email field', target: { selectors: [{ id: ID('email') }, { desc: 'Email' }] }, value: 'ana@example.com' },
      { id: 's2', action: 'fill', intent: 'Type into the Password field', target: { selectors: [{ id: ID('password') }, { desc: 'Password' }] }, value: '${secret.password}' },
      { id: 's3', action: 'click', intent: 'Tap "Sign in"', target: { selectors: [{ id: ID('sign_in') }, { text: 'Sign in' }] } },
      { id: 's4', action: 'click', intent: 'Tap "Order #2"', target: { selectors: [{ id: ID('order_2') }, { text: 'Order #2' }] } },
      { id: 's5', action: 'press', key: 'Back' },
      { id: 's6', action: 'click', intent: 'Tap "Cart"', target: { selectors: [{ id: ID('cart') }, { desc: 'Cart' }] } }
    ])
    expect(r.flow?.name).toBe('Shop sign-in')
    expect(r.inputs, '5 taps + 2 keys + 26 typed characters').toBe(5 + 2 + 15 + 11)
    expect(r.flow_yaml, 'the password never reaches the flow file').not.toContain('s3cr3t')
    expect(ready.length, 'the person is told each time the screen was read').toBeGreaterThanOrEqual(6)
    expect(ready[0], 'the first read comes before any touch').toBe(0)

    // The app was started from its launcher before the stream, and the stream was stopped at the end.
    expect(s.shell.slice(0, 5)).toEqual([`pm path '${PKG}'`, `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER '${PKG}'`, `am force-stop '${PKG}'`, `am start -W -n '${PKG}/.MainActivity'`, `pidof '${PKG}'`])
    expect(s.shell.slice(5, 9)).toEqual(['wm size', 'wm density', 'getevent -lp', 'settings get secure long_press_timeout'])
    expect(s.stream.args).toEqual(['<sdk>/platform-tools/adb', '-s', SERIAL, 'shell', 'getevent -lt'])
    expect(s.stream.stopped).toBe(true)

    const parsed = parseFlow(r.flow_yaml ?? '')
    if (!parsed.ok) throw new Error(`the recorded flow does not parse: ${JSON.stringify(parsed.errors)}`)
    for (let i = 0; i < 3; i++) {
      const d = device('login', { keyboardOnFocus: true })
      const run = await replayAndroidFlow({ adb: 'adb', serial: SERIAL, flow: parsed.flow, secret: (n) => (n === 'password' ? "s3cr3t 'pw'" : undefined) }, d.host)
      expect(run.status, `replay ${i + 1}: ${JSON.stringify(run.steps.find((st) => st.status !== 'passed'))}`).toBe('passed')
      expect(d.typed, 'the replay typed what the person typed').toEqual(s.d.typed)
      expect(d.stack, 'and ended where the person did').toEqual(s.d.stack)
    }
  })

  it('records the same flow from the same session every time', async () => {
    const a = await record(sim(shopSession().acts), { idleMs: 30_000 })
    const b = await record(sim(shopSession().acts), { idleMs: 30_000 })
    expect(a.flow?.steps).toHaveLength(6)
    expect(b.flow_yaml).toBe(a.flow_yaml)
  })

  it('does not record a tap that came before the screen after the previous tap was read, and says so', async () => {
    // Sign in, then 1 s later the cart icon: the read of the order list (2 s) had not finished.
    const p = new Person().tap(200, 800).tap(980, 170, 1000)
    const s = sim(p.acts, { keyboardOnFocus: false })
    const r = await record(s)
    expect(r.ok).toBe(true)
    expect(r.flow?.steps.map((st) => st.action === 'click' && st.intent)).toEqual(['Tap "Sign in"'])
    expect(r.warnings).toEqual([
      'A touch or key press was not recorded: it came before Nawi had read the screen after the previous touch. Wait for the screen to settle (about 2 seconds) after each tap that changes it.'
    ])
    expect(s.d.stack, 'the device did get to the cart').toEqual(['login', 'orders', 'cart'])
  })

  it('notices the screen turning between touches: a rotate step, and a touch right after the turn waits for the turned screen (M5d-4)', async () => {
    const turn = async (d: Device): Promise<void> => {
      await sh(d, 'settings put system accelerometer_rotation 0')
      await sh(d, 'settings put system user_rotation 1')
    }
    // Sign in at 6.5 s; the phone is turned sideways at 9.5 s (no touch, no key); then the cart, which is at (980, 170)
    // on the turned screen, (909, 980) of the natural one the panel reports.
    const session = (tapAt: number): Act[] => [
      ...new Person().tap(200, 800).acts,
      { at: 9_500, lines: '', act: turn },
      { at: tapAt, lines: touchLines(200_000, [909, 980], 80, [[910, 981]]), act: (d) => sh(d, 'input tap 980 170') }
    ]
    const later = sim(session(14_000), { keyboardOnFocus: false })
    const r = await record(later)
    expect(r.flow?.steps.map((st) => (st.action === 'rotate' ? `rotate ${st.orientation}` : st.intent)), JSON.stringify(r.warnings)).toEqual([
      'rotate portrait',
      'Tap "Sign in"',
      'rotate landscape',
      'Tap "Cart"'
    ])
    expect(r.warnings).toEqual([])
    expect(later.probes.length, 'looked at the rotation while quiet').toBeGreaterThan(0)
    expect(Math.min(...later.probes.filter((t) => t > 9_500)) - 9_500, 'the first look after the turn comes within about a second').toBeLessThanOrEqual(1_100)

    // 1.5 s after the turn: the turned screen is still being read, so the tap is not recorded (rather than recorded
    // on the unturned screen), and the warning says so.
    const soon = await record(sim(session(11_000), { keyboardOnFocus: false }))
    expect(soon.flow?.steps.map((st) => (st.action === 'rotate' ? `rotate ${st.orientation}` : st.intent))).toEqual(['rotate portrait', 'Tap "Sign in"', 'rotate landscape'])
    expect(soon.warnings).toEqual([
      'A touch or key press was not recorded: it came before Nawi had read the screen after the previous touch. Wait for the screen to settle (about 2 seconds) after each tap that changes it.'
    ])
  })

  it('a Back pressed before the screen was read is not recorded either (the keyboard may have been up)', async () => {
    const p = new Person().tap(300, 360).key('KEY_BACK', 'KEYCODE_BACK', 500)
    const r = await record(sim(p.acts))
    expect(r.flow?.steps).toEqual([{ id: 's1', action: 'click', intent: 'Tap the Email field', target: { selectors: [{ id: ID('email') }, { desc: 'Email' }] } }])
    expect(r.warnings[0]).toMatch(/^A touch or key press was not recorded/)
  })

  it('typing that starts before the field\'s screen was read is still recorded, with no warning naming a key', async () => {
    // The field tap is at 6.5 s; the keyboard taps follow 100 ms apart, with no read in between.
    const p = new Person().tap(300, 360)
    p.acts.push(...new Person(6500 + 100 - 1000).type('ab', 100).acts)
    const r = await record(sim(p.acts))
    expect(r.flow?.steps).toEqual([{ id: 's1', action: 'fill', intent: 'Type into the Email field', target: { selectors: [{ id: ID('email') }, { desc: 'Email' }] }, value: 'ab' }])
    expect(r.warnings, 'the held keyboard taps were typing, not lost taps').toEqual([])
  })

  it('keeps a screen read that only typing interrupted, so a tap soon after slow typing is still recorded', async () => {
    // A key every 700 ms: each read (2 s) starts between two keys and is interrupted by the next ones.
    const p = new Person().tap(300, 360).type('abcdefgh', 700, 3500).tap(200, 800, 1000)
    const r = await record(sim(p.acts))
    expect(r.flow?.steps.map((st) => (st.action === 'click' ? st.intent : st.action))).toEqual(['fill', 'Tap "Sign in"'])
    expect(r.warnings.some((w) => w.startsWith('A touch or key press was not recorded')), `the tap is not lost: ${r.warnings.join(' | ')}`).toBe(false)
  })

  it('warns when a tap follows typing before the typed text was read', async () => {
    // The field's screen is read before the typing starts; Sign in comes 400 ms after the last key.
    const p = new Person().tap(300, 360).type('ana', 150, 3500).tap(200, 800, 400)
    const r = await record(sim(p.acts))
    expect(r.ok).toBe(true)
    expect(r.warnings).toContain(
      'A tap came right after typing, before Nawi had read the typed text: check that the fill steps before it have the whole text. Pause a moment after typing before you tap.'
    )
    for (const w of r.warnings) expect(w, 'no warning says where a key was').not.toMatch(/\(\d+, \d+\)/)
  })

  it('takes every touch as typing while the keyboard is up but its area is unknown', async () => {
    const p = new Person().tap(300, 360).type('ab').tap(200, 800, 5000)
    const r = await record(sim(p.acts, { keyboardWindow: 'no region here\n' }))
    expect(r.flow?.steps.map((st) => st.action)).toEqual(['fill'])
    expect(r.warnings).toContain("The on-screen keyboard's area could not be read: touches while it was up are taken as typing and not recorded as taps.")
  })

  it('a keyboard check that times out counts as a keyboard in an unknown place: no tap through it, no key position in a warning', async () => {
    const p = new Person().tap(300, 360).type('ab').tap(200, 800, 5000)
    const r = await record(sim(p.acts, { keyboardShown: { code: null, stdout: '', stderr: '', error: 'timeout' } }))
    expect(r.ok).toBe(true)
    expect(r.flow?.steps.filter((st) => st.action === 'click'), 'no touch became a tap').toEqual([])
    expect(r.warnings).toContain("The on-screen keyboard's area could not be read: touches while it was up are taken as typing and not recorded as taps.")
    for (const w of r.warnings) expect(w, 'no warning says where a touch was').not.toMatch(/\(\d+, \d+\)/)
  })

  it('reads what was still in the pipe when the stream stopped before closing the last line', async () => {
    // The Sign in tap's lines are cut in the middle of a value when the recording is cancelled; the rest is buffered.
    const stop = new AbortController()
    const lines = touchLines(80_000, [200, 800], 80)
    const cut = lines.indexOf('ABS_MT_POSITION_Y') + 'ABS_MT_POSITION_Y    00'.length
    const acts: Act[] = [
      { at: 3000, lines: lines.slice(0, cut) },
      { at: 3000, lines: '', act: async () => stop.abort() }
    ]
    const s = sim(acts, { keyboardOnFocus: false, tailOnStop: lines.slice(cut) })
    const r = await record(s, { signal: stop.signal })
    expect(r.stopped).toBe('cancelled')
    expect(r.flow?.steps).toEqual([{ id: 's1', action: 'click', intent: 'Tap "Sign in"', target: { selectors: [{ id: ID('sign_in') }, { text: 'Sign in' }] } }])
    expect(r.warnings).toEqual([])
  })

  it('does not read the screen while a finger is still down (a slow drag or a held finger)', async () => {
    // A finger goes down at 6 s and lifts at 9 s, with no events in between: the device is silent but not quiet.
    const lines = touchLines(80_000, [200, 800], 3000).split('\n')
    const acts: Act[] = [
      { at: 6000, lines: `${lines.slice(0, 5).join('\n')}\n` },
      { at: 9000, lines: `${lines.slice(5).join('\n')}`, act: (d) => sh(d, 'input tap 200 800') }
    ]
    const s = sim(acts, { keyboardOnFocus: false })
    const r = await record(s)
    expect(s.readTimes.filter((t) => t > 6000 && t < 9000), 'no read while the finger was down').toEqual([])
    expect(r.ok).toBe(true)
    expect(r.flow?.steps, 'the 3 s press is recorded as a long press (M5d-3)').toEqual([
      { id: 's1', action: 'click', intent: 'Long press "Sign in"', target: { selectors: [{ id: ID('sign_in') }, { text: 'Sign in' }] }, hold_ms: 3000 }
    ])
  })

  it('tells a held finger from a long press by the device\'s own touch & hold delay, the default when it cannot be read (M5d-3)', async () => {
    // A 1.2 s press on Sign in: a tap on a device whose delay is 1.5 s, a long press on one that does not say.
    const lines = touchLines(80_000, [200, 800], 1200).split('\n')
    const recordWith = async (longPressTimeout: ExecResult) => {
      const acts: Act[] = [
        { at: 6000, lines: `${lines.slice(0, 5).join('\n')}\n` },
        { at: 7200, lines: `${lines.slice(5).join('\n')}`, act: (d) => sh(d, 'input tap 200 800') }
      ]
      return record(sim(acts, { keyboardOnFocus: false, longPressTimeout }))
    }
    const slow = await recordWith(ok('1500\n'))
    expect(slow.flow?.steps, 'a 1.5 s delay: the 1.2 s press was a tap').toEqual([{ id: 's1', action: 'click', intent: 'Tap "Sign in"', target: { selectors: [{ id: ID('sign_in') }, { text: 'Sign in' }] } }])
    for (const unread of [ok('null\n'), fail('settings: not found')]) {
      const r = await recordWith(unread)
      expect(r.flow?.steps, `${JSON.stringify(unread)}: the 500 ms default makes it a long press`).toEqual([
        { id: 's1', action: 'click', intent: 'Long press "Sign in"', target: { selectors: [{ id: ID('sign_in') }, { text: 'Sign in' }] }, hold_ms: 1200 }
      ])
    }
  })

  it('backs off after a failed screen read and gives up after a few in a row', async () => {
    const s = sim([], { dumpFails: () => true })
    const r = await record(s)
    expect(r.ok).toBe(false)
    expect(r.stopped).toBe('unreadable')
    expect(r.error).toBe("could not read loop-api36's screen to start recording")
    const times = s.readTimes.filter((t) => t >= 0)
    expect(times, 'five tries, not one every 50 ms until max time').toHaveLength(5)
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1], 'a second between tries').toBeGreaterThanOrEqual(1000)
  })

  it('stops with what it has when the screen can no longer be read mid-session', async () => {
    const s = sim(new Person().tap(200, 800).acts, { keyboardOnFocus: false, dumpFails: (n) => n >= 2 })
    const r = await record(s)
    expect(r.ok).toBe(true)
    expect(r.stopped).toBe('unreadable')
    expect(r.flow?.steps.map((st) => st.action)).toEqual(['click'])
    expect(r.warnings).toContain("Recording stopped: loop-api36's screen could not be read 5 times in a row; the flow has what was recorded until then.")
  })

  it('stops when cancelled and keeps what was recorded', async () => {
    const stop = new AbortController()
    const p = new Person().tap(200, 800)
    p.acts.push({ at: 9000, lines: '', act: async () => stop.abort() })
    const r = await record(sim(p.acts, { keyboardOnFocus: false }), { signal: stop.signal })
    expect(r.stopped).toBe('cancelled')
    expect(r.ok).toBe(true)
    expect(r.flow?.steps.map((st) => st.action)).toEqual(['click'])
  })

  it('stops at max time even while the person keeps tapping', async () => {
    const p = new Person()
    for (let i = 0; i < 10; i++) p.tap(980, 170, 3000)
    const s = sim(p.acts, { keyboardOnFocus: false })
    const r = await record(s, { maxMs: 10_000 })
    expect(r.stopped).toBe('max_time')
    expect(s.d.stack.length, 'the person was still tapping').toBeLessThan(11)
  })

  it('stops after the idle time once something was recorded, not before the first touch', async () => {
    const s = sim(new Person(20_000).tap(200, 800).acts, { keyboardOnFocus: false })
    const r = await record(s, { idleMs: 5000 })
    expect(r.stopped).toBe('idle')
    expect(r.flow?.steps).toHaveLength(1)
    expect(s.reads(), 'the screen is refreshed every 5 s while nobody touches it').toBeGreaterThanOrEqual(4)
  })

  it('a device that stops streaming ends the recording with what it has', async () => {
    const s = sim(new Person().tap(200, 800).acts, { keyboardOnFocus: false, streamEnds: { at: 8000, code: 0, stderr: '' } })
    const r = await record(s)
    expect(r.ok).toBe(true)
    expect(r.stopped).toBe('disconnected')
    expect(r.flow?.steps).toHaveLength(1)
    expect(r.warnings).toContain('loop-api36 stopped sending touches (disconnected?); the flow has what was recorded until then.')
  })

  it('getevent failing before the first screen read is an error with the device\'s message', async () => {
    const s = sim([], { streamEnds: { at: 0, code: 1, stderr: 'could not open /dev/input/event2, Permission denied\n' } })
    const r = await record(s)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('could not read touches from loop-api36: could not open /dev/input/event2, Permission denied')
    expect(r.flow).toBeNull()
  })

  it('refuses a device with no multi-touch panel, before streaming', async () => {
    const s = sim([], { getevent: ok('add device 1: /dev/input/event1\n  name: "keyboard"\n') })
    const r = await record(s)
    expect(r.ok).toBe(false)
    expect(r.error).toBe("could not find loop-api36's touch screen in `getevent -lp`")
    expect(s.stream.args).toBeNull()
  })

  it('refuses when the screen size cannot be read', async () => {
    const r = await record(sim([], { wmSize: fail('Error: no display') }))
    expect(r.error).toBe("could not read loop-api36's screen size and density (wm size / wm density)")
  })

  it('with launch: false records from where the app is and says how to replay it', async () => {
    const s = sim(new Person().tap(200, 800).acts, { keyboardOnFocus: false })
    const r = await record(s, { launch: false })
    expect(r.launched).toBeNull()
    expect(s.shell.some((l) => l.startsWith('am '))).toBe(false)
    expect(r.warnings).toContain('The app was not restarted before recording: replay this flow from the same screen with launch: false (`nawi run --no-launch`).')
  })

  it('records the app in front when no package is named, and refuses the home screen', async () => {
    const s = sim(new Person().tap(200, 800).acts, { keyboardOnFocus: false })
    const r = await record(s, { package: null })
    expect(r.package).toBe(PKG)
    expect(r.flow?.target).toEqual({ kind: 'android', package: PKG })

    const home = await record(sim([], { inFront: 'launcher' }), { package: null })
    expect(home.ok).toBe(false)
    expect(home.error).toBe('no app is in front to record')
    expect(home.fix).toContain('nawi mobile-open')
  })

  it('refuses a bad target or package before touching the device', async () => {
    const s = sim([])
    await expect(record(s, { target: 'bad target!' })).rejects.toThrow('is not an adb serial or AVD name')
    await expect(record(s, { package: 'not a package' })).rejects.toThrow('is not an Android package name')
    expect(s.shell).toEqual([])
  })
})

describe('parseWmSize', () => {
  it('prefers the override size, then the physical one', () => {
    expect(parseWmSize('Physical size: 1080x2400\n')).toEqual({ width: 1080, height: 2400 })
    expect(parseWmSize('Physical size: 1080x2400\nOverride size: 720x1600\n')).toEqual({ width: 720, height: 1600 })
    expect(parseWmSize('')).toBeNull()
    expect(parseWmSize('Physical size: big\n')).toBeNull()
  })
})

describe('spawnStream', () => {
  it('hands over stdout as it comes and settles once stopped', async () => {
    const chunks: string[] = []
    const s = spawnStream(process.execPath, ['-e', 'process.stdout.write("one\\n"); setInterval(() => {}, 1000)'], (c) => chunks.push(c))
    await expect.poll(() => chunks.join(''), { timeout: 10_000 }).toBe('one\n')
    s.stop()
    const done = await s.done
    expect(done.error, 'a stop is not a failure').toBeUndefined()
  })

  it('reports a process that exits non-zero with its stderr', async () => {
    const s = spawnStream(process.execPath, ['-e', 'process.stderr.write("no access"); process.exit(3)'], () => undefined)
    expect(await s.done).toEqual({ code: 3, error: 'failed', stderr: 'no access' })
  })

  it('reports a missing binary as not_found', async () => {
    const s = spawnStream(join(tmpdir(), 'nawi-no-such-adb'), [], () => undefined)
    expect((await s.done).error).toBe('not_found')
  })
})
