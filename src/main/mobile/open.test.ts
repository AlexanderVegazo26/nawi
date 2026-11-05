import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApkInfo } from './apk'
import { detectFramework } from './framework'
import type { ExecResult } from './doctor'
import { defaultDeviceSettings, KEEP_DEVICE_SETTINGS, type DeviceSettings } from './profile'
import {
  BOOT_POLL_MS,
  FIRST_SCREEN_SETTLE_MS,
  freeEmulatorPort,
  installFix,
  openApp,
  parseAmStart,
  runtimePermissionsFor,
  shQuote,
  type MobileOpenResult,
  type OpenHost,
  type OpenRequest
} from './open'

/**
 * mobile_open's engine (roadmap M1c) against a simulated adb + emulator: which device it picks, the exact adb commands
 * it sends (and that names are shell-quoted), booting an AVD, and that every failure stops at its step with one fix.
 * The SDK, AVD folder and /dev/kvm are temp files; no real device, emulator or clock is touched.
 */

let root: string
let home: string
let sdkDir: string
let calls: string[][]
let spawned: { file: string; args: string[] }[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nawi-open-'))
  home = join(root, 'home')
  mkdirSync(home)
  sdkDir = join(root, 'sdk')
  for (const tool of ['platform-tools/adb', 'emulator/emulator']) {
    const path = join(sdkDir, tool)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '#!/bin/sh\n')
    chmodSync(path, 0o755)
  }
  calls = []
  spawned = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function avd(name: string, api: number, abi = 'x86_64'): void {
  const avdHome = join(home, '.android', 'avd')
  const dir = join(avdHome, `${name}.avd`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(avdHome, `${name}.ini`), `path=${dir}\ntarget=android-${api}\n`)
  const image = `system-images/android-${api}/google_apis/${abi}`
  writeFileSync(join(dir, 'config.ini'), `abi.type=${abi}\nimage.sysdir.1=${image}/\ntag.id=google_apis\n`)
  mkdirSync(join(sdkDir, image), { recursive: true })
}

interface SimDevice {
  serial: string
  state?: string
  api?: number
  abis?: string[]
  /** The AVD a running emulator was started from. */
  avd?: string
}

interface Sim {
  devices: SimDevice[]
  /** Polls of sys.boot_completed before a booted emulator answers 1. */
  bootPolls?: number
  /** The emulator process exits right away. */
  emulatorDies?: boolean
  install?: ExecResult
  grant?: (perm: string) => ExecResult
  am?: ExecResult
  pidof?: ExecResult
  /** `settings put ...` and `cmd ...` lines (device settings, M2b); default: success, printing what Android prints. */
  setting?: (line: string) => ExecResult
  /** The `uiautomator dump` line after launch (M2c); default: the app's own screen with nothing in front. */
  dump?: ExecResult
  /** Screens in order, one per dump (the last one repeats): the device after each onboarding tap (M2c part 2). */
  dumps?: ExecResult[]
  /** `input tap x y`; default: success. */
  tap?: (line: string) => ExecResult
}

/** A uiautomator dump: one window of `pkg` with these nodes (attribute strings) inside it. */
export function dumpXml(pkg: string, inner: string[] = []): string {
  const nodes = inner.map((n) => `<node index="0" package="${pkg}" ${n} enabled="true"/>`).join('')
  return `UI hierchary dumped to: /data/local/tmp/nawi-window.xml\n<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="${pkg}" content-desc="" clickable="false" enabled="true" password="false" bounds="[0,0][1080,2400]">${nodes}</node></hierarchy>`
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
const failed = (stderr: string, stdout = ''): ExecResult => ({ code: 1, stdout, stderr, error: 'failed' })

function simHost(sim: Sim, over: Partial<OpenHost> = {}): OpenHost {
  const kvm = join(root, 'kvm')
  writeFileSync(kvm, '')
  chmodSync(kvm, 0o600)
  let polls = 0
  let exited = false
  let clock = 0
  const host: OpenHost = {
    env: { ANDROID_HOME: sdkDir },
    platform: 'linux',
    arch: 'x64',
    home,
    kvmPath: kvm,
    exec: async (file, args) => {
      calls.push([file.replace(sdkDir, '<sdk>'), ...args])
      if (args[0] === 'version') return ok('Android Debug Bridge version 1.0.41\n')
      if (args[0] === 'devices') return ok(`List of devices attached\n${sim.devices.map((d) => `${d.serial}\t${d.state ?? 'device'}`).join('\n')}\n`)
      if (args[0] !== '-s') return failed(`unexpected ${args.join(' ')}`)
      const d = sim.devices.find((x) => x.serial === args[1])
      if (!d) return failed(`adb: device '${args[1]}' not found`)
      const cmd = args.slice(2)
      if (cmd[0] === 'emu') return d.avd ? ok(`${d.avd}\nOK\n`) : failed('not an emulator')
      if (cmd[0] === 'install') return sim.install ?? ok('Performing Streamed Install\nSuccess\n')
      if (cmd[0] !== 'shell') return failed(`unexpected ${cmd.join(' ')}`)
      const line = cmd[1]
      if (line.startsWith('getprop ro.build')) return ok(`${d.api ?? ''}\n${(d.abis ?? ['x86_64']).join(',')}\n`)
      if (line === 'getprop sys.boot_completed') return ok(++polls > (sim.bootPolls ?? 0) ? '1\n' : '\n')
      if (line.startsWith('pm grant')) return sim.grant?.(line) ?? ok()
      if (line.startsWith('am start')) return sim.am ?? ok('Starting: Intent { cmp=x }\nStatus: ok\nLaunchState: COLD\nActivity: x\nTotalTime: 412\nWaitTime: 420\nComplete\n')
      if (line.startsWith('pidof')) return sim.pidof ?? ok('4242\n')
      if (line.startsWith('uiautomator dump') && sim.dumps) return (sim.dumps.length > 1 ? sim.dumps.shift() : sim.dumps[0]) as ExecResult
      if (line.startsWith('input tap')) return sim.tap?.(line) ?? ok()
      if (line.startsWith('uiautomator dump')) return sim.dump ?? ok(dumpXml('dev.nawi.sample', ['text="Welcome back" class="android.widget.TextView" bounds="[0,100][1080,200]"']))
      if (line.startsWith('settings put') || line.startsWith('cmd ')) return sim.setting?.(line) ?? ok(line.startsWith('cmd uimode') ? 'Night mode: no\n' : '')
      return failed(`unexpected shell ${line}`)
    },
    spawnDetached: (file, args) => {
      spawned.push({ file: file.replace(sdkDir, '<sdk>'), args })
      exited = sim.emulatorDies ?? false
      // The booted emulator shows up in adb under the port it was given.
      if (!exited) sim.devices.push({ serial: `emulator-${args[args.indexOf('-port') + 1]}`, api: 36, abis: ['x86_64', 'arm64-v8a'], avd: args[1] })
      return { exitCode: () => (exited ? 1 : null) }
    },
    // Time passes only in delay(), so the boot deadline is exact.
    delay: async (ms) => {
      clock += ms
    },
    now: () => clock,
    ...over
  }
  return host
}

const apk = (over: Partial<ApkInfo> = {}): ApkInfo => ({
  package: 'dev.nawi.sample',
  version_code: 1,
  version_name: '1.0',
  min_sdk: 26,
  target_sdk: 35,
  launcher_activity: 'dev.nawi.sample.MainActivity',
  abis: [],
  debuggable: true,
  permissions: [
    { name: 'android.permission.CAMERA', runtime: true, max_sdk: null },
    { name: 'android.permission.INTERNET', runtime: false, max_sdk: null },
    { name: 'android.permission.READ_EXTERNAL_STORAGE', runtime: true, max_sdk: 32 }
  ],
  deep_links: [],
  exported_components: [],
  framework: detectFramework([], true),
  unresolved: [],
  ...over
})

const req = (over: Partial<OpenRequest> = {}): OpenRequest => ({ apkFile: '/home/u/app.apk', apk: apk(), ...over })
const step = (r: MobileOpenResult, id: string) => r.steps.find((s) => s.id === id)
const adbCalls = () => calls.filter((c) => c[0] === '<sdk>/platform-tools/adb' && c[1] === '-s').map((c) => c.slice(2).join(' '))

describe('openApp on a connected device', () => {
  it('installs, grants the runtime permissions for its API level, launches the launcher activity, in that order', async () => {
    const r = await openApp(req(), simHost({ devices: [{ serial: 'R58M', api: 34 }] }))
    expect(r.fix, 'fix on the happy path').toBeNull()
    expect(r.ok, `steps: ${JSON.stringify(r.steps)}`).toBe(true)
    expect(r.target).toEqual({ kind: 'device', name: 'R58M', serial: 'R58M', api: 34, booted: false })
    expect(adbCalls().filter((c) => !c.includes('getprop ro.build')), 'adb commands sent to the device').toEqual([
      'R58M install -r -t /home/u/app.apk',
      "R58M shell pm grant 'dev.nawi.sample' 'android.permission.CAMERA'",
      "R58M shell am start -W -n 'dev.nawi.sample/dev.nawi.sample.MainActivity'",
      "R58M shell pidof 'dev.nawi.sample'",
      expect.stringMatching(/^R58M shell uiautomator dump (\/data\/local\/tmp\/nawi-window-[0-9a-f]{12}\.xml) && cat \1; s=\$\?; rm -f \1; exit \$s$/)
    ])
    expect(r.permissions, 'READ_EXTERNAL_STORAGE has maxSdkVersion 32 < API 34, so it is not granted').toEqual({ granted: ['android.permission.CAMERA'], not_granted: [] })
    expect(r.launched).toEqual({ activity: 'dev.nawi.sample.MainActivity', total_time_ms: 412, pid: 4242 })
    expect(r.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['doctor:ok', 'boot:skipped', 'install:ok', 'grant:ok', 'settings:skipped', 'launch:ok', 'onboarding:skipped', 'first_screen:ok'])
    expect(r.first_screen, 'the app\'s own screen, nothing in front').toEqual({ package: 'dev.nawi.sample', blockers: [] })
    expect(spawned, 'nothing booted when a device is connected').toEqual([])
    expect(r.settings, 'a physical phone keeps its own settings by default').toEqual({ requested: KEEP_DEVICE_SETTINGS, applied: [], not_applied: [] })
  })

  it('uses the profile\'s permission list and activity instead of the manifest\'s, and grant [] skips granting', async () => {
    const r = await openApp(req({ grant: [], activity: 'dev.nawi.sample.Other$Inner' }), simHost({ devices: [{ serial: 'R58M', api: 34 }] }))
    expect(step(r, 'grant')?.status).toBe('skipped')
    expect(adbCalls(), 'a $ in the class name is quoted, not expanded by the device shell').toContain("R58M shell am start -W -n 'dev.nawi.sample/dev.nawi.sample.Other$Inner'")
  })

  it('reports a permission the device refuses as a warning and still launches', async () => {
    const sim: Sim = {
      devices: [{ serial: 'R58M', api: 30 }],
      grant: (line) => (line.includes('READ_EXTERNAL') ? ok('Exception occurred while executing \'grant\':\njava.lang.SecurityException: not a changeable permission type\n') : ok())
    }
    const r = await openApp(req(), simHost(sim))
    expect(r.ok, 'a refused grant does not stop the launch').toBe(true)
    expect(r.permissions.granted).toEqual(['android.permission.CAMERA'])
    expect(r.permissions.not_granted).toEqual([{ name: 'android.permission.READ_EXTERNAL_STORAGE', reason: "Exception occurred while executing 'grant':" }])
    expect(step(r, 'grant')?.status).toBe('warn')
    expect(step(r, 'grant')?.fix).toMatch(/dialog/)
  })

  it.each([
    ['INSTALL_FAILED_UPDATE_INCOMPATIBLE', /signed with a different key.*adb -s R58M uninstall dev\.nawi\.sample/],
    ['INSTALL_FAILED_VERSION_DOWNGRADE', /newer version/],
    ['INSTALL_FAILED_INSUFFICIENT_STORAGE', /out of storage/],
    ['INSTALL_PARSE_FAILED_NO_CERTIFICATES', /apksigner/],
    ['INSTALL_FAILED_USER_RESTRICTED', /Install via USB/],
    ['INSTALL_FAILED_SOMETHING_NEW', /adb -s R58M install -r -t \/home\/u\/app\.apk/]
  ])('an install failing with %s stops before granting, with its fix', async (code, fix) => {
    const r = await openApp(req(), simHost({ devices: [{ serial: 'R58M', api: 34 }], install: failed(`adb: failed to install /home/u/app.apk: Failure [${code}: details]`) }))
    expect(r.ok).toBe(false)
    expect(step(r, 'install')).toMatchObject({ status: 'fail', summary: `adb install failed: ${code}` })
    expect(r.fix, `fix for ${code}`).toMatch(fix)
    expect(r.steps.map((s) => s.id), 'no step after the failed install').toEqual(['doctor', 'boot', 'install'])
  })

  it('a device unplugged during the install says to reconnect it', async () => {
    const r = await openApp(req(), simHost({ devices: [{ serial: 'R58M', api: 34 }], install: failed("adb: device 'R58M' not found") }))
    expect(r.fix).toBe('Reconnect R58M (or restart that emulator), then retry.')
  })

  it.each([
    ['a missing activity', 'Error type 3\nError: Activity class {dev.nawi.sample/dev.nawi.sample.Gone} does not exist.\n', /not an activity of dev\.nawi\.sample/],
    ['an unexported activity', 'Security exception: Permission Denial: starting Intent { cmp=x } not exported from uid 10123\n', /not exported/],
    ['a status other than ok', 'Status: timeout\n', /logcat/]
  ])('a launch that fails with %s names the fix', async (_what, stdout, fix) => {
    const r = await openApp(req(), simHost({ devices: [{ serial: 'R58M', api: 34 }], am: ok(stdout) }))
    expect(r.ok).toBe(false)
    expect(step(r, 'launch')?.status).toBe('fail')
    expect(r.fix).toMatch(fix)
  })

  it('an app that exits right after starting is reported as a startup crash', async () => {
    const r = await openApp(req(), simHost({ devices: [{ serial: 'R58M', api: 34 }], pidof: { code: 1, stdout: '', stderr: '' } }))
    expect(r.ok).toBe(false)
    expect(step(r, 'launch')?.summary).toBe('dev.nawi.sample started and then stopped')
    expect(r.fix).toMatch(/logcat -b crash/)
  })

  it('an image without pidof still counts as launched', async () => {
    const r = await openApp(req({ apk: apk({ min_sdk: 21 }) }), simHost({ devices: [{ serial: 'R58M', api: 22 }], pidof: { code: 127, stdout: '', stderr: '/system/bin/sh: pidof: not found', error: 'failed' } }))
    expect(r.ok, JSON.stringify(r.steps)).toBe(true)
    expect(r.launched?.pid).toBeNull()
  })

  it('an app without a launcher activity fails at launch with what to name instead', async () => {
    const r = await openApp(req({ apk: apk({ launcher_activity: null }) }), simHost({ devices: [{ serial: 'R58M', api: 34 }] }))
    expect(step(r, 'launch')).toMatchObject({ status: 'fail', summary: 'dev.nawi.sample has no launcher activity' })
    expect(r.fix).toMatch(/launch\.activity/)
  })
})

describe('openApp choosing and booting a virtual device', () => {
  it('boots the recommended AVD on a free port, waits for sys.boot_completed, then installs on it', async () => {
    avd('Pixel_API_36', 36)
    const sim: Sim = { devices: [{ serial: 'emulator-5554', state: 'offline' }], bootPolls: 3 }
    const r = await openApp(req({ headless: true }), simHost(sim))
    expect(r.ok, JSON.stringify(r.steps)).toBe(true)
    expect(spawned, 'the emulator command line').toEqual([
      { file: '<sdk>/emulator/emulator', args: ['-avd', 'Pixel_API_36', '-port', '5556', '-no-snapshot-save', '-no-boot-anim', '-no-window', '-no-audio'] }
    ])
    expect(r.target).toEqual({ kind: 'avd', name: 'Pixel_API_36', serial: 'emulator-5556', api: 36, booted: true })
    expect(adbCalls().filter((c) => c.endsWith('sys.boot_completed')), 'polled until booted').toHaveLength(4)
    expect(step(r, 'boot')).toMatchObject({ status: 'ok', summary: 'Pixel_API_36 booted as emulator-5556' })
    expect(adbCalls()).toContain('emulator-5556 install -r -t /home/u/app.apk')
  })

  it('reuses an AVD that is already running instead of starting a second copy', async () => {
    avd('Pixel_API_36', 36)
    const r = await openApp(req({ target: 'Pixel_API_36' }), simHost({ devices: [{ serial: 'emulator-5560', api: 36, avd: 'Pixel_API_36' }] }))
    expect(spawned).toEqual([])
    expect(r.target).toEqual({ kind: 'avd', name: 'Pixel_API_36', serial: 'emulator-5560', api: 36, booted: false })
    expect(step(r, 'boot')?.status).toBe('skipped')
  })

  it('records a running emulator it picked by its AVD name (the serial changes from boot to boot)', async () => {
    avd('Pixel_API_36', 36)
    const r = await openApp(req(), simHost({ devices: [{ serial: 'emulator-5554', api: 36, avd: 'Pixel_API_36' }] }))
    expect(r.target).toEqual({ kind: 'avd', name: 'Pixel_API_36', serial: 'emulator-5554', api: 36, booted: false })
    expect(spawned).toEqual([])
  })

  it('an emulator that exits during boot says to run it by hand', async () => {
    avd('Pixel_API_36', 36)
    const r = await openApp(req(), simHost({ devices: [], emulatorDies: true }))
    expect(step(r, 'boot')?.summary).toBe('the emulator for Pixel_API_36 exited before Android finished booting')
    expect(r.fix).toContain(`Run \`${sdkDir}/emulator/emulator -avd Pixel_API_36\` in a terminal`)
  })

  it('the boot deadline counts the time adb calls take, not only the waits between polls', async () => {
    avd('Pixel_API_36', 36)
    let t = 0
    const sim: Sim = { devices: [], bootPolls: 1_000 }
    const h = simHost(sim, { now: () => t, delay: async (ms) => void (t += ms) })
    const exec = h.exec
    // Each getprop hangs for 15 s (a half-up adbd), so a 60 s budget fits 4 polls, not 30.
    h.exec = async (file, args, timeoutMs) => {
      if (args.at(-1) === 'getprop sys.boot_completed') t += 15_000
      return exec(file, args, timeoutMs)
    }
    const r = await openApp(req({ bootTimeoutMs: 60_000 }), h)
    expect(step(r, 'boot')?.summary).toBe('Pixel_API_36 was still booting after 60 s')
    expect(adbCalls().filter((c) => c.endsWith('sys.boot_completed')).length).toBeLessThanOrEqual(4)
  })

  it('a boot that never completes times out after the given time with what to do', async () => {
    avd('Pixel_API_36', 36)
    const r = await openApp(req({ bootTimeoutMs: 10 * BOOT_POLL_MS }), simHost({ devices: [], bootPolls: 1_000 }))
    expect(adbCalls().filter((c) => c.endsWith('sys.boot_completed')), 'one poll per interval').toHaveLength(10)
    expect(step(r, 'boot')?.summary).toBe('Pixel_API_36 was still booting after 20 s')
    expect(r.fix).toMatch(/retry with target emulator-5554/)
  })

  it('with nothing that can run the app, stops at the doctor with its fix and the report attached', async () => {
    const r = await openApp(req(), simHost({ devices: [] }))
    expect(step(r, 'doctor')?.status).toBe('fail')
    expect(r.fix).toMatch(/avdmanager create avd/)
    expect(r.doctor?.ready).toBe(false)
    expect(spawned).toEqual([])
  })

  it.each([
    ['an unknown name', 'Nope', /no device or virtual device named Nope/],
    ['an incompatible device', 'OLD', /Pick another device/],
    ['an unauthorized device', 'UNAUTH', /Allow USB debugging/]
  ])('a target naming %s is refused before anything runs', async (_what, target, fix) => {
    const sim: Sim = { devices: [{ serial: 'OLD', api: 21 }, { serial: 'UNAUTH', state: 'unauthorized' }] }
    const r = await openApp(req({ target }), simHost(sim))
    expect(r.fix).toMatch(fix)
    expect(adbCalls().some((c) => c.includes('install')), 'no install').toBe(false)
  })

  it('refuses names that are not Android names before calling adb (they end up in a device shell line)', async () => {
    const h = simHost({ devices: [{ serial: 'R58M', api: 34 }] })
    await expect(openApp(req({ grant: ["x'; reboot; '"] }), h)).rejects.toThrow(/not a permission name/)
    await expect(openApp(req({ activity: 'a.B;reboot' }), h)).rejects.toThrow(/not an activity class name/)
    await expect(openApp(req({ apk: apk({ package: 'x y' }) }), h)).rejects.toThrow(/not an Android package name/)
    await expect(openApp(req({ target: '-s' }), h)).rejects.toThrow(/not an adb serial/)
    expect(calls).toEqual([])
  })

  it('a cancelled call stops before the next step', async () => {
    const stop = new AbortController()
    const r = openApp(req({ signal: stop.signal, onStep: (id) => id === 'install' && stop.abort(new Error('cancelled by test')) }), simHost({ devices: [{ serial: 'R58M', api: 34 }] }))
    await expect(r).rejects.toThrow('cancelled by test')
    expect(adbCalls().some((c) => c.includes('pm grant')), 'nothing after the abort').toBe(false)
  })
})

describe('openApp device settings (roadmap M2b)', () => {
  const ALL_SET: DeviceSettings = { locale: 'es-419', dark_mode: true, font_scale: 1.3, animations: false, network: true }

  it('on a virtual device applies the test defaults (animations off, light theme, font scale 1, en-US, network on) after granting and before launch', async () => {
    avd('Pixel_API_36', 36)
    const r = await openApp(req(), simHost({ devices: [{ serial: 'emulator-5554', api: 36, avd: 'Pixel_API_36' }] }))
    expect(r.ok, JSON.stringify(r.steps)).toBe(true)
    const sent = adbCalls().filter((c) => /shell (settings|cmd|pm grant|am start)/.test(c))
    expect(sent, 'grant, then settings in a fixed order, then launch').toEqual([
      "emulator-5554 shell pm grant 'dev.nawi.sample' 'android.permission.CAMERA'",
      'emulator-5554 shell settings put global window_animation_scale 0 && settings put global transition_animation_scale 0 && settings put global animator_duration_scale 0',
      'emulator-5554 shell cmd uimode night no',
      'emulator-5554 shell settings put system font_scale 1',
      "emulator-5554 shell cmd locale set-app-locales 'dev.nawi.sample' --locales 'en-US'",
      'emulator-5554 shell cmd connectivity airplane-mode disable',
      "emulator-5554 shell am start -W -n 'dev.nawi.sample/dev.nawi.sample.MainActivity'"
    ])
    expect(r.settings).toEqual({ requested: defaultDeviceSettings('avd'), applied: ['animations', 'dark_mode', 'font_scale', 'locale', 'network'], not_applied: [] })
    expect(step(r, 'settings')).toEqual({ id: 'settings', status: 'ok', summary: 'animations off, dark mode off, font scale 1, locale en-US, airplane mode off', fix: null })
  })

  it('never applies settings meant for a virtual device to a physical phone (a profile saved on an AVD, run with --target <phone>)', async () => {
    const r = await openApp(req({ settings: defaultDeviceSettings('avd') }), simHost({ devices: [{ serial: 'R58M', api: 34 }] }))
    expect(r.ok).toBe(true)
    expect(adbCalls().filter((c) => /shell (settings|cmd)/.test(c)), 'no setting command reaches the phone').toEqual([])
    expect(step(r, 'settings')).toMatchObject({ status: 'skipped', summary: "the profile's device settings are for a virtual device; R58M is a physical device and is left as it is" })
    expect(r.settings.requested, 'nothing was requested of the phone').toBeNull()
  })

  it('leaves out of the virtual-device defaults what an older Android lacks, so a default open does not warn', async () => {
    avd('Pixel_API_30', 30)
    const r = await openApp(req(), simHost({ devices: [{ serial: 'emulator-5554', api: 30, avd: 'Pixel_API_30' }] }))
    expect(r.settings).toEqual({ requested: { locale: null, dark_mode: false, font_scale: 1, animations: false, network: true }, applied: ['animations', 'dark_mode', 'font_scale', 'network'], not_applied: [] })
    expect(step(r, 'settings')?.status, 'API 30: no per-app locale, and no warning for it').toBe('ok')
  })

  it('applies a physical phone\'s settings only when asked, and settings: null leaves even a virtual device alone', async () => {
    const asked = await openApp(req({ settings: { ...KEEP_DEVICE_SETTINGS, dark_mode: true }, settingsOnPhone: true }), simHost({ devices: [{ serial: 'R58M', api: 34 }] }))
    expect(adbCalls().filter((c) => /shell (settings|cmd)/.test(c)), 'only the one setting the profile asks for').toEqual(['R58M shell cmd uimode night yes'])
    expect(asked.settings.applied).toEqual(['dark_mode'])
    expect(step(asked, 'settings')?.summary).toBe('dark mode on')

    calls = []
    avd('Pixel_API_36', 36)
    const left = await openApp(req({ settings: null }), simHost({ devices: [{ serial: 'emulator-5554', api: 36, avd: 'Pixel_API_36' }] }))
    expect(adbCalls().filter((c) => /shell (settings|cmd)/.test(c)), 'settings: null sends no setting command').toEqual([])
    expect(step(left, 'settings')).toMatchObject({ status: 'skipped', summary: 'no device settings to apply (the device is left as it is)' })
    expect(left.settings.requested).toBeNull()
  })

  it('never turns airplane mode on over a network adb connection (it would cut adb), and still launches', async () => {
    const serial = '192.168.1.20:5555'
    const r = await openApp(req({ settings: { ...KEEP_DEVICE_SETTINGS, font_scale: 1, network: false }, settingsOnPhone: true }), simHost({ devices: [{ serial, api: 34 }] }))
    expect(r.ok, JSON.stringify(r.steps)).toBe(true)
    expect(adbCalls().filter((c) => /shell (settings|cmd)/.test(c)), 'no airplane-mode command reaches a wireless-adb phone').toEqual([`${serial} shell settings put system font_scale 1`])
    expect(r.settings.applied).toEqual(['font_scale'])
    expect(r.settings.not_applied).toEqual([{ name: 'network', reason: `adb reaches ${serial} over the network, and airplane mode would cut that connection` }])
    expect(step(r, 'settings')?.status).toBe('warn')

    calls = []
    const on = await openApp(req({ settings: { ...KEEP_DEVICE_SETTINGS, network: true }, settingsOnPhone: true }), simHost({ devices: [{ serial, api: 34 }] }))
    expect(adbCalls().filter((c) => /shell (settings|cmd)/.test(c)), 'turning airplane mode off is safe over the network').toEqual([`${serial} shell cmd connectivity airplane-mode disable`])
    expect(on.settings.applied).toEqual(['network'])
  })

  it('skips a setting the device\'s Android version lacks with the version it needs, as a warning, and still launches', async () => {
    const r = await openApp(req({ settings: ALL_SET, settingsOnPhone: true }), simHost({ devices: [{ serial: 'R58M', api: 28 }] }))
    expect(r.ok, 'missing settings do not stop the launch').toBe(true)
    expect(adbCalls().filter((c) => /shell (settings|cmd)/.test(c)), 'nothing sent for the settings API 28 lacks').toEqual([
      'R58M shell settings put global window_animation_scale 0 && settings put global transition_animation_scale 0 && settings put global animator_duration_scale 0',
      'R58M shell settings put system font_scale 1.3'
    ])
    expect(r.settings.applied).toEqual(['animations', 'font_scale'])
    expect(r.settings.not_applied, 'named by their profile keys').toEqual([
      { name: 'dark_mode', reason: 'needs Android 10 (API 29); R58M is API 28' },
      { name: 'locale', reason: 'needs Android 13 (API 33); R58M is API 28' },
      { name: 'network', reason: 'needs Android 11 (API 30); R58M is API 28' }
    ])
    expect(step(r, 'settings')?.status).toBe('warn')
    expect(step(r, 'settings')?.summary).toMatch(/^applied 2 of 5; not applied: dark mode on \(needs Android 10/)
    expect(step(r, 'settings')?.fix).toMatch(/set dark_mode, locale, network to null in the profile's device section/)
    expect(r.launched?.activity).toBe('dev.nawi.sample.MainActivity')
  })

  it.each([
    ['an exception printed with exit code 0', ok('Exception occurred while executing \'set-app-locales\':\njava.lang.IllegalArgumentException: Unknown package\n'), "Exception occurred while executing 'set-app-locales':"],
    ['a missing service', ok("cmd: Can't find service: locale\n"), "cmd: Can't find service: locale"],
    // What API 36 prints (exit code 0) for a package it does not know.
    ['an unknown package', ok('Unknown package dev.nawi.sample for userId 0\n'), 'Unknown package dev.nawi.sample for userId 0'],
    ['a non-zero exit', failed('/system/bin/sh: cmd: inaccessible or not found'), '/system/bin/sh: cmd: inaccessible or not found'],
    ['a timeout', { code: null, stdout: '', stderr: '', error: 'timeout' } as ExecResult, 'the device did not answer']
  ])('reports a setting the device refuses (%s) as not applied, with what it said', async (_case, answer, reason) => {
    const r = await openApp(req({ settings: { ...KEEP_DEVICE_SETTINGS, locale: 'en-US' }, settingsOnPhone: true }), simHost({ devices: [{ serial: 'R58M', api: 34 }], setting: () => answer }))
    expect(r.ok).toBe(true)
    expect(r.settings.not_applied).toEqual([{ name: 'locale', reason }])
    expect(step(r, 'settings')?.status).toBe('warn')
  })

  it('a cancel while applying settings stops before the launch', async () => {
    const stop = new AbortController()
    const r = openApp(req({ settings: ALL_SET, settingsOnPhone: true, signal: stop.signal, onStep: (id) => id === 'settings' && stop.abort(new Error('cancelled by test')) }), simHost({ devices: [{ serial: 'R58M', api: 34 }] }))
    await expect(r).rejects.toThrow('cancelled by test')
    expect(adbCalls().some((c) => c.includes('am start') || /shell (settings|cmd)/.test(c)), 'no setting or launch after the abort').toBe(false)
  })
})

describe('openApp first screen (roadmap M2c)', () => {
  const phone = (): Sim => ({ devices: [{ serial: 'R58M', api: 34 }] })

  it('waits for the screen to settle, then names a permission prompt in front of the app with the button to tap', async () => {
    const delays: number[] = []
    const prompt = `<?xml version='1.0' ?><hierarchy rotation="0"><node package="com.google.android.permissioncontroller" bounds="[0,0][1080,2400]"><node resource-id="com.android.permissioncontroller:id/permission_message" text="Allow Sample to send you notifications?" package="com.google.android.permissioncontroller" bounds="[60,900][1020,1000]"/><node resource-id="com.android.permissioncontroller:id/permission_allow_button" text="Allow" class="android.widget.Button" clickable="true" enabled="true" package="com.google.android.permissioncontroller" bounds="[60,1100][1020,1200]"/></node></hierarchy>`
    const r = await openApp(req(), simHost({ ...phone(), dump: ok(prompt) }, { delay: async (ms) => void delays.push(ms) }))
    expect(r.ok, 'a blocker does not make the open fail').toBe(true)
    expect(r.fix).toBeNull()
    expect(delays, 'one settle delay before the dump').toEqual([FIRST_SCREEN_SETTLE_MS])
    expect(r.first_screen?.blockers.map((b) => [b.kind, b.tap])).toEqual([['permission_dialog', { resource_id: 'com.android.permissioncontroller:id/permission_allow_button' }]])
    expect(step(r, 'first_screen')).toEqual({
      id: 'first_screen',
      status: 'warn',
      summary: 'Android asks: "Allow Sample to send you notifications?"',
      fix: 'Tap "Allow" to go on, or grant that permission before launch (the profile\'s permissions.grant) so the prompt never shows.'
    })
  })

  it('lists every blocker in the summary, front-most first, and gives the first one\'s fix', async () => {
    const r = await openApp(
      req(),
      simHost({
        ...phone(),
        dump: ok(dumpXml('dev.nawi.sample', ['text="We use cookies"', 'text="Accept" clickable="true" bounds="[0,500][500,600]"', 'class="android.widget.EditText" password="true" bounds="[0,700][500,800]"']))
      })
    )
    expect(step(r, 'first_screen')).toMatchObject({ status: 'warn', summary: 'a consent screen ("Accept" button); also a sign-in form (password field)', fix: 'Tap "Accept" to accept it for this test device.' })
  })

  it('warns when another app is in front of the one it launched', async () => {
    const r = await openApp(req(), simHost({ ...phone(), dump: ok(dumpXml('com.google.android.apps.nexuslauncher')) }))
    expect(step(r, 'first_screen')).toMatchObject({ status: 'warn', summary: 'the screen shows com.google.android.apps.nexuslauncher, not dev.nawi.sample' })
    expect(r.ok, 'the launch itself succeeded').toBe(true)
  })

  it.each([
    ['uiautomator printing its idle error', ok('ERROR: could not get idle state.\n'), 'could not read the screen: uiautomator printed no screen: ERROR: could not get idle state.'],
    ['an image without uiautomator', failed('/system/bin/sh: uiautomator: inaccessible or not found'), 'could not read the screen: /system/bin/sh: uiautomator: inaccessible or not found'],
    ['a hung dump', { code: null, stdout: '', stderr: '', error: 'timeout' } as ExecResult, 'could not read the screen: uiautomator did not answer'],
    ['a dump cut at adb\'s output cap', { code: null, stdout: 'UI hierchary dumped to: x\n<hierarchy rotation="0"><node', stderr: '', error: 'timeout' } as ExecResult, 'could not read the screen: the dump is larger than 1 MB'],
    ['a cut-off dump', ok('<hierarchy rotation="0"><node package="dev.nawi.sample">'), 'could not read the screen: the screen dump is cut off (no closing </hierarchy>)']
  ])('skips the step on %s and still reports the app running', async (_what, dump, summary) => {
    const r = await openApp(req(), simHost({ ...phone(), dump }))
    expect(r.ok).toBe(true)
    expect(r.first_screen).toBeNull()
    expect(step(r, 'first_screen')).toEqual({ id: 'first_screen', status: 'skipped', summary, fix: null })
  })

  it('a cancel while the screen settles keeps the running app\'s result and reads nothing', async () => {
    const stop = new AbortController()
    const r = await openApp(req({ signal: stop.signal, onStep: (id) => id === 'first_screen' && stop.abort(new Error('cancelled by test')) }), simHost(phone()))
    expect(r.ok).toBe(true)
    expect(step(r, 'first_screen')).toEqual({ id: 'first_screen', status: 'skipped', summary: 'cancelled before the screen was read', fix: null })
    expect(adbCalls().some((c) => c.includes('uiautomator')), 'no dump after the cancel').toBe(false)
  })

  it('reads nothing when the launch failed', async () => {
    const r = await openApp(req(), simHost({ ...phone(), pidof: ok('') }))
    expect(r.ok).toBe(false)
    expect(step(r, 'first_screen')).toBeUndefined()
    expect(adbCalls().some((c) => c.includes('uiautomator'))).toBe(false)
  })
})

describe('open helpers', () => {
  it('shQuote makes any text one literal argument for sh', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
    expect(shQuote('$HOME;x')).toBe(`'$HOME;x'`)
  })

  it('freeEmulatorPort skips ports (and their adb port) used by running emulators', () => {
    expect(freeEmulatorPort([])).toBe(5554)
    expect(freeEmulatorPort(['emulator-5554', 'R58M', 'emulator-5558'])).toBe(5556)
    expect(freeEmulatorPort(['emulator-5555']), 'console 5555 means adb 5556 is taken').toBe(5558)
  })

  it('parseAmStart reads TotalTime, and the first error line', () => {
    expect(parseAmStart('Status: ok\nTotalTime: 77\n', '')).toEqual({ ok: true, totalTimeMs: 77 })
    expect(parseAmStart('Status: ok\n', '')).toEqual({ ok: true, totalTimeMs: null })
    expect(parseAmStart('Starting: Intent\n', 'Error: Activity not started, unable to resolve Intent')).toEqual({ ok: false, error: 'Error: Activity not started, unable to resolve Intent' })
  })

  it('runtimePermissionsFor drops install-time ones and those capped below the API level', () => {
    expect(runtimePermissionsFor(apk(), 32)).toEqual(['android.permission.CAMERA', 'android.permission.READ_EXTERNAL_STORAGE'])
    expect(runtimePermissionsFor(apk(), 33)).toEqual(['android.permission.CAMERA'])
  })

  it('installFix falls back to the command that prints the full message', () => {
    expect(installFix('INSTALL_FAILED_X', 'a.b', 'S', '/f.apk')).toBe('adb could not install the app (INSTALL_FAILED_X): run `adb -s S install -r -t /f.apk` in a terminal for the full message.')
  })
})

describe('openApp onboarding taps (roadmap M2c part 2)', () => {
  const phone = (): Partial<Sim> => ({ devices: [{ serial: 'R58M', api: 34 }] })
  const PROMPT = 'com.google.android.permissioncontroller'
  const intro = dumpXml('dev.nawi.sample', ['text="Welcome"', 'text="Skip" class="android.widget.Button" clickable="true" bounds="[800,2200][1000,2300]"'])
  const prompt = `<hierarchy rotation="0"><node package="${PROMPT}" bounds="[0,0][1080,2400]"><node resource-id="com.android.permissioncontroller:id/permission_message" text="Allow Sample to take pictures?" package="${PROMPT}" enabled="true" bounds="[60,900][1020,1000]"/><node resource-id="com.android.permissioncontroller:id/permission_allow_foreground_only_button" text="While using the app" class="android.widget.Button" clickable="true" enabled="true" package="${PROMPT}" bounds="[60,1100][1020,1200]"/></node></hierarchy>`
  const home = dumpXml('dev.nawi.sample', ['text="Your albums" class="android.widget.TextView" bounds="[0,100][1080,200]"'])
  const skipTap = { when: 'intro' as const, tap: { text: 'Skip' } }
  const allowTap = { when: 'permission_dialog' as const, tap: { resource_id: 'com.android.permissioncontroller:id/permission_allow_foreground_only_button' } }
  const taps = () => adbCalls().filter((c) => c.includes('input tap'))
  const order = (r: MobileOpenResult) => r.steps.map((s) => `${s.id}:${s.status}`).slice(-3)

  it('replays the saved taps in the order the screens come, re-reading the screen after each, and reports a clear screen', async () => {
    const announced: string[] = []
    const r = await openApp(req({ onboarding: [allowTap, skipTap], onStep: (id) => announced.push(id) }), simHost({ ...phone(), dumps: [ok(intro), ok(prompt), ok(home)] } as Sim))
    expect(taps(), 'Skip at its center, then the prompt\'s allow button at its center').toEqual(['R58M shell input tap 900 2250', 'R58M shell input tap 540 1150'])
    expect(r.onboarding?.tapped).toEqual([
      { ...skipTap, label: 'Skip', learned: false },
      { ...allowTap, label: 'While using the app', learned: false }
    ])
    expect(step(r, 'onboarding')).toEqual({ id: 'onboarding', status: 'ok', summary: 'tapped 2: intro "Skip", permission dialog "While using the app"', fix: null })
    expect(r.first_screen, 'what is left after the taps: the app itself').toEqual({ package: 'dev.nawi.sample', blockers: [] })
    expect(order(r)).toEqual(['launch:ok', 'onboarding:ok', 'first_screen:ok'])
    expect(announced.slice(-2), 'steps announced in the order they are reported').toEqual(['onboarding', 'first_screen'])
    expect(adbCalls().filter((c) => c.includes('uiautomator')), 'one read per screen').toHaveLength(3)
  })

  it('without learn mode taps only saved taps and leaves the rest to first_screen', async () => {
    const r = await openApp(req({ onboarding: [skipTap] }), simHost({ ...phone(), dumps: [ok(prompt)] } as Sim))
    expect(taps()).toEqual([])
    expect(step(r, 'onboarding')).toMatchObject({ status: 'skipped', summary: 'none of the saved taps is on the screen' })
    expect(r.first_screen?.blockers.map((b) => b.kind), 'the prompt is still reported').toEqual(['permission_dialog'])
    expect(step(r, 'first_screen')?.status).toBe('warn')
  })

  it('learn mode taps what it recognises and marks those taps learned, so the caller can save them', async () => {
    const r = await openApp(req({ learnOnboarding: true }), simHost({ ...phone(), dumps: [ok(intro), ok(prompt), ok(home)] } as Sim))
    expect(r.onboarding?.tapped.map((t) => [t.when, t.tap, t.learned])).toEqual([
      ['intro', { text: 'Skip' }, true],
      ['permission_dialog', allowTap.tap, true]
    ])
    expect(step(r, 'onboarding')?.summary).toBe('tapped 2: intro "Skip" (learned), permission dialog "While using the app" (learned)')
  })

  it('stops with a warning when a tap changes nothing, without tapping it again', async () => {
    const r = await openApp(req({ onboarding: [skipTap] }), simHost({ ...phone(), dumps: [ok(intro)] } as Sim))
    expect(taps(), 'one tap, not a loop').toHaveLength(1)
    expect(step(r, 'onboarding')).toMatchObject({ status: 'warn', summary: 'tapped 1: intro "Skip"; the screen did not change after tapping "Skip"' })
    expect(r.ok).toBe(true)
  })

  it('does not report a learned tap that changed nothing, so it is never saved', async () => {
    const r = await openApp(req({ learnOnboarding: true }), simHost({ ...phone(), dumps: [ok(intro)] } as Sim))
    expect(taps()).toHaveLength(1)
    expect(r.onboarding?.tapped).toEqual([])
    expect(step(r, 'onboarding')).toMatchObject({ status: 'warn', summary: 'the screen did not change after tapping "Skip" (not saved)' })
  })

  it('gives up after 10 taps on a screen that keeps coming back', async () => {
    let n = 0
    const pages = () => ok(dumpXml('dev.nawi.sample', [`text="Page ${++n}"`, 'text="Skip" class="android.widget.Button" clickable="true" bounds="[0,0][100,100]"']))
    const host = simHost({ ...phone(), dumps: Array.from({ length: 20 }, pages) } as Sim)
    const r = await openApp(req({ onboarding: [skipTap] }), host)
    expect(taps()).toHaveLength(10)
    expect(step(r, 'onboarding')).toMatchObject({ status: 'warn' })
    expect(step(r, 'onboarding')?.summary).toMatch(/stopped after 10 taps$/)
  })

  it('a failed tap is a warning with a fix, and nothing else is tapped', async () => {
    const r = await openApp(req({ onboarding: [skipTap, allowTap] }), simHost({ ...phone(), dumps: [ok(intro), ok(prompt)], tap: () => failed('java.lang.SecurityException: Injecting input events requires the caller to have INJECT_EVENTS') } as Sim))
    expect(taps()).toHaveLength(1)
    expect(step(r, 'onboarding')).toMatchObject({ status: 'warn', fix: 'Tap "Skip" on the device by hand.' })
    expect(r.onboarding?.tapped).toEqual([])
  })

  it('makes no tap when the screen can\'t be read', async () => {
    const r = await openApp(req({ onboarding: [skipTap] }), simHost({ ...phone(), dumps: [failed('/system/bin/sh: uiautomator: inaccessible or not found')] } as Sim))
    expect(taps()).toEqual([])
    expect(step(r, 'onboarding')).toMatchObject({ status: 'skipped', summary: 'no tap made: could not read the screen: /system/bin/sh: uiautomator: inaccessible or not found' })
    expect(step(r, 'first_screen')?.status).toBe('skipped')
  })

  it('a cancel after a tap keeps the running app\'s result and taps nothing more', async () => {
    const stop = new AbortController()
    const host = simHost({ ...phone(), dumps: [ok(intro), ok(prompt), ok(home)], tap: () => (stop.abort(new Error('cancelled by test')), ok()) } as Sim)
    const r = await openApp(req({ onboarding: [skipTap, allowTap], signal: stop.signal }), host)
    expect(r.ok).toBe(true)
    expect(taps()).toHaveLength(1)
    expect(step(r, 'onboarding')).toMatchObject({ status: 'ok', summary: 'tapped 1: intro "Skip"; cancelled' })
    expect(step(r, 'first_screen'), 'no stale pre-tap screen').toEqual({ id: 'first_screen', status: 'skipped', summary: 'cancelled before the screen was read again', fix: null })
  })

  it('reports the step as skipped when there is nothing to replay', async () => {
    const r = await openApp(req(), simHost({ ...phone() } as Sim))
    expect(step(r, 'onboarding')).toEqual({ id: 'onboarding', status: 'skipped', summary: 'no onboarding taps to replay (none saved in a profile)', fix: null })
    expect(r.onboarding).toBeNull()
    expect(taps()).toEqual([])
  })
})
