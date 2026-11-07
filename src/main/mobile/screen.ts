import type { MobileScreenFrame } from '@shared/mobile'
import { type ProcessResult, runBytes } from './exec'
import { PNG_SIGNATURE } from './png'

/**
 * Roadmap M1d: one frame of a device's screen, for the live view next to the open progress. `adb exec-out
 * screencap -p` writes a PNG to stdout (exec-out, not shell: shell mangles binary on old devices). Electron-free;
 * the process runner is injectable so tests never touch adb.
 */

/** The window's frame type (src/shared/mobile.ts): what crosses IPC as is. */
export type ScreenFrame = MobileScreenFrame

/** A frame grab's outcome; too_large: stdout passed MAX_FRAME_BYTES (see exec.ts). */
export type BinaryExecResult = ProcessResult<Uint8Array>

export type BinaryExec = (file: string, args: string[], timeoutMs: number) => Promise<BinaryExecResult>

export const SCREENCAP_TIMEOUT_MS = 10_000
/** A 4K RGBA screen as an uncompressed PNG is ~33 MB; anything bigger is not a screenshot. */
export const MAX_FRAME_BYTES = 48 * 1024 * 1024

export const execBinary: BinaryExec = (file, args, timeoutMs) => runBytes(file, args, timeoutMs, MAX_FRAME_BYTES)

/** Width and height from a PNG's IHDR chunk, or null when `bytes` is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null
  // Bytes 12..15 are the first chunk's type, which must be IHDR; width and height follow, big-endian.
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? ''
}

/** One PNG frame of `serial`'s screen. Never throws: a failure says what to do. */
export async function captureScreen(adb: string, serial: string, exec: BinaryExec = execBinary): Promise<ScreenFrame> {
  const r = await exec(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], SCREENCAP_TIMEOUT_MS)
  if (r.error === 'not_found') return { ok: false, error: 'adb could not be started', fix: 'Install the Android SDK Platform-Tools and set ANDROID_HOME, then open the app again.' }
  if (r.error === 'timeout') return { ok: false, error: `${serial} did not send its screen within ${SCREENCAP_TIMEOUT_MS / 1000} s`, fix: `Check that ${serial} responds (\`adb -s ${serial} shell echo ok\`).` }
  if (r.error === 'too_large') return { ok: false, error: `${serial} sent more than ${MAX_FRAME_BYTES / 1024 / 1024} MB for one frame`, fix: `Run \`adb -s ${serial} exec-out screencap -p > screen.png\` in a terminal and check what it writes; a screenshot is a few MB.` }
  const said = firstLine(r.stderr)
  if (/device '.*' not found|device offline|no devices\/emulators found|device not found/i.test(said)) {
    return { ok: false, error: `${serial} is no longer connected`, fix: `Reconnect ${serial} (or restart that emulator), then open the app again.` }
  }
  const size = r.code === 0 ? pngSize(r.stdout) : null
  if (!size) {
    // A locked-down screen (FLAG_SECURE) or an old screencap prints nothing or text instead of a PNG.
    const why = said || firstLine(Buffer.from(r.stdout.subarray(0, 200)).toString('utf8')) || (r.code === 0 ? 'no image' : `exit code ${r.code}`)
    return { ok: false, error: `screencap did not return an image (${why})`, fix: `Run \`adb -s ${serial} exec-out screencap -p > screen.png\` in a terminal to see why; apps that block screenshots show a black or empty screen.` }
  }
  return { ok: true, png: r.stdout, ...size }
}
