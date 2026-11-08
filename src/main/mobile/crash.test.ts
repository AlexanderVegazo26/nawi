import { describe, expect, it } from 'vitest'
import { crashLogLine, crashMessage, MAX_CRASH_LINES, parseCrashLog, startCrashWatch } from './crash'
import type { ExecResult } from './doctor'
import { anr, javaCrash, nativeCrash } from './fixtures/crash-logs'

/**
 * Crash and ANR detection for android runs (roadmap M5d-1), on reports in the shapes an API 36 emulator logs
 * (fixtures/crash-logs.ts): which entries are the app's, what each says in one line, which lines are kept.
 */

const PKG = 'dev.nawi.shop'
const SEC = 1_794_174_082
const keep = (s: string): string => s

describe('parseCrashLog', () => {
  it('reads an uncaught exception of the app: process, pid, the exception as the summary, the report as its log', () => {
    const [f, ...more] = parseCrashLog(javaCrash(SEC, PKG), PKG, keep)
    expect(more, 'one report, one crash').toEqual([])
    expect(f.crash).toEqual({ kind: 'crash', process: PKG, pid: 3475, at: new Date(SEC * 1000 + 974).toISOString(), summary: 'java.lang.IllegalStateException: tracking id missing' })
    expect(f.log.map((l) => l.message).slice(0, 3)).toEqual(['FATAL EXCEPTION: main', `Process: ${PKG}, PID: 3475`, 'java.lang.IllegalStateException: tracking id missing'])
    expect(f.log.every((l) => l.tag === 'AndroidRuntime' && l.level === 'E'), JSON.stringify(f.log[0])).toBe(true)
    expect(crashMessage(f.crash)).toBe(`${PKG} crashed: java.lang.IllegalStateException: tracking id missing`)
  })

  it('reads a native crash from the crash dumper: the signal (and abort message) as the summary', () => {
    const [f] = parseCrashLog(nativeCrash(SEC, PKG, { abort: 'assertion "track" failed' }), PKG, keep)
    expect(f.crash).toMatchObject({ kind: 'native_crash', process: PKG, pid: 6507, summary: 'signal 11 (SIGSEGV), code 1 (SEGV_MAPERR); Abort message: \'assertion "track" failed\'' })
    expect(crashMessage(f.crash)).toMatch(/^dev\.nawi\.shop crashed in native code: signal 11 \(SIGSEGV\)/)
    expect(f.log.some((l) => l.message.includes('backtrace:')), 'the backtrace stays in the log').toBe(true)
  })

  it('reads an ANR: the reason as the summary, and only its header (the system-wide load and CPU tables are dropped)', () => {
    const [f, ...more] = parseCrashLog(anr(SEC, PKG), PKG, keep)
    expect(more, '"Aborted stack trace dump" is another entry, not an ANR').toEqual([])
    expect(f.crash).toMatchObject({ kind: 'anr', process: PKG, pid: 5874 })
    expect(f.crash.summary).toMatch(/^Input dispatching timed out \(856277e dev\.nawi\.shop\//)
    expect(f.log.map((l) => l.message.split(':')[0])).toEqual(['ANR in dev.nawi.shop (dev.nawi.shop/.MainActivity)', 'PID', 'Reason', 'Parent', 'ErrorId', 'Frozen'])
    expect(crashMessage(f.crash)).toMatch(/^dev\.nawi\.shop stopped responding \(ANR\): Input dispatching/)
  })

  it('counts the app\'s named processes, but not another package with the same prefix or one that only mentions it', () => {
    expect(parseCrashLog(javaCrash(SEC, `${PKG}:sync`), PKG, keep).map((f) => f.crash.process)).toEqual([`${PKG}:sync`])
    const others = javaCrash(SEC, `${PKG}.debug`) + nativeCrash(SEC, 'dev.nawi.shopping') + anr(SEC, 'com.android.settings') + javaCrash(SEC, 'com.other', { exception: `java.lang.Error: could not bind ${PKG}` })
    expect(parseCrashLog(others, PKG, keep), 'none of these is the app').toEqual([])
  })

  it('returns every crash in order, each with its own lines, when several are in the log', () => {
    const text = javaCrash(SEC, PKG, { pid: 100 }) + anr(SEC + 5, PKG, { pid: 200 }) + javaCrash(SEC + 9, PKG, { pid: 300, ms: '001' })
    const found = parseCrashLog(text, PKG, keep)
    expect(found.map((f) => [f.crash.kind, f.crash.pid])).toEqual([['crash', 100], ['anr', 200], ['crash', 300]])
    expect(new Set(found.map((f) => f.key)).size, 'each report has its own key').toBe(3)
    expect(found[1].log.every((l) => l.tag === 'ActivityManager')).toBe(true)
  })

  it('scrubs secrets from the summary and every line, and caps a long stack with a dropped count', () => {
    const [f] = parseCrashLog(javaCrash(SEC, PKG, { exception: 'java.lang.IllegalArgumentException: bad password hunter2', frames: 60 }), PKG, (t) => t.replaceAll('hunter2', '***'))
    expect(f.crash.summary).toBe('java.lang.IllegalArgumentException: bad password ***')
    expect(JSON.stringify(f), 'the secret must not be kept anywhere').not.toContain('hunter2')
    expect(f.log).toHaveLength(MAX_CRASH_LINES)
    expect(f.dropped, '3 header lines + 60 frames + 1 = 64 lines').toBe(64 - MAX_CRASH_LINES)
  })

  it('finds a report logged on the same thread right after another error (each report starts its own entry)', () => {
    const sameThread = anr(SEC, PKG).replace(/ 6152 E ActivityManager/, ' 6153 E ActivityManager')
    expect(sameThread, 'fixture: the "Aborted stack trace dump" line is on the ANR thread now').toContain(' 6153 E ActivityManager: Aborted')
    const twoCrashes = javaCrash(SEC, 'com.other', { pid: 3475 }) + javaCrash(SEC, PKG, { pid: 3475 })
    expect(parseCrashLog(sameThread, PKG, keep).map((f) => f.crash.kind)).toEqual(['anr'])
    expect(parseCrashLog(twoCrashes, PKG, keep).map((f) => f.crash.process), 'a crash after another on the same pid/tid').toEqual([PKG])
  })

  it('keeps each line\'s own time (a tombstone spans several ms), so a step log holding the same lines matches them', () => {
    const text = nativeCrash(SEC, PKG).replace(/\.924( +1000 +6545 +6545 F DEBUG +: signal)/, '.931$1')
    const [f] = parseCrashLog(text, PKG, keep)
    const signal = f.log.find((l) => l.message.startsWith('signal 11'))
    expect(signal?.at).toBe(new Date(SEC * 1000 + 931).toISOString())
    expect(f.crash.at, 'the crash is dated by its first line').toBe(new Date(SEC * 1000 + 924).toISOString())
    expect(f.lineKeys.has(`${signal?.at}|DEBUG|${signal?.message}`)).toBe(true)
  })

  it('marks a report still being written (no exception, signal or reason line yet) as incomplete', () => {
    const cutJava = javaCrash(SEC, PKG).split('\n').slice(0, 3).join('\n')
    const cutNative = nativeCrash(SEC, PKG).split('\n').filter((l) => !/signal 11|rax|backtrace|#00/.test(l)).join('\n')
    const cutAnr = anr(SEC, PKG).split('\n').slice(0, 4).join('\n')
    expect([cutJava, cutNative, cutAnr].map((t) => parseCrashLog(t, PKG, keep).map((f) => [f.crash.kind, f.complete]))).toEqual([[['crash', false]], [['native_crash', false]], [['anr', false]]])
    expect(parseCrashLog(javaCrash(SEC, PKG) + nativeCrash(SEC, PKG) + anr(SEC, PKG), PKG, keep).every((f) => f.complete)).toBe(true)
  })

  it('ignores lines that are not logcat lines and other tags', () => {
    expect(parseCrashLog('--------- beginning of crash\nrandom text\n         1794174082.974  1000  3475  3475 E Settings: FATAL EXCEPTION: main\n', PKG, keep)).toEqual([])
  })
})

describe('startCrashWatch', () => {
  const fake = (answers: Array<string | ExecResult>) => {
    const lines: string[] = []
    return {
      lines,
      host: {
        exec: async (file: string, args: string[]): Promise<ExecResult> => {
          lines.push([file, ...args].join(' '))
          const a = answers.shift() ?? ''
          return typeof a === 'string' ? { code: 0, stdout: a, stderr: '' } : a
        }
      }
    }
  }

  it('reads the crash and system buffers from the run start on the device clock, only the crash tags', () => {
    expect(crashLogLine(1_794_174_082_005)).toBe("logcat -d -b crash -b system -v epoch,uid -t 1794174082.005 AndroidRuntime:E ActivityManager:E DEBUG:F '*:S'")
  })

  it('reports each crash once, the next one on a later check, then null', async () => {
    const both = javaCrash(SEC, PKG, { pid: 1 }) + anr(SEC + 1, PKG, { pid: 2 })
    const f = fake([javaCrash(SEC, PKG, { pid: 1 }), both, both])
    const w = startCrashWatch({ adb: 'adb', serial: 'emulator-5560', pkg: PKG, sinceDeviceMs: SEC * 1000, redact: keep }, f.host)
    expect((await w.check())?.crash.pid).toBe(1)
    expect((await w.check())?.crash.kind, 'the first crash was reported; the ANR is new').toBe('anr')
    expect(await w.check(), 'nothing new').toBeNull()
    expect(f.lines[0]).toBe(`adb -s emulator-5560 shell ${crashLogLine(SEC * 1000)}`)
  })

  it('leaves a report still being written for the next check once, then reports it whole; the last check does not wait', async () => {
    const partial = nativeCrash(SEC, PKG).split('\n').filter((l) => !/signal 11/.test(l)).join('\n')
    const f = fake([partial, nativeCrash(SEC, PKG)])
    const w = startCrashWatch({ adb: 'adb', serial: 's', pkg: PKG, sinceDeviceMs: 1, redact: keep }, f.host)
    expect(await w.check(), 'first read: still being written').toBeNull()
    expect((await w.check())?.crash.summary, 'next read: whole').toBe('signal 11 (SIGSEGV), code 1 (SEGV_MAPERR)')
    const never = fake([partial, partial])
    const w2 = startCrashWatch({ adb: 'adb', serial: 's', pkg: PKG, sinceDeviceMs: 1, redact: keep }, never.host)
    expect(await w2.check()).toBeNull()
    expect((await w2.check())?.crash.summary, 'waited once: reported as it is').toBe('native crash')
    const lastOnly = fake([partial])
    expect((await startCrashWatch({ adb: 'adb', serial: 's', pkg: PKG, sinceDeviceMs: 1, redact: keep }, lastOnly.host).check({ last: true }))?.crash.kind).toBe('native_crash')
  })

  it('never asks without a device clock, and treats an adb failure as no crash (it never throws)', async () => {
    const none = fake([])
    expect(await startCrashWatch({ adb: 'adb', serial: 's', pkg: PKG, sinceDeviceMs: null, redact: keep }, none.host).check()).toBeNull()
    expect(none.lines).toEqual([])
    const broken = fake([{ code: 1, stdout: javaCrash(SEC, PKG), stderr: 'logcat: bad buffer', error: 'failed' }, { code: null, stdout: '', stderr: '', error: 'timeout' }])
    const w = startCrashWatch({ adb: 'adb', serial: 's', pkg: PKG, sinceDeviceMs: 1, redact: keep }, broken.host)
    expect(await w.check()).toBeNull()
    expect(await w.check()).toBeNull()
  })
})
