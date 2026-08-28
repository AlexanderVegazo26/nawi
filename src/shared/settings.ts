/**
 * Settings schema, defaults, validation and merge — shared by main and renderer.
 *
 * This module is deliberately node-free: `src/shared/**` is compiled into the web
 * project too, which has no node types. All filesystem work lives in
 * `src/main/settings.ts`.
 *
 * Main is the only place that validates: everything arriving from the renderer is
 * untrusted, so `sanitizeSettings` / `mergeSettings` never trust a key or a value's
 * type and never copy a prototype-polluting key.
 */

/** Every rebindable global action. The list is closed — an unknown action is dropped. */
export const HOTKEY_ACTIONS = [
  'capture-region',
  'capture-fullscreen',
  'capture-window',
  'record-start',
  'record-stop',
  'show-main'
] as const

export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number]

export type ThemePreference = 'system' | 'dark' | 'light'

export interface CaptureDefaults {
  /** Copy every new capture to the clipboard as soon as it exists. */
  copyToClipboard: boolean
  /** Open the editor after a capture instead of returning to the library. */
  openEditorAfterCapture: boolean
  /** Include an audio track when starting a recording. */
  recordAudio: boolean
  /** Hide the main window before a fullscreen/region capture. */
  hideAppDuringCapture: boolean
}

/** A named pattern applied to harvested text before it is written to disk. */
export interface RedactionRule {
  id: string
  label: string
  /** JavaScript regular-expression source. Compiled by the consumer, never by this module. */
  pattern: string
  enabled: boolean
}

export interface Settings {
  version: 1
  /** action -> Electron accelerator. */
  hotkeys: Record<HotkeyAction, string>
  theme: ThemePreference
  captureDefaults: CaptureDefaults
  /** Window/app titles whose pixels are blacked out during capture. */
  maskedApps: string[]
  redactionRules: RedactionRule[]
}

/**
 * The six accelerators that were hardcoded in `registerShortcuts()` before the
 * settings layer existed. Changing a value here changes the out-of-box binding.
 */
export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  'capture-region': 'CommandOrControl+Shift+1',
  'capture-fullscreen': 'CommandOrControl+Shift+2',
  'capture-window': 'CommandOrControl+Shift+3',
  'record-start': 'CommandOrControl+Shift+4',
  'record-stop': 'CommandOrControl+Shift+S',
  'show-main': 'CommandOrControl+Shift+0'
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    hotkeys: { ...DEFAULT_HOTKEYS },
    theme: 'system',
    captureDefaults: {
      copyToClipboard: true,
      openEditorAfterCapture: true,
      recordAudio: false,
      hideAppDuringCapture: true
    },
    maskedApps: [],
    redactionRules: []
  }
}

/** Partial settings as they arrive over IPC — every level optional, nothing trusted. */
export type SettingsPatch = {
  hotkeys?: Partial<Record<string, unknown>>
  theme?: unknown
  captureDefaults?: Partial<Record<string, unknown>>
  maskedApps?: unknown
  redactionRules?: unknown
}

const THEMES: readonly ThemePreference[] = ['system', 'dark', 'light']

/** Keys that must never be copied out of an object that crossed a trust boundary. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * An accelerator is a short printable single-line string. This is a shape check,
 * not a validity check — whether Electron can bind the chord is only knowable by
 * asking Electron, which `registerShortcuts()` does, best-effort.
 */
function isAccelerator(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 && !/[\r\n\t]/.test(v)
}

function sanitizeString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 && t.length <= max ? t : null
}

function mergeHotkeys(
  base: Record<HotkeyAction, string>,
  patch: unknown
): Record<HotkeyAction, string> {
  const out = { ...base }
  if (!isRecord(patch)) return out
  // Iterate the closed action list rather than the patch's own keys: an unknown or
  // polluting key can then never reach the output at all.
  for (const action of HOTKEY_ACTIONS) {
    if (!Object.prototype.hasOwnProperty.call(patch, action)) continue
    const value = patch[action]
    if (isAccelerator(value)) out[action] = value
  }
  return resolveHotkeyCollisions(out, base)
}

/**
 * Two actions cannot share a chord.
 *
 * A global accelerator is claimed by whichever action registers it first; the
 * second `register()` just returns false. So a duplicate does not produce a
 * conflict the user can see — it silently disables one of their hotkeys, and the
 * only trace is a console line that a packaged Windows app has no stdout to
 * print. Resolving it here means the persisted file is always bindable.
 *
 * The incoming binding wins and the *other* action is the one that yields, since
 * the collision only exists because the user just asked for that chord. A yielding
 * action falls back to its previous chord when that is still free, and is
 * otherwise left unbound rather than silently stealing a third action's key.
 */
function resolveHotkeyCollisions(
  next: Record<HotkeyAction, string>,
  previous: Record<HotkeyAction, string>
): Record<HotkeyAction, string> {
  const out = { ...next }
  const claimedBy = new Map<string, HotkeyAction>()

  // Actions whose chord actually changed staked their claim first.
  const changed = HOTKEY_ACTIONS.filter((a) => out[a] !== previous[a])
  const unchanged = HOTKEY_ACTIONS.filter((a) => out[a] === previous[a])

  for (const action of [...changed, ...unchanged]) {
    const chord = out[action]
    const key = chord.toLowerCase()
    if (!claimedBy.has(key)) {
      claimedBy.set(key, action)
      continue
    }
    const fallback = previous[action]
    if (fallback && !claimedBy.has(fallback.toLowerCase())) {
      out[action] = fallback
      claimedBy.set(fallback.toLowerCase(), action)
    } else {
      out[action] = ''
    }
  }
  return out
}

function mergeCaptureDefaults(base: CaptureDefaults, patch: unknown): CaptureDefaults {
  const out = { ...base }
  if (!isRecord(patch)) return out
  for (const key of Object.keys(out) as Array<keyof CaptureDefaults>) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
    if (typeof patch[key] === 'boolean') out[key] = patch[key]
  }
  return out
}

function sanitizeMaskedApps(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback
  const seen = new Set<string>()
  for (const entry of v.slice(0, 200)) {
    const s = sanitizeString(entry, 256)
    if (s) seen.add(s)
  }
  return [...seen]
}

function sanitizeRedactionRules(v: unknown, fallback: RedactionRule[]): RedactionRule[] {
  if (!Array.isArray(v)) return fallback
  const out: RedactionRule[] = []
  for (const entry of v.slice(0, 200)) {
    if (!isRecord(entry)) continue
    const id = sanitizeString(entry.id, 128)
    const label = sanitizeString(entry.label, 128)
    const pattern = sanitizeString(entry.pattern, 1024)
    if (!id || !label || !pattern) continue
    if (FORBIDDEN_KEYS.has(id)) continue
    out.push({ id, label, pattern, enabled: entry.enabled !== false })
  }
  return out
}

/**
 * Coerces arbitrary parsed JSON into a complete `Settings`, filling anything
 * missing or malformed from the defaults. Used on the read path so a hand-edited
 * or half-written file degrades field-by-field instead of all at once.
 */
export function sanitizeSettings(raw: unknown): Settings {
  return mergeSettings(defaultSettings(), raw)
}

/**
 * Applies a partial patch over a known-good base.
 *
 * Top level is a shallow replace per field; `hotkeys` and `captureDefaults` merge
 * per key so a settings panel can send one changed binding without having to
 * round-trip the whole record. Arrays (`maskedApps`, `redactionRules`) replace
 * wholesale — a partial array has no meaningful merge semantics.
 */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const p: Record<string, unknown> = isRecord(patch) ? patch : {}
  const theme = p.theme
  return {
    version: 1,
    hotkeys: mergeHotkeys(base.hotkeys, p.hotkeys),
    theme: THEMES.includes(theme as ThemePreference) ? (theme as ThemePreference) : base.theme,
    captureDefaults: mergeCaptureDefaults(base.captureDefaults, p.captureDefaults),
    maskedApps: 'maskedApps' in p ? sanitizeMaskedApps(p.maskedApps, base.maskedApps) : base.maskedApps,
    redactionRules:
      'redactionRules' in p
        ? sanitizeRedactionRules(p.redactionRules, base.redactionRules)
        : base.redactionRules
  }
}

/** True when the two hotkey maps differ, so main only re-binds when it must. */
export function hotkeysDiffer(
  a: Record<HotkeyAction, string>,
  b: Record<HotkeyAction, string>
): boolean {
  return HOTKEY_ACTIONS.some((action) => a[action] !== b[action])
}
