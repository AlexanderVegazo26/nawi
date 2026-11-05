import { LOCALE_RE, PACKAGE_RE, type DeviceSettings } from './profile'
import { shQuote } from './shell'

/**
 * Roadmap M2 (second slice, M2b): the device settings a mobile profile asks for, as the `adb shell` lines that apply
 * them. Pure: the same settings, package and API level always give the same commands, so tests can pin them.
 *
 * - `animations`: the three global animation scales (0 = off, 1 = the Android default).
 * - `dark_mode`: `cmd uimode night yes|no` (Android 10, API 29+).
 * - `font_scale`: `settings put system font_scale <n>`.
 * - `locale`: the app's own language (`cmd locale set-app-locales`, Android 13, API 33+); changing the whole
 *   device's language needs root, and a per-app locale is what the app's language picker would set anyway.
 * - `network`: airplane mode off (true) or on (false) with `cmd connectivity airplane-mode` (Android 11, API 30+), so a
 *   profile that asks for the network brings back a device an earlier offline run left in airplane mode, and a
 *   profile can run the app offline on purpose. Only airplane mode: Wi-Fi or mobile data switched off on their own
 *   stay off. Airplane mode is never turned on over a network adb connection (`isNetworkSerial`): it would cut adb.
 *
 * Every value is checked against the profile schema's rules again here and the package and locale are quoted (they
 * end up in a shell command line); numbers are printed by us, never copied from a string.
 */

export type DeviceSettingName = keyof DeviceSettings

export interface SettingCommand {
  name: DeviceSettingName
  /** What it sets, for the step summary: "animations off", "locale en-US". */
  label: string
  /** One `adb shell` command line. */
  line: string
  /** The lowest API level that has the command; null: every supported level. */
  minApi: number | null
}

const ANIMATION_SCALES = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'] as const

/** `1`, `1.15`, `0.85`: at most two decimals, no exponent, no locale formatting. */
export function formatScale(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** The commands for the settings that are not null, in a fixed order (animations first: they affect everything after; network last). */
export function settingCommands(pkg: string, settings: DeviceSettings): SettingCommand[] {
  if (!PACKAGE_RE.test(pkg)) throw new Error(`"${pkg}" is not an Android package name.`)
  const out: SettingCommand[] = []
  if (settings.animations !== null) {
    const scale = settings.animations ? '1' : '0'
    out.push({
      name: 'animations',
      label: `animations ${settings.animations ? 'on' : 'off'}`,
      line: ANIMATION_SCALES.map((k) => `settings put global ${k} ${scale}`).join(' && '),
      minApi: null
    })
  }
  if (settings.dark_mode !== null) {
    out.push({ name: 'dark_mode', label: `dark mode ${settings.dark_mode ? 'on' : 'off'}`, line: `cmd uimode night ${settings.dark_mode ? 'yes' : 'no'}`, minApi: 29 })
  }
  if (settings.font_scale !== null) {
    if (!Number.isFinite(settings.font_scale) || settings.font_scale < 0.5 || settings.font_scale > 3) throw new Error(`font_scale ${settings.font_scale} is outside 0.5..3.`)
    const n = formatScale(settings.font_scale)
    out.push({ name: 'font_scale', label: `font scale ${n}`, line: `settings put system font_scale ${n}`, minApi: null })
  }
  if (settings.locale !== null) {
    if (!LOCALE_RE.test(settings.locale)) throw new Error(`"${settings.locale}" is not a language tag.`)
    out.push({ name: 'locale', label: `locale ${settings.locale}`, line: `cmd locale set-app-locales ${shQuote(pkg)} --locales ${shQuote(settings.locale)}`, minApi: 33 })
  }
  if (settings.network !== null) {
    if (typeof settings.network !== 'boolean') throw new Error(`network ${JSON.stringify(settings.network)} is not true, false or null.`)
    out.push({
      name: 'network',
      label: settings.network ? 'airplane mode off' : 'airplane mode on (offline)',
      line: `cmd connectivity airplane-mode ${settings.network ? 'disable' : 'enable'}`,
      minApi: 30
    })
  }
  return out
}

/**
 * True for an adb serial that reaches the device over the network (`adb connect host:port`, wireless debugging's
 * `adb-<id>._adb-tls-connect._tcp`): turning airplane mode on there would cut adb itself and leave the phone offline
 * with no way to switch it back from here. USB serials and `emulator-<port>` have neither a port nor that suffix.
 */
export function isNetworkSerial(serial: string): boolean {
  return serial.includes(':') || /\._adb-tls-connect\._tcp\.?$/.test(serial)
}

/** The Android version that brought an API level's command, for "needs Android 13" messages. */
export function androidVersionFor(api: number): string {
  const names: Record<number, string> = { 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16' }
  return names[api] ?? `API ${api}`
}
