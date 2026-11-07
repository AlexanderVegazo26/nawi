import { execFile, type ExecFileException } from 'node:child_process'

/**
 * The one process runner behind the mobile host's `exec` (text: adb, emulator) and `execBinary` (PNG frames).
 * Electron-free; callers inject a fake in tests, and exec.test.ts runs this one against real child processes.
 */

/**
 * Why a process did not run to completion.
 * - not_found: it could not be started (missing or not executable).
 * - timeout: it was still running at the deadline and was killed.
 * - too_large: its stdout or stderr passed `maxBuffer`; node killed it and kept only the output up to the cap.
 *   (node's error then has no `killed`/`signal`, so it must be told apart by its code, not as a kill.)
 * - failed: it ran and exited non-zero, or died of a signal it did not get from us.
 */
export type ExecError = 'not_found' | 'timeout' | 'too_large' | 'failed'

export interface ProcessResult<Out> {
  /** Exit code, or null when the process could not start or was killed. */
  code: number | null
  stdout: Out
  stderr: string
  /** Why it did not run to completion. */
  error?: ExecError
}

/** The result fields node's execFile error stands for. */
export function classifyExecError(err: Pick<ExecFileException, 'code' | 'killed' | 'signal'>): { code: number | null; error: ExecError } {
  if (err.code === 'ENOENT' || err.code === 'EACCES') return { code: null, error: 'not_found' }
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { code: null, error: 'too_large' }
  if (err.killed || err.signal === 'SIGTERM') return { code: null, error: 'timeout' }
  return { code: typeof err.code === 'number' ? err.code : null, error: 'failed' }
}

/** execFile throws on a fractional timeout, and deadlines on performance.now() leave fractions (19999.998 ms). */
const wholeMs = (timeoutMs: number): number => Math.max(1, Math.ceil(timeoutMs))

/** Run `file` and collect its output as UTF-8 text, at most `maxBuffer` characters per stream. Never rejects. */
export function runText(file: string, args: string[], timeoutMs: number, maxBuffer: number): Promise<ProcessResult<string>> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: wholeMs(timeoutMs), windowsHide: true, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr })
      resolve({ ...classifyExecError(err), stdout, stderr })
    })
  })
}

/** Run `file` and collect its stdout as bytes (no copy: a Buffer is a Uint8Array), at most `maxBuffer` bytes. Never rejects. */
export function runBytes(file: string, args: string[], timeoutMs: number, maxBuffer: number): Promise<ProcessResult<Uint8Array>> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: wholeMs(timeoutMs), windowsHide: true, maxBuffer, encoding: 'buffer' }, (err, stdout, stderr) => {
      const out: Uint8Array = stdout ?? new Uint8Array()
      const errText = Buffer.from(stderr ?? []).toString('utf8')
      if (!err) return resolve({ code: 0, stdout: out, stderr: errText })
      resolve({ ...classifyExecError(err), stdout: out, stderr: errText })
    })
  })
}
