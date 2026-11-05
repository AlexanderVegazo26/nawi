import { describe, expect, it } from 'vitest'
import { defaultDeviceSettings, KEEP_DEVICE_SETTINGS, parseMobileProfile, type DeviceSettings } from './profile'
import { androidVersionFor, formatScale, isNetworkSerial, settingCommands } from './settings'

/**
 * Device settings (roadmap M2b): the exact `adb shell` lines a profile's device section turns into, and that no value
 * can smuggle shell syntax into them even when a caller skips the profile schema. Pure; no device.
 */

const PKG = 'dev.nawi.sample'

describe('settingCommands', () => {
  it('turns every setting into its command, animations first, with the API level each command needs', () => {
    const all: DeviceSettings = { locale: 'pt-BR', dark_mode: true, font_scale: 1.15, animations: true, network: true }
    expect(settingCommands(PKG, all)).toEqual([
      {
        name: 'animations',
        label: 'animations on',
        line: 'settings put global window_animation_scale 1 && settings put global transition_animation_scale 1 && settings put global animator_duration_scale 1',
        minApi: null
      },
      { name: 'dark_mode', label: 'dark mode on', line: 'cmd uimode night yes', minApi: 29 },
      { name: 'font_scale', label: 'font scale 1.15', line: 'settings put system font_scale 1.15', minApi: null },
      { name: 'locale', label: 'locale pt-BR', line: `cmd locale set-app-locales '${PKG}' --locales 'pt-BR'`, minApi: 33 },
      { name: 'network', label: 'airplane mode off', line: 'cmd connectivity airplane-mode disable', minApi: 30 }
    ])
  })

  it('turns network: false into airplane mode on, so a profile can run the app offline', () => {
    expect(settingCommands(PKG, { ...KEEP_DEVICE_SETTINGS, network: false }), 'network off').toEqual([
      { name: 'network', label: 'airplane mode on (offline)', line: 'cmd connectivity airplane-mode enable', minApi: 30 }
    ])
  })

  it('sends nothing for null settings (leave the device as it is)', () => {
    expect(settingCommands(PKG, KEEP_DEVICE_SETTINGS), 'all null').toEqual([])
    expect(settingCommands(PKG, { ...KEEP_DEVICE_SETTINGS, font_scale: 0.85 }).map((c) => c.line), 'only font_scale set').toEqual(['settings put system font_scale 0.85'])
  })

  it('gives the same commands for the same settings every time (a profile replays identically)', () => {
    const a = settingCommands(PKG, defaultDeviceSettings('avd'))
    const b = settingCommands(PKG, structuredClone(defaultDeviceSettings('avd')))
    expect(a).toEqual(b)
    expect(a.map((c) => c.label)).toEqual(['animations off', 'dark mode off', 'font scale 1', 'locale en-US', 'airplane mode off'])
  })

  it.each([
    ['a shell command in the locale', { ...KEEP_DEVICE_SETTINGS, locale: 'en; reboot' }, /not a language tag/],
    ['a command substitution in the locale', { ...KEEP_DEVICE_SETTINGS, locale: '$(reboot)' }, /not a language tag/],
    ['a font scale out of range', { ...KEEP_DEVICE_SETTINGS, font_scale: 10 }, /outside 0\.5\.\.3/],
    ['a font scale that is not a number', { ...KEEP_DEVICE_SETTINGS, font_scale: Number.NaN }, /outside 0\.5\.\.3/],
    ['a network setting given as the string "false"', { ...KEEP_DEVICE_SETTINGS, network: 'false' }, /network "false" is not true, false or null/]
  ])('refuses %s even without the profile schema in front of it', (_case, settings, message) => {
    expect(() => settingCommands(PKG, settings as DeviceSettings)).toThrow(message)
  })

  it('refuses a package name that is not an Android package name', () => {
    expect(() => settingCommands('dev.nawi; reboot', defaultDeviceSettings('avd'))).toThrow(/not an Android package name/)
  })
})

describe('defaults and helpers', () => {
  it('a virtual device gets a fixed test setup; a physical phone is left as it is', () => {
    expect(defaultDeviceSettings('avd'), 'unknown API: everything').toEqual({ locale: 'en-US', dark_mode: false, font_scale: 1, animations: false, network: true })
    expect(defaultDeviceSettings('avd', 36), 'API 36').toEqual({ locale: 'en-US', dark_mode: false, font_scale: 1, animations: false, network: true })
    expect(defaultDeviceSettings('avd', 32), 'API 32: no per-app locale').toEqual({ locale: null, dark_mode: false, font_scale: 1, animations: false, network: true })
    expect(defaultDeviceSettings('avd', 29), 'API 29: no airplane-mode command either').toEqual({ locale: null, dark_mode: false, font_scale: 1, animations: false, network: null })
    expect(defaultDeviceSettings('avd', 28), 'API 28: no dark mode either').toEqual({ locale: null, dark_mode: null, font_scale: 1, animations: false, network: null })
    expect(defaultDeviceSettings('device', 36)).toEqual(KEEP_DEVICE_SETTINGS)
    defaultDeviceSettings('device').locale = 'xx'
    expect(KEEP_DEVICE_SETTINGS.locale, 'the shared constant is not handed out to be mutated').toBeNull()
  })

  it('isNetworkSerial tells adb-over-the-network serials (airplane mode would cut them) from USB and emulator ones', () => {
    const network = ['192.168.1.20:5555', 'localhost:5555', '[fe80::1]:5555', 'adb-R58M123-AbCdEf._adb-tls-connect._tcp', 'adb-R58M123-AbCdEf._adb-tls-connect._tcp.']
    const local = ['emulator-5554', 'R58M123ABC', '0123456789ABCDEF', 'Pixel_API_36']
    expect(network.filter((s) => !isNetworkSerial(s)), 'network serials read as local').toEqual([])
    expect(local.filter(isNetworkSerial), 'local serials read as network').toEqual([])
  })

  it('formatScale prints at most two decimals without exponent', () => {
    expect([1, 1.1, 0.85, 1.149999, 2].map(formatScale)).toEqual(['1', '1.1', '0.85', '1.15', '2'])
  })

  it('androidVersionFor names the release of an API level, or the level itself', () => {
    expect([29, 30, 33, 36, 40].map(androidVersionFor)).toEqual(['10', '11', '13', '16', 'API 40'])
  })
})

describe('device section in the profile', () => {
  const base = `version: 1
app: { apk: /home/u/app.apk, package: dev.nawi.sample, version_code: 1, version_name: "1.0", sha256: ${'a'.repeat(64)} }
target: null
permissions: { grant: [] }
launch: { activity: null }
`

  it('loads a profile saved before device settings existed (no screen or device section)', () => {
    const parsed = parseMobileProfile(base)
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
    if (parsed.ok) expect(parsed.profile.device, 'missing device section').toBeUndefined()
  })

  it('reads a setting left out of a hand-written device section as null (leave it as it is)', () => {
    const parsed = parseMobileProfile(`${base}device:\n  animations: false\n`)
    expect(parsed).toEqual(expect.objectContaining({ ok: true, profile: expect.objectContaining({ device: { locale: null, dark_mode: null, font_scale: null, animations: false, network: null } }) }))
  })

  it('loads screen and device sections', () => {
    const parsed = parseMobileProfile(`${base}screen: { framework: flutter, read: flutter_semantics }\ndevice: { locale: es-419, dark_mode: null, font_scale: 1.3, animations: false }\n`)
    expect(parsed).toMatchObject({ ok: true, profile: { screen: { framework: 'flutter', read: 'flutter_semantics' }, device: { locale: 'es-419', dark_mode: null, font_scale: 1.3, animations: false } } })
  })

  it.each([
    ['a shell command in the locale', 'device: { locale: "en; reboot", dark_mode: null, font_scale: null, animations: null }', 'device.locale'],
    ['a font scale above 3', 'device: { locale: null, dark_mode: null, font_scale: 4, animations: null }', 'device.font_scale'],
    ['a dark mode that is not true/false/null', 'device: { locale: null, dark_mode: "auto", font_scale: null, animations: null }', 'device.dark_mode'],
    ['a network setting that is not true/false/null', 'device: { network: "wifi" }', 'device.network'],
    ['a device setting Nawi does not know', 'device: { locale: null, dark_mode: null, font_scale: null, animations: null, wifi: false }', 'device'],
    ['a read strategy Nawi does not know', 'screen: { framework: native, read: ocr }', 'screen.read']
  ])('refuses %s, naming the field', (_case, extra, path) => {
    const parsed = parseMobileProfile(`${base}${extra}\n`)
    expect(parsed.ok, `${extra} should be refused`).toBe(false)
    if (!parsed.ok) expect(parsed.errors.map((e) => e.path)).toContain(path)
  })
})
