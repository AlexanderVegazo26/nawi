/**
 * Crash, native crash and ANR reports as `logcat -d -b crash -b system -v epoch,uid ... AndroidRuntime:E
 * ActivityManager:E DEBUG:F '*:S'` prints them, in the shapes an API 36 emulator logged for `am crash <pkg>`, a SIGSEGV
 * and a SIGSTOP'd app given a tap (roadmap M5d-1). `sec` is the device time in seconds; the package is a parameter.
 */

const line = (sec: number, ms: string, uid: number, pid: number, tid: number, level: string, tag: string, message: string): string =>
  `         ${sec}.${ms} ${String(uid).padStart(5)} ${String(pid).padStart(5)} ${String(tid).padStart(5)} ${level} ${tag.padEnd(7)}: ${message}`

export function javaCrash(sec: number, pkg: string, opts: { pid?: number; uid?: number; exception?: string; frames?: number; ms?: string } = {}): string {
  const pid = opts.pid ?? 3475
  const at = (m: string): string => line(sec, opts.ms ?? '974', opts.uid ?? 10234, pid, pid, 'E', 'AndroidRuntime', m)
  const frames = Array.from({ length: opts.frames ?? 4 }, (_, i) => at(`\tat ${pkg}.ui.CheckoutFragment.track$${i}(CheckoutFragment.kt:${40 + i})`))
  return [
    '--------- beginning of crash',
    at('FATAL EXCEPTION: main'),
    at(`Process: ${pkg}, PID: ${pid}`),
    at(opts.exception ?? 'java.lang.IllegalStateException: tracking id missing'),
    ...frames,
    at('\tat android.os.Handler.dispatchMessage(Handler.java:110)')
  ].join('\n') + '\n'
}

export function nativeCrash(sec: number, pkg: string, opts: { pid?: number; abort?: string } = {}): string {
  const pid = opts.pid ?? 6507
  const dbg = (m: string): string => line(sec, '924', 1000, 6545, 6545, 'F', 'DEBUG', m)
  return [
    '--------- beginning of crash',
    dbg('*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***'),
    dbg("Build fingerprint: 'google/sdk_gphone64_x86_64/emu64xa:16/BE2A.250530.026.F3/13894323:userdebug/dev-keys'"),
    dbg('Process uptime: 2s'),
    dbg(`Cmdline: ${pkg}`),
    dbg(`pid: ${pid}, tid: ${pid}, name: ${pkg.slice(-15)}  >>> ${pkg} <<<`),
    dbg('uid: 10234'),
    dbg('signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0000000000000010'),
    ...(opts.abort ? [dbg(`Abort message: '${opts.abort}'`)] : []),
    dbg('    rax 0000000000000010  rbx 00000000024e60b0  rcx 0000000070fcc180  rdx 0000000000000910'),
    dbg('backtrace:'),
    dbg('      #00 pc 000000000020d86e  /data/app/~~x/lib/x86_64/libshop.so (Checkout::track()+30)')
  ].join('\n') + '\n'
}

export function anr(sec: number, pkg: string, opts: { pid?: number } = {}): string {
  const am = (m: string, tid = 6153): string => line(sec, '474', 1000, 3013, tid, 'E', 'ActivityManager', m)
  return [
    '--------- beginning of system',
    line(sec, '453', 1000, 3013, 6152, 'E', 'ActivityManager', `Aborted stack trace dump (current primary pid=${opts.pid ?? 5874}); deadline exceeded.`),
    am(`ANR in ${pkg} (${pkg}/.MainActivity)`),
    am(`PID: ${opts.pid ?? 5874}`),
    am(`Reason: Input dispatching timed out (856277e ${pkg}/${pkg}.MainActivity is not responding. Waited 5000ms for MotionEvent(deviceId=-1, source=TOUCHSCREEN, action=DOWN))`),
    am(`Parent: ${pkg}/.MainActivity`),
    am('ErrorId: 6a422753-c59a-417d-bc63-fa7032a7f102'),
    am('Frozen: false'),
    am('Load: 11.82 / 3.18 / 1.08'),
    am('----- Output from /proc/pressure/memory -----'),
    am('some avg10=3.95 avg60=2.50 avg300=0.66 total=2287830'),
    am('  40% 5491/com.google.android.apps.messaging: 28% user + 11% kernel')
  ].join('\n') + '\n'
}
