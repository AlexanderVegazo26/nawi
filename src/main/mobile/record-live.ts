import { spawn } from 'node:child_process'
import type { Flow } from '../../shared/flow/schema'
import { stringifyFlow } from '../../shared/flow/yaml'
import { runMobileDoctor, type ExecResult } from './doctor'
import type { ExecError } from './exec'
import { homePackage } from './explore-live'
import { readKeyboardBoxes } from './flow-evidence'
import { defaultAndroidRunHost, prepareAndroidRun, type AndroidRunHost, type AndroidRunTarget } from './flow-device'
import { failed } from './flow-replay'
import { LONG_PRESS_TIMEOUT_LINE, parseLongPressTimeout } from './long-press'
import { readScreen } from './open'
import { PACKAGE_RE, TARGET_RE } from './profile'
import { flowFromAndroidRecording, GestureReader, inside, parseTouchPanels, toScreen, type DisplayInfo, type RawInput, type RecordedEvent, type Snapshot } from './record'
import { DISPLAY_ROTATION_LINE, parseDisplayRotation, parseWmSize } from './rotation'
import { parseDensity } from './study'
import { appPackage, pickTarget } from './study-live'

/**
 * Roadmap M5c, second slice: record what a person does on a connected Android device, live, into an android flow
 * (`mobile_record` / `nawi mobile-record`). The engine that turns touches and screens into steps is record.ts; this
 * module feeds it from the device:
 *
 * - The app is started from its launcher first (force-stop + start, like `nawi run` does before a replay), so the
 *   recording begins where its replay will begin. With `launch: false` it starts from whatever the app shows now.
 * - The kernel's touches and keys stream from `adb shell getevent -lt` (a managed child process, stopped at the end).
 * - The screen (`uiautomator dump`) and the on-screen keyboard's area are read once the device has been quiet for
 *   SETTLE_MS after an input, and that read is the screen the next input acted on. A read that a touch or key
 *   interrupted is thrown away and taken again, unless every one was typing on the keyboard (then only a field's text
 *   changed: the read is kept and the screen is read again for the whole text). While nobody touches the device the screen is read again every REFRESH_MS, so a
 *   list that loads late is on the screen the next tap is resolved on.
 * - A screen read takes about two seconds on an emulator. A touch that comes before the read after the previous
 *   screen-changing touch finished can't be resolved (the screen it landed on was never read): it is not recorded and
 *   the warnings say so. Taps on the keyboard (typing) never wait for a read: typing is read from the field's text.
 * - It stops when the request is cancelled, after `idleMs` without input (once something was recorded), after
 *   `maxMs`, when the device stops streaming (unplugged), or when MAX_READ_FAILURES screen reads in a row failed. The screen is read one last time for the typing on it.
 *
 * Warnings never say where a touch on the keyboard landed (a password's keys). Electron-free; adb, the stream, the
 * clock and the delays are injectable, so tests drive a simulated app.
 */

export interface InputStream {
  /** Ends the process; `done` settles once it has exited. */
  stop(): void
  done: Promise<{ code: number | null; error?: ExecError; stderr: string }>
}

/** Start a long-running process and hand each chunk of its stdout (UTF-8) to `onData` as it arrives. */
export type StartStream = (file: string, args: string[], onData: (chunk: string) => void) => InputStream

export interface RecordLiveHost extends AndroidRunHost {
  stream: StartStream
}

/** Most stderr kept from a stream, for its error message. */
const MAX_STREAM_STDERR = 4096

/** The real stream: a child process with piped stdout/stderr. Never throws; a missing binary resolves `done` with not_found. */
export const spawnStream: StartStream = (file, args, onData) => {
  let stderr = ''
  let stopping = false
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => onData(chunk))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < MAX_STREAM_STDERR) stderr = (stderr + chunk).slice(0, MAX_STREAM_STDERR)
  })
  const done = new Promise<{ code: number | null; error?: ExecError; stderr: string }>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => resolve({ code: null, error: err.code === 'ENOENT' || err.code === 'EACCES' ? 'not_found' : 'failed', stderr }))
    child.on('close', (code) => resolve(code === 0 || stopping ? { code, stderr } : { code, error: 'failed', stderr }))
  })
  return {
    stop() {
      stopping = true
      child.kill()
    },
    done
  }
}

export function defaultRecordLiveHost(): RecordLiveHost {
  return { ...defaultAndroidRunHost(), stream: spawnStream }
}

/** How long the device must be quiet after an input before its screen is read. */
export const SETTLE_MS = 300
/** While nobody touches the device, how often its screen is read again (late-loading content). */
export const REFRESH_MS = 5_000
/**
 * How often, while the device is quiet, the recorder takes a quick look at the screen's rotation (M5d-4): turning the
 * device sends no touch or key, so without it a touch after the screen turned would be read on the unturned screen
 * until the next refresh. A changed rotation makes the screen unknown until it is read again.
 */
export const ROTATION_PROBE_MS = 1_000
/** How often the loop looks at the clock, the stream and the cancel signal. */
export const POLL_MS = 50
/** After a failed screen read, how long before the next try. */
export const READ_RETRY_MS = 1_000
/** Screen reads in a row that may fail before the recording stops (the device can't be read any more). */
export const MAX_READ_FAILURES = 5
export const DEFAULT_MAX_MS = 120_000
export const DEFAULT_IDLE_MS = 15_000
const SHELL_TIMEOUT_MS = 30_000
/** `getevent -lt` (labels, timestamps) and `-lp` (each device's axes) */
export const GETEVENT_STREAM_LINE = 'getevent -lt'
export const GETEVENT_DEVICES_LINE = 'getevent -lp'

export interface LiveRecordRequest {
  /** An adb serial or the AVD name of a running emulator; default: the only device connected. */
  target?: string | null
  /** The app to record; default: the app in front. */
  package?: string | null
  /** Start the app from its launcher first (default true), like a replay does. */
  launch?: boolean
  /** The flow's name; default `Recorded on <package>`. */
  name?: string
  maxMs?: number
  idleMs?: number
  signal?: AbortSignal
  /** Called each time the screen has been read after inputs: the next touch is safe. `inputs` so far. */
  onReady?: (inputs: number) => void
}

export type RecordStopped = 'idle' | 'max_time' | 'cancelled' | 'disconnected' | 'unreadable'

export interface LiveRecordResult {
  ok: boolean
  error: string | null
  /** The one next step when not ok. */
  fix: string | null
  target: AndroidRunTarget | null
  package: string | null
  /** The launcher activity started before recording; null with launch: false. */
  launched: { activity: string } | null
  stopped: RecordStopped | null
  /** Touches and keys read from the device (typing included). */
  inputs: number
  flow: Flow | null
  flow_yaml: string | null
  warnings: string[]
}

const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0]?.trim().slice(0, 200) ?? ''

export async function recordAndroidLive(req: LiveRecordRequest, host: RecordLiveHost = defaultRecordLiveHost()): Promise<LiveRecordResult> {
  if (req.target != null && !TARGET_RE.test(req.target)) throw new Error(`"${req.target}" is not an adb serial or AVD name.`)
  if (req.package != null && !PACKAGE_RE.test(req.package)) throw new Error(`"${req.package}" is not an Android package name.`)
  const maxMs = req.maxMs ?? DEFAULT_MAX_MS
  const idleMs = req.idleMs ?? DEFAULT_IDLE_MS
  const result: LiveRecordResult = { ok: false, error: null, fix: null, target: null, package: null, launched: null, stopped: null, inputs: 0, flow: null, flow_yaml: null, warnings: [] }
  const stop = (error: string, fix: string): LiveRecordResult => ({ ...result, error, fix })
  const signal = req.signal

  // The app: named, or the one in front (read once, on the device the caller means).
  let pkg = req.package ?? null
  let picked: { adb: string; target: AndroidRunTarget } | undefined
  if (pkg === null) {
    const doctor = await runMobileDoctor(null, host)
    const adb = doctor.adb?.path
    if (!adb) return stop('adb is not available', doctor.fix ?? 'Install the Android SDK Platform-Tools and set ANDROID_HOME.')
    const target = await pickTarget(doctor, host, adb, req.target ?? null, 'record')
    if ('fix' in target) return stop(target.error, target.fix)
    result.target = target
    const screen = await readScreen(host, adb, target.serial)
    if ('skipped' in screen) return stop(screen.skipped, `Check that ${target.name} shows an unlocked screen, then retry.`)
    pkg = appPackage(screen)
    if (pkg === null || pkg === (await homePackage(host, adb, target.serial))) {
      return stop('no app is in front to record', `Start the app first (\`nawi mobile-open <file.apk> --target ${target.name}\`), or name it with package, then record again.`)
    }
    picked = { adb, target }
  }
  result.package = pkg

  if (signal?.aborted) return { ...stop('the recording was cancelled before it started', 'Record again.'), stopped: 'cancelled' }
  const prepared = await prepareAndroidRun({ package: pkg, target: req.target ?? null, picked, launch: req.launch !== false, signal, verb: 'record' }, host)
  if ('stopped' in prepared) return { ...stop('the recording was cancelled before it started', 'Record again.'), stopped: 'cancelled' }
  if ('fix' in prepared) return stop(prepared.error, prepared.fix)
  const { adb, target } = prepared
  const { serial, name } = target
  result.target = target
  result.launched = prepared.launched
  const shell = (line: string): Promise<ExecResult> => host.exec(adb, ['-s', serial, 'shell', line], SHELL_TIMEOUT_MS)
  const deviceFix = `Check that ${name} is still connected and unlocked (\`nawi mobile-doctor\`), then retry.`

  const size = await shell('wm size')
  const density = await shell('wm density')
  const wm = failed(size) ? null : parseWmSize(size.stdout)
  const dpi = failed(density) ? null : parseDensity(density.stdout)
  if (!wm || dpi === null) return stop(`could not read ${name}'s screen size and density (wm size / wm density)`, deviceFix)
  const display: DisplayInfo = { ...wm, density: dpi }
  const devices = await shell(GETEVENT_DEVICES_LINE)
  const panels = failed(devices) ? [] : parseTouchPanels(devices.stdout)
  if (panels.length === 0) {
    return stop(
      `could not find ${name}'s touch screen in \`getevent -lp\`${failed(devices) ? ` (${firstLine(devices.stderr) || 'adb failed'})` : ''}`,
      'Recording needs a device whose touch screen reports multi-touch positions to `adb shell getevent`; try a virtual device from `nawi mobile-doctor`.'
    )
  }

  const warnings: string[] = []
  let keyboardUnknown = false
  const readSnapshot = async (): Promise<Snapshot | null> => {
    // Both at once: a shorter read leaves less time in which a touch can't be resolved.
    const [screen, keyboard] = await Promise.all([readScreen(host, adb, serial), readKeyboardBoxes(shell)])
    if ('skipped' in screen) return null
    if (keyboard !== null) return { screen, keyboard: keyboard.length > 0 ? keyboard : null }
    // The keyboard is (or may be) up but where is unknown: every touch then counts as typing (never a key position in a
    // warning, never a tap through the keyboard onto the app), and the warning says why taps went missing.
    keyboardUnknown = true
    return { screen, keyboard: [{ left: 0, top: 0, right: Number.MAX_SAFE_INTEGER, bottom: Number.MAX_SAFE_INTEGER }] }
  }

  // Which resting touches the device itself takes for long presses (its touch & hold delay); unreadable = the default.
  const delay = await shell(LONG_PRESS_TIMEOUT_LINE)
  const longPressTimeoutMs = failed(delay) ? undefined : parseLongPressTimeout(delay.stdout)

  const reader = new GestureReader(panels, display)
  const events: RecordedEvent[] = []
  /** The last screen read that no input interrupted; null until the first one. */
  let current: Snapshot | null = null
  /** An input changed (or may have changed) the screen since `current` was read. */
  let stale = true
  /** Touches held while `current` was stale: decided against the next read (typing, or not recorded). */
  let held: RawInput[] = []
  let typedSinceRead = false
  let lateTyping = 0
  let unread = 0
  let inputs = 0
  /** Last time the device sent anything (a finger moving counts, not only finished touches). */
  let lastActivityAt = host.now()
  let lastReadAt = host.now()
  /**
   * The rotation the last quick look saw, and when it looked. Only a change between two looks counts: the look and
   * the screen read may name the same screen differently on some devices, and that must not read the screen forever.
   */
  let probedRotation = null as number | null
  let lastProbeAt = Number.NEGATIVE_INFINITY
  let dirty = true
  let readFailed = false
  let readFailures = 0
  /** Inputs since the current read started. */
  let sinceRead: RawInput[] = []

  const onKeyboard = (input: RawInput, snap: Snapshot): boolean =>
    input.kind === 'stroke' && snap.keyboard !== null && snap.keyboard.some((b) => inside(b, toScreen(input.start, snap.screen.rotation, display)))

  const onInput = (input: RawInput): void => {
    inputs++
    sinceRead.push(input)
    dirty = true
    if (current === null || stale) {
      held.push(input)
      return
    }
    if (onKeyboard(input, current)) {
      events.push({ input, before: current })
      typedSinceRead = true
      return
    }
    if (typedSinceRead && input.kind === 'stroke') lateTyping++
    events.push({ input, before: current })
    stale = true
  }

  /** A read no input interrupted: it settles the touches held while the screen was unknown. */
  const settled = (snap: Snapshot): void => {
    for (const h of held) {
      // A held touch on the keyboard was typing, read from the field's text; anything else was never resolved.
      if (!onKeyboard(h, snap)) unread++
    }
    held = []
    current = snap
    stale = false
    typedSinceRead = false
    dirty = false
  }

  const stream = host.stream(adb, ['-s', serial, 'shell', GETEVENT_STREAM_LINE], (chunk) => {
    lastActivityAt = host.now()
    for (const input of reader.push(chunk)) onInput(input)
  })
  // Assigned in the callback, so typed by hand (TS would narrow a `null` initializer for good).
  let ended = null as Awaited<InputStream['done']> | null
  void stream.done.then((r) => {
    ended = r
  })

  const started = host.now()
  let stopped: RecordStopped | null = null
  try {
    for (;;) {
      if (signal?.aborted) stopped = 'cancelled'
      else if (ended !== null) stopped = 'disconnected'
      else if (host.now() - started >= maxMs) stopped = 'max_time'
      else if (readFailures >= MAX_READ_FAILURES) stopped = 'unreadable'
      else if (inputs > 0 && !dirty && held.length === 0 && host.now() - lastActivityAt >= idleMs) stopped = 'idle'
      if (stopped) break
      // Quiet: nothing sent for SETTLE_MS and no finger on the screen (a slow drag or a held finger is not done).
      const quiet = host.now() - lastActivityAt >= SETTLE_MS && !reader.touching
      if (quiet && (dirty || host.now() - lastReadAt >= REFRESH_MS)) {
        const wasDirty = dirty
        sinceRead = []
        const snap = await readSnapshot()
        lastReadAt = host.now()
        if (snap === null) {
          if (!readFailed) warnings.push(`Nawi could not read ${name}'s screen at least once while recording; touches until the next good read could not be resolved.`)
          readFailed = true
          readFailures++
          await host.delay(READ_RETRY_MS, signal)
          continue
        }
        readFailures = 0
        // Typing during the read changed only a field's text: the screen is good for the next tap, and is read again
        // for the whole text. Any other input, or a finger still down, may have half-changed it: read again once quiet.
        const typing = sinceRead.length > 0
        if (reader.touching || (typing && !sinceRead.every((i) => onKeyboard(i, snap)))) continue
        settled(snap)
        if (typing) {
          dirty = true
          typedSinceRead = true
        }
        if (wasDirty) req.onReady?.(inputs)
        continue
      }
      if (quiet && !dirty && current !== null && host.now() - lastProbeAt >= ROTATION_PROBE_MS) {
        lastProbeAt = host.now()
        const probe = await shell(DISPLAY_ROTATION_LINE)
        const rotation = failed(probe) ? null : parseDisplayRotation(probe.stdout)
        if (rotation !== null && probedRotation !== null && rotation !== probedRotation) {
          // The screen turned: touches from now on wait for the turned screen's read (held, like after any change).
          stale = true
          dirty = true
        }
        if (rotation !== null) probedRotation = rotation
        continue
      }
      await host.delay(POLL_MS, signal)
    }
  } finally {
    stream.stop()
  }
  // Output still in the pipe arrives until the process has exited; only then is a cut-off last line really the last.
  const exit = ended ?? (await stream.done)
  for (const input of reader.end()) onInput(input)

  if (current === null) {
    if (stopped === 'disconnected') {
      const why = exit.error === 'not_found' ? 'adb could not be started' : firstLine(exit.stderr) || `getevent exited with code ${exit.code ?? 'unknown'}`
      return { ...stop(`could not read touches from ${name}: ${why}`, deviceFix), stopped }
    }
    return { ...stop(`could not read ${name}'s screen to start recording`, deviceFix), stopped }
  }
  if (stopped === 'unreadable') warnings.push(`Recording stopped: ${name}'s screen could not be read ${MAX_READ_FAILURES} times in a row; the flow has what was recorded until then.`)

  // The last screen: where the typing of the last field shows. The stream has stopped, so no input interrupts it.
  let after: Snapshot = current
  if (dirty || held.length > 0) {
    await host.delay(SETTLE_MS)
    const snap = await readSnapshot()
    if (snap) {
      settled(snap)
      after = snap
    } else warnings.push('The screen could not be read after the last touch: typing on it may be missing from the flow.')
  }

  if (stopped === 'disconnected') warnings.push(`${name} stopped sending touches (disconnected?); the flow has what was recorded until then.`)
  if (unread > 0) {
    warnings.push(
      `${unread === 1 ? 'A touch or key press was' : `${unread} touches or key presses were`} not recorded: ${unread === 1 ? 'it' : 'each'} came before Nawi had read the screen ` +
        'after the previous touch. Wait for the screen to settle (about 2 seconds) after each tap that changes it.'
    )
  }
  if (lateTyping > 0) {
    warnings.push(
      `${lateTyping === 1 ? 'A tap' : `${lateTyping} taps`} came right after typing, before Nawi had read the typed text: check that the fill steps before ` +
        `${lateTyping === 1 ? 'it' : 'them'} have the whole text. Pause a moment after typing before you tap.`
    )
  }
  if (keyboardUnknown) warnings.push("The on-screen keyboard's area could not be read: touches while it was up are taken as typing and not recorded as taps.")
  if (req.launch === false) warnings.push('The app was not restarted before recording: replay this flow from the same screen with launch: false (`nawi run --no-launch`).')

  let recorded: ReturnType<typeof flowFromAndroidRecording>
  try {
    recorded = flowFromAndroidRecording({ package: pkg, name: req.name, display, longPressTimeoutMs, events, after })
  } catch (err) {
    return { ...stop(`the recording could not be turned into a flow: ${err instanceof Error ? err.message : String(err)}`, 'Record again; if it keeps failing, report it with the warnings.'), stopped, inputs }
  }
  return {
    ...result,
    ok: true,
    stopped,
    inputs,
    flow: recorded.flow,
    flow_yaml: stringifyFlow(recorded.flow),
    warnings: [...warnings, ...recorded.warnings]
  }
}
