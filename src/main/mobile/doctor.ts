import { execFile } from 'node:child_process'
import { constants as fsc, promises as fs } from 'node:fs'
import { arch as osArch, homedir } from 'node:os'
import { basename, delimiter as pathDelimiter, dirname, join, win32 } from 'node:path'
import type { ApkInfo } from './apk'

/**
 * Roadmap M1 (second slice, M1b): can this machine run an Android app, and if not, what is the one thing to do?
 * Finds the SDK (ANDROID_HOME, ANDROID_SDK_ROOT, the default install folder, adb on PATH), adb and the emulator,
 * the virtual devices (AVDs, read from their .ini files without booting anything) and the connected devices, checks
 * hardware virtualization, and, given an APK's manifest facts (M1a), matches each device against its min SDK and
 * native ABIs. Electron-free; every process and host fact is injectable so tests never touch the real machine.
 *
 * Side effect worth knowing: `adb devices` starts the adb server when it is not running (as every adb client does).
 * Nothing else is started, installed or changed.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped'
export type CheckId = 'sdk' | 'adb' | 'emulator' | 'virtualization' | 'devices' | 'avds'

export interface DoctorCheck {
  id: CheckId
  status: CheckStatus
  summary: string
  /** One sentence telling the user what to do, when the status is warn or fail. */
  fix: string | null
}

/** Whether a device can run the app, and why not. */
export interface Compatibility {
  ok: boolean
  /** e.g. "API 29 is below the app's min SDK 31", or "ABIs x86_64 (app ships arm64-v8a only)". Null when ok. */
  reason: string | null
}

export interface AndroidDevice {
  serial: string
  /** adb's state: device (usable), unauthorized, offline, ... */
  state: string
  model: string | null
  emulator: boolean
  api: number | null
  abis: string[]
  /** Against the APK, when one was given and the device is usable. */
  compatible: Compatibility | null
}

export interface VirtualDevice {
  name: string
  api: number | null
  abi: string | null
  /** System image variant, e.g. google_apis. */
  tag: string | null
  /** The system image the AVD boots from is installed in the SDK. */
  image_present: boolean
  /** Whether it can boot here (host CPU, image installed) and, with an APK, run that app. */
  compatible: Compatibility | null
}

export interface MobileDoctorReport {
  /** A device (connected, or a virtual one that can boot here) can run the app now. */
  ready: boolean
  /** Where to run it: a connected device first, else the newest compatible AVD. */
  recommended: { kind: 'device' | 'avd'; name: string } | null
  /** The one next step when not ready; null when ready (each check still carries its own fix). */
  fix: string | null
  apk: Pick<ApkInfo, 'package' | 'min_sdk' | 'target_sdk' | 'abis'> | null
  sdk: { path: string; source: string } | null
  adb: { path: string; version: string | null } | null
  emulator: { path: string } | null
  virtualization: { status: 'ok' | 'unavailable' | 'no_permission' | 'unknown'; detail: string }
  devices: AndroidDevice[]
  avds: VirtualDevice[]
  checks: DoctorCheck[]
}

export interface ExecResult {
  /** Exit code, or null when the process could not start or was killed. */
  code: number | null
  stdout: string
  stderr: string
  /** Why it did not run to completion. */
  error?: 'not_found' | 'timeout' | 'failed'
}

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>

/** The host, injectable for tests. Defaults: this process and machine. */
export interface DoctorHost {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  /** node's os.arch(): x64, arm64, ... */
  arch: string
  home: string
  /** Linux KVM device node. */
  kvmPath: string
  exec: Exec
}

/** Newest stable Android API level, for the "create a virtual device" suggestion when the app doesn't say. */
export const LATEST_STABLE_API = 36
/** Listing caps: a machine with hundreds of AVDs or devices still gets a bounded report. */
export const MAX_AVDS = 64
export const MAX_DEVICES = 32
const ADB_TIMEOUT_MS = 15_000
const PROP_TIMEOUT_MS = 10_000
const ACCEL_TIMEOUT_MS = 20_000

const execDefault: Exec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    // execFile throws on a fractional timeout, and deadlines on performance.now() leave fractions (19999.998 ms).
    execFile(file, args, { timeout: Math.max(1, Math.ceil(timeoutMs)), windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr })
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string; signal?: string | null }
      if (e.code === 'ENOENT' || e.code === 'EACCES') return resolve({ code: null, stdout, stderr, error: 'not_found' })
      if (e.killed || e.signal === 'SIGTERM') return resolve({ code: null, stdout, stderr, error: 'timeout' })
      return resolve({ code: typeof e.code === 'number' ? e.code : null, stdout, stderr, error: 'failed' })
    })
  })

export function defaultHost(): DoctorHost {
  return { env: process.env, platform: process.platform, arch: osArch(), home: homedir(), kvmPath: '/dev/kvm', exec: execDefault }
}

const exe = (platform: NodeJS.Platform, name: string) => (platform === 'win32' ? `${name}.exe` : name)
const pathJoin = (platform: NodeJS.Platform, ...parts: string[]) => (platform === 'win32' ? win32.join(...parts) : join(...parts))

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) return false
    if (platform !== 'win32') await fs.access(path, fsc.X_OK)
    return true
  } catch {
    return false
  }
}

async function isDir(path: string): Promise<boolean> {
  return fs.stat(path).then((s) => s.isDirectory(), () => false)
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? ''
}

/** `key=value` lines (AVD .ini / config.ini). Later keys win; comments and blank lines skipped. */
export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

/** `adb devices -l` lines after the header: serial, state, then key:value details (model, device, transport_id...). */
export function parseAdbDevices(stdout: string): { serial: string; state: string; model: string | null }[] {
  const out: { serial: string; state: string; model: string | null }[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('*') || /^List of devices/i.test(line)) continue
    const [serial, first, ...rest] = line.split(/\s+/)
    if (!serial || !first) continue
    // Linux without udev rules: "no permissions (missing udev rules? ...); see [url]".
    const state = first === 'no' && rest[0]?.startsWith('permissions') ? 'no permissions' : first
    const model = rest.find((r) => r.startsWith('model:'))?.slice('model:'.length).replace(/_/g, ' ') || null
    out.push({ serial, state, model })
    if (out.length >= MAX_DEVICES) break
  }
  return out
}

/**
 * What an AVD of this ABI is expected to run before it boots (once booted, the device's own abilist is used). Older
 * 64-bit images also run the matching 32-bit ABI; x86_64 Google APIs images from API 30 run arm64-v8a code through
 * their translation layer and are treated as 64-bit only (an API 36 google_apis x86_64 image reports
 * `x86_64,arm64-v8a`, no x86): erring this way sends an x86-only app to a phone rather than to a failed install.
 */
export function abisForImage(abi: string | null, api: number | null = null, tag: string | null = null): string[] {
  switch (abi) {
    case 'x86_64':
      return api !== null && api >= 30 && (tag ?? '').startsWith('google_apis') ? ['x86_64', 'arm64-v8a'] : ['x86_64', 'x86']
    case 'arm64-v8a':
      return ['arm64-v8a', 'armeabi-v7a', 'armeabi']
    case 'armeabi-v7a':
      return ['armeabi-v7a', 'armeabi']
    case null:
      return []
    default:
      return [abi]
  }
}

/** API level and ABIs against the app's min SDK and native ABIs (an app with no native code runs on any ABI). */
export function compatibility(apk: Pick<ApkInfo, 'min_sdk' | 'abis'>, api: number | null, abis: string[]): Compatibility {
  if (api === null) return { ok: false, reason: 'its API level is unknown' }
  if (api < apk.min_sdk) return { ok: false, reason: `API ${api} is below the app's min SDK ${apk.min_sdk}` }
  if (apk.abis.length > 0 && !apk.abis.some((a) => abis.includes(a))) {
    return { ok: false, reason: `it runs ${abis.join(', ') || 'unknown ABIs'} and the app ships native code for ${apk.abis.join(', ')} only` }
  }
  return { ok: true, reason: null }
}

/** System image ABIs the emulator on this host's CPU can boot (it needs the host's architecture). */
export function bootableImageAbis(arch: string): string[] {
  if (arch === 'x64') return ['x86_64', 'x86']
  if (arch === 'arm64') return ['arm64-v8a']
  return []
}

/** The AVD system image ABI for this host's CPU (the emulator needs the host's architecture to run at speed). */
export function hostImageAbi(arch: string): string | null {
  if (arch === 'x64') return 'x86_64'
  if (arch === 'arm64') return 'arm64-v8a'
  return null
}

function sdkDefaults(host: DoctorHost): string[] {
  if (host.platform === 'darwin') return [join(host.home, 'Library', 'Android', 'sdk')]
  if (host.platform === 'win32') {
    const local = host.env.LOCALAPPDATA ?? win32.join(host.home, 'AppData', 'Local')
    return [win32.join(local, 'Android', 'Sdk')]
  }
  return [join(host.home, 'Android', 'Sdk'), join(host.home, 'Android', 'sdk')]
}

interface SdkFind {
  sdk: { path: string; source: string } | null
  adbPath: string | null
  /** A variable that is set but points somewhere without adb: the most specific thing to fix. */
  badVar: { name: string; value: string } | null
}

async function findSdk(host: DoctorHost): Promise<SdkFind> {
  const adbName = exe(host.platform, 'adb')
  let badVar: SdkFind['badVar'] = null
  for (const name of ['ANDROID_HOME', 'ANDROID_SDK_ROOT'] as const) {
    const value = host.env[name]?.trim()
    if (!value) continue
    const adb = pathJoin(host.platform, value, 'platform-tools', adbName)
    if (await isExecutable(adb, host.platform)) return { sdk: { path: value, source: name }, adbPath: adb, badVar: null }
    badVar ??= { name, value }
  }
  for (const dir of sdkDefaults(host)) {
    const adb = pathJoin(host.platform, dir, 'platform-tools', adbName)
    if (await isExecutable(adb, host.platform)) return { sdk: { path: dir, source: 'default location' }, adbPath: adb, badVar }
  }
  for (const dir of (host.env.PATH ?? host.env.Path ?? '').split(host.platform === 'win32' ? ';' : pathDelimiter)) {
    if (!dir) continue
    const adb = pathJoin(host.platform, dir, adbName)
    if (!(await isExecutable(adb, host.platform))) continue
    // adb from an SDK (…/platform-tools/adb) tells us where the SDK is; a distro package (/usr/bin/adb) does not.
    const real = await fs.realpath(adb).catch(() => adb)
    const parent = dirname(real)
    const sdk = basename(parent) === 'platform-tools' ? { path: dirname(parent), source: 'adb on PATH' } : null
    return { sdk, adbPath: adb, badVar }
  }
  return { sdk: null, adbPath: null, badVar }
}

function avdHome(host: DoctorHost): string {
  const env = host.env
  if (env.ANDROID_AVD_HOME?.trim()) return env.ANDROID_AVD_HOME.trim()
  const user = env.ANDROID_USER_HOME?.trim() || env.ANDROID_EMULATOR_HOME?.trim()
  return user ? join(user, 'avd') : join(host.home, '.android', 'avd')
}

async function readText(path: string): Promise<string | null> {
  try {
    const stat = await fs.stat(path)
    // A config.ini is a few KB; anything huge is not one.
    if (!stat.isFile() || stat.size > 256 * 1024) return null
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function listAvds(host: DoctorHost, sdkPath: string | null): Promise<VirtualDevice[]> {
  const home = avdHome(host)
  let names: string[]
  try {
    names = (await fs.readdir(home)).filter((f) => f.endsWith('.ini')).sort()
  } catch {
    return []
  }
  return Promise.all(names.slice(0, MAX_AVDS).map(async (file): Promise<VirtualDevice> => {
    const name = file.slice(0, -'.ini'.length)
    const outer = parseIni((await readText(join(home, file))) ?? '')
    const dir = outer.path && (await isDir(outer.path)) ? outer.path : join(home, `${name}.avd`)
    const config = parseIni((await readText(join(dir, 'config.ini'))) ?? '')
    const sysdir = config['image.sysdir.1'] ?? null
    const apiText = /android-(\d+)/.exec(sysdir ?? '')?.[1] ?? /^android-(\d+)$/.exec(outer.target ?? config.target ?? '')?.[1]
    const relImage = sysdir?.replace(/[\\/]+$/, '').split(/[\\/]/) ?? null
    return {
      name,
      api: apiText ? Number(apiText) : null,
      abi: config['abi.type'] || null,
      tag: config['tag.id'] || null,
      image_present: sdkPath !== null && relImage !== null && (await isDir(join(sdkPath, ...relImage))),
      compatible: null
    }
  }))
}

async function listDevices(host: DoctorHost, adb: string): Promise<{ devices: AndroidDevice[]; error: string | null }> {
  const r = await host.exec(adb, ['devices', '-l'], ADB_TIMEOUT_MS)
  if (r.error === 'timeout') return { devices: [], error: 'timeout' }
  if (r.code !== 0) return { devices: [], error: firstLine(r.stderr) || firstLine(r.stdout) || 'adb devices failed' }
  const rows = parseAdbDevices(r.stdout)
  const devices = await Promise.all(
    rows.map(async (row): Promise<AndroidDevice> => {
      const device: AndroidDevice = { ...row, emulator: row.serial.startsWith('emulator-'), api: null, abis: [], compatible: null }
      if (row.state !== 'device') return device
      const p = await host.exec(adb, ['-s', row.serial, 'shell', 'getprop ro.build.version.sdk; getprop ro.product.cpu.abilist'], PROP_TIMEOUT_MS)
      if (p.code === 0) {
        const [sdk = '', abilist = ''] = p.stdout.split(/\r?\n/).map((l) => l.trim())
        device.api = /^\d+$/.test(sdk) ? Number(sdk) : null
        device.abis = abilist ? abilist.split(',').map((a) => a.trim()).filter(Boolean) : []
      }
      return device
    })
  )
  return { devices, error: null }
}

async function checkVirtualization(host: DoctorHost, emulator: string | null): Promise<MobileDoctorReport['virtualization']> {
  if (host.platform === 'linux') {
    try {
      await fs.stat(host.kvmPath)
    } catch {
      return { status: 'unavailable', detail: `${host.kvmPath} does not exist` }
    }
    try {
      await fs.access(host.kvmPath, fsc.R_OK | fsc.W_OK)
      return { status: 'ok', detail: `KVM (${host.kvmPath}) is usable` }
    } catch {
      return { status: 'no_permission', detail: `${host.kvmPath} exists but this user cannot open it` }
    }
  }
  if (!emulator) return { status: 'unknown', detail: 'not checked: the emulator is not installed' }
  const r = await host.exec(emulator, ['-accel-check'], ACCEL_TIMEOUT_MS)
  const text = `${r.stdout}\n${r.stderr}`
  const said = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /usable|not|hypervisor|haxm|aehd|whpx|hvf/i.test(l))?.slice(0, 200)
  if (r.code === 0) return { status: 'ok', detail: said ?? 'the emulator reports hardware acceleration as usable' }
  if (r.error === 'timeout') return { status: 'unknown', detail: 'emulator -accel-check did not answer' }
  return { status: 'unavailable', detail: said ?? (firstLine(text) || 'emulator -accel-check failed') }
}

function virtualizationFix(host: DoctorHost, status: MobileDoctorReport['virtualization']['status']): string {
  if (status === 'no_permission') return 'Add yourself to the kvm group (`sudo usermod -aG kvm $USER`), then log out and back in.'
  if (host.platform === 'linux') return 'Turn on CPU virtualization (Intel VT-x or AMD-V/SVM) in the BIOS/UEFI settings, then load KVM (`sudo modprobe kvm_intel` or `sudo modprobe kvm_amd`).'
  if (host.platform === 'win32') return 'Turn on "Windows Hypervisor Platform" in Windows Features (and CPU virtualization in the BIOS/UEFI), then restart.'
  return 'Update the emulator (`sdkmanager "emulator"`) and macOS; the emulator uses the built-in Hypervisor.framework.'
}

/**
 * The API level to suggest for a new virtual device: the app's target SDK, at least its min SDK, and at least 30 when
 * only the x86_64 image's arm64 translation (API 30+) can run the app's native code.
 */
function suggestedApi(host: DoctorHost, apk: MobileDoctorReport['apk']): number {
  if (!apk) return LATEST_STABLE_API
  const api = Math.max(apk.min_sdk, Math.min(apk.target_sdk, Math.max(LATEST_STABLE_API, apk.min_sdk)))
  const abi = hostImageAbi(host.arch)
  const native = abisForImage(abi, null, null)
  const needsTranslation = abi === 'x86_64' && apk.abis.length > 0 && !apk.abis.some((a) => native.includes(a)) && apk.abis.includes('arm64-v8a')
  return needsTranslation ? Math.max(api, 30) : api
}

function createAvdFix(host: DoctorHost, apk: MobileDoctorReport['apk']): string {
  const abi = hostImageAbi(host.arch) ?? 'x86_64'
  const api = suggestedApi(host, apk)
  const image = `system-images;android-${api};google_apis;${abi}`
  return `Create a virtual device: \`sdkmanager "${image}"\` then \`avdmanager create avd -n nawi-api${api} -k "${image}" -d pixel_6\` (both in the SDK's cmdline-tools/latest/bin).`
}

/**
 * Inspect this machine's Android setup. `apk` (from inspectApkFile) narrows "ready" to devices that can run that app.
 * Never throws for a missing or broken setup: that is what the report is for.
 */
export async function runMobileDoctor(apk: ApkInfo | null = null, host: DoctorHost = defaultHost()): Promise<MobileDoctorReport> {
  const app = apk ? { package: apk.package, min_sdk: apk.min_sdk, target_sdk: apk.target_sdk, abis: apk.abis } : null
  const checks: DoctorCheck[] = []
  const found = await findSdk(host)

  const report: MobileDoctorReport = {
    ready: false,
    recommended: null,
    fix: null,
    apk: app,
    sdk: found.sdk,
    adb: null,
    emulator: null,
    virtualization: { status: 'unknown', detail: 'not checked' },
    devices: [],
    avds: [],
    checks
  }

  const installAdb = found.badVar
    ? `${found.badVar.name} is ${found.badVar.value} but there is no platform-tools/${exe(host.platform, 'adb')} in it: point it at the Android SDK folder (the one that contains platform-tools), or install them there with \`sdkmanager "platform-tools"\`.`
    : 'Install the Android SDK Platform-Tools (Android Studio > SDK Manager, or `sdkmanager "platform-tools"`) and set ANDROID_HOME to the SDK folder where Nawi starts (the app or `nawi serve` reads it at launch, not from the shell running this check).'
  if (!found.adbPath) {
    checks.push({ id: 'sdk', status: 'fail', summary: 'no Android SDK found (ANDROID_HOME, ANDROID_SDK_ROOT, the default folder, PATH)', fix: installAdb })
    checks.push({ id: 'adb', status: 'skipped', summary: 'adb not found', fix: null })
    report.fix = installAdb
    return report
  }
  checks.push(
    found.sdk
      ? { id: 'sdk', status: found.badVar ? 'warn' : 'ok', summary: `${found.sdk.path} (${found.sdk.source})`, fix: found.badVar ? installAdb : null }
      : { id: 'sdk', status: 'warn', summary: `adb at ${found.adbPath} is not inside an SDK, so the emulator and system images can't be found`, fix: installAdb }
  )

  const version = await host.exec(found.adbPath, ['version'], ADB_TIMEOUT_MS)
  if (version.code !== 0) {
    const why = version.error === 'timeout' ? 'did not answer' : firstLine(version.stderr) || firstLine(version.stdout) || 'failed to start'
    const fix = `adb at ${found.adbPath} does not run (${why}): reinstall it with \`sdkmanager "platform-tools"\`.`
    checks.push({ id: 'adb', status: 'fail', summary: `adb ${why}`, fix })
    report.fix = fix
    return report
  }
  const adbVersion = /Android Debug Bridge version ([\w.-]+)/.exec(version.stdout)?.[1] ?? null
  report.adb = { path: found.adbPath, version: adbVersion }
  checks.push({ id: 'adb', status: 'ok', summary: `${found.adbPath}${adbVersion ? ` (${adbVersion})` : ''}`, fix: null })

  if (found.sdk) {
    const emulator = pathJoin(host.platform, found.sdk.path, 'emulator', exe(host.platform, 'emulator'))
    if (await isExecutable(emulator, host.platform)) report.emulator = { path: emulator }
  }
  const emulatorFix = found.sdk
    ? 'Install the emulator (`sdkmanager "emulator"`) to run virtual devices, or connect a phone with USB debugging on.'
    : `adb at ${found.adbPath} is not part of an Android SDK, so there is no emulator: install the SDK (Android Studio, or the command-line tools) and set ANDROID_HOME, or connect a phone with USB debugging on.`
  checks.push(
    report.emulator
      ? { id: 'emulator', status: 'ok', summary: report.emulator.path, fix: null }
      : { id: 'emulator', status: 'warn', summary: 'the Android emulator is not installed', fix: emulatorFix }
  )

  const [virt, listed, avds] = await Promise.all([
    checkVirtualization(host, report.emulator?.path ?? null),
    listDevices(host, found.adbPath),
    listAvds(host, found.sdk?.path ?? null)
  ])
  report.virtualization = virt
  const virtFix =
    virt.status === 'unavailable' || virt.status === 'no_permission'
      ? virtualizationFix(host, virt.status)
      : virt.status === 'unknown' && report.emulator
        ? `\`emulator -accel-check\` did not answer: run \`${report.emulator.path} -accel-check\` in a terminal to see what blocks hardware acceleration.`
        : null
  checks.push({ id: 'virtualization', status: virt.status === 'ok' ? 'ok' : virtFix ? (virt.status === 'unknown' ? 'warn' : 'fail') : 'skipped', summary: virt.detail, fix: virtFix })

  report.devices = listed.devices
  for (const d of report.devices) if (app && d.state === 'device') d.compatible = compatibility(app, d.api, d.abis)
  const usable = report.devices.filter((d) => d.state === 'device' && (d.compatible?.ok ?? true))
  const unauthorized = report.devices.find((d) => d.state === 'unauthorized')
  const offline = report.devices.find((d) => d.state === 'offline')
  const noPermissions = report.devices.find((d) => d.state === 'no permissions')
  const incompatible = report.devices.filter((d) => d.compatible && !d.compatible.ok)
  const adbStuck = listed.error === 'timeout' ? 'adb did not answer `adb devices`: restart it with `adb kill-server` and retry.' : null
  const deviceFix =
    adbStuck ??
    (listed.error ? `\`adb devices\` failed (${listed.error}): restart adb with \`adb kill-server\` and retry.` : null) ??
    (unauthorized ? `Unlock ${unauthorized.model ?? unauthorized.serial} and accept "Allow USB debugging", then retry.` : null) ??
    (noPermissions ? `This computer may not open ${noPermissions.serial} over USB: add udev rules for Android devices (e.g. the android-udev-rules package), then unplug and replug it.` : null) ??
    (offline ? `${offline.model ?? offline.serial} is offline: reconnect the cable (or restart that emulator) and retry.` : null)
  checks.push({
    id: 'devices',
    status: listed.error ? 'fail' : usable.length ? 'ok' : deviceFix || incompatible.length ? 'warn' : 'skipped',
    summary: listed.error
      ? `adb devices: ${listed.error}`
      : report.devices.length === 0
        ? 'no device connected'
        : report.devices.map((d) => `${d.serial} ${d.state}${d.api !== null ? ` API ${d.api}` : ''}${d.compatible && !d.compatible.ok ? ` (can't run the app: ${d.compatible.reason})` : ''}`).join('; '),
    fix: usable.length ? null : deviceFix
  })

  // An AVD can only start here when the emulator and virtualization both work.
  const canBoot = report.emulator !== null && virt.status === 'ok'
  report.avds = avds
  const hostImages = bootableImageAbis(host.arch)
  // AVDs that would run the app (or any app) once their image is installed: the candidates for "reinstall it".
  const wouldRun = new Set<string>()
  for (const a of avds) {
    let c: Compatibility = { ok: true, reason: null }
    if (a.abi !== null && !hostImages.includes(a.abi)) c = { ok: false, reason: `its ${a.abi} image can't run on this computer's CPU` }
    else if (app) c = compatibility(app, a.api, abisForImage(a.abi, a.api, a.tag))
    if (c.ok) wouldRun.add(a.name)
    a.compatible = c.ok && !a.image_present ? { ok: false, reason: 'its system image is not installed' } : c
  }
  const bootable = canBoot ? avds.filter((a) => a.compatible?.ok).sort((x, y) => (y.api ?? 0) - (x.api ?? 0) || x.name.localeCompare(y.name)) : []
  const missingImage = avds.find((a) => !a.image_present && wouldRun.has(a.name))
  checks.push({
    id: 'avds',
    status: bootable.length ? 'ok' : avds.length ? 'warn' : 'skipped',
    summary: avds.length === 0 ? 'no virtual devices' : avds.map((a) => `${a.name} API ${a.api ?? '?'} ${a.abi ?? '?'}${a.compatible && !a.compatible.ok ? ` (${a.compatible.reason})` : ''}`).join('; '),
    fix: bootable.length || !canBoot ? null : missingImage ? `Reinstall the system image of ${missingImage.name} (Android Studio > Device Manager, or recreate it), or create a new one.` : createAvdFix(host, app)
  })

  const device = usable[0]
  if (device) report.recommended = { kind: 'device', name: device.serial }
  else if (bootable[0]) report.recommended = { kind: 'avd', name: bootable[0].name }
  report.ready = report.recommended !== null

  if (!report.ready) {
    // Native code the virtual device we would suggest can't run (e.g. 32-bit ARM only on an x86_64 computer).
    const hostAbis = abisForImage(hostImageAbi(host.arch), suggestedApi(host, app), 'google_apis')
    const noEmulatorAbi = app !== null && app.abis.length > 0 && !app.abis.some((a) => hostAbis.includes(a))
    const phoneFix = `This app ships native code for ${app?.abis.join(', ')} only, which this computer's emulator can't run: connect a phone with that ABI and USB debugging on.`
    // Most specific first: a device that only needs a tap, then what blocks virtual devices, then creating one.
    report.fix =
      (unauthorized || noPermissions || offline || listed.error ? deviceFix : null) ??
      (noEmulatorAbi ? phoneFix : null) ??
      (!report.emulator ? emulatorFix : null) ??
      virtFix ??
      checks.find((c) => c.id === 'avds')?.fix ??
      createAvdFix(host, app)
  }
  return report
}

/** The adb the doctor would use (same search order), or null. For callers that only need adb, e.g. the live screen. */
export async function findAdb(host: DoctorHost = defaultHost()): Promise<string | null> {
  return (await findSdk(host)).adbPath
}
