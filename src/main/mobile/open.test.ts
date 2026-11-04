import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApkInfo } from './apk'
import { detectFramework } from './framework'
import type { ExecResult } from './doctor'
import {
  BOOT_POLL_MS,
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
      "R58M shell pidof 'dev.nawi.sample'"
    ])
    expect(r.permissions, 'READ_EXTERNAL_STORAGE has maxSdkVersion 32 < API 34, so it is not granted').toEqual({ granted: ['android.permission.CAMERA'], not_granted: [] })
    expect(r.launched).toEqual({ activity: 'dev.nawi.sample.MainActivity', total_time_ms: 412, pid: 4242 })
    expect(r.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['doctor:ok', 'boot:skipped', 'install:ok', 'grant:ok', 'launch:ok'])
    expect(spawned, 'nothing booted when a device is connected').toEqual([])
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
