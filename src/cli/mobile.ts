import { resolve } from 'node:path'
import { MAX_MOBILE_PROFILE_BYTES, MOBILE_PROFILE_SUFFIX } from '../shared/mobile'
import { readBoundedText, type TextFs } from './run'
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
                 [--no-grant] [--learn-onboarding] [--profile <out.nawi.mobile.yaml> | --no-profile]
                 [--boot-timeout-ms n] [--json]

  Installs an Android app on a device and starts it: picks a connected device or boots a virtual device (AVD)
  that can run it, installs the app, grants its runtime permissions, applies device settings (on a virtual
  device: en-US, light theme, font scale 1, animations off, network on) and starts its launcher activity. On success
  it saves a mobile profile (next to the .apk as <package>.nawi.mobile.yaml unless --profile says where) that
  repeats the same setup when passed instead of the .apk, including its onboarding taps (tapped past the
  first-run screens after launch). --learn-onboarding also taps past the permission prompts, consent and
  intro screens Nawi recognises (accepting them on that device) and saves those taps in the profile.
  A profile's sign_in section fills in a sign-in form still in front of the app: its \${secret.name} values
  come from NAWI_SECRET_<name> (or NAWI_SECRET_<NAME>), \${env.NAME} from this shell; only the names the
  profile mentions are sent, and never saved.
  Exit 0 when the app is running, 1 when not.`

export interface MobileOpenArgs {
  file: string
  json: boolean
  target?: string
  headless?: true
  grant?: false
  save_profile?: false
  learn_onboarding?: true
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
    else if (a === '--learn-onboarding') out.learn_onboarding = true
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

/**
 * The profile text the CLI may read to find its sign_in references, or null: only a regular *.nawi.mobile.yaml
 * within the app's size limit; anything else is left for the app to refuse with the real reason.
 */
export function readProfileText(file: string, fs: TextFs): string | null {
  return file.toLowerCase().endsWith(MOBILE_PROFILE_SUFFIX) ? readBoundedText(file, MAX_MOBILE_PROFILE_BYTES, fs) : null
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
  if (r.profile_error) lines.push('', r.profile ? `Note: ${r.profile_error}` : `Profile not saved: ${r.profile_error}`)
  const notes = r.steps.filter((s) => s.status === 'warn' && s.fix)
  if (r.fix) lines.push('', `Next: ${r.fix}`)
  else if (notes.length > 0) lines.push('', ...notes.map((s) => `Note: ${s.fix}`))
  return lines.join('\n')
}

export const MOBILE_STUDY_USAGE = `nawi mobile-study [--target <serial|avd>] [--package <name>] [--secret <name>]... [--json]

  Studies the screen a connected Android device shows now (start the app with mobile-open first): every element a
  test or a person can act on, the locator that finds it again, and what to fix (unlabeled controls, touch targets
  under 48 dp, shared or missing view ids, locators that rest only on text or position). Saves the study and a
  screenshot in Nawi's studies folder. Nothing is installed, tapped or booted. --target picks the device when
  several are connected; --package names the app to judge (default: the app in front). --secret <name> scrubs the
  value of NAWI_SECRET_<name> (typed into the app, e.g. to sign in) from the result, and skips the screenshot if
  it is on the screen. Exit 0 when the screen was studied, 1 when not.`

export interface MobileStudyArgs {
  json: boolean
  target?: string
  package?: string
  /** Names whose NAWI_SECRET_<name> values the CLI sends to be scrubbed. */
  secret: string[]
}

const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/

export function parseMobileStudyArgs(argv: string[]): MobileStudyArgs {
  const out: MobileStudyArgs = { json: false, secret: [] }
  const value = (flag: string, v: string | undefined): string => {
    if (v === undefined || v.startsWith('--')) throw new MobileUsageError(`${flag} needs a value.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--target') out.target = value(a, argv[++i])
    else if (a === '--package') out.package = value(a, argv[++i])
    else if (a === '--secret') {
      const name = value(a, argv[++i])
      if (!SECRET_NAME_RE.test(name)) throw new MobileUsageError(`--secret takes a name (letters, digits, _), not "${name.slice(0, 40)}".`)
      if (!out.secret.includes(name)) out.secret.push(name)
    } else if (a.startsWith('--')) throw new MobileUsageError(`Unknown flag ${a}.`)
    else throw new MobileUsageError(`mobile-study takes no file: it studies the device's current screen (got "${a.slice(0, 80)}").`)
  }
  return out
}

/** What `nawi mobile-study` prints; mobile_study's structured result. */
export interface MobileStudyReport {
  ok: boolean
  error: string | null
  fix: string | null
  target: { kind: 'device' | 'avd'; name: string; serial: string; api: number | null } | null
  study_id: string | null
  screen_id?: string
  package?: string | null
  density_dpi?: number | null
  elements?: Array<{ locator_basis: string }>
  elements_total?: number
  save_error?: string | null
  findings?: Array<{ kind: string; severity: string; summary: string; fix: string }>
  notes?: string[]
  screenshot: string | null
  screenshot_error: string | null
}

const SEVERITY_MARK: Record<string, string> = { error: 'FAIL', warning: 'warn', info: 'info' }

/** A terminal summary of a mobile_study result; `--json` prints the object itself. */
export function renderStudyResult(r: MobileStudyReport): string {
  const where = r.target ? (r.target.kind === 'avd' ? `virtual device ${r.target.name} (${r.target.serial})` : `device ${r.target.name}`) : null
  if (!r.ok) return [`Could not study the screen${where ? ` of ${where}` : ''}: ${r.error ?? 'unknown error'}.`, ...(r.fix ? ['', `Next: ${r.fix}`] : [])].join('\n')
  const elements = r.elements ?? []
  const byBasis = new Map<string, number>()
  for (const e of elements) byBasis.set(e.locator_basis, (byBasis.get(e.locator_basis) ?? 0) + 1)
  const basis = ['resource_id', 'content_desc', 'text', 'index'].filter((b) => byBasis.has(b)).map((b) => `${byBasis.get(b)} by ${b === 'index' ? 'position only' : b}`)
  const findings = r.findings ?? []
  const lines = [
    `Screen ${r.screen_id}${r.package ? ` of ${r.package}` : ''} on ${where}${r.density_dpi ? `, ${r.density_dpi} dpi` : ''}.`,
    `  elements   ${elements.length}${basis.length ? ` (${basis.join(', ')})` : ''}`,
    `  findings   ${findings.length === 0 ? 'none' : findings.length}`
  ]
  for (const f of findings) lines.push(`    ${SEVERITY_MARK[f.severity] ?? f.severity}  ${f.summary}`, `          Fix: ${f.fix}`)
  for (const n of r.notes ?? []) lines.push(`  note       ${n}`)
  if ((r.elements_total ?? elements.length) > elements.length) lines.push(`  (${elements.length} of ${r.elements_total} elements shown; the saved study.json has them all)`)
  if (r.save_error) lines.push('', `Not saved: ${r.save_error.replace(/\.$/, '')}.`)
  lines.push('', r.screenshot ? `Screenshot: ${r.screenshot}` : `No screenshot: ${(r.screenshot_error ?? 'none taken').replace(/\.$/, '')}.`)
  return lines.join('\n')
}
