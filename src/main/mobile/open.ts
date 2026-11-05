import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { ApkInfo } from './apk'
import { findFirstRunBlockers, labelOf, type FirstScreen } from './blockers'
import { defaultHost, runMobileDoctor, type DoctorHost, type ExecResult, type MobileDoctorReport } from './doctor'
import { DumpError, dumpLine, parseUiDump, type UiScreen } from './hierarchy'
import { MAX_ONBOARDING_TAPS, nextOnboardingTap, screenKey, type OnboardingTap } from './onboarding'
import { CLASS_RE, defaultDeviceSettings, PACKAGE_RE, PERMISSION_RE, TARGET_RE, type DeviceSettings } from './profile'
import { androidVersionFor, DEFAULT_NETWORK_LINE, isNetworkSerial, parseDefaultNetwork, settingCommands, type DeviceSettingName } from './settings'
import { shQuote } from './shell'
import { redactSecrets } from '../../shared/flow/interpolate'
import { clearLine, locateOnApp, promptInFront, resolveSignIn, typeLines, type SignInInputs, type SignInSpec } from './sign-in'

export { shQuote }

/**
 * Roadmap M1 (third slice, M1c): put an app on a device and start it. Uses the doctor (M1b) to pick a connected
 * device or a virtual device (AVD) that can run the app, boots the AVD when needed, installs the .apk, grants its
 * runtime permissions (`pm grant`, so no dialog blocks a run), applies the profile's device settings (M2b: locale,
 * dark mode, font scale, animations, network) and starts its launcher activity (`am start -W`). Then (M2c) it reads the screen
 * once (`uiautomator dump`) and names any first-run blocker in front of the app (a permission prompt, a consent or
 * intro screen, a sign-in form) with the element to tap past it. With the profile's onboarding taps (M2c part 2) it
 * taps past those screens itself, one saved tap at a time, re-reading the screen after each; with `learnOnboarding`
 * it also taps the ones it named, so the caller can save them. With the profile's sign_in (M2, last slice) and a sign-in
 * form still in front of the app, it fills the form from the call's secrets/env and submits it.
 * Every failure is a normal result with the step that failed and one fix. Electron-free; adb, the emulator and the
 * clock are injectable so tests never touch a real device.
 *
 * Side effects (that is the point): may start an emulator, which keeps running afterwards; installs (or replaces)
 * the app on the target; grants permissions; changes device settings (global ones like animations, font scale and
 * airplane mode stay changed); starts the app.
 */

export type OpenStepId = 'doctor' | 'boot' | 'install' | 'grant' | 'settings' | 'launch' | 'onboarding' | 'sign_in' | 'first_screen'
export type OpenStepStatus = 'ok' | 'warn' | 'fail' | 'skipped'

export interface OpenStep {
  id: OpenStepId
  status: OpenStepStatus
  summary: string
  /** One sentence telling the user what to do, when the status is warn or fail. */
  fix: string | null
}

export interface OpenTarget {
  kind: 'device' | 'avd'
  /** The adb serial for a device, the AVD name for a virtual device. */
  name: string
  /** adb serial used for install/launch (an AVD's is emulator-<port> once booted). */
  serial: string | null
  api: number | null
  /** Nawi started the emulator in this call (it keeps running afterwards). */
  booted: boolean
}

export interface MobileOpenResult {
  /** Installed and launched. */
  ok: boolean
  /** The one next step when not ok. */
  fix: string | null
  package: string
  target: OpenTarget | null
  permissions: { granted: string[]; not_granted: { name: string; reason: string }[] }
  /**
   * The device settings asked for (null fields: left alone; null: none), the ones applied and the ones not, by their
   * key in the profile's device section (`locale`, `dark_mode`, `font_scale`, `animations`, `network`).
   */
  settings: { requested: DeviceSettings | null; applied: DeviceSettingName[]; not_applied: { name: DeviceSettingName; reason: string }[] }
  launched: { activity: string; total_time_ms: number | null; pid: number | null } | null
  /**
   * The screen right after launch (M2c): the window in front and the first-run blockers on it, each with the element
   * to tap past it (or null). Null when the app did not start or the screen could not be read (see the step).
   */
  first_screen: FirstScreen | null
  /**
   * The onboarding taps made after launch (M2c part 2), in order; `learned`: proposed by Nawi, not in the profile yet.
   * Null when there was nothing to replay or learn.
   */
  onboarding: { tapped: OnboardingTapped[] } | null
  /**
   * The sign-in made with the profile's sign_in section: how many fields were typed into and whether the form was
   * submitted and gone afterwards. Null when there was no sign-in form to fill (or no sign_in section). Never the values.
   */
  sign_in: { fields: number; submitted: boolean; signed_in: boolean } | null
  steps: OpenStep[]
  /** The doctor's report, when no target could be chosen (it explains why). */
  doctor: MobileDoctorReport | null
}

export interface OnboardingTapped extends OnboardingTap {
  /** The visible label of the element tapped. */
  label: string
  learned: boolean
}

export interface OpenRequest {
  /** Real path of the .apk (already inspected). */
  apkFile: string
  apk: ApkInfo
  /** adb serial or AVD name; default: the doctor's recommendation. */
  target?: string | null
  /** Permissions to grant; default: the app's runtime permissions requested at the target's API level. */
  grant?: string[] | null
  /**
   * Device settings to apply before launch; null leaves the device as it is. Default: defaultDeviceSettings for the
   * chosen target (a fixed setup on a virtual device, nothing on a physical phone).
   */
  settings?: DeviceSettings | null
  /**
   * Whether `settings` may also change a physical phone. Off by default: settings saved for a virtual device (the
   * defaults) must not land on somebody's own phone when a run is pointed at it; a profile pinned to a phone turns
   * it on, since any value in it was written for that phone.
   */
  settingsOnPhone?: boolean
  /** Taps that get past the first-run screens (the profile's onboarding), replayed after launch. */
  onboarding?: readonly OnboardingTap[] | null
  /** Also tap the first-run blockers Nawi names a tap for (the user agreed), so they can be saved. */
  learnOnboarding?: boolean
  /** The profile's sign_in section: filled in when a sign-in form is in front of the app after the onboarding taps. */
  signIn?: SignInSpec | null
  /** Values for its `${secret.*}` / `${env.*}` references. Never stored or reported. */
  inputs?: SignInInputs
  /** Activity to start; default: the launcher activity. */
  activity?: string | null
  /** Start a booted emulator without a window (servers, CI). */
  headless?: boolean
  bootTimeoutMs?: number
  signal?: AbortSignal
  /** Called as each step starts, e.g. "install com.x on emulator-5554". */
  onStep?: (id: OpenStepId, summary: string) => void
}

export interface Spawned {
  /** Exit code once the process has ended, else null (still running). */
  exitCode(): number | null
}

export interface OpenHost extends DoctorHost {
  /** Start a long-lived process (the emulator) detached from Nawi, output discarded. Throws when it can't start. */
  spawnDetached(file: string, args: string[]): Spawned
  delay(ms: number, signal?: AbortSignal): Promise<void>
  /** Milliseconds on a monotonic clock (the boot deadline). */
  now(): number
}

export const DEFAULT_BOOT_TIMEOUT_MS = 180_000
export const BOOT_POLL_MS = 2_000
const INSTALL_TIMEOUT_MS = 300_000
const SHELL_TIMEOUT_MS = 30_000
const LAUNCH_TIMEOUT_MS = 60_000
/** After `am start -W` returns, how long a prompt or consent dialog the app opens in onCreate takes to show. */
export const FIRST_SCREEN_SETTLE_MS = 1_500
/** How long, after airplane mode is switched, openApp waits for the default network to come back (or to go) before launch. */
export const NETWORK_SETTLE_TIMEOUT_MS = 20_000
export const NETWORK_POLL_MS = 500
/** After a sign-in is submitted, how long Nawi waits for the form to go (a network round trip, then a new screen). */
export const SIGN_IN_TIMEOUT_MS = 20_000
/** Prints `mInputShown=true` while the on-screen keyboard is up (checked on API 36: false again right after Back). */
export const KEYBOARD_SHOWN_LINE = 'dumpsys input_method | grep -m 1 mInputShown'
/** After Back hides the keyboard, how long the app takes to lay its screen out again. */
export const KEYBOARD_SETTLE_MS = 500
/** uiautomator waits up to ~10 s for the screen to go idle before it gives up. */
const DUMP_TIMEOUT_MS = 15_000
/** Emulator console ports adb scans (5554..5584 by default; the emulator accepts up to 5682). */
const FIRST_PORT = 5554
const LAST_PORT = 5682

export function defaultOpenHost(): OpenHost {
  return {
    ...defaultHost(),
    spawnDetached(file, args) {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true })
      let code: number | null = null
      child.on('exit', (c, signal) => {
        code = c ?? (signal ? 128 : 1)
      })
      child.on('error', () => {
        code ??= 127
      })
      child.unref()
      return { exitCode: () => code }
    },
    now: () => performance.now(),
    delay: (ms, signal) =>
      new Promise((resolve) => {
        const t = setTimeout(done, ms)
        function done(): void {
          clearTimeout(t)
          signal?.removeEventListener('abort', done)
          resolve()
        }
        signal?.addEventListener('abort', done, { once: true })
      })
  }
}


function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 300) ?? ''
}

function said(r: ExecResult): string {
  return firstLine(r.stderr) || firstLine(r.stdout) || (r.error === 'not_found' ? 'adb could not be started' : `exit code ${r.code}`)
}

/** `adb: device 'X' not found`, `device offline`, `no devices/emulators found`: the target went away mid-way. */
function deviceGone(text: string): boolean {
  return /device '.*' not found|device offline|no devices\/emulators found|device not found/i.test(text)
}

/**
 * The fix for an `adb install` failure code (the `Failure [INSTALL_...]` line). Unknown codes get the command to
 * run by hand, which prints the full message.
 */
export function installFix(code: string, pkg: string, serial: string, file: string): string {
  const uninstall = `\`adb -s ${serial} uninstall ${pkg}\` (this deletes the app's data on that device)`
  switch (code) {
    case 'INSTALL_FAILED_UPDATE_INCOMPATIBLE':
      return `A copy of ${pkg} signed with a different key is already installed: uninstall it with ${uninstall}, then retry.`
    case 'INSTALL_FAILED_VERSION_DOWNGRADE':
      return `A newer version of ${pkg} is already installed: uninstall it with ${uninstall}, then retry.`
    case 'INSTALL_FAILED_INSUFFICIENT_STORAGE':
      return 'The device is out of storage: uninstall apps you don\'t need (or wipe the virtual device\'s data in Device Manager), then retry.'
    case 'INSTALL_FAILED_NO_MATCHING_ABIS':
      return 'The device can\'t run the app\'s native code: pick another device (`nawi mobile-doctor <file.apk>` lists the ones that can).'
    case 'INSTALL_FAILED_OLDER_SDK':
      return 'The device\'s Android version is older than the app\'s min SDK: pick a newer device (`nawi mobile-doctor <file.apk>`).'
    case 'INSTALL_FAILED_DEPRECATED_SDK_VERSION':
      return 'Android 14 and later refuse apps that target a very old SDK: rebuild the app with a newer targetSdk, or use a device on Android 13 or older.'
    case 'INSTALL_PARSE_FAILED_NO_CERTIFICATES':
    case 'INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES':
      return 'The APK is not signed (or its signature is broken): sign it with apksigner (debug builds are signed automatically), then retry.'
    case 'INSTALL_FAILED_USER_RESTRICTED':
    case 'INSTALL_FAILED_ABORTED':
      return 'The device refused the install: on the phone allow "Install via USB" in Developer options and accept the prompt, then retry.'
    case 'INSTALL_FAILED_INVALID_APK':
    case 'INSTALL_PARSE_FAILED_NOT_APK':
      return 'The device says the file is not a valid APK: rebuild or re-download it.'
    default:
      return `adb could not install the app (${code}): run \`adb -s ${serial} install -r -t ${file}\` in a terminal for the full message.`
  }
}

/** Parse `am start -W` output: ok + TotalTime, or the error line. */
export function parseAmStart(stdout: string, stderr: string): { ok: true; totalTimeMs: number | null } | { ok: false; error: string } {
  const text = `${stdout}\n${stderr}`
  // "Error type 3" is only a code; the line after it ("Error: Activity class {...} does not exist.") says why.
  const error = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^(Error|Exception|Security exception|java\.lang\.\w+Exception)\b/.test(l) && !/^Error type \d+$/.test(l))
  if (error) return { ok: false, error: error.slice(0, 300) }
  if (!/^Status:\s*ok\b/m.test(stdout)) {
    const status = /^Status:\s*(\S+)/m.exec(stdout)?.[1]
    return { ok: false, error: status ? `am start reported status ${status}` : firstLine(text) || 'am start printed nothing' }
  }
  const total = /^TotalTime:\s*(\d+)/m.exec(stdout)?.[1]
  return { ok: true, totalTimeMs: total ? Number(total) : null }
}

/** The emulator ports already used by running emulators (`emulator-5554` -> 5554, 5555). */
export function freeEmulatorPort(serials: string[]): number | null {
  const used = new Set<number>()
  for (const s of serials) {
    const m = /^emulator-(\d+)$/.exec(s)
    if (m) {
      used.add(Number(m[1]))
      used.add(Number(m[1]) + 1)
    }
  }
  for (let p = FIRST_PORT; p <= LAST_PORT; p += 2) if (!used.has(p) && !used.has(p + 1)) return p
  return null
}

/** Runtime permissions the app asks for at this API level (android:maxSdkVersion respected). */
export function runtimePermissionsFor(apk: ApkInfo, api: number | null): string[] {
  return apk.permissions.filter((p) => p.runtime && (p.max_sdk === null || api === null || api <= p.max_sdk)).map((p) => p.name)
}

class Stop extends Error {}

/**
 * Install and launch `req.apk` on a device. Never throws for a device or setup problem (the result says what to do);
 * throws only for invalid input (names that are not Android names) and on abort.
 */
export async function openApp(req: OpenRequest, host: OpenHost = defaultOpenHost()): Promise<MobileOpenResult> {
  const pkg = req.apk.package
  if (!PACKAGE_RE.test(pkg)) throw new Error(`"${pkg}" is not an Android package name.`)
  if (req.target != null && !TARGET_RE.test(req.target)) throw new Error(`"${req.target}" is not an adb serial or AVD name.`)
  for (const p of req.grant ?? []) if (!PERMISSION_RE.test(p)) throw new Error(`"${p}" is not a permission name.`)
  if (req.activity != null && !CLASS_RE.test(req.activity)) throw new Error(`"${req.activity}" is not an activity class name.`)

  const result: MobileOpenResult = {
    ok: false,
    fix: null,
    package: pkg,
    target: null,
    permissions: { granted: [], not_granted: [] },
    settings: { requested: null, applied: [], not_applied: [] },
    launched: null,
    first_screen: null,
    onboarding: null,
    sign_in: null,
    steps: [],
    doctor: null
  }
  const steps = result.steps
  const fail = (id: OpenStepId, summary: string, fix: string): never => {
    steps.push({ id, status: 'fail', summary, fix })
    result.fix = fix
    throw new Stop()
  }
  const checkAbort = (): void => {
    if (req.signal?.aborted) throw req.signal.reason instanceof Error ? req.signal.reason : new Error(String(req.signal.reason ?? 'cancelled'))
  }

  try {
    // 1. Doctor: where can it run?
    req.onStep?.('doctor', 'checking the Android setup')
    const doctor = await runMobileDoctor(req.apk, host)
    checkAbort()
    const adb = doctor.adb?.path
    if (!adb) {
      result.doctor = doctor
      fail('doctor', 'adb is not available', doctor.fix ?? 'Install the Android SDK Platform-Tools and set ANDROID_HOME.')
    }
    const adbPath = adb as string
    const target = await chooseTarget(req, doctor, host, adbPath)
    if ('fix' in target) {
      result.doctor = doctor
      fail('doctor', target.summary, target.fix)
    }
    const chosen = target as OpenTarget
    result.target = { kind: chosen.kind, name: chosen.name, serial: chosen.serial, api: chosen.api, booted: false }
    steps.push({ id: 'doctor', status: 'ok', summary: `${chosen.kind === 'device' ? 'device' : 'virtual device'} ${chosen.name}${chosen.api !== null ? ` (API ${chosen.api})` : ''}`, fix: null })

    // 2. Boot the AVD when it is not running yet.
    if (chosen.serial === null) {
      const emulator = doctor.emulator?.path as string
      const port = freeEmulatorPort(doctor.devices.map((d) => d.serial))
      if (port === null) fail('boot', 'every emulator port is in use', 'Close an emulator you don\'t need, then retry.')
      const serial = `emulator-${port}`
      req.onStep?.('boot', `booting ${chosen.name} as ${serial}`)
      const args = ['-avd', chosen.name, '-port', String(port), '-no-snapshot-save', '-no-boot-anim', ...(req.headless ? ['-no-window', '-no-audio'] : [])]
      let proc: Spawned
      try {
        proc = host.spawnDetached(emulator, args)
      } catch (err) {
        return fail('boot', `the emulator did not start (${err instanceof Error ? err.message : String(err)})`, `Run \`${emulator} -avd ${chosen.name}\` in a terminal to see why it does not start.`)
      }
      result.target.serial = serial
      result.target.booted = true
      const timeout = req.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS
      const booted = await waitForBoot(host, adbPath, serial, proc, timeout, req.signal)
      checkAbort()
      if (booted !== 'ok') {
        const manual = `\`${emulator} -avd ${chosen.name}\``
        if (booted === 'exited') fail('boot', `the emulator for ${chosen.name} exited before Android finished booting`, `Run ${manual} in a terminal to see why it stops (often a damaged AVD: wipe its data in Device Manager).`)
        fail('boot', `${chosen.name} was still booting after ${Math.round(timeout / 1000)} s`, `Wait for ${serial} to reach the home screen, then retry with target ${serial} (a first boot can take several minutes; a cold boot from Device Manager helps when it hangs).`)
      }
      steps.push({ id: 'boot', status: 'ok', summary: `${chosen.name} booted as ${serial}`, fix: null })
    } else {
      steps.push({ id: 'boot', status: 'skipped', summary: `${chosen.serial} is already running`, fix: null })
    }
    const serial = result.target.serial as string

    // 3. Install (replace, keep data; -t allows test-only debug builds).
    checkAbort()
    req.onStep?.('install', `installing ${pkg} on ${serial}`)
    const inst = await host.exec(adbPath, ['-s', serial, 'install', '-r', '-t', req.apkFile], INSTALL_TIMEOUT_MS)
    const instText = `${inst.stdout}\n${inst.stderr}`
    if (inst.code !== 0 || !/^Success\b/m.test(inst.stdout)) {
      if (inst.error === 'timeout') fail('install', `the install did not finish within ${INSTALL_TIMEOUT_MS / 60_000} min`, `Check that ${serial} responds (\`adb -s ${serial} shell echo ok\`), then retry.`)
      if (deviceGone(instText)) fail('install', `${serial} went away during the install`, `Reconnect ${serial} (or restart that emulator), then retry.`)
      const code = /\b(INSTALL_[A-Z_]+)\b/.exec(instText)?.[1]
      fail('install', code ? `adb install failed: ${code}` : `adb install failed: ${said(inst)}`, installFix(code ?? 'unknown error', pkg, serial, req.apkFile))
    }
    steps.push({ id: 'install', status: 'ok', summary: `${pkg}${req.apk.version_name ? ` ${req.apk.version_name}` : ''} installed on ${serial}`, fix: null })

    // 4. Grant runtime permissions (a failure is a warning: the app still runs, a dialog may appear).
    checkAbort()
    const grant = req.grant ?? runtimePermissionsFor(req.apk, result.target.api)
    if (grant.length === 0) {
      steps.push({ id: 'grant', status: 'skipped', summary: 'no runtime permissions to grant', fix: null })
    } else {
      req.onStep?.('grant', `granting ${grant.length} permission${grant.length === 1 ? '' : 's'}`)
      for (const perm of grant) {
        checkAbort()
        const r = await host.exec(adbPath, ['-s', serial, 'shell', `pm grant ${shQuote(pkg)} ${shQuote(perm)}`], SHELL_TIMEOUT_MS)
        // pm prints its exceptions on stdout on some versions and exits 0 on others.
        const text = `${r.stdout}\n${r.stderr}`
        if (r.code === 0 && !/Exception|Error|Unknown permission|not a changeable/i.test(text)) result.permissions.granted.push(perm)
        else result.permissions.not_granted.push({ name: perm, reason: r.error === 'timeout' ? 'pm grant did not answer' : said(r) })
      }
      const missed = result.permissions.not_granted
      steps.push(
        missed.length === 0
          ? { id: 'grant', status: 'ok', summary: `granted ${grant.length}: ${grant.join(', ')}`, fix: null }
          : {
              id: 'grant',
              status: 'warn',
              summary: `granted ${result.permissions.granted.length} of ${grant.length}; not granted: ${missed.map((m) => `${m.name} (${m.reason})`).join('; ')}`,
              fix: 'Those permissions will be asked for in a dialog when the app needs them; remove them from the profile\'s permissions.grant if the device doesn\'t have them.'
            }
      )
    }

    // 5. Device settings (a failure is a warning: the app still runs, only on a less predictable screen).
    checkAbort()
    const api = result.target.api
    const onPhone = result.target.kind === 'device'
    const wanted = req.settings === undefined ? defaultDeviceSettings(result.target.kind, api) : req.settings
    const commands = wanted ? settingCommands(pkg, wanted) : []
    if (commands.length > 0 && onPhone && req.settings !== undefined && !req.settingsOnPhone) {
      steps.push({ id: 'settings', status: 'skipped', summary: `the profile's device settings are for a virtual device; ${serial} is a physical device and is left as it is`, fix: null })
    } else if (commands.length === 0) {
      result.settings.requested = wanted
      steps.push({ id: 'settings', status: 'skipped', summary: 'no device settings to apply (the device is left as it is)', fix: null })
    } else {
      result.settings.requested = wanted
      req.onStep?.('settings', `applying ${commands.map((c) => c.label).join(', ')}`)
      const done: string[] = []
      const missed: string[] = []
      for (const c of commands) {
        checkAbort()
        if (c.minApi !== null && api !== null && api < c.minApi) {
          const reason = `needs Android ${androidVersionFor(c.minApi)} (API ${c.minApi}); ${serial} is API ${api}`
          result.settings.not_applied.push({ name: c.name, reason })
          missed.push(`${c.label} (${reason})`)
          continue
        }
        if (c.name === 'network' && wanted?.network === false && isNetworkSerial(serial)) {
          const reason = `adb reaches ${serial} over the network, and airplane mode would cut that connection`
          result.settings.not_applied.push({ name: c.name, reason })
          missed.push(`${c.label} (${reason})`)
          continue
        }
        const r = await host.exec(adbPath, ['-s', serial, 'shell', c.line], SHELL_TIMEOUT_MS)
        // `cmd` and `settings` print their errors on stdout and exit 0 on some versions, like pm does.
        const text = `${r.stdout}\n${r.stderr}`
        if (r.code === 0 && !/Exception|Error|Unknown|Invalid|not found|Can't find service|No shell command/i.test(text)) {
          result.settings.applied.push(c.name)
          done.push(c.label)
        } else {
          const reason = r.error === 'timeout' ? 'the device did not answer' : said(r)
          result.settings.not_applied.push({ name: c.name, reason })
          missed.push(`${c.label} (${reason})`)
        }
      }
      // Airplane mode returns before the radios have reconnected (or dropped): wait, so the first screen does not
      // depend on how fast Wi-Fi came back.
      let unsettled: { summary: string; fix: string } | null = null
      if (result.settings.applied.includes('network') && typeof wanted?.network === 'boolean') {
        const want = wanted.network ? 'up' : 'down'
        req.onStep?.('settings', want === 'up' ? 'waiting for the network to come back' : 'waiting for the network to go')
        const got = await waitForNetwork(host, adbPath, serial, want, req.signal)
        checkAbort()
        if (got === 'timeout') {
          const secs = NETWORK_SETTLE_TIMEOUT_MS / 1000
          unsettled =
            want === 'up'
              ? {
                  summary: `airplane mode is off, but ${serial} had no network after ${secs} s`,
                  fix: `Turn on Wi-Fi or mobile data on ${serial} (airplane mode off does not turn on a Wi-Fi switched off on its own), or set network to null in the profile's device section if the app should run without one.`
                }
              : {
                  summary: `airplane mode is on, but ${serial} still had a network after ${secs} s`,
                  fix: `Check \`adb -s ${serial} shell dumpsys connectivity\` for the network that stayed up (Wi-Fi allowed in airplane mode stays on); the app may not see itself offline.`
                }
        }
      }
      const keys = result.settings.not_applied.map((m) => m.name).join(', ')
      steps.push(
        missed.length === 0 && !unsettled
          ? { id: 'settings', status: 'ok', summary: done.join(', '), fix: null }
          : missed.length === 0 && unsettled
            ? { id: 'settings', status: 'warn', summary: `${done.join(', ')}; ${unsettled.summary}`, fix: unsettled.fix }
            : {
                id: 'settings',
                status: 'warn',
                summary: `applied ${done.length} of ${commands.length}; not applied: ${missed.join('; ')}${unsettled ? `; ${unsettled.summary}` : ''}`,
                fix: `The app runs with the device's own value for those; set ${keys} to null in the profile's device section to stop asking, or use a newer device.${unsettled ? ` ${unsettled.fix}` : ''}`
              }
      )
    }

    // 6. Launch.
    checkAbort()
    const activity = req.activity ?? req.apk.launcher_activity
    if (!activity) {
      fail('launch', `${pkg} has no launcher activity`, 'Name the activity to start (an exported one from `nawi mobile-inspect <file.apk>`), e.g. in the profile\'s launch.activity.')
    }
    const act = activity as string
    req.onStep?.('launch', `starting ${act}`)
    const am = await host.exec(adbPath, ['-s', serial, 'shell', `am start -W -n ${shQuote(`${pkg}/${act}`)}`], LAUNCH_TIMEOUT_MS)
    if (am.error === 'timeout') fail('launch', 'the app did not finish starting within 60 s', `Look at \`adb -s ${serial} logcat\` for what the app is doing at startup, then retry.`)
    if (deviceGone(`${am.stdout}\n${am.stderr}`)) fail('launch', `${serial} went away before the app started`, `Reconnect ${serial} (or restart that emulator), then retry.`)
    const started = parseAmStart(am.stdout, am.stderr)
    if (!started.ok) {
      const missing = /does not exist|unable to resolve/i.test(started.error)
      const denied = /Permission Denial|not exported/i.test(started.error)
      fail(
        'launch',
        `could not start ${act}: ${started.error}`,
        missing
          ? `${act} is not an activity of ${pkg}: use the launcher activity from \`nawi mobile-inspect <file.apk>\`.`
          : denied
            ? `${act} can't be started from outside the app (not exported): start the launcher activity instead.`
            : `Look at \`adb -s ${serial} logcat\` for why ${pkg} did not start, then retry.`
      )
    }
    const startedOk = started as { ok: true; totalTimeMs: number | null }
    const pidOut = await host.exec(adbPath, ['-s', serial, 'shell', `pidof ${shQuote(pkg)}`], SHELL_TIMEOUT_MS)
    const pidText = /^\d+/.exec(pidOut.stdout.trim())?.[0]
    const pid = pidOut.code === 0 && pidText ? Number(pidText) : null
    // Old Android images have no pidof: then "not running" can't be told, and the launch counts as ok.
    const noPidof = /not found|inaccessible/i.test(`${pidOut.stdout}\n${pidOut.stderr}`) || pidOut.error === 'timeout'
    result.launched = { activity: act, total_time_ms: startedOk.totalTimeMs, pid }
    if (pid === null && !noPidof) {
      fail('launch', `${pkg} started and then stopped`, `It probably crashed at startup: look at \`adb -s ${serial} logcat -b crash\`.`)
    }
    steps.push({ id: 'launch', status: 'ok', summary: `${act} started${startedOk.totalTimeMs !== null ? ` in ${startedOk.totalTimeMs} ms` : ''}${pid !== null ? ` (pid ${pid})` : ''}`, fix: null })
    result.ok = true

    // 7. The first screen: anything in front of the app a test would trip over, after the onboarding taps got past
    // what they could. Never fails the open, and a cancel here keeps the result (the app is already running).
    const saved = req.onboarding ?? []
    const replaying = saved.length > 0 || !!req.learnOnboarding
    // Steps are announced in the order they are reported: the first of onboarding / sign_in / first_screen that runs
    // reads the first screen.
    req.onStep?.(
      replaying ? 'onboarding' : req.signIn ? 'sign_in' : 'first_screen',
      replaying ? `reading the first screen to tap past it${req.learnOnboarding ? ' (learning new taps)' : ''}` : req.signIn ? 'reading the first screen for a sign-in form' : 'reading the first screen'
    )
    await host.delay(FIRST_SCREEN_SETTLE_MS, req.signal)
    let read: ScreenRead = req.signal?.aborted ? { skipped: 'cancelled before the screen was read' } : await readScreen(host, adbPath, serial)
    if (replaying) {
      const replay = await replayOnboarding(host, adbPath, serial, pkg, saved, !!req.learnOnboarding, read, req.signal)
      read = replay.read
      result.onboarding = { tapped: replay.tapped }
      steps.push(replay.step)
    } else {
      steps.push({ id: 'onboarding', status: 'skipped', summary: 'no onboarding taps to replay (none saved in a profile)', fix: null })
    }
    let typedSecrets: Array<[string, string]> = []
    if (req.signIn) {
      const signed = await signIn(host, adbPath, serial, pkg, req.signIn, req.inputs ?? {}, read, req.signal, req.onStep)
      read = signed.read
      result.sign_in = signed.done
      typedSecrets = signed.secrets
      steps.push(signed.step)
    } else {
      steps.push({ id: 'sign_in', status: 'skipped', summary: 'no sign_in section in a profile', fix: null })
    }
    if (replaying || req.signIn) req.onStep?.('first_screen', 'checking what is left in front of the app')
    if ('skipped' in read) steps.push({ id: 'first_screen', status: 'skipped', summary: read.skipped, fix: null })
    else {
      // The screen after a sign-in may show what was typed (a code in a plain text field, an echoed name): the text
      // read from it never carries a secret that was typed.
      const first = findFirstRunBlockers(read, pkg)
      result.first_screen = typedSecrets.length > 0 ? scrubScreen(first, typedSecrets) : first
      steps.push(firstScreenStep(result.first_screen, pkg))
    }
    return result
  } catch (err) {
    if (err instanceof Stop) return result
    throw err
  }
}

/** A first screen with every secret that was typed replaced by its placeholder in the text read from the screen. */
export function scrubScreen(screen: FirstScreen, secrets: ReadonlyArray<readonly [string, string]>): FirstScreen {
  const r = (t: string): string => redactSecrets(t, secrets)
  return {
    package: screen.package,
    blockers: screen.blockers.map((b) => ({
      ...b,
      summary: r(b.summary),
      fix: r(b.fix),
      tap_label: b.tap_label === null ? null : r(b.tap_label),
      tap: b.tap === null ? null : Object.fromEntries(Object.entries(b.tap).map(([k, v]) => [k, r(v)]))
    }))
  }
}

/** adb's answer counts as failed: an exit code, a timeout, or an exception printed with exit code 0 (old Androids). */
function shellFailed(r: ExecResult): boolean {
  return r.code !== 0 || !!r.error || /Exception|Error/.test(`${r.stdout}\n${r.stderr}`)
}

/** Dump and read the screen; a device that can't dump (old image, a screen that never goes idle) is a skip. */
async function readScreen(host: OpenHost, adb: string, serial: string): Promise<UiScreen | { skipped: string }> {
  const r = await host.exec(adb, ['-s', serial, 'shell', dumpLine(randomBytes(6).toString('hex'))], DUMP_TIMEOUT_MS)
  if (r.error === 'timeout') {
    // The dump is printed only once it is complete, so output with a kill means adb's output cap cut it, not a hang.
    return { skipped: r.stdout.includes('<hierarchy') ? 'could not read the screen: the dump is larger than 1 MB' : 'could not read the screen: uiautomator did not answer' }
  }
  try {
    return parseUiDump(r.stdout)
  } catch (err) {
    if (!(err instanceof DumpError)) throw err
    return { skipped: `could not read the screen: ${r.code !== 0 && !r.stdout.trim() ? said(r) : err.message}` }
  }
}

type ScreenRead = UiScreen | { skipped: string }

/**
 * Tap past the first-run screens: on each screen, the first saved tap that is on it (or, learning, the first blocker
 * Nawi names a tap for), then wait and read the screen again. Stops when nothing is left to tap, a tap changed
 * nothing, the screen can't be read, the call is cancelled, or after MAX_ONBOARDING_TAPS. Never fails the open.
 */
async function replayOnboarding(
  host: OpenHost,
  adb: string,
  serial: string,
  pkg: string,
  saved: readonly OnboardingTap[],
  learn: boolean,
  first: ScreenRead,
  signal: AbortSignal | undefined
): Promise<{ read: ScreenRead; tapped: OnboardingTapped[]; step: OpenStep }> {
  const tapped: OnboardingTapped[] = []
  const what = (t: OnboardingTapped): string => `${t.when.replace('_', ' ')} "${t.label}"${t.learned ? ' (learned)' : ''}`
  const done = (status: OpenStepStatus, summary: string, fix: string | null, read: ScreenRead) => ({
    read,
    tapped,
    step: { id: 'onboarding' as const, status, summary: tapped.length > 0 ? `tapped ${tapped.length}: ${tapped.map(what).join(', ')}${summary ? `; ${summary}` : ''}` : summary, fix }
  })
  let read = first
  if ('skipped' in read) return done('skipped', `no tap made: ${read.skipped}`, null, read)
  for (;;) {
    if (signal?.aborted) return done(tapped.length > 0 ? 'ok' : 'skipped', 'cancelled', null, read)
    const screen: UiScreen = read
    const next = nextOnboardingTap(screen, pkg, saved, learn)
    if (next === null) {
      if (tapped.length > 0) return done('ok', '', null, read)
      return done('skipped', saved.length > 0 ? 'none of the saved taps is on the screen' : 'nothing on the screen to tap past', null, read)
    }
    if (tapped.length >= MAX_ONBOARDING_TAPS) {
      return done('warn', `stopped after ${MAX_ONBOARDING_TAPS} taps`, `Something keeps coming back after a tap: look at the device, and remove the tap that repeats from the profile's onboarding section.`, read)
    }
    // Only numbers reach the shell: the coordinates come from the dump's bounds, parsed as integers.
    const r = await host.exec(adb, ['-s', serial, 'shell', `input tap ${next.x} ${next.y}`], SHELL_TIMEOUT_MS)
    if (shellFailed(r)) {
      return done('warn', `could not tap "${next.label}" (${r.error === 'timeout' ? 'the device did not answer' : said(r)})`, `Tap "${next.label}" on the device by hand.`, read)
    }
    const t: OnboardingTapped = { when: next.entry.when, tap: { ...next.entry.tap }, label: next.label, learned: next.learned }
    // A learned tap is reported (and so saved) only once the next screen shows it worked.
    if (!t.learned) tapped.push(t)
    const unverified = t.learned ? ` (tapped "${t.label}", not saved: its effect could not be checked)` : ''
    await host.delay(FIRST_SCREEN_SETTLE_MS, signal)
    // The screen read before the tap is out of date now: report nothing rather than a screen that is gone.
    if (signal?.aborted) return done('ok', `cancelled${unverified}`, null, { skipped: 'cancelled before the screen was read again' })
    const again = await readScreen(host, adb, serial)
    if ('skipped' in again) return done('warn', `${again.skipped.replace(/^could not/, 'then could not')}${unverified}`, 'The first-run screens may not all be past: look at the device.', again)
    if (screenKey(again) === screenKey(screen)) {
      return done(
        'warn',
        `the screen did not change after tapping "${t.label}"${t.learned ? ' (not saved)' : ''}`,
        t.learned ? `Get past this screen on the device by hand.` : `Tap "${t.label}" on the device by hand; if it is not the right element, remove it from the profile's onboarding section.`,
        again
      )
    }
    if (t.learned) tapped.push(t)
    read = again
  }
}

/**
 * Fill and submit the app's sign-in form with the profile's sign_in section, when a sign-in form is in front of the
 * app: per field, find it on the latest screen, tap it, clear it and type its value; then tap submit and wait (up to
 * SIGN_IN_TIMEOUT_MS) for the form to go. Never fails the open, and never reports a value, not even in an adb error.
 */
async function signIn(
  host: OpenHost,
  adb: string,
  serial: string,
  pkg: string,
  spec: SignInSpec,
  inputs: SignInInputs,
  first: ScreenRead,
  signal: AbortSignal | undefined,
  onStep: OpenRequest['onStep']
): Promise<{ read: ScreenRead; done: MobileOpenResult['sign_in']; step: OpenStep; secrets: Array<[string, string]> }> {
  let secrets: Array<[string, string]> = []
  const end = (status: OpenStepStatus, summary: string, fix: string | null, read: ScreenRead, done: MobileOpenResult['sign_in'] = null) => ({
    read,
    done,
    secrets,
    step: { id: 'sign_in' as const, status, summary, fix }
  })
  const wall = (screen: UiScreen): boolean => findFirstRunBlockers(screen, pkg).blockers.some((b) => b.kind === 'login_wall')
  if ('skipped' in first) return end('skipped', `not signed in: ${first.skipped}`, null, first)
  if (!wall(first)) return end('skipped', 'no sign-in form in front of the app', null, first)
  if (promptInFront(first)) {
    return end('warn', 'not signed in: a permission prompt is in front of the sign-in form', 'Grant that permission before launch (the profile\'s permissions.grant) or save a permission_dialog onboarding tap for it.', first)
  }
  const resolved = resolveSignIn(spec, inputs)
  if (!resolved.ok) {
    const names = resolved.missing.map((m) => (m.startsWith('secret.') ? `NAWI_SECRET_${m.slice(7)}` : m.slice(4)))
    return resolved.missing.length > 0
      ? end(
          'warn',
          `not signed in: the sign-in form needs ${resolved.missing.map((m) => `\${${m}}`).join(', ')}, which this open was not given`,
          `Set ${names.join(', ')} in the shell that runs \`nawi mobile-open\` (or pass mobile_open's secrets/env), then open the app again.`,
          first
        )
      : end('warn', `not signed in: ${resolved.bad.join('; ')}`, 'Fix those values (a test account with a plain ASCII user name and password), then open the app again.', first)
  }
  secrets = resolved.secrets
  onStep?.('sign_in', `signing in (${spec.fields.length} field${spec.fields.length === 1 ? '' : 's'})`)
  const shell = (line: string) => host.exec(adb, ['-s', serial, 'shell', line], SHELL_TIMEOUT_MS)
  // The reason without the device's own words: an error line from `input text` could echo what was typed.
  const why = (r: ExecResult): string => (r.error === 'timeout' ? 'the device did not answer' : r.error === 'not_found' ? 'adb could not be started' : 'the device refused the input')
  const checkFix = 'Compare the profile\'s sign_in locators with the screen (`adb shell uiautomator dump`), or sign in on the device by hand.'
  const n = spec.fields.length
  const progress = (fields: number, submitted = false) => ({ fields, submitted, signed_in: false })
  const cancelled = (fields: number, read: ScreenRead) => end('skipped', `cancelled after typing into ${fields} of ${n} sign-in field${n === 1 ? '' : 's'}`, null, read, progress(fields))
  /**
   * The on-screen keyboard is not in the dump, so an element under it can't be seen: hide it before the next tap.
   * Back only while Android says the keyboard is shown (then Back closes the keyboard, not the screen), and the screen
   * is read again, since the app lays itself out anew. A string: why it could not be done.
   */
  const hideKeyboard = async (screen: UiScreen): Promise<{ screen: ScreenRead } | string> => {
    const ime = await shell(KEYBOARD_SHOWN_LINE)
    if (shellFailed(ime) || !/mInputShown=true/.test(ime.stdout)) return { screen }
    const back = await shell('input keyevent KEYCODE_BACK')
    if (shellFailed(back)) return `could not hide the on-screen keyboard (${why(back)})`
    await host.delay(KEYBOARD_SETTLE_MS, signal)
    if (signal?.aborted) return { screen }
    return { screen: await readScreen(host, adb, serial) }
  }
  let screen: UiScreen = first
  for (const [i, f] of spec.fields.entries()) {
    if (signal?.aborted) return cancelled(i, screen)
    const what = `sign-in field ${i + 1}`
    if (i > 0) {
      const hidden = await hideKeyboard(screen)
      if (typeof hidden === 'string') return end('warn', `not signed in: before ${what}, ${hidden}`, 'Finish signing in on the device by hand.', screen, progress(i))
      if ('skipped' in hidden.screen) return end('warn', `not signed in: before ${what}, ${hidden.screen.skipped}`, 'Finish signing in on the device by hand.', hidden.screen, progress(i))
      screen = hidden.screen
      if (signal?.aborted) return cancelled(i, screen)
    }
    const at = locateOnApp(screen, pkg, f.field, what, true)
    if (!at.ok) return end('warn', `not signed in: ${at.why}`, checkFix, screen, progress(i))
    // Only numbers reach the shell for taps; typed values go through shQuote in typeLines.
    let r = await shell(`input tap ${at.at.x} ${at.at.y}`)
    const clear = clearLine(at.node.text.length)
    if (!shellFailed(r) && clear) r = await shell(clear)
    for (const line of shellFailed(r) ? [] : typeLines(resolved.values[i])) {
      r = await shell(line)
      if (shellFailed(r)) break
    }
    if (shellFailed(r)) return end('warn', `not signed in: could not type into ${what} (${why(r)})`, 'Sign in on the device by hand, then open the app again.', screen, progress(i))
    // The keyboard may have come up and moved things: find the next element on a fresh screen.
    const again = await readScreen(host, adb, serial)
    if ('skipped' in again) return end('warn', `not signed in: after ${what}, ${again.skipped}`, 'Finish signing in on the device by hand.', again, progress(i + 1))
    screen = again
  }
  const typed = `typed into ${n} field${n === 1 ? '' : 's'}`
  if (signal?.aborted) return cancelled(n, screen)
  const hidden = await hideKeyboard(screen)
  if (typeof hidden === 'string') return end('warn', `${typed}, not submitted: ${hidden}`, 'Tap the sign-in button on the device by hand.', screen, progress(n))
  if ('skipped' in hidden.screen) return end('warn', `${typed}, not submitted: after hiding the keyboard, ${hidden.screen.skipped}`, 'Tap the sign-in button on the device by hand.', hidden.screen, progress(n))
  screen = hidden.screen
  // A cancel must never be followed by a submit.
  if (signal?.aborted) return cancelled(n, screen)
  const button = locateOnApp(screen, pkg, spec.submit, 'sign-in button')
  if (!button.ok) {
    return end(
      'warn',
      `${typed}, not submitted: ${button.why}`,
      /covered by/.test(button.why) ? 'Another window is over the sign-in button: close it on the device, or tap the button by hand.' : checkFix,
      screen,
      progress(n)
    )
  }
  const label = labelOf(button.node) || button.node.resource_id.replace(/^.*:id\//, '') || 'submit'
  const tapped = await shell(`input tap ${button.at.x} ${button.at.y}`)
  if (shellFailed(tapped)) return end('warn', `${typed}, could not tap "${label}" (${why(tapped)})`, `Tap "${label}" on the device by hand.`, screen, progress(n))
  const deadline = host.now() + SIGN_IN_TIMEOUT_MS
  let read: ScreenRead = screen
  // The form counts as gone after two reads in a row without it: a "Signing in…" dialog in front of it for a moment
  // is not a sign-in.
  let gone = 0
  for (;;) {
    await host.delay(FIRST_SCREEN_SETTLE_MS, signal)
    if (signal?.aborted) return end('ok', `${typed}, tapped "${label}"; cancelled before the result was read`, null, { skipped: 'cancelled before the screen was read again' }, progress(n, true))
    read = await readScreen(host, adb, serial)
    if ('skipped' in read) return end('warn', `${typed}, tapped "${label}"; then ${read.skipped}`, 'Check on the device whether the sign-in worked.', read, progress(n, true))
    gone = wall(read) ? 0 : gone + 1
    if (gone >= 2) return end('ok', `signed in: ${typed}, tapped "${label}"`, null, read, { fields: n, submitted: true, signed_in: true })
    if (host.now() >= deadline) break
  }
  return end(
    'warn',
    gone > 0
      ? `${typed}, tapped "${label}"; the sign-in form went only at the last read, after ${SIGN_IN_TIMEOUT_MS / 1000} s`
      : `${typed}, tapped "${label}", but the sign-in form was still on screen after ${SIGN_IN_TIMEOUT_MS / 1000} s`,
    gone > 0 ? 'Check on the device whether the sign-in worked.' : 'Check the test account on the device: a wrong password, a second factor or a captcha keeps the form up.',
    read,
    progress(n, true)
  )
}

export function firstScreenStep(screen: FirstScreen, pkg: string): OpenStep {
  const [first, ...more] = screen.blockers
  if (first) {
    const also = more.length > 0 ? `; also ${more.map((b) => b.summary).join('; ')}` : ''
    return { id: 'first_screen', status: 'warn', summary: `${first.summary}${also}`, fix: first.fix }
  }
  if (screen.package !== null && screen.package !== pkg) {
    return {
      id: 'first_screen',
      status: 'warn',
      summary: `the screen shows ${screen.package}, not ${pkg}`,
      fix: `Look at the device: ${pkg} may have closed, or opened another app in front of itself.`
    }
  }
  return { id: 'first_screen', status: 'ok', summary: 'no permission prompt, consent, intro or sign-in screen in front of the app', fix: null }
}

type Chosen = OpenTarget | { summary: string; fix: string }

async function chooseTarget(req: OpenRequest, doctor: MobileDoctorReport, host: OpenHost, adb: string): Promise<Chosen> {
  const wanted = req.target ?? null
  // A running emulator answers `adb emu avd name` with its AVD name, then "OK".
  const avdNameOf = async (serial: string): Promise<string | null> => {
    const r = await host.exec(adb, ['-s', serial, 'emu', 'avd', 'name'], SHELL_TIMEOUT_MS)
    const name = r.code === 0 ? firstLine(r.stdout) : ''
    return name && name !== 'OK' && TARGET_RE.test(name) ? name : null
  }
  const runningAvds = async (): Promise<Map<string, string>> => {
    const out = new Map<string, string>()
    for (const d of doctor.devices.filter((x) => x.emulator && x.state === 'device')) {
      const name = await avdNameOf(d.serial)
      if (name) out.set(name, d.serial)
    }
    return out
  }
  const asDevice = async (serial: string): Promise<Chosen> => {
    const d = doctor.devices.find((x) => x.serial === serial)
    if (!d) return { summary: `no device ${serial}`, fix: `${serial} is not connected: run \`nawi mobile-doctor\` for the devices and virtual devices available.` }
    if (d.state !== 'device') {
      const check = doctor.checks.find((c) => c.id === 'devices')
      return { summary: `${serial} is ${d.state}`, fix: check?.fix ?? `Reconnect ${serial}, then retry.` }
    }
    if (d.compatible && !d.compatible.ok) return { summary: `${serial} can't run ${req.apk.package}: ${d.compatible.reason}`, fix: `Pick another device: \`nawi mobile-doctor <file.apk>\` lists the ones that can run it.` }
    // A running emulator is recorded by its AVD name: its serial (emulator-<port>) changes from boot to boot.
    const avdName = d.emulator ? await avdNameOf(serial) : null
    return avdName ? { kind: 'avd', name: avdName, serial, api: d.api, booted: false } : { kind: 'device', name: serial, serial, api: d.api, booted: false }
  }
  const asAvd = async (name: string): Promise<Chosen> => {
    const avd = doctor.avds.find((a) => a.name === name)
    if (!avd) return { summary: `no virtual device ${name}`, fix: `There is no device or virtual device named ${name}: run \`nawi mobile-doctor\` for the list.` }
    // Already running: use its serial instead of starting a second copy (the emulator refuses that anyway).
    const serial = (await runningAvds()).get(name)
    if (serial) {
      const d = await asDevice(serial)
      return 'fix' in d ? d : { ...d, kind: 'avd', name }
    }
    if (!doctor.emulator) return { summary: 'the Android emulator is not installed', fix: doctor.checks.find((c) => c.id === 'emulator')?.fix ?? 'Install the emulator (`sdkmanager "emulator"`).' }
    if (doctor.virtualization.status !== 'ok') {
      const v = doctor.checks.find((c) => c.id === 'virtualization')
      return { summary: `virtual devices can't start here: ${doctor.virtualization.detail}`, fix: v?.fix ?? 'Turn on hardware virtualization, then retry.' }
    }
    if (avd.compatible && !avd.compatible.ok) return { summary: `${name} can't run ${req.apk.package}: ${avd.compatible.reason}`, fix: doctor.checks.find((c) => c.id === 'avds')?.fix ?? 'Pick another virtual device (`nawi mobile-doctor <file.apk>`).' }
    return { kind: 'avd', name, serial: null, api: avd.api, booted: false }
  }

  if (wanted !== null) {
    if (doctor.devices.some((d) => d.serial === wanted)) return asDevice(wanted)
    return asAvd(wanted)
  }
  if (!doctor.recommended) return { summary: 'no device or virtual device can run the app', fix: doctor.fix ?? 'Run `nawi mobile-doctor <file.apk>` for what is missing.' }
  return doctor.recommended.kind === 'device' ? asDevice(doctor.recommended.name) : asAvd(doctor.recommended.name)
}

/**
 * Poll the device's default network until it is `want`, or the deadline passes. 'unreadable' when three reads in a row
 * print no network state (an Android whose dumpsys says something else): waiting longer would not tell us more.
 */
async function waitForNetwork(host: OpenHost, adb: string, serial: string, want: 'up' | 'down', signal?: AbortSignal): Promise<'ok' | 'timeout' | 'unreadable'> {
  const deadline = host.now() + NETWORK_SETTLE_TIMEOUT_MS
  let unread = 0
  for (;;) {
    if (signal?.aborted) return 'timeout'
    const left = deadline - host.now()
    if (left <= 0) return 'timeout'
    const r = await host.exec(adb, ['-s', serial, 'shell', DEFAULT_NETWORK_LINE], Math.max(1_000, Math.min(SHELL_TIMEOUT_MS, left)))
    const state = parseDefaultNetwork(`${r.stdout}\n${r.stderr}`)
    if (state === want) return 'ok'
    unread = state === null ? unread + 1 : 0
    if (unread >= 3) return 'unreadable'
    await host.delay(Math.min(NETWORK_POLL_MS, Math.max(0, deadline - host.now())), signal)
  }
}

/** Poll `sys.boot_completed` until it is 1, the emulator exits, or the deadline (wall time, adb calls included) passes. */
async function waitForBoot(host: OpenHost, adb: string, serial: string, proc: Spawned, timeoutMs: number, signal?: AbortSignal): Promise<'ok' | 'exited' | 'timeout'> {
  const deadline = host.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) return 'timeout'
    if (proc.exitCode() !== null) return 'exited'
    const left = deadline - host.now()
    if (left <= 0) return 'timeout'
    const r = await host.exec(adb, ['-s', serial, 'shell', 'getprop sys.boot_completed'], Math.max(1_000, Math.min(SHELL_TIMEOUT_MS, left)))
    if (r.code === 0 && r.stdout.trim() === '1') return 'ok'
    await host.delay(Math.min(BOOT_POLL_MS, Math.max(0, deadline - host.now())), signal)
  }
}
