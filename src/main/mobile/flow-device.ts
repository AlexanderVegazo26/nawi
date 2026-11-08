import { defaultHost, runMobileDoctor, type DoctorHost, type ExecResult } from './doctor'
import { failed, why, type AndroidReplayHost } from './flow-replay'
import { defaultOpenHost, parseAmStart } from './open'
import { TARGET_RE } from './profile'
import { shQuote } from './shell'
import { execBinary } from './screen'
import { pickTarget, type LiveStudyResult } from './study-live'

/**
 * Roadmap M5b (first part): get a device ready for an android flow run (`run_flow` / `nawi run` on a flow with
 * `target.kind: android`). Picks the device the way mobile_study does (the one connected, or the serial / AVD name the
 * caller gave; never boots one), checks the flow's app is installed, and starts it from its launcher activity after a
 * force-stop, so every run begins on the app's first screen like a browser run begins on a fresh profile. With
 * `launch: false` the app is left as it is (a run that continues from where a person or mobile_open left it).
 *
 * Nothing is installed or granted here: an app that is missing is a refusal that names `nawi mobile-open`. What reaches
 * the device's shell: the package name (validated by the flow schema) and the launcher component the device itself
 * resolved (checked against a strict pattern), both quoted. Electron-free; adb, the clock and the delays are
 * injectable, so tests drive a fake adb.
 */

export interface AndroidRunHost extends DoctorHost, AndroidReplayHost {}

/** The real host: the doctor's adb lookup, screenshots, real delays, and an epoch clock (step timestamps are epoch ms). */
export function defaultAndroidRunHost(): AndroidRunHost {
  return {
    ...defaultHost(),
    execBinary,
    delay: defaultOpenHost().delay,
    now: Date.now
  }
}

export type AndroidRunTarget = NonNullable<LiveStudyResult['target']>

export interface AndroidRunDevice {
  adb: string
  target: AndroidRunTarget
  /** The activity started for the run; null with `launch: false`. */
  launched: { activity: string } | null
}

/** Why the run can't start on a device, and the one thing to do about it. */
export interface AndroidRunRefusal {
  error: string
  fix: string
}

/** The run was stopped (kill switch, cancel) while the device was being readied; the app was not restarted after it. */
export interface AndroidRunStopped {
  stopped: true
}

const SHELL_TIMEOUT_MS = 30_000
const LAUNCH_TIMEOUT_MS = 60_000
/** What `cmd package resolve-activity` names when several activities match: the system chooser, not one of the app's. */
const CHOOSER_RE = /^android\/com\.android\.internal\.app\.\w*(Resolver|Chooser)\w*$/

const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0]?.trim() ?? ''
/** adb itself could not reach the device (gone, offline, unauthorized), or did not answer: not something the device said. */
const unreachable = (r: ExecResult): boolean =>
  r.error === 'timeout' || r.error === 'not_found' || r.error === 'too_large' || /^(adb: )?error:|device '.*' not found|device offline|unauthorized|no devices\/emulators found/im.test(r.stderr)

/** `cmd package resolve-activity --brief` ends with `package/activity`; anything else is not a launcher of `pkg`. */
export function parseLauncher(stdout: string, pkg: string): string | null {
  const last = stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''
  const m = /^([A-Za-z][\w.]*)\/([\w.$]+)$/.exec(last)
  return m && m[1] === pkg ? `${m[1]}/${m[2]}` : null
}

/**
 * The device to run `pkg`'s flow on, with the app started (unless `launch` is false), or why not. Never throws for a
 * device or setup problem. `signal` is checked before the app is stopped and before it is started again.
 */
export async function prepareAndroidRun(
  req: { package: string; target?: string | null; launch?: boolean; signal?: AbortSignal },
  host: AndroidRunHost
): Promise<AndroidRunDevice | AndroidRunRefusal | AndroidRunStopped> {
  if (req.target != null && !TARGET_RE.test(req.target)) {
    return { error: `"${req.target.slice(0, 100)}" is not an adb serial or AVD name`, fix: 'Pass the serial from `nawi mobile-doctor` or the name of a running virtual device.' }
  }
  const pkg = req.package
  const doctor = await runMobileDoctor(null, host)
  const adb = doctor.adb?.path
  if (!adb) return { error: 'adb is not available', fix: doctor.fix ?? 'Install the Android SDK Platform-Tools and set ANDROID_HOME.' }
  const target = await pickTarget(doctor, host, adb, req.target ?? null, 'run')
  if ('fix' in target) return target
  const { serial, name } = target
  const shell = (line: string, timeoutMs = SHELL_TIMEOUT_MS): Promise<ExecResult> => host.exec(adb, ['-s', serial, 'shell', line], timeoutMs)
  const lost = (r: ExecResult, what: string): AndroidRunRefusal => ({
    error: `could not ${what} on ${name}: ${r.error === 'timeout' || r.error === 'not_found' ? why(r) : firstLine(r.stderr).slice(0, 200) || why(r)}`,
    fix: `Check that ${name} is still connected and unlocked (\`nawi mobile-doctor\`), then retry.`
  })

  // `pm path` prints `package:/data/app/.../base.apk` for an installed app; for any other it prints nothing and exits 1.
  const path = await shell(`pm path ${shQuote(pkg)}`)
  if (!/^package:/m.test(path.stdout)) {
    if (unreachable(path)) return lost(path, 'check which apps are installed')
    return { error: `${pkg} is not installed on ${name}`, fix: `Install it with \`nawi mobile-open <file.apk> --target ${name}\`, then run the flow again.` }
  }

  if (req.launch === false) return { adb, target, launched: null }

  // Android's `cmd` reports a missing activity in its output with exit code 0: the parsed line decides.
  const resolved = await shell(`cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${shQuote(pkg)}`)
  if (unreachable(resolved)) return lost(resolved, `find ${pkg}'s launcher activity`)
  const component = failed(resolved) ? null : parseLauncher(resolved.stdout, pkg)
  if (component === null) {
    const several = CHOOSER_RE.test(resolved.stdout.trim().split(/\r?\n/).pop()?.trim() ?? '')
    return {
      error: several ? `${pkg} has several launcher activities on ${name}, so Nawi can't tell which one the flow starts from` : `${pkg} has no launcher activity on ${name}`,
      fix: 'Start the app on the screen the flow begins on yourself (or with mobile_open), then run the flow without launching it (`--no-launch`, run_flow launch: false).'
    }
  }
  if (req.signal?.aborted) return { stopped: true }
  const stop = await shell(`am force-stop ${shQuote(pkg)}`)
  if (failed(stop)) return lost(stop, `stop ${pkg} before the run`)
  if (req.signal?.aborted) return { stopped: true }
  const am = await shell(`am start -W -n ${shQuote(component)}`, LAUNCH_TIMEOUT_MS)
  if (am.error === 'timeout') return { error: `${pkg} did not finish starting within ${LAUNCH_TIMEOUT_MS / 1000} s`, fix: `Look at \`adb -s ${serial} logcat\` for what the app is doing at startup, then retry.` }
  if (unreachable(am)) return lost(am, `start ${pkg}`)
  const started = parseAmStart(am.stdout, am.stderr)
  if (!started.ok) return { error: `${pkg} did not start on ${name}: ${started.error}`, fix: `Run \`adb -s ${serial} shell am start -W -n ${component}\` to see the full message.` }
  if (failed(am)) return lost(am, `start ${pkg}`)
  // Like mobile_open: an app that dies in onCreate still lets `am start` say ok. Old images have no pidof: then it can't be told.
  const pid = await shell(`pidof ${shQuote(pkg)}`)
  const noPidof = /not found|inaccessible/i.test(`${pid.stdout}\n${pid.stderr}`) || pid.error === 'timeout' || unreachable(pid)
  if (!/^\d+/.test(pid.stdout.trim()) && !noPidof) {
    return { error: `${pkg} started on ${name} and then stopped`, fix: `It probably crashed at startup: look at \`adb -s ${serial} logcat -b crash\`.` }
  }
  return { adb, target, launched: { activity: component.slice(pkg.length + 1) } }
}
