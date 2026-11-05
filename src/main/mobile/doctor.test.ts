import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApkInfo } from './apk'
import { detectFramework } from './framework'
import {
  abisForImage,
  compatibility,
  defaultHost,
  parseAdbDevices,
  parseIni,
  runMobileDoctor,
  type DoctorHost,
  type Exec,
  type ExecResult,
  type MobileDoctorReport
} from './doctor'

/**
 * mobile doctor (roadmap M1b) against SDK, AVD and /dev/kvm layouts built in a temp folder, with adb and the emulator
 * faked: the report a person or agent gets, and that every broken setup ends in one specific fix. Never the real
 * machine's SDK, devices or home.
 */

let root: string
let home: string
let calls: string[][]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nawi-doctor-'))
  home = join(root, 'home')
  mkdirSync(home)
  calls = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function executable(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, 0o755)
  return path
}

/** An SDK with platform-tools/adb, optionally the emulator and system images. */
function sdk(dir = join(root, 'sdk'), opts: { emulator?: boolean; images?: string[] } = {}): string {
  executable(join(dir, 'platform-tools', 'adb'))
  if (opts.emulator ?? true) executable(join(dir, 'emulator', 'emulator'))
  for (const image of opts.images ?? []) mkdirSync(join(dir, image), { recursive: true })
  return dir
}

/** An AVD as avdmanager writes it: <home>/.android/avd/<name>.ini pointing at <name>.avd/config.ini. */
function avd(name: string, config: { api: number; abi: string; tag?: string }, avdHome = join(home, '.android', 'avd')): string {
  const dir = join(avdHome, `${name}.avd`)
  mkdirSync(dir, { recursive: true })
  const tag = config.tag ?? 'google_apis'
  writeFileSync(join(avdHome, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=avd/${name}.avd\ntarget=android-${config.api}\n`)
  writeFileSync(
    join(dir, 'config.ini'),
    `# written by avdmanager\nPlayStore.enabled=no\nabi.type=${config.abi}\nhw.cpu.arch=${config.abi}\nimage.sysdir.1=system-images/android-${config.api}/${tag}/${config.abi}/\ntag.id=${tag}\n`
  )
  return `system-images/android-${config.api}/${tag}/${config.abi}`
}

function kvm(mode: number | null): string {
  const path = join(root, 'kvm')
  if (mode !== null) {
    writeFileSync(path, '')
    chmodSync(path, mode)
  }
  return path
}

interface FakeDevice {
  serial: string
  state?: string
  model?: string
  api?: number
  abis?: string[]
}

/** adb and the emulator, answering from a device table. */
function fakeExec(devices: FakeDevice[] = [], over: { version?: ExecResult; devices?: ExecResult; accel?: ExecResult } = {}): Exec {
  return async (file, args) => {
    calls.push([file, ...args])
    if (file.endsWith('emulator')) return over.accel ?? { code: 0, stdout: 'accel:\n0\nHVF is installed and usable.\naccel\n', stderr: '' }
    if (args[0] === 'version') return over.version ?? { code: 0, stdout: 'Android Debug Bridge version 1.0.41\nVersion 37.0.1-15733141\n', stderr: '' }
    if (args[0] === 'devices') {
      if (over.devices) return over.devices
      const lines = devices.map((d) => `${d.serial}\t${d.state ?? 'device'}${d.model ? ` product:x model:${d.model} transport_id:1` : ''}`)
      return { code: 0, stdout: `List of devices attached\n${lines.join('\n')}\n\n`, stderr: '' }
    }
    if (args[0] === '-s' && args[2] === 'shell') {
      const d = devices.find((x) => x.serial === args[1])
      if (!d) return { code: 1, stdout: '', stderr: `adb: device '${args[1]}' not found`, error: 'failed' }
      return { code: 0, stdout: `${d.api ?? ''}\n${(d.abis ?? []).join(',')}\n`, stderr: '' }
    }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}`, error: 'failed' }
  }
}

function host(over: Partial<DoctorHost> = {}): DoctorHost {
  return { env: {}, platform: 'linux', arch: 'x64', home, exec: fakeExec(), ...over, kvmPath: over.kvmPath ?? kvm(0o600) }
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
  permissions: [],
  deep_links: [],
  exported_components: [],
  framework: detectFramework([], true),
  unresolved: [],
  ...over
})

const check = (r: MobileDoctorReport, id: string) => r.checks.find((c) => c.id === id)

describe('runMobileDoctor: finding the SDK and adb', () => {
  it('with nothing installed, says to install platform-tools and set ANDROID_HOME, and runs nothing', async () => {
    const r = await runMobileDoctor(null, host({ env: { PATH: join(root, 'empty') } }))
    expect(r.ready, 'ready with no SDK').toBe(false)
    expect(r.fix, 'fix with no SDK').toMatch(/sdkmanager "platform-tools".*ANDROID_HOME/)
    expect(check(r, 'sdk')?.status).toBe('fail')
    expect(calls, 'processes started with no adb found').toEqual([])
  })

  it('names an ANDROID_HOME that has no adb in it as the thing to fix', async () => {
    const wrong = join(root, 'not-an-sdk')
    mkdirSync(wrong)
    const r = await runMobileDoctor(null, host({ env: { ANDROID_HOME: wrong } }))
    expect(r.fix, 'fix for a wrong ANDROID_HOME').toContain(`ANDROID_HOME is ${wrong} but there is no platform-tools/adb in it`)
  })

  it.each([
    ['ANDROID_HOME', (dir: string) => ({ ANDROID_HOME: dir })],
    ['ANDROID_SDK_ROOT', (dir: string) => ({ ANDROID_SDK_ROOT: dir })],
    ['adb on PATH', (dir: string) => ({ PATH: `${join(root, 'empty')}:${join(dir, 'platform-tools')}` })]
  ])('finds the SDK through %s', async (source, env) => {
    const dir = sdk()
    const r = await runMobileDoctor(null, host({ env: env(dir) }))
    expect(r.sdk, `sdk found via ${source}`).toEqual({ path: dir, source })
    expect(r.adb).toEqual({ path: join(dir, 'platform-tools', 'adb'), version: '1.0.41' })
    expect(r.emulator).toEqual({ path: join(dir, 'emulator', 'emulator') })
  })

  it('finds the default install folder (macOS ~/Library/Android/sdk) with no variables set', async () => {
    const dir = sdk(join(home, 'Library', 'Android', 'sdk'))
    const r = await runMobileDoctor(null, host({ platform: 'darwin' }))
    expect(r.sdk).toEqual({ path: dir, source: 'default location' })
  })

  it('a distro adb outside any SDK works for phones but warns that the emulator cannot be found', async () => {
    executable(join(root, 'usr-bin', 'adb'))
    const r = await runMobileDoctor(null, host({ env: { PATH: join(root, 'usr-bin') }, exec: fakeExec([{ serial: 'R58M', model: 'Pixel_8', api: 35, abis: ['arm64-v8a'] }]) }))
    expect(r.sdk).toBeNull()
    expect(check(r, 'sdk')?.status).toBe('warn')
    expect(r.recommended, 'a connected phone is enough').toEqual({ kind: 'device', name: 'R58M' })
  })

  it.each([
    ['times out', { code: null, stdout: '', stderr: '', error: 'timeout' as const }, /did not answer/],
    ['crashes', { code: 1, stdout: '', stderr: 'error while loading shared libraries: libc++.so', error: 'failed' as const }, /libc\+\+\.so.*sdkmanager "platform-tools"/]
  ])('an adb that %s gets the reinstall fix with what it said', async (_what, version, fix) => {
    const r = await runMobileDoctor(null, host({ env: { ANDROID_HOME: sdk() }, exec: fakeExec([], { version }) }))
    expect(r.ready).toBe(false)
    expect(r.fix).toMatch(fix)
  })
})

describe('runMobileDoctor: devices', () => {
  it('recommends a connected device that can run the app, with its API level and ABIs read over adb', async () => {
    const exec = fakeExec([{ serial: 'emulator-5554', model: 'sdk_gphone64_x86_64', api: 36, abis: ['x86_64', 'x86'] }])
    const r = await runMobileDoctor(apk(), host({ env: { ANDROID_HOME: sdk() }, exec }))
    expect(r.ready).toBe(true)
    expect(r.fix, 'fix when ready').toBeNull()
    expect(r.recommended).toEqual({ kind: 'device', name: 'emulator-5554' })
    expect(r.devices[0], 'device row').toMatchObject({ emulator: true, api: 36, abis: ['x86_64', 'x86'], model: 'sdk gphone64 x86 64', compatible: { ok: true, reason: null } })
  })

  it('skips a device whose API level is below the app\'s min SDK and says why', async () => {
    const exec = fakeExec([{ serial: 'OLD1', api: 23, abis: ['arm64-v8a'] }])
    const r = await runMobileDoctor(apk({ min_sdk: 26 }), host({ env: { ANDROID_HOME: sdk() }, exec }))
    expect(r.devices[0]?.compatible).toEqual({ ok: false, reason: "API 23 is below the app's min SDK 26" })
    expect(r.recommended, 'no AVDs either').toBeNull()
    expect(r.fix, 'next step: create a matching virtual device').toMatch(/system-images;android-35;google_apis;x86_64/)
  })

  it('an unauthorized phone gets "accept the USB debugging prompt" ahead of any other fix', async () => {
    const exec = fakeExec([{ serial: 'R58M', state: 'unauthorized', model: 'Galaxy_S24' }])
    const r = await runMobileDoctor(apk(), host({ env: { ANDROID_HOME: sdk() }, exec }))
    expect(r.ready).toBe(false)
    expect(r.fix).toBe('Unlock Galaxy S24 and accept "Allow USB debugging", then retry.')
    expect(calls.some((c) => c.includes('R58M')), 'getprop on an unauthorized device').toBe(false)
  })

  it('an adb server that hangs on `adb devices` gets the kill-server fix', async () => {
    const exec = fakeExec([], { devices: { code: null, stdout: '', stderr: '', error: 'timeout' } })
    const r = await runMobileDoctor(null, host({ env: { ANDROID_HOME: sdk() }, exec }))
    expect(check(r, 'devices')?.status).toBe('fail')
    expect(r.fix).toMatch(/adb kill-server/)
  })
})

describe('runMobileDoctor: virtual devices and virtualization', () => {
  it('recommends the newest AVD that matches the app when no device is connected', async () => {
    const images = [avd('old', { api: 24, abi: 'x86_64' }), avd('pixel-34', { api: 34, abi: 'x86_64' }), avd('pixel-36', { api: 36, abi: 'x86_64' })]
    const r = await runMobileDoctor(apk({ min_sdk: 26, abis: ['x86_64', 'arm64-v8a'] }), host({ env: { ANDROID_HOME: sdk(undefined, { images }) } }))
    expect(r.recommended).toEqual({ kind: 'avd', name: 'pixel-36' })
    expect(r.avds.map((a) => [a.name, a.api, a.abi, a.image_present, a.compatible?.ok])).toEqual([
      ['old', 24, 'x86_64', true, false],
      ['pixel-34', 34, 'x86_64', true, true],
      ['pixel-36', 36, 'x86_64', true, true]
    ])
    expect(r.avds[0]?.compatible?.reason).toBe("API 24 is below the app's min SDK 26")
  })

  it('reads AVDs from ANDROID_AVD_HOME when set', async () => {
    const avdHome = join(root, 'avds')
    const image = avd('custom', { api: 35, abi: 'x86_64' }, avdHome)
    const r = await runMobileDoctor(null, host({ env: { ANDROID_HOME: sdk(undefined, { images: [image] }), ANDROID_AVD_HOME: avdHome } }))
    expect(r.recommended).toEqual({ kind: 'avd', name: 'custom' })
  })

  it('an AVD whose system image was deleted is not recommended, and the fix says to reinstall it', async () => {
    avd('broken', { api: 35, abi: 'x86_64' })
    const r = await runMobileDoctor(apk(), host({ env: { ANDROID_HOME: sdk() } }))
    expect(r.avds[0]).toMatchObject({ image_present: false, compatible: { ok: false, reason: 'its system image is not installed' } })
    expect(r.fix).toMatch(/Reinstall the system image of broken/)
  })

  it('arm64 native code runs on an x86_64 Google APIs AVD from API 30 (translation), not on an older one', async () => {
    const images = [avd('pixel-29', { api: 29, abi: 'x86_64' }), avd('pixel-36', { api: 36, abi: 'x86_64' })]
    const r = await runMobileDoctor(apk({ min_sdk: 24, abis: ['arm64-v8a'] }), host({ env: { ANDROID_HOME: sdk(undefined, { images }) } }))
    expect(r.avds.map((a) => [a.name, a.compatible])).toEqual([
      ['pixel-29', { ok: false, reason: 'it runs x86_64, x86 and the app ships native code for arm64-v8a only' }],
      ['pixel-36', { ok: true, reason: null }]
    ])
    expect(r.recommended).toEqual({ kind: 'avd', name: 'pixel-36' })
  })

  it('32-bit-ARM-only native code on an x86_64 computer is pointed at a phone, not at another AVD', async () => {
    const image = avd('pixel-36', { api: 36, abi: 'x86_64' })
    const r = await runMobileDoctor(apk({ abis: ['armeabi-v7a'] }), host({ env: { ANDROID_HOME: sdk(undefined, { images: [image] }) } }))
    expect(r.avds[0]?.compatible?.reason).toMatch(/app ships native code for armeabi-v7a only/)
    expect(r.ready).toBe(false)
    expect(r.fix).toMatch(/armeabi-v7a only.*connect a phone/)
  })

  it('on an ARM computer the same app gets an arm64-v8a virtual device to create', async () => {
    const r = await runMobileDoctor(apk({ abis: ['arm64-v8a'] }), host({ env: { ANDROID_HOME: sdk() }, arch: 'arm64' }))
    expect(r.fix).toMatch(/sdkmanager "system-images;android-35;google_apis;arm64-v8a".*avdmanager create avd -n nawi-api35/)
  })

  it.each([
    ['missing', null, 'unavailable', /BIOS\/UEFI.*modprobe/],
    ['not openable by this user', 0o000, 'no_permission', /usermod -aG kvm/]
  ])('Linux with /dev/kvm %s: the AVD is not bootable and the fix is about KVM', async (_what, mode, status, fix) => {
    const image = avd('pixel-36', { api: 36, abi: 'x86_64' })
    const r = await runMobileDoctor(null, host({ env: { ANDROID_HOME: sdk(undefined, { images: [image] }) }, kvmPath: kvm(mode) }))
    expect(r.virtualization.status).toBe(status)
    expect(r.recommended, 'an AVD that cannot boot').toBeNull()
    expect(r.fix).toMatch(fix)
  })

  it('outside Linux asks the emulator (-accel-check) and reports what it said', async () => {
    const accel = { code: 1, stdout: 'accel:\n1\nWHPX is not installed or not usable.\naccel\n', stderr: '', error: 'failed' as const }
    const r = await runMobileDoctor(null, host({ platform: 'darwin', env: { ANDROID_HOME: sdk() }, exec: fakeExec([], { accel }) }))
    expect(r.virtualization).toEqual({ status: 'unavailable', detail: 'WHPX is not installed or not usable.' })
    expect(calls.some((c) => c[0]?.endsWith('emulator') && c[1] === '-accel-check')).toBe(true)
  })

  it('with no emulator and no device, the fix is to install the emulator', async () => {
    const r = await runMobileDoctor(apk(), host({ env: { ANDROID_HOME: sdk(undefined, { emulator: false }) } }))
    expect(check(r, 'emulator')?.status).toBe('warn')
    expect(r.fix).toMatch(/sdkmanager "emulator"/)
  })

  it('with everything working but no AVD, the fix creates one for the app\'s target SDK', async () => {
    const r = await runMobileDoctor(apk({ min_sdk: 28, target_sdk: 34 }), host({ env: { ANDROID_HOME: sdk() } }))
    expect(r.fix).toBe(
      'Create a virtual device: `sdkmanager "system-images;android-34;google_apis;x86_64"` then `avdmanager create avd -n nawi-api34 -k "system-images;android-34;google_apis;x86_64" -d pixel_6` (both in the SDK\'s cmdline-tools/latest/bin).'
    )
  })
})

describe('runMobileDoctor: review findings (each a wrong answer before)', () => {
  it('an -accel-check that hangs gets "run it yourself", not "create an AVD" the user already has', async () => {
    const image = avd('pixel-36', { api: 36, abi: 'x86_64' })
    const accel = { code: null, stdout: '', stderr: '', error: 'timeout' as const }
    const r = await runMobileDoctor(null, host({ platform: 'darwin', env: { ANDROID_HOME: sdk(undefined, { images: [image] }) }, exec: fakeExec([], { accel }) }))
    expect(check(r, 'virtualization')?.status).toBe('warn')
    expect(r.fix).toMatch(/emulator -accel-check` in a terminal/)
  })

  it('an arm64 AVD on an x86_64 computer is never recommended', async () => {
    const image = avd('mac-copy', { api: 35, abi: 'arm64-v8a' })
    const r = await runMobileDoctor(null, host({ env: { ANDROID_HOME: sdk(undefined, { images: [image] }) } }))
    expect(r.avds[0]?.compatible).toEqual({ ok: false, reason: "its arm64-v8a image can't run on this computer's CPU" })
    expect(r.recommended).toBeNull()
    expect(r.fix).toMatch(/system-images;android-36;google_apis;x86_64/)
  })

  it('x86-only native code does not match an API 30+ x86_64 image (64-bit only)', async () => {
    const image = avd('pixel-36', { api: 36, abi: 'x86_64' })
    const r = await runMobileDoctor(apk({ abis: ['x86'] }), host({ env: { ANDROID_HOME: sdk(undefined, { images: [image] }) } }))
    expect(r.avds[0]?.compatible?.ok, 'x86 app on an API 36 x86_64 image').toBe(false)
  })

  it('an arm64-only app targeting API 29 gets an API 30 image to create (translation), not the phone fix', async () => {
    const r = await runMobileDoctor(apk({ min_sdk: 24, target_sdk: 29, abis: ['arm64-v8a'] }), host({ env: { ANDROID_HOME: sdk() } }))
    expect(r.fix).toMatch(/system-images;android-30;google_apis;x86_64/)
  })

  it('a phone Linux has no USB permission for gets the udev fix', async () => {
    const out = 'List of devices attached\nR58M\tno permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:1-1 transport_id:3\n'
    const r = await runMobileDoctor(apk(), host({ env: { ANDROID_HOME: sdk() }, exec: fakeExec([], { devices: { code: 0, stdout: out, stderr: '' } }) }))
    expect(r.devices[0]?.state).toBe('no permissions')
    expect(check(r, 'devices')?.status).toBe('warn')
    expect(r.fix).toMatch(/udev rules.*replug/)
  })

  it('a connected device that cannot run the app is a warning, not "skipped"', async () => {
    const r = await runMobileDoctor(apk({ min_sdk: 31 }), host({ env: { ANDROID_HOME: sdk() }, exec: fakeExec([{ serial: 'OLD1', api: 26, abis: ['arm64-v8a'] }]) }))
    expect(check(r, 'devices')?.status).toBe('warn')
  })

  it('"reinstall the system image" only names an AVD that would run the app', async () => {
    avd('old-21', { api: 21, abi: 'x86_64' })
    const present = avd('pixel-28', { api: 28, abi: 'x86_64' })
    const r = await runMobileDoctor(apk({ min_sdk: 30, target_sdk: 34 }), host({ env: { ANDROID_HOME: sdk(undefined, { images: [present] }) } }))
    expect(r.avds.find((a) => a.name === 'old-21')?.compatible?.reason, 'API reason wins over the missing image').toMatch(/below the app's min SDK 30/)
    expect(r.fix).toMatch(/Create a virtual device: `sdkmanager "system-images;android-34/)
  })

  it('a distro adb with no SDK is told to install the SDK, not to run sdkmanager', async () => {
    executable(join(root, 'usr-bin', 'adb'))
    const r = await runMobileDoctor(apk(), host({ env: { PATH: join(root, 'usr-bin') } }))
    expect(r.fix).toMatch(/is not part of an Android SDK, so there is no emulator: install the SDK/)
  })
})

describe('doctor parsers', () => {
  it('parseAdbDevices reads serial, state and model, skipping the header and daemon chatter', () => {
    const out = '* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\nemulator-5554          device product:sdk_gphone64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\nR58M\tunauthorized usb:1-1 transport_id:2\n\n'
    expect(parseAdbDevices(out)).toEqual([
      { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 x86 64' },
      { serial: 'R58M', state: 'unauthorized', model: null }
    ])
  })

  it('parseIni keeps the last value per key and ignores comments', () => {
    expect(parseIni('# c\na=1\n\nb = two words \na=3\nnoequals\n')).toEqual({ a: '3', b: 'two words' })
  })

  it('compatibility: any ABI for an app without native code; 32-bit code on a 64-bit image', () => {
    expect(compatibility({ min_sdk: 21, abis: [] }, 21, ['x86_64'])).toEqual({ ok: true, reason: null })
    expect(compatibility({ min_sdk: 21, abis: ['armeabi-v7a'] }, 30, abisForImage('arm64-v8a'))).toEqual({ ok: true, reason: null })
    expect(compatibility({ min_sdk: 21, abis: [] }, null, [])).toEqual({ ok: false, reason: 'its API level is unknown' })
  })
})

describe('defaultHost().exec', () => {
  it('accepts a fractional timeout (a deadline on performance.now()) instead of throwing a RangeError', async () => {
    const r = await defaultHost().exec(process.execPath, ['-e', 'process.stdout.write("ok")'], 19_999.998)
    expect(r, 'node -e with a 19999.998 ms timeout').toEqual({ code: 0, stdout: 'ok', stderr: '' })
  })
})
