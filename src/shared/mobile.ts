/**
 * Roadmap M1d: what the window shows while an .apk dropped on it is opened on a device. Main runs the same open as
 * the MCP tool mobile_open (src/main/mcp/tools.ts openMobileFile) and reports each step; the renderer draws them.
 */

/** `read` is reading the .apk; the rest are mobile_open's steps, in order. */
export type MobileStepId = 'read' | 'doctor' | 'boot' | 'install' | 'grant' | 'launch'
export const MOBILE_STEPS: readonly MobileStepId[] = ['read', 'doctor', 'boot', 'install', 'grant', 'launch']

export type MobileStepStatus = 'ok' | 'warn' | 'fail' | 'skipped'

/** main -> renderer while an open runs: the step that just started. */
export interface MobileProgress {
  /** The open this belongs to (from openApk's reply), so a late event from an earlier open is ignored. */
  openId: number
  id: MobileStepId
  summary: string
}

export interface MobileStepView {
  id: MobileStepId
  status: MobileStepStatus
  summary: string
  /** One sentence telling the user what to do, for warn and fail. */
  fix: string | null
}

export interface MobileOpenView {
  openId: number
  /** Installed and launched. */
  ok: boolean
  /** The user pressed Cancel (ok is false, fix is null). */
  cancelled: boolean
  /** The one next step when not ok and not cancelled. */
  fix: string | null
  package: string | null
  target: { kind: 'device' | 'avd'; name: string; serial: string | null; api: number | null; booted: boolean } | null
  launched: { activity: string; total_time_ms: number | null; pid: number | null } | null
  steps: MobileStepView[]
  /** Where the reusable *.nawi.mobile.yaml profile was saved, or why it wasn't. */
  profile: string | null
  profile_error: string | null
}

/** One frame of the device screen, or why there is none. */
export type MobileScreenFrame =
  | { ok: true; png: Uint8Array; width: number; height: number }
  | { ok: false; error: string; fix: string }

/** File names the window accepts as an Android app (an .aab is refused by main with the bundletool fix). */
export function isAndroidPackageName(name: string): boolean {
  return /\.(apk|aab)$/i.test(name)
}
