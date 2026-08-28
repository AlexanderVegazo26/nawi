import { app, shell, systemPreferences } from 'electron'
import type { PermissionState, ScreenAccess } from '@shared/types'

/**
 * Screen-recording permission state and recovery (UX-PRM.1-3).
 *
 * PRD-002 §4 calls this "the single largest drop-off risk on macOS and Wayland",
 * and before this module the entire treatment was one toast string produced by
 * `describeMediaError` in `src/renderer/lib/recorder.ts` — a dead end, which
 * UX-PRM.2 forbids by name.
 *
 * ## What is actually knowable, per platform
 *
 * `systemPreferences.getMediaAccessStatus('screen')` is the only API Electron
 * offers here, and it is meaningful on macOS. It is called inside a try/catch
 * and anything unexpected degrades to `'unknown'` rather than to `'granted'`:
 * an API that throws must not be able to report permission as present.
 *
 * On Windows, screen capture is not gated behind a per-app OS permission the
 * way it is on macOS, so a `'granted'` reading there says nothing useful and a
 * capture can still fail for reasons the OS does not model as a permission
 * (graphics-capture failure, group policy, a secure desktop). The recovery card
 * is therefore driven by *an actual failed capture*, never by the status alone.
 * That ordering is the important part: status-first would show the card to
 * nobody on Windows and to the wrong people on macOS.
 */

/** Where the user has to go, in the OS's own vocabulary (UX-PRM.1). */
function settingsPath(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return 'System Settings → Privacy & Security → Screen & System Audio Recording'
    case 'win32':
      return 'Settings → Privacy & security'
    default:
      return 'your desktop environment’s screen-sharing settings'
  }
}

export function screenPermission(): PermissionState {
  const platform = process.platform
  let status: ScreenAccess = 'unknown'
  try {
    // Not available on every platform; a throw here is a normal outcome, not a
    // bug, and must resolve to 'unknown'.
    const raw = systemPreferences.getMediaAccessStatus('screen')
    status =
      raw === 'granted' || raw === 'denied' || raw === 'restricted' || raw === 'not-determined'
        ? raw
        : 'unknown'
  } catch {
    status = 'unknown'
  }

  return {
    platform,
    screen: status,
    settingsPath: settingsPath(platform),
    /**
     * UX-PRM.3. "Granted but the app has not been relaunched" is a macOS
     * behaviour — the TCC grant is read at process start. Reporting it on
     * Windows would offer the user a relaunch that fixes nothing, so it is
     * gated on the platform rather than invented for parity.
     */
    relaunchMayBeRequired: platform === 'darwin'
  }
}

/**
 * Deep-links to the relevant OS settings pane (UX-PRM.2's `[Open System Settings]`).
 *
 * Returns nothing on success and throws on failure, so the caller's IPC wrapper
 * turns a refused deep link into a visible error rather than a button that
 * appears to work.
 */
export async function openScreenSettings(): Promise<void> {
  if (process.platform === 'darwin') {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    )
    return
  }
  if (process.platform === 'win32') {
    // Windows exposes no screen-capture privacy page; the Privacy & security
    // root is the closest honest destination, and the card's copy says so
    // rather than implying a toggle exists that does not.
    await shell.openExternal('ms-settings:privacy')
    return
  }
  throw new Error('This platform has no settings page we can open for you.')
}

/** UX-PRM.3 `[Relaunch now]`. */
export function relaunchApp(): void {
  app.relaunch()
  app.quit()
}
