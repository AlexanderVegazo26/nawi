import type { AppCrash, DeviceLogLine } from '../replay/evidence'
import type { Exec } from './doctor'
import { keptLogText, LOGCAT_LINE_RE, logcatTime } from './flow-evidence'

/**
 * Roadmap M5d-1: notice when the flow's app crashes or stops responding during an android run, and keep what the
 * device logged about it, so the step it happened in fails with the cause instead of timing out on a missing view.
 *
 * The device logs all three in buffers adb can read without root, each in its own shape (checked on an API 36
 * emulator: `am crash`, SIGSEGV, SIGSTOP + a tap):
 * - a Java/Kotlin crash: `AndroidRuntime` E, `FATAL EXCEPTION: <thread>`, `Process: <pkg>, PID: <pid>`, the exception;
 * - a native crash: `DEBUG` F from the crash dumper, `pid: <pid>, tid: <tid>, name: <thread>  >>> <pkg> <<<`, then
 *   `signal <n> (<NAME>), ...` and an optional `Abort message: '...'`;
 * - an ANR: `ActivityManager` E, `ANR in <pkg> (<component>)`, `PID: <pid>`, `Reason: ...`, then the system's load
 *   and CPU tables (not kept).
 * A process of the app (`<pkg>` or `<pkg>:<name>`) counts; another package that merely mentions it does not.
 *
 * Secrets are scrubbed from every kept line and the summary before they are cut. Never throws.
 *
 * The device may still be writing a report when it is read (a tombstone takes a few ms): a report missing the line its
 * summary comes from is left for the next read once, then reported as it is.
 */

/** Most log lines kept for one crash; a stack's first lines say what crashed. */
export const MAX_CRASH_LINES = 30
/** How often a step that waits on a screen without the app's views asks the device about a crash. */
export const CRASH_POLL_MS = 1_000
/** How often a step that waits while the app's views are on screen asks (the system declares an ANR after 5 s). */
export const ANR_POLL_MS = 5_000
const SHELL_TIMEOUT_MS = 30_000
const SUMMARY_MAX = 300

/** The crash buffer plus the system's ANR reports, only the tags that report a crash or an ANR. */
export const crashLogLine = (sinceDeviceMs: number): string =>
  `logcat -d -b crash -b system -v epoch,uid -t ${logcatTime(sinceDeviceMs)} AndroidRuntime:E ActivityManager:E DEBUG:F '*:S'`

/** A crash or ANR of the app, with what the device logged about it. */
export interface CrashFound {
  crash: AppCrash
  /** The report's lines, scrubbed, at most MAX_CRASH_LINES. */
  log: DeviceLogLine[]
  /** The report's lines beyond MAX_CRASH_LINES. */
  dropped: number
  /** Every line of the report as `at|tag|message` (kept or not): the same lines in a step's log are not repeated. */
  lineKeys: ReadonlySet<string>
}

/** One line's identity in a step's log (DeviceLogLine). */
export const logLineKey = (l: Pick<DeviceLogLine, 'at' | 'tag' | 'message'>): string => `${l.at}|${l.tag}|${l.message}`

interface Entry {
  key: string
  tag: string
  level: DeviceLogLine['level']
  lines: Array<{ at: string; message: string }>
}

/** The first line of a report: it starts a new entry even on the thread that logged the line before. */
const REPORT_START_RE = /^(FATAL EXCEPTION\b|ANR in |\*\*\* \*\*\* \*\*\*)/

/** Log entries: consecutive lines of the same process, thread and tag, split where a report starts. */
function entries(stdout: string): Entry[] {
  const out: Entry[] = []
  let last: Entry | null = null
  let lastId = ''
  for (const raw of stdout.split(/\r?\n/)) {
    const m = LOGCAT_LINE_RE.exec(raw)
    if (!m) continue
    const [, sec, ms, , pid, tid, level, tag, message] = m
    const at = new Date(Number(sec) * 1000 + Number(ms))
    if (Number.isNaN(at.getTime())) continue
    const id = `${pid}/${tid}/${tag}`
    if (last !== null && id === lastId && !REPORT_START_RE.test(message)) {
      last.lines.push({ at: at.toISOString(), message })
      continue
    }
    last = { key: `${sec}.${ms} ${id}`, tag, level: level as DeviceLogLine['level'], lines: [{ at: at.toISOString(), message }] }
    lastId = id
    out.push(last)
  }
  return out
}

/** `pkg` itself or one of its named processes (`pkg:remote`). */
const isAppProcess = (name: string, pkg: string): boolean => name === pkg || name.startsWith(`${pkg}:`)

/**
 * The crash or ANR of `pkg` this entry reports, without its log lines; null for anything else. `complete` is false
 * when the line its summary comes from is not there (yet).
 */
function classify(e: Entry, pkg: string): (Omit<AppCrash, 'at'> & { complete: boolean }) | null {
  const msgs = e.lines.map((l) => l.message)
  if (e.tag === 'AndroidRuntime' && /^FATAL EXCEPTION\b/.test(msgs[0] ?? '')) {
    const at = msgs.findIndex((m) => /^Process: \S+, PID: \d+/.test(m))
    const p = at === -1 ? null : /^Process: (\S+), PID: (\d+)/.exec(msgs[at])
    if (p === null || !isAppProcess(p[1], pkg)) return null
    const exception = msgs.slice(at + 1).find((m) => m.trim() !== '' && !/^\s+at /.test(m) && !/^PID: /.test(m))
    return { kind: 'crash', process: p[1], pid: Number(p[2]), summary: exception ?? msgs[0], complete: exception !== undefined }
  }
  if (e.tag === 'DEBUG') {
    const head = msgs.map((m) => /^pid: (\d+), tid: \d+, name: .*>>> (\S+) <<<\s*$/.exec(m)).find((m) => m !== null)
    if (!head || !isAppProcess(head[2], pkg)) return null
    const signal = msgs.find((m) => /^signal \d+ \(\w+\)/.test(m))
    const abort = msgs.find((m) => /^Abort message: /.test(m))
    const summary = [signal?.replace(/, fault addr.*$/, ''), abort].filter((s) => s !== undefined).join('; ') || 'native crash'
    return { kind: 'native_crash', process: head[2], pid: Number(head[1]), summary, complete: signal !== undefined }
  }
  if (e.tag === 'ActivityManager') {
    const anr = /^ANR in (\S+)/.exec(msgs[0] ?? '')
    if (!anr || !isAppProcess(anr[1], pkg)) return null
    const pid = msgs.map((m) => /^PID: (\d+)\s*$/.exec(m)).find((m) => m !== null)
    const reason = msgs.find((m) => /^Reason: /.test(m))
    return {
      kind: 'anr',
      process: anr[1],
      ...(pid ? { pid: Number(pid[1]) } : {}),
      summary: reason ? reason.slice('Reason: '.length) : 'the app did not respond',
      complete: reason !== undefined
    }
  }
  return null
}

/** The lines of an entry worth keeping: an ANR's header (the load and CPU tables after it are the whole system's). */
function keptLines<T extends { message: string }>(kind: AppCrash['kind'], lines: readonly T[]): T[] {
  if (kind !== 'anr') return lines.slice()
  const end = lines.findIndex((l) => l.message.trim() === '' || l.message.startsWith('-----') || /^Load: /.test(l.message))
  return end === -1 ? lines.slice() : lines.slice(0, end)
}

const SUMMARY_CUT = (text: string): string => (text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text)

/**
 * Every crash and ANR of `pkg` in `logcat -v epoch,uid` output (crashLogLine), oldest first, each with its own log
 * lines (scrubbed, capped), a key that identifies it across reads, and whether it was complete when read.
 */
export function parseCrashLog(stdout: string, pkg: string, redact: (text: string) => string): Array<CrashFound & { key: string; complete: boolean }> {
  const found: Array<CrashFound & { key: string; complete: boolean }> = []
  for (const e of entries(stdout)) {
    const c = classify(e, pkg)
    if (c === null) continue
    const { complete, ...crash } = c
    const all = keptLines(crash.kind, e.lines).map((l) => ({ at: l.at, level: e.level, ...keptLogText(e.tag, l.message, redact) }))
    found.push({
      key: e.key,
      complete,
      crash: { ...crash, at: e.lines[0].at, summary: SUMMARY_CUT(redact(crash.summary)) },
      log: all.slice(0, MAX_CRASH_LINES),
      dropped: Math.max(0, all.length - MAX_CRASH_LINES),
      lineKeys: new Set(all.map(logLineKey))
    })
  }
  return found
}

/** What a step's error says about the crash. */
export function crashMessage(c: AppCrash): string {
  if (c.kind === 'anr') return `${c.process} stopped responding (ANR): ${c.summary}`
  if (c.kind === 'native_crash') return `${c.process} crashed in native code: ${c.summary}`
  return `${c.process} crashed: ${c.summary}`
}

export interface CrashWatch {
  /**
   * The app's next crash or ANR since the watch's start that was not reported yet, or null (also when unknown). A
   * report still being written is left for the next check once; with `last`, there is no next check to wait for.
   */
  check(opts?: { last?: boolean }): Promise<CrashFound | null>
}

/**
 * Watches `pkg` from `sinceDeviceMs` (the device's epoch clock) on; without a device clock (null) there is nothing to
 * read from and every check is null.
 */
export function startCrashWatch(
  req: { adb: string; serial: string; pkg: string; sinceDeviceMs: number | null; redact: (text: string) => string },
  host: { exec: Exec }
): CrashWatch {
  const reported = new Set<string>()
  const deferred = new Set<string>()
  return {
    async check(opts = {}) {
      if (req.sinceDeviceMs === null) return null
      const r = await host.exec(req.adb, ['-s', req.serial, 'shell', crashLogLine(req.sinceDeviceMs)], SHELL_TIMEOUT_MS)
      if (r.code !== 0 || r.error) return null
      for (const { key, complete, ...f } of parseCrashLog(r.stdout, req.pkg, req.redact)) {
        if (reported.has(key)) continue
        if (!complete && !opts.last && !deferred.has(key)) {
          deferred.add(key)
          return null
        }
        reported.add(key)
        return f
      }
      return null
    }
  }
}
