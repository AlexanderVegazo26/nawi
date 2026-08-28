import { useEffect, useState } from 'react'
import { DEFAULT_HOTKEYS, type HotkeyAction } from '@shared/settings'

/**
 * PRD-002 §9 — "Keep hotkeys in copy rendered as the user's actual binding,
 * resolved at render time."
 *
 * Before this module, `CaptureView` and `overlay.tsx` carried string literals
 * like `Ctrl+Shift+1`. Those are not merely stylistically wrong: the M0 settings
 * layer lets the user rebind every action, and `resolveHotkeyCollisions` can
 * leave an action *unbound* entirely. A hardcoded literal then tells the user to
 * press a chord that does nothing, which is the exact failure UX-STA.1 is about
 * ("with the user's actual configured hotkey rendered").
 */

/**
 * Turns an Electron accelerator into something a person reads on this platform.
 *
 * Pure and platform-parameterised so it is provable without a browser: the
 * `platform` argument defaults to the live one but every test passes it
 * explicitly.
 */
export function formatAccelerator(
  accelerator: string,
  platform: string = typeof navigator === 'undefined' ? 'win32' : navigator.platform
): string {
  const mac = /mac|iphone|ipad/i.test(platform)
  const parts = accelerator
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) return ''

  return parts
    .map((part) => {
      switch (part.toLowerCase()) {
        case 'commandorcontrol':
        case 'cmdorctrl':
          return mac ? '⌘' : 'Ctrl'
        case 'command':
        case 'cmd':
        case 'super':
        case 'meta':
          return mac ? '⌘' : 'Win'
        case 'control':
        case 'ctrl':
          return mac ? '⌃' : 'Ctrl'
        case 'alt':
          return mac ? '⌥' : 'Alt'
        case 'option':
          return '⌥'
        case 'shift':
          return mac ? '⇧' : 'Shift'
        default:
          return part
      }
    })
    .join(mac ? '' : '+')
}

/**
 * What to render when an action has no binding.
 *
 * `mergeHotkeys` writes `''` for an action that lost a collision, so this is a
 * reachable state, not a defensive branch. Naming it beats rendering an empty
 * `<kbd>` that looks like a layout bug.
 */
export const UNBOUND_LABEL = 'not set'

/** Formats one action's binding, or `UNBOUND_LABEL` when it has none. */
export function hotkeyLabel(
  hotkeys: Record<HotkeyAction, string> | null,
  action: HotkeyAction,
  platform?: string
): string {
  const accel = hotkeys?.[action]
  if (accel === undefined) return formatAccelerator(DEFAULT_HOTKEYS[action], platform)
  if (accel === '') return UNBOUND_LABEL
  return formatAccelerator(accel, platform)
}

/**
 * Live hotkey map for copy.
 *
 * Starts at `null` rather than at the defaults so a caller can tell "not read
 * yet" from "read, and this is the binding" — rendering the defaults during the
 * read would flash a chord the user may have rebound away. `hotkeyLabel`
 * degrades a `null` map to the defaults, which is the right answer for a
 * settings read that *failed*, and both paths are one line apart.
 */
export function useHotkeys(): Record<HotkeyAction, string> | null {
  const [hotkeys, setHotkeys] = useState<Record<HotkeyAction, string> | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.getSettings().then((res) => {
      if (!cancelled && res.ok) setHotkeys(res.value.hotkeys)
    })
    // A rebind made in another window has to reach this copy, or the label goes
    // stale in exactly the situation the requirement exists for.
    const off = window.api.onSettingsChanged((next) => setHotkeys(next.hotkeys))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  return hotkeys
}
