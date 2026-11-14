import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { androidReplayOf, runFlowFile } from '../flow-run'
import { ToolError } from '../mcp/errors'
import { readRunRecord } from '../run-record'
import type { ExecResult } from './doctor'
import { javaCrash } from './fixtures/crash-logs'
import { prepareAndroidRun, type AndroidRunHost } from './flow-device'
import { parseLauncher } from './open'
import { encodePng } from './png'

/**
 * Roadmap M5b (first part): android flows through `run_flow` / `nawi run`. A fake adb simulates a small sign-in app on
 * one or more devices; each test checks which device was used, exactly what reached the device's shell before the
 * first step (pm path, the launcher lookup, force-stop, am start), what the reply and the saved run record say, and
 * that a refusal sends no taps and names the one thing to do. The SDK and /dev/kvm are temp files.
 */

const PKG = 'dev.nawi.shop'
const START = Date.UTC(2026, 10, 8, 12)

let root: string
let sdkDir: string
let calls: string[][]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nawi-flow-device-'))
  mkdirSync(join(root, 'home'))
  sdkDir = join(root, 'sdk')
  const adb = join(sdkDir, 'platform-tools', 'adb')
  mkdirSync(join(adb, '..'), { recursive: true })
  writeFileSync(adb, '#!/bin/sh\n')
  chmodSync(adb, 0o755)
  writeFileSync(join(root, 'kvm'), '')
  calls = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

type Screen = 'launcher' | 'login' | 'welcome'

interface SimDevice {
  serial: string
  avd?: string
  api?: number
}

interface Sim {
  devices: SimDevice[]
  /** Packages `pm path` knows. Default: the shop app. */
  installed?: string[]
  /** What `cmd package resolve-activity` prints for the launcher. */
  launcher?: string
  /** What `am start -W` answers. */
  amStart?: ExecResult
  /** The shop app's screen before the run (it keeps it until force-stopped). */
  screen?: Screen
  /** The app dies right after `am start` reports ok (pidof finds nothing). */
  crashesOnStart?: boolean
  /** The device drops off adb from the n-th device command on (1-based). */
  goneFrom?: number
  /** Called with each device shell line before it is answered. */
  onShell?: (line: string) => void
  /** Answers the evidence commands (M5b-2): device clock, app uid, these logcat lines, and a screenshot. */
  evidence?: { logcat: string }
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr, error: 'failed' })

const SIGN_IN: [number, number, number, number] = [40, 700, 1040, 850]

function dump(screen: Screen): string {
  const pkg = screen === 'launcher' ? 'com.android.launcher3' : PKG
  const view = (text: string, cls: string, b: readonly number[], clickable: boolean): string =>
    `<node index="0" text="${text}" resource-id="${pkg}:id/v" class="${cls}" package="${pkg}" content-desc="" checkable="false" checked="false" clickable="${clickable}" enabled="true" focusable="${clickable}" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[${b[0]},${b[1]}][${b[2]},${b[3]}]"/>`
  const body =
    screen === 'login'
      ? view('Sign in', 'android.widget.Button', SIGN_IN, true)
      : screen === 'welcome'
        ? view('Welcome back', 'android.widget.TextView', [40, 100, 1040, 250], false)
        : view('Shop', 'android.widget.TextView', [40, 100, 300, 300], true)
  return (
    'UI hierchary dumped to: /data/local/tmp/nawi-window-1.xml\n' +
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="${pkg}" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">` +
    body +
    '</node></hierarchy>'
  )
}

function simHost(sim: Sim): AndroidRunHost & { screen: () => Screen } {
  let screen: Screen = sim.screen ?? 'launcher'
  let clock = START
  let deviceCommands = 0
  let running = sim.screen !== undefined
  const installed = sim.installed ?? [PKG]
  // Each screenshot differs (a counter in its first pixel): identical images are stored once.
  let shots = 0
  return {
    ...(sim.evidence
      ? {
          execBinary: async (file: string, args: string[]) => {
            calls.push([file.replace(sdkDir, '<sdk>'), ...args])
            return { code: 0, stdout: encodePng({ width: 2, height: 2, rgb: new Uint8Array(12).fill(++shots, 0, 1) }), stderr: '' }
          }
        }
      : {}),
    env: { ANDROID_HOME: sdkDir },
    platform: 'linux',
    arch: 'x64',
    home: join(root, 'home'),
    kvmPath: join(root, 'kvm'),
    now: () => clock,
    delay: async (ms) => {
      clock += ms
    },
    screen: () => screen,
    exec: async (file, args) => {
      clock += 5
      calls.push([file.replace(sdkDir, '<sdk>'), ...args])
      if (args[0] === 'version') return ok('Android Debug Bridge version 1.0.41\n')
      if (args[0] === 'devices') return ok(`List of devices attached\n${sim.devices.map((d) => `${d.serial}\tdevice`).join('\n')}\n`)
      if (args[0] !== '-s') return failed(`unexpected ${args.join(' ')}`)
      const d = sim.devices.find((x) => x.serial === args[1])
      if (!d) return failed(`adb: device '${args[1]}' not found`)
      deviceCommands++
      if (sim.goneFrom !== undefined && deviceCommands >= sim.goneFrom) return failed('adb: device offline')
      const cmd = args.slice(2)
      if (cmd[0] === 'emu') return d.avd ? ok(`${d.avd}\nOK\n`) : failed('not an emulator')
      if (cmd[0] !== 'shell') return failed(`unexpected ${cmd.join(' ')}`)
      const line = cmd[1]
      sim.onShell?.(line)
      if (sim.evidence && line === 'date +%s%3N') return ok(`${clock}\n`)
      if (sim.evidence && line.startsWith('cmd package list packages -U ')) return ok(`package:${PKG} uid:10234\n`)
      if (sim.evidence && line.startsWith('logcat ')) return ok(sim.evidence.logcat)
      if (line.startsWith('getprop ro.build')) return ok(`${d.api ?? 34}\nx86_64\n`)
      if (line.startsWith('uiautomator dump')) return ok(dump(screen))
      if (line.startsWith('dumpsys input_method')) return ok('mInputShown=false\n')
      if (line.startsWith('pm path ')) {
        const pkg = line.slice('pm path '.length).replace(/'/g, '')
        // Like real adb through runText: exit 1 with no output is classified error 'failed'.
        return installed.includes(pkg) ? ok(`package:/data/app/~~x/${pkg}-1/base.apk\n`) : { code: 1, stdout: '', stderr: '', error: 'failed' }
      }
      if (line.startsWith('cmd package resolve-activity')) {
        return ok(sim.launcher ?? `priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n${PKG}/.MainActivity\n`)
      }
      if (line === `am force-stop '${PKG}'`) {
        screen = 'launcher'
        running = false
        return ok()
      }
      if (line === `pidof '${PKG}'`) return running ? ok('4321\n') : { code: 1, stdout: '', stderr: '', error: 'failed' }
      if (line.startsWith('am start -W -n ')) {
        const r = sim.amStart ?? ok(`Starting: Intent { cmp=${PKG}/.MainActivity }\nStatus: ok\nLaunchState: COLD\nActivity: ${PKG}/.MainActivity\nTotalTime: 412\nWaitTime: 420\nComplete\n`)
        if (r.code === 0 && /Status: ok/.test(r.stdout) && !sim.crashesOnStart) {
          screen = 'login'
          running = true
        }
        return r
      }
      const tap = /^input tap (\d+) (\d+)$/.exec(line)
      if (tap) {
        const [x, y] = [Number(tap[1]), Number(tap[2])]
        if (screen === 'login' && x >= SIGN_IN[0] && x <= SIGN_IN[2] && y >= SIGN_IN[1] && y <= SIGN_IN[3]) screen = 'welcome'
        return ok()
      }
      return failed(`unexpected shell ${line}`)
    }
  }
}

/** The shell lines sent to the device, without screen reads, keyboard checks, getprop, `emu avd name` and evidence reads (M5b-2). */
const shellLines = (): string[] =>
  calls
    .filter((c) => c[1] === '-s' && c[3] === 'shell' && !/^(uiautomator dump|dumpsys input_method|getprop |date |cmd package list |logcat )/.test(c[4]))
    .map((c) => `${c[2]}: ${c[4]}`)

const FLOW = `version: 1
name: sign in
target: { kind: android, package: ${PKG} }
steps:
  - { id: tap, action: click, target: { selectors: [{ text: Sign in }] } }
  - { id: check, action: assert, target: { selectors: [{ text: Welcome back }] }, expect: { visible: true } }
`

function flowFile(text = FLOW, name = 'phone.nawi.yaml'): string {
  const file = join(root, name)
  writeFileSync(file, text)
  return file
}

async function refusal(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p
  } catch (error) {
    if (error instanceof ToolError) return error
    throw error
  }
  throw new Error('expected a ToolError, the run went ahead')
}

describe('runFlowFile on an android flow', () => {
  it('restarts the app from its launcher on the only device, replays the steps and records the device', async () => {
    const host = simHost({ devices: [{ serial: 'emulator-5560', avd: 'loop-api36', api: 36 }] })
    const runs = join(root, 'runs')
    const report = await runFlowFile({ file: flowFile() }, { roots: [root], androidHost: host, now: host.now, record: { dir: runs, appVersion: '0.1.0' } })

    expect(report.status, `run failed: ${report.error} ${JSON.stringify(report.steps)}`).toBe('passed')
    expect(report.steps.map((s) => [s.id, s.status]), 'every step ran in order').toEqual([['tap', 'passed'], ['check', 'passed']])
    expect(report.steps[0].matched, 'the tap was found by its text locator').toMatchObject({ index: 0, layer: 'text' })
    expect(shellLines().slice(0, 4), 'app checked, launcher resolved, app force-stopped, then started, before any step').toEqual([
      `emulator-5560: pm path '${PKG}'`,
      `emulator-5560: cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER '${PKG}'`,
      `emulator-5560: am force-stop '${PKG}'`,
      `emulator-5560: am start -W -n '${PKG}/.MainActivity'`
    ])
    expect(shellLines()[4], 'then it checks the app is still running').toBe(`emulator-5560: pidof '${PKG}'`)
    expect(shellLines()[5], 'the first step taps the Sign in button centre').toBe('emulator-5560: input tap 540 775')
    const device = { kind: 'avd', name: 'loop-api36', serial: 'emulator-5560', api: 36, package: PKG, launched_activity: '.MainActivity' }
    expect(report.device, 'the reply names the device and the activity started').toEqual(device)

    expect(report.run_id, `record not saved: ${report.record_error}`).toBeDefined()
    const record = await readRunRecord(runs, report.run_id!)
    expect(record?.environment.device, 'run.json keeps the device').toEqual(device)
    expect(record?.environment.browser, 'no browser facts on a device run').toBeUndefined()
    expect(Date.parse(record?.started_at ?? '') - START, 'started_at comes from the epoch clock (host.now), shortly after the device checks').toBeGreaterThanOrEqual(0)
    expect(Date.parse(record?.started_at ?? '') - START, 'started_at comes from the epoch clock (host.now), shortly after the device checks').toBeLessThan(60_000)
    const html = readFileSync(join(report.run_dir!, 'report.html'), 'utf8')
    expect(html, 'report.html names the device').toContain('<dt>Device</dt><dd>loop-api36 (virtual device), Android API 36</dd>')
    expect(html, 'report.html names the app and the activity started').toContain(`<dt>App</dt><dd>${PKG} (started .MainActivity)</dd>`)
    expect(existsSync(join(report.run_dir!, 'junit.xml')), 'junit.xml is written like for browser runs').toBe(true)
  })

  it('records a crash of the app (M5d-1): the step fails with it, run.json, the reply and report.html keep the report', async () => {
    // The device's log holds the app's crash report: both the crash read and the step log read return it.
    const logcat = javaCrash(Math.floor(START / 1000), PKG, { uid: 10234 })
    const host = simHost({ devices: [{ serial: 'emulator-5560', avd: 'loop-api36', api: 36 }], evidence: { logcat } })
    const runs = join(root, 'runs')
    const report = await runFlowFile({ file: flowFile(), trace: false }, { roots: [root], androidHost: host, now: host.now, record: { dir: runs } })
    expect(report.status).toBe('failed')
    expect(report.failed_step_id).toBe('tap')
    expect(report.steps[0].error).toBe(`${PKG} crashed: java.lang.IllegalStateException: tracking id missing`)
    expect(report.steps[0].crash, 'the reply names the crash').toMatchObject({ kind: 'crash', process: PKG, pid: 3475 })
    const record = await readRunRecord(runs, report.run_id!)
    expect(record?.steps[0].crash?.summary, 'run.json keeps the crash').toBe('java.lang.IllegalStateException: tracking id missing')
    expect(record?.steps[0].logcat?.filter((l) => l.message === 'FATAL EXCEPTION: main'), 'the report once, though both reads return it').toHaveLength(1)
    const html = readFileSync(join(report.run_dir!, 'report.html'), 'utf8')
    expect(html).toContain(`${PKG} crashed: java.lang.IllegalStateException: tracking id missing`)
    expect(html).toContain('logcat E AndroidRuntime: FATAL EXCEPTION: main')
    expect(readFileSync(join(report.run_dir!, 'junit.xml'), 'utf8')).toContain('crashed: java.lang.IllegalStateException')
    // Watched from before the launch (pm path, force-stop, am start each take fake time), not from the first step.
    const since = calls.map((c) => /^logcat -d -b crash .* -t (\d+)\.(\d{3}) /.exec(c[4] ?? '')).find((m) => m !== null)
    expect(Number(since?.[1]) * 1000 + Number(since?.[2]) - START, 'crash log read from the launch on').toBeLessThanOrEqual(5)
  })

  it('saves the device screen around each step and the app\'s log lines in the record, and asks for neither without one', async () => {
    const logcat = `  ${Math.floor(START / 1000)}.500 10234  4321  4321 E Shop: could not load the welcome banner\n`
    const host = simHost({ devices: [{ serial: 'emulator-5560', avd: 'loop-api36', api: 36 }], evidence: { logcat } })
    const runs = join(root, 'runs')
    const report = await runFlowFile({ file: flowFile() }, { roots: [root], androidHost: host, now: host.now, record: { dir: runs } })
    expect(report.status, `run failed: ${report.error}`).toBe('passed')
    expect(report.steps[0].shots, 'the reply points at PNG files inside run_dir').toEqual({ before: 'steps/001-tap.before.png', after: 'steps/001-tap.after.png' })
    expect(report.steps[0].logcat?.[0], 'the reply carries the step\'s first log lines').toMatchObject({ level: 'E', tag: 'Shop', message: 'could not load the welcome banner' })
    const record = await readRunRecord(runs, report.run_id!)
    expect(record?.steps[1].shots, 'the second step starts from the first one\'s after shot').toEqual({ before: 'steps/001-tap.after.png', after: 'steps/002-check.after.png' })
    expect(record?.steps[0].logcat, 'run.json keeps the log lines').toHaveLength(1)
    expect(existsSync(join(report.run_dir!, 'steps', '002-check.after.png'))).toBe(true)
    expect(readFileSync(join(report.run_dir!, 'report.html'), 'utf8')).toContain('logcat E Shop: could not load the welcome banner')

    calls.length = 0
    const off = await runFlowFile({ file: flowFile(), screenshots: 'off' }, { roots: [root], androidHost: host, now: host.now, record: { dir: runs } })
    expect(off.steps.some((st) => st.shots), 'screenshots off: none').toBe(false)
    expect(calls.some((c) => c.includes('screencap')), 'screenshots off: no screencap').toBe(false)
    calls.length = 0
    const unrecorded = await runFlowFile({ file: flowFile() }, { roots: [root], androidHost: host })
    expect(unrecorded.status).toBe('passed')
    expect(calls.some((c) => c.includes('screencap') || /^logcat (?!-d -b crash )/.test(c[4] ?? '')), 'no record: no screenshots or step log asked of the device').toBe(false)
    expect(calls.some((c) => /^logcat -d -b crash /.test(c[4] ?? '')), 'crashes are watched for with or without a record (M5d-1)').toBe(true)
  })

  it('with launch false acts on the app as it is: no launcher lookup, force-stop or start', async () => {
    const host = simHost({ devices: [{ serial: 'R5CT1234' }], screen: 'login' })
    const report = await runFlowFile({ file: flowFile(), launch: false }, { roots: [root], androidHost: host })
    expect(report.status, `run failed: ${report.error}`).toBe('passed')
    expect(shellLines(), 'only the install check and the step\'s tap reach the shell').toEqual([`R5CT1234: pm path '${PKG}'`, 'R5CT1234: input tap 540 775'])
    expect(report.device, 'a phone is named by its serial; no activity was started').toEqual({ kind: 'device', name: 'R5CT1234', serial: 'R5CT1234', api: 34, package: PKG })
  })

  it('fails the step, not the call, when the app does not reach the screen the flow expects', async () => {
    // Without the restart the app stays on the launcher screen, where no "Sign in" view exists.
    const host = simHost({ devices: [{ serial: 'R5CT1234' }], screen: 'launcher' })
    const report = await runFlowFile({ file: flowFile(), launch: false, stepTimeoutMs: 1000 }, { roots: [root], androidHost: host })
    expect(report.status).toBe('failed')
    expect(report.failed_step_id, 'the first step is the one that failed').toBe('tap')
    expect(report.steps[0].error, 'the step names the locator that found nothing').toMatch(/no view of dev\.nawi\.shop matched: text="Sign in" found nothing/)
    expect(report.steps[1].status, 'later steps are not run').toBe('not_run')
  })

  it('runs on the device named by target when several are connected, and refuses to guess without it', async () => {
    const sim: Sim = { devices: [{ serial: 'R5CT1234' }, { serial: 'emulator-5560', avd: 'loop-api36', api: 36 }] }
    const guess = await refusal(runFlowFile({ file: flowFile() }, { roots: [root], androidHost: simHost(sim) }))
    expect(guess.code).toBe('UNAVAILABLE')
    expect(guess.message, 'names the devices').toMatch(/2 devices are connected \(R5CT1234, emulator-5560\)/)
    expect(guess.detail.fix, 'says how to pick one').toMatch(/Say which one to run with target/)
    expect(shellLines(), 'nothing reached a device while no device was chosen').toEqual([])

    const report = await runFlowFile({ file: flowFile(), device: 'loop-api36' }, { roots: [root], androidHost: simHost(sim) })
    expect(report.status, `run failed: ${report.error}`).toBe('passed')
    expect(report.device?.serial, 'the AVD name picked its emulator').toBe('emulator-5560')
    expect(shellLines().every((l) => l.startsWith('emulator-5560: ')), `only the chosen device got commands: ${shellLines().join(' | ')}`).toBe(true)
  })

  it('refuses an app that is not installed, with mobile-open as the fix, and touches nothing', async () => {
    const e = await refusal(runFlowFile({ file: flowFile() }, { roots: [root], androidHost: simHost({ devices: [{ serial: 'R5CT1234' }], installed: [] }) }))
    expect(e.code).toBe('UNAVAILABLE')
    expect(e.message).toMatch(/dev\.nawi\.shop is not installed on R5CT1234/)
    expect(e.detail.fix).toBe('Install it with `nawi mobile-open <file.apk> --target R5CT1234`, then run the flow again.')
    expect(shellLines(), 'only the install check was sent').toEqual([`R5CT1234: pm path '${PKG}'`])
  })

  it('says the device went away, not that the app is missing, when adb loses the device at the install check', async () => {
    // Device commands: getprop (doctor), then pm path.
    const e = await refusal(runFlowFile({ file: flowFile() }, { roots: [root], androidHost: simHost({ devices: [{ serial: 'R5CT1234' }], goneFrom: 2 }) }))
    expect(e.code).toBe('UNAVAILABLE')
    expect(e.message).toMatch(/could not check which apps are installed on R5CT1234: adb: device offline/)
    expect(e.detail.fix).toMatch(/still connected and unlocked/)
  })

  it('refuses when the app dies right after starting, pointing at the crash log', async () => {
    const e = await refusal(runFlowFile({ file: flowFile() }, { roots: [root], androidHost: simHost({ devices: [{ serial: 'R5CT1234' }], crashesOnStart: true }) }))
    expect(e.code).toBe('UNAVAILABLE')
    expect(e.message).toMatch(/dev\.nawi\.shop started on R5CT1234 and then stopped/)
    expect(e.detail.fix).toBe('It probably crashed at startup: look at `adb -s R5CT1234 logcat -b crash`.')
    expect(shellLines().some((l) => l.includes('input ')), 'no step ran').toBe(false)
  })

  it('names several launcher activities (the system chooser) instead of calling them none', async () => {
    const launcher = 'priority=0 preferredOrder=0 match=0x0 specificIndex=-1 isDefault=false\nandroid/com.android.internal.app.ResolverActivity\n'
    const e = await refusal(runFlowFile({ file: flowFile() }, { roots: [root], androidHost: simHost({ devices: [{ serial: 'R5CT1234' }], launcher }) }))
    expect(e.message).toMatch(/has several launcher activities on R5CT1234/)
    expect(e.detail.fix).toMatch(/--no-launch/)
  })

  it('does not stop or restart the app when the run is stopped while the device is being readied', async () => {
    const stop = new AbortController()
    const host = simHost({ devices: [{ serial: 'R5CT1234' }], screen: 'login', onShell: (line) => (line.startsWith('cmd package resolve-activity') ? stop.abort('agent access was paused') : undefined) })
    const report = await runFlowFile({ file: flowFile() }, { roots: [root], androidHost: host, signal: stop.signal })
    expect(report.status).toBe('failed')
    expect(report.error).toBe('agent access was paused')
    expect(report.steps.map((s) => s.status), 'no step ran').toEqual(['not_run', 'not_run'])
    expect(shellLines().some((l) => /force-stop|am start|input /.test(l)), `the app was left alone: ${shellLines().join(' | ')}`).toBe(false)
    expect(host.screen(), 'the user\'s screen in the app is untouched').toBe('login')
  })

  it('refuses when no device is connected', async () => {
    const e = await refusal(runFlowFile({ file: flowFile() }, { roots: [root], androidHost: simHost({ devices: [] }) }))
    expect(e.code).toBe('UNAVAILABLE')
    expect(e.message).toMatch(/no device is connected/)
    expect(e.detail.fix, 'points at mobile-open, then running it').toMatch(/nawi mobile-open <file\.apk>`, then run it\./)
  })

  it('refuses an app without a launcher activity before stopping it, and suggests --no-launch', async () => {
    // Android's cmd prints a missing match with exit code 0.
    const e = await refusal(runFlowFile({ file: flowFile() }, { roots: [root], androidHost: simHost({ devices: [{ serial: 'R5CT1234' }], launcher: 'No activity found\n' }) }))
    expect(e.code).toBe('UNAVAILABLE')
    expect(e.message).toMatch(/dev\.nawi\.shop has no launcher activity on R5CT1234/)
    expect(e.detail.fix).toMatch(/--no-launch/)
    expect(shellLines().some((l) => /force-stop|am start|input /.test(l)), `the app was not stopped or touched: ${shellLines().join(' | ')}`).toBe(false)
  })

  it('refuses when the app does not start, with the am start error and the command to see it in full', async () => {
    const amStart: ExecResult = ok(`Starting: Intent { cmp=${PKG}/.MainActivity }\nError type 3\nError: Activity class {${PKG}/${PKG}.MainActivity} does not exist.\n`)
    const e = await refusal(runFlowFile({ file: flowFile() }, { roots: [root], androidHost: simHost({ devices: [{ serial: 'R5CT1234' }], amStart }) }))
    expect(e.code).toBe('UNAVAILABLE')
    expect(e.message).toMatch(/did not start on R5CT1234: Error: Activity class \{dev\.nawi\.shop\/dev\.nawi\.shop\.MainActivity\} does not exist\./)
    expect(e.detail.fix).toBe(`Run \`adb -s R5CT1234 shell am start -W -n ${PKG}/.MainActivity\` to see the full message.`)
    expect(shellLines().some((l) => l.includes('input ')), 'no step ran').toBe(false)
  })

  it('stops after the step in progress when the kill switch fires, leaving the rest not run', async () => {
    const stop = new AbortController()
    const host = simHost({ devices: [{ serial: 'R5CT1234' }] })
    const report = await runFlowFile(
      { file: flowFile() },
      { roots: [root], androidHost: host, signal: stop.signal, onStep: (s) => (s.id === 'tap' ? stop.abort('agent access was paused') : undefined) }
    )
    expect(report.status).toBe('failed')
    expect(report.steps.map((s) => [s.id, s.status]), 'the tap finished, the check was not run').toEqual([['tap', 'passed'], ['check', 'not_run']])
  })

  it('touches no device when an input is missing or the run was stopped before it started', async () => {
    const file = flowFile(FLOW.replace('expect: { visible: true }', 'expect: { text: "${env.GREETING}" }'))
    const missing = await runFlowFile({ file }, { roots: [root], androidHost: simHost({ devices: [{ serial: 'R5CT1234' }] }) })
    expect(missing.status).toBe('failed')
    expect(missing.error, JSON.stringify(missing)).toMatch(/env\.GREETING/)
    const stopped = new AbortController()
    stopped.abort('paused')
    const early = await runFlowFile({ file: flowFile() }, { roots: [root], androidHost: simHost({ devices: [{ serial: 'R5CT1234' }] }), signal: stopped.signal })
    expect(early.steps.map((s) => s.status)).toEqual(['not_run', 'not_run'])
    expect(calls, 'adb was never called').toEqual([])
  })

  it('refuses browser-only options on an android flow and android-only ones on a browser flow', async () => {
    const host = simHost({ devices: [{ serial: 'R5CT1234' }] })
    const cdp = await refusal(runFlowFile({ file: flowFile(), cdpEndpoint: '9222' }, { roots: [root], androidHost: host }))
    expect(cdp.code).toBe('INVALID_ARGUMENTS')
    expect(cdp.message).toMatch(/cdp_endpoint is for browser flows/)
    const traced = await refusal(runFlowFile({ file: flowFile(), trace: true }, { roots: [root], androidHost: host }))
    expect(traced.code, 'a browser performance trace on an android flow is refused, not silently skipped').toBe('INVALID_ARGUMENTS')
    expect(traced.message).toMatch(/trace is for browser flows/)
    const web = flowFile('version: 1\nname: w\ntarget: { kind: browser, url: "https://example.test" }\nsteps:\n  - { id: s1, action: press, key: Enter }\n', 'web.nawi.yaml')
    const opened: string[] = []
    const openPage = async (): Promise<never> => {
      opened.push('page')
      throw new Error('no browser in this test')
    }
    for (const request of [{ device: 'R5CT1234' }, { launch: false }]) {
      const e = await refusal(runFlowFile({ file: web, ...request }, { roots: [root], openPage }))
      expect(e.code, JSON.stringify(request)).toBe('INVALID_ARGUMENTS')
      expect(e.message).toMatch(/target and launch are for Android flows/)
    }
    expect(opened, 'no browser was opened').toEqual([])
    expect(calls, 'no adb call').toEqual([])
  })
})

describe('prepareAndroidRun', () => {
  it('refuses a target that is not a serial or AVD name before asking adb anything', async () => {
    const r = await prepareAndroidRun({ package: PKG, target: 'x; reboot' }, simHost({ devices: [{ serial: 'R5CT1234' }] }))
    expect(r).toMatchObject({ error: '"x; reboot" is not an adb serial or AVD name' })
    expect(calls).toEqual([])
  })
})

describe('androidReplayOf (apply_heal replays an android run the same way)', () => {
  it('repeats the device and the launch setting of the run, and adds nothing for a browser run', () => {
    expect(androidReplayOf({ environment: { device: { name: 'loop-api36', launched_activity: '.MainActivity' } } }), 'launched run: same device, default launch').toEqual({ device: 'loop-api36' })
    expect(androidReplayOf({ environment: { device: { name: 'R5CT1234' } } }), 'run with launch off: replay with launch off').toEqual({ device: 'R5CT1234', launch: false })
    expect(androidReplayOf({ environment: {} }), 'browser run').toEqual({})
    expect(androidReplayOf({}), 'a run.json without environment').toEqual({})
    expect(androidReplayOf({ environment: { device: { name: 42 } } }), 'a hand-edited device name that is not a string').toEqual({})
  })
})

describe('parseLauncher', () => {
  it('reads the component from the last line, only for the asked package', () => {
    expect(parseLauncher(`priority=0 preferredOrder=0\n${PKG}/.MainActivity\n`, PKG)).toBe(`${PKG}/.MainActivity`)
    expect(parseLauncher(`${PKG}/${PKG}.ui.Start$Alias\n`, PKG), 'full class names and $ are fine').toBe(`${PKG}/${PKG}.ui.Start$Alias`)
    expect(parseLauncher('com.android.launcher3/.Launcher\n', PKG), 'another app (a resolver or chooser) is not this app\'s launcher').toBeNull()
    expect(parseLauncher('No activity found\n', PKG)).toBeNull()
    expect(parseLauncher(`${PKG}/.Main; reboot\n`, PKG), 'nothing that could carry a shell command').toBeNull()
  })
})
