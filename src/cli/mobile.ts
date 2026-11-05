import { resolve } from 'node:path'
import type { ApkInfo } from '../main/mobile/apk'
import type { CheckStatus, MobileDoctorReport } from '../main/mobile/doctor'
import type { FrameworkInfo } from '../main/mobile/framework'
import type { MobileOpenResult, OpenStepStatus } from '../main/mobile/open'

/**
 * `nawi mobile-inspect <file.apk>` — the CLI half of the `inspect_apk` tool (roadmap M1). Pure functions so the
 * argument handling and the output are unit-tested without a running app. Like `nawi run`, the only thing added
 * over the generic command path is a positional file resolved against the shell's folder (the app's cwd is not
 * the user's).
 */

export const MOBILE_INSPECT_USAGE = `nawi mobile-inspect <file.apk> [--json]

  Reads an Android app package without installing it: package, versions, SDK levels, launcher activity,
  native ABIs, debuggable, permissions (runtime ones marked), deep links, exported components, and the UI
  framework (native, Flutter, React Native, game engine, WebView) with how Nawi reads its screen.
  An .aab is refused with the bundletool command that converts it.`

export class MobileUsageError extends Error {}

export const MOBILE_DOCTOR_USAGE = `nawi mobile-doctor [file.apk] [--json]

  Checks whether this machine can run an Android app: the SDK, adb, the emulator, hardware virtualization,
  connected devices and virtual devices (AVDs). With an APK, each device is matched against the app's min SDK and
  native ABIs. Prints the device to use, or the one thing to fix. Exit 0 when ready, 1 when not.`

/** The positional APK argument shared by the mobile commands; `required: false` allows none (mobile-doctor). */
function parseApkArg(argv: string[], cwd: string, required: boolean): { file: string | undefined; json: boolean } {
  let file: string | undefined
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') json = true
    else if (a === '--file') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new MobileUsageError('--file needs a path.')
      if (file !== undefined) throw new MobileUsageError('Give one APK file.')
      file = v
    } else if (a.startsWith('--')) throw new MobileUsageError(`Unknown flag ${a}.`)
    else if (file !== undefined) throw new MobileUsageError('Give one APK file.')
    else file = a
  }
  if (file === undefined && required) throw new MobileUsageError('Which APK? nawi mobile-inspect <file.apk>')
  return { file: file === undefined ? undefined : resolve(cwd, file), json }
}

export function parseMobileInspectArgs(argv: string[], cwd: string): { file: string; json: boolean } {
  const { file, json } = parseApkArg(argv, cwd, true)
  return { file: file as string, json }
}

export function parseMobileDoctorArgs(argv: string[], cwd: string): { file: string | undefined; json: boolean } {
  return parseApkArg(argv, cwd, false)
}

const MARK: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skipped: '-   ' }

/** A terminal summary of a mobile_doctor report; `--json` prints the object itself. */
export function renderDoctorReport(r: MobileDoctorReport): string {
  const target = r.recommended ? `${r.recommended.kind === 'device' ? 'device' : 'virtual device'} ${r.recommended.name}` : null
  const lines = [r.ready ? `Ready${r.apk ? ` to run ${r.apk.package}` : ''}: use ${target}.` : `Not ready${r.apk ? ` to run ${r.apk.package}` : ''}.`]
  for (const c of r.checks) lines.push(`  ${MARK[c.status]}  ${c.id.padEnd(15)}${c.summary}`)
  if (r.fix) lines.push('', `Next: ${r.fix}`)
  return lines.join('\n')
}

const FRAMEWORK_LABEL: Record<FrameworkInfo['kind'], string> = { native: 'native Android', flutter: 'Flutter', react_native: 'React Native', game_engine: 'game engine', webview: 'WebView (hybrid web app)' }
const STRATEGY_LABEL: Record<FrameworkInfo['read_strategy'], string> = {
  accessibility: 'the accessibility tree',
  flutter_semantics: 'Flutter\'s semantics tree',
  webview_cdp: 'the WebView\'s DOM over DevTools',
  screenshot: 'screenshots only (no element tree)'
}

/** A terminal summary of an inspect_apk result; `--json` prints the object itself. */
export function renderApkInfo(info: ApkInfo): string {
  const version = [info.version_name, info.version_code !== null ? `(${info.version_code})` : null].filter(Boolean).join(' ')
  const lines = [
    `${info.package}${version ? ` ${version}` : ''}`,
    `  SDK          min ${info.min_sdk}, target ${info.target_sdk}`,
    `  launcher     ${info.launcher_activity ?? '(none: the app has no launcher activity)'}`,
    `  ABIs         ${info.abis.length ? info.abis.join(', ') : 'any (no native code)'}`,
    `  debuggable   ${info.debuggable ? 'yes' : 'no'}`,
    `  framework    ${FRAMEWORK_LABEL[info.framework.kind]}, screen read from ${STRATEGY_LABEL[info.framework.read_strategy]}${info.framework.also.length ? ` (also found: ${info.framework.also.map((k) => FRAMEWORK_LABEL[k]).join(', ')})` : ''}`,
    ...(info.framework.evidence.length ? [`    decided by ${info.framework.evidence.join(', ')}`] : []),
    `    ${info.framework.note}`
  ]
  const runtime = info.permissions.filter((p) => p.runtime)
  lines.push(`  permissions  ${info.permissions.length} (${runtime.length} runtime${runtime.length ? `: ${runtime.map((p) => p.name.replace(/^android\.permission\./, '')).join(', ')}` : ''})`)
  if (info.deep_links.length === 0) lines.push('  deep links   none')
  else {
    lines.push(`  deep links   ${info.deep_links.length}`)
    for (const d of info.deep_links) lines.push(`    ${d.uri}${d.auto_verify ? ' (verified)' : ''} -> ${d.component}`)
  }
  if (info.exported_components.length === 0) lines.push('  exported     none')
  else {
    lines.push(`  exported     ${info.exported_components.length}`)
    for (const c of info.exported_components) lines.push(`    ${c.kind} ${c.name}${c.why === 'intent-filter' ? ' (implicit: intent filter, no android:exported)' : ''}`)
  }
  if (info.unresolved.length > 0) {
    lines.push(`  unresolved   ${info.unresolved.length} (resource references, not read yet)`)
    for (const u of info.unresolved) lines.push(`    ${u}`)
  }
  return lines.join('\n')
}

export const MOBILE_OPEN_USAGE = `nawi mobile-open <file.apk | profile.nawi.mobile.yaml> [--target <serial|avd>] [--headless]
                 [--no-grant] [--profile <out.nawi.mobile.yaml> | --no-profile] [--boot-timeout-ms n] [--json]

  Installs an Android app on a device and starts it: picks a connected device or boots a virtual device (AVD)
  that can run it, installs the app, grants its runtime permissions, applies device settings (on a virtual
  device: en-US, light theme, font scale 1, animations off) and starts its launcher activity. On success
  it saves a mobile profile (next to the .apk as <package>.nawi.mobile.yaml unless --profile says where) that
  repeats the same setup when passed instead of the .apk. Exit 0 when the app is running, 1 when not.`

export interface MobileOpenArgs {
  file: string
  json: boolean
  target?: string
  headless?: true
  grant?: false
  save_profile?: false
  profile?: string
  boot_timeout_ms?: number
}

/** `nawi mobile-open` arguments; paths are resolved against the shell's folder like the other mobile commands. */
export function parseMobileOpenArgs(argv: string[], cwd: string): MobileOpenArgs {
  let file: string | undefined
  const out: Omit<MobileOpenArgs, 'file'> = { json: false }
  const value = (flag: string, v: string | undefined): string => {
    if (v === undefined || v.startsWith('--')) throw new MobileUsageError(`${flag} needs a value.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--headless') out.headless = true
    else if (a === '--no-grant') out.grant = false
    else if (a === '--no-profile') out.save_profile = false
    else if (a === '--target') out.target = value(a, argv[++i])
    else if (a === '--profile') out.profile = resolve(cwd, value(a, argv[++i]))
    else if (a === '--boot-timeout-ms') {
      const v = value(a, argv[++i])
      if (!/^\d+$/.test(v) || Number(v) < 10_000 || Number(v) > 900_000) throw new MobileUsageError('--boot-timeout-ms needs a whole number of milliseconds from 10000 to 900000.')
      out.boot_timeout_ms = Number(v)
    } else if (a === '--file') {
      if (file !== undefined) throw new MobileUsageError('Give one APK or profile.')
      file = value(a, argv[++i])
    } else if (a.startsWith('--')) throw new MobileUsageError(`Unknown flag ${a}.`)
    else if (file !== undefined) throw new MobileUsageError('Give one APK or profile.')
    else file = a
  }
  if (file === undefined) throw new MobileUsageError('Which app? nawi mobile-open <file.apk | profile.nawi.mobile.yaml>')
  if (out.profile !== undefined && out.save_profile === false) throw new MobileUsageError('--profile and --no-profile contradict each other.')
  return { file: resolve(cwd, file), ...out }
}

const STEP_MARK: Record<OpenStepStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skipped: '-   ' }

export type MobileOpenReport = MobileOpenResult & { apk: string; sha256: string | null; profile: string | null; profile_error: string | null; apk_changed: boolean | null }

/** A terminal summary of a mobile_open result; `--json` prints the object itself. */
export function renderOpenResult(r: MobileOpenReport): string {
  const where = r.target ? ` on ${r.target.kind === 'avd' ? `virtual device ${r.target.name}${r.target.serial ? ` (${r.target.serial})` : ''}` : `device ${r.target.name}`}` : ''
  const lines = [r.ok ? `${r.package} is running${where}.` : `${r.package} is not running${where}.`]
  for (const s of r.steps) lines.push(`  ${STEP_MARK[s.status]}  ${s.id.padEnd(13)}${s.summary}`)
  if (r.apk_changed) lines.push('', `The .apk changed since the profile was saved (its SHA-256 differs)${r.profile ? '; the profile now records the new one' : ''}.`)
  if (r.profile) lines.push('', `Profile: ${r.profile}`)
  if (r.profile_error) lines.push('', `Profile not saved: ${r.profile_error}`)
  const notes = r.steps.filter((s) => s.status === 'warn' && s.fix)
  if (r.fix) lines.push('', `Next: ${r.fix}`)
  else if (notes.length > 0) lines.push('', ...notes.map((s) => `Note: ${s.fix}`))
  return lines.join('\n')
}
