import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { RUN_ID_RE } from '../run-record'
import { defaultHost, runMobileDoctor, type DoctorHost, type MobileDoctorReport } from './doctor'
import { frontPackage, PERMISSION_PACKAGES } from './blockers'
import type { UiScreen } from './hierarchy'
import { KEYBOARD_SHOWN_LINE, readScreen, runningAvdName } from './open'
import { decodePng, type RgbImage } from './png'
import { PACKAGE_RE, TARGET_RE } from './profile'
import { captureScreen, execBinary, type BinaryExec } from './screen'
import { parseDensity, studyScreen, type ScreenStudy } from './study'
import { secretRedactor } from '../../shared/flow/interpolate'

/**
 * Roadmap M3 (second slice, M3b): study the screen a device shows right now. Reads it the way mobile_open does
 * (`uiautomator dump`), measures with the device's density (`wm density`), takes a screenshot (`screencap`), and
 * hands the dump and the decoded screenshot to studyScreen (M3a; contrast from the screenshot, M3b2). Nothing is installed, launched, tapped or booted: the device must already be
 * connected (a phone, or an emulator mobile_open started), so a study never changes what it looks at.
 *
 * Secret values the caller typed into the app (a sign-in) are scrubbed from everything the study reports. A
 * screenshot can't be scrubbed, so when a secret value is on the screen the screenshot is left out and the result
 * says why. Password fields are never a problem: Android does not put their text in the dump (and studyScreen drops
 * it anyway). Electron-free; adb is injectable so tests never touch a device.
 */

export interface StudyHost extends DoctorHost {
  execBinary: BinaryExec
}

export function defaultStudyHost(): StudyHost {
  return { ...defaultHost(), execBinary }
}

export interface LiveStudyRequest {
  /** An adb serial or the AVD name of a running emulator; default: the only device connected. */
  target?: string | null
  /** The app whose views are judged; default: the app in front. */
  package?: string | null
  /** Values typed into the app (name -> value), scrubbed from the result. */
  secrets?: Readonly<Record<string, string>>
}

export interface LiveStudyResult {
  ok: boolean
  /** The one next step when not ok. */
  fix: string | null
  /** What went wrong when not ok, one sentence. */
  error: string | null
  target: { kind: 'device' | 'avd'; name: string; serial: string; api: number | null } | null
  study: ScreenStudy | null
  /** The screen as a PNG; null with screenshot_error saying why. */
  screenshot: { png: Uint8Array; width: number; height: number } | null
  screenshot_error: string | null
}

const SHELL_TIMEOUT_MS = 30_000

/** Windows that are Android's, not the app's: the permission prompt and the status bar / notification shade. */
const SYSTEM_PACKAGES: ReadonlySet<string> = new Set([...PERMISSION_PACKAGES, 'com.android.systemui'])

type Target = NonNullable<LiveStudyResult['target']>

/** The connected device to study, or why there is none. Never boots one: a study looks at what is already there. */
async function pickTarget(doctor: MobileDoctorReport, host: StudyHost, adb: string, wanted: string | null): Promise<Target | { error: string; fix: string }> {
  const online = doctor.devices.filter((d) => d.state === 'device')
  const asTarget = async (serial: string, api: number | null, emulator: boolean): Promise<Target> => {
    const avd = emulator ? await runningAvdName(host, adb, serial) : null
    return avd ? { kind: 'avd', name: avd, serial, api } : { kind: 'device', name: serial, serial, api }
  }
  if (wanted !== null) {
    const bySerial = doctor.devices.find((d) => d.serial === wanted)
    if (bySerial) {
      if (bySerial.state !== 'device') {
        const check = doctor.checks.find((c) => c.id === 'devices')
        return { error: `${wanted} is ${bySerial.state}`, fix: check?.fix ?? `Reconnect ${wanted}, then retry.` }
      }
      return asTarget(bySerial.serial, bySerial.api, bySerial.emulator)
    }
    const emulators = online.filter((x) => x.emulator)
    const names = await Promise.all(emulators.map((d) => runningAvdName(host, adb, d.serial)))
    const running = emulators.find((_, k) => names[k] === wanted)
    if (running) return { kind: 'avd', name: wanted, serial: running.serial, api: running.api }
    const isAvd = doctor.avds.some((a) => a.name === wanted)
    return isAvd
      ? { error: `virtual device ${wanted} is not running`, fix: `Start it with the app on it first: \`nawi mobile-open <file.apk> --target ${wanted}\`.` }
      : { error: `no device ${wanted}`, fix: `${wanted} is not connected: run \`nawi mobile-doctor\` for the devices available.` }
  }
  if (online.length === 0) {
    // A phone that is plugged in but unauthorized/offline, or adb not answering: the doctor's devices check names it.
    const check = doctor.checks.find((c) => c.id === 'devices')
    if (doctor.devices.length > 0 && check?.fix) {
      return { error: `no device is ready (${doctor.devices.map((d) => `${d.serial} is ${d.state}`).join(', ')})`, fix: check.fix }
    }
    return { error: 'no device is connected', fix: 'Connect a phone with USB debugging on, or start the app on a virtual device with `nawi mobile-open <file.apk>`, then study it.' }
  }
  if (online.length > 1) {
    return { error: `${online.length} devices are connected (${online.map((d) => d.serial).join(', ')})`, fix: 'Say which one to study with target (an adb serial or the AVD name of a running emulator).' }
  }
  return asTarget(online[0].serial, online[0].api, online[0].emulator)
}

/** Every string a study reports, with each secret value replaced by its `${secret.name}` placeholder. */
export function scrubStudy(study: ScreenStudy, secrets: ReadonlyArray<readonly [string, string]>): ScreenStudy {
  if (secrets.length === 0) return study
  const r = secretRedactor(secrets)
  return {
    ...study,
    elements: study.elements.map((e) => ({
      ...e,
      content_desc: r(e.content_desc),
      text: r(e.text),
      hint: r(e.hint),
      label: r(e.label),
      locator: e.locator === null ? null : Object.fromEntries(Object.entries(e.locator).map(([k, v]) => [k, r(v)]))
    })),
    findings: study.findings.map((f) => ({ ...f, summary: r(f.summary), fix: r(f.fix) })),
    notes: study.notes.map(r)
  }
}

/**
 * The app whose views are judged when the caller names none: the first window that is not Android's own (a
 * permission prompt in front of the app is not the app's to fix). Null when only Android's windows are on screen.
 */
export function appPackage(screen: UiScreen): string | null {
  return screen.nodes.find((n) => n.package !== '' && !SYSTEM_PACKAGES.has(n.package))?.package ?? null
}

/** Whether a secret value is on the screen (in what the dump read): then the screenshot shows it too. */
export function showsSecret(screen: UiScreen, secrets: ReadonlyArray<readonly [string, string]>): boolean {
  const r = secretRedactor(secrets)
  return screen.nodes.some((n) => [n.text, n.content_desc, n.hint].some((t) => t !== '' && r(t) !== t))
}

export async function studyLiveScreen(req: LiveStudyRequest, host: StudyHost = defaultStudyHost()): Promise<LiveStudyResult> {
  if (req.target != null && !TARGET_RE.test(req.target)) throw new Error(`"${req.target}" is not an adb serial or AVD name.`)
  if (req.package != null && !PACKAGE_RE.test(req.package)) throw new Error(`"${req.package}" is not an Android package name.`)
  const secrets = Object.entries(req.secrets ?? {}).filter(([, v]) => v.length > 0)
  const result: LiveStudyResult = { ok: false, fix: null, error: null, target: null, study: null, screenshot: null, screenshot_error: null }
  const redact = secretRedactor(secrets)
  const stop = (error: string, fix: string): LiveStudyResult => ({ ...result, error: redact(error), fix: redact(fix) })

  const doctor = await runMobileDoctor(null, host)
  const adb = doctor.adb?.path
  if (!adb) return stop('adb is not available', doctor.fix ?? 'Install the Android SDK Platform-Tools and set ANDROID_HOME.')
  const target = await pickTarget(doctor, host, adb, req.target ?? null)
  if ('fix' in target) return stop(target.error, target.fix)
  result.target = target
  const { serial } = target

  const screen = await readScreen(host, adb, serial)
  if ('skipped' in screen) {
    return stop(screen.skipped, `Check that ${serial} shows an unlocked screen and answers \`adb -s ${serial} shell uiautomator dump\`, then retry.`)
  }
  const density = await host.exec(adb, ['-s', serial, 'shell', 'wm density'], SHELL_TIMEOUT_MS)
  const densityDpi = density.code === 0 ? parseDensity(density.stdout) : null
  const pkg = req.package ?? appPackage(screen)
  const shot = await takeScreenshot(host, adb, serial, screen, secrets)
  let image: RgbImage | null = null
  let keyboardShown = false
  let noScreenshotReason = shot.ok ? null : `there is no screenshot (${shot.error})`
  if (pkg === null) {
    noScreenshotReason = "only Android's own windows are on screen"
  } else if (shot.ok) {
    const decoded = decodePng(shot.frame.png)
    if (decoded.ok) {
      image = decoded.image
      // uiautomator leaves the keyboard's window out of the dump: ask the input method service instead.
      const ime = await host.exec(adb, ['-s', serial, 'shell', KEYBOARD_SHOWN_LINE], SHELL_TIMEOUT_MS)
      keyboardShown = ime.code === 0 && /mInputShown=true/.test(ime.stdout)
    } else noScreenshotReason = `the screenshot could not be read (${decoded.error})`
  }
  let study = studyScreen(screen, { package: pkg ?? frontPackage(screen.nodes), densityDpi, screenshot: image, noScreenshotReason, keyboardShown })
  if (pkg === null) {
    // Only Android's own windows: nothing on screen is the app's to fix.
    study = { ...study, findings: [], notes: [...study.notes, 'Only Android\'s own windows are on screen (a permission prompt, the notification shade): nothing was judged. Get past it (mobile_open with learn_onboarding taps it), then study again.'] }
  }
  result.study = scrubStudy(study, secrets)
  result.ok = true
  if (shot.ok) result.screenshot = { png: shot.frame.png, width: shot.frame.width, height: shot.frame.height }
  else result.screenshot_error = redact(shot.error)
  return result
}

/**
 * The screenshot to keep, or why there is none. With secrets, none is taken while one shows in the dump, and the
 * screen is read again after it (a "show password" tap, the next page) so the picture is kept only if a secret is
 * on neither read.
 */
async function takeScreenshot(
  host: StudyHost,
  adb: string,
  serial: string,
  screen: UiScreen,
  secrets: ReadonlyArray<readonly [string, string]>
): Promise<{ ok: true; frame: { png: Uint8Array; width: number; height: number } } | { ok: false; error: string }> {
  const secretOnScreen = 'not taken: a secret value typed into the app is on the screen, and a screenshot cannot be scrubbed'
  if (secrets.length > 0 && showsSecret(screen, secrets)) return { ok: false, error: secretOnScreen }
  const frame = await captureScreen(adb, serial, host.execBinary)
  if (!frame.ok) return { ok: false, error: `${frame.error.replace(/\.$/, '')}; \`adb -s ${serial} exec-out screencap -p > screen.png\` shows why` }
  if (secrets.length > 0) {
    const after = await readScreen(host, adb, serial)
    if ('skipped' in after) return { ok: false, error: 'not kept: secrets were given and the screen could not be read again after the screenshot to check it shows none' }
    if (showsSecret(after, secrets)) return { ok: false, error: secretOnScreen }
  }
  return { ok: true, frame }
}

/** How many saved studies to keep (oldest go first), like the saved runs. */
export const DEFAULT_KEEP_STUDIES = 100

/**
 * Save a study as `<root>/<id>/study.json` (+ `screen.png` when there is a screenshot), written to a temp folder and
 * renamed so a folder that exists is complete. Returns the folder and the screenshot's path (null without one).
 */
export async function writeStudy(
  root: string,
  id: string,
  saved: { study: ScreenStudy; target: LiveStudyResult['target']; taken_at: string },
  png: Uint8Array | null
): Promise<{ dir: string; screenshot: string | null }> {
  if (!RUN_ID_RE.test(id)) throw new Error(`not a study id: ${JSON.stringify(id)}`)
  await fs.mkdir(root, { recursive: true })
  const dir = join(root, id)
  const temp = join(root, `.tmp-${id}`)
  try {
    await fs.mkdir(temp)
    if (png) await fs.writeFile(join(temp, 'screen.png'), png)
    await fs.writeFile(join(temp, 'study.json'), `${JSON.stringify({ study_id: id, ...saved, screenshot: png ? 'screen.png' : null }, null, 2)}\n`)
    await fs.rename(temp, dir)
  } catch (err) {
    await fs.rm(temp, { recursive: true, force: true })
    throw err
  }
  return { dir, screenshot: png ? join(dir, 'screen.png') : null }
}
