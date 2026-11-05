import { describe, expect, it } from 'vitest'
import type { ApkInfo } from '../main/mobile/apk'
import { detectFramework } from '../main/mobile/framework'
import type { MobileDoctorReport } from '../main/mobile/doctor'
import { MobileUsageError, parseMobileDoctorArgs, parseMobileInspectArgs, parseMobileOpenArgs, readProfileText, renderApkInfo, renderDoctorReport, renderOpenResult, type MobileOpenReport } from './mobile'

describe('parseMobileInspectArgs', () => {
  it('resolves a positional or --file path against the shell folder, and takes --json', () => {
    expect(parseMobileInspectArgs(['app.apk'], '/home/u/dl')).toEqual({ file: '/home/u/dl/app.apk', json: false })
    expect(parseMobileInspectArgs(['--json', '--file', '../app.apk'], '/home/u/dl')).toEqual({ file: '/home/u/app.apk', json: true })
    expect(parseMobileInspectArgs(['/abs/app.apk'], '/home/u')).toEqual({ file: '/abs/app.apk', json: false })
  })

  it.each([
    [[], /Which APK/],
    [['a.apk', 'b.apk'], /one APK/],
    [['a.apk', '--file', 'b.apk'], /one APK/],
    [['--file'], /--file needs a path/],
    [['--file', '--json'], /--file needs a path/],
    [['--headless', 'a.apk'], /Unknown flag --headless/]
  ])('refuses %j as a usage error', (argv, message) => {
    expect(() => parseMobileInspectArgs(argv, '/home/u')).toThrow(MobileUsageError)
    expect(() => parseMobileInspectArgs(argv, '/home/u')).toThrow(message)
  })
})

describe('renderApkInfo', () => {
  const base: ApkInfo = {
    package: 'com.example',
    version_code: 7,
    version_name: '2.0',
    min_sdk: 24,
    target_sdk: 35,
    launcher_activity: 'com.example.Main',
    abis: ['arm64-v8a'],
    debuggable: false,
    permissions: [
      { name: 'android.permission.INTERNET', runtime: false, max_sdk: null },
      { name: 'android.permission.CAMERA', runtime: true, max_sdk: null }
    ],
    deep_links: [{ component: 'com.example.Links', uri: 'https://example.test/x*', auto_verify: true }],
    exported_components: [{ kind: 'receiver', name: 'com.example.Boot', why: 'intent-filter' }],
    framework: detectFramework([], false),
    unresolved: []
  }

  it('prints one line per fact, runtime permissions by short name, links and exports indented', () => {
    expect(renderApkInfo(base).split('\n')).toEqual([
      'com.example 2.0 (7)',
      '  SDK          min 24, target 35',
      '  launcher     com.example.Main',
      '  ABIs         arm64-v8a',
      '  debuggable   no',
      '  framework    native Android, screen read from the accessibility tree',
      '    Android views or Compose: Nawi reads the accessibility tree. Resource ids (android:id, or a Compose testTag with testTagsAsResourceId) and content descriptions make locators stable.',
      '  permissions  2 (1 runtime: CAMERA)',
      '  deep links   1',
      '    https://example.test/x* (verified) -> com.example.Links',
      '  exported     1',
      '    receiver com.example.Boot (implicit: intent filter, no android:exported)'
    ])
  })

  it('names the framework, how its screen is read, the deciding files and the outranked ones', () => {
    const framework = detectFramework(['lib/arm64-v8a/libflutter.so', 'assets/www/cordova.js'], false)
    const lines = renderApkInfo({ ...base, framework }).split('\n')
    const at = lines.indexOf("  framework    Flutter, screen read from Flutter's semantics tree (also found: WebView (hybrid web app))")
    expect(at, `framework line in:\n${lines.join('\n')}`).toBeGreaterThan(0)
    expect(lines.slice(at + 1, at + 3)).toEqual(['    decided by lib/arm64-v8a/libflutter.so', `    ${framework.note}`])
  })

  it('says what an absent launcher, ABI list, link list or export list means', () => {
    const out = renderApkInfo({ ...base, version_code: null, version_name: null, launcher_activity: null, abis: [], permissions: [], deep_links: [], exported_components: [] })
    expect(out).toContain('com.example\n')
    expect(out).toContain('(none: the app has no launcher activity)')
    expect(out).toContain('any (no native code)')
    expect(out).toContain('permissions  0 (0 runtime)')
    expect(out).toContain('deep links   none')
    expect(out).toContain('exported     none')
    expect(out, 'no unresolved section when everything resolved').not.toContain('unresolved')
  })

  it('lists the values taken from resources that were not resolved', () => {
    const out = renderApkInfo({ ...base, unresolved: ['versionName (@0x7f120001)'] })
    expect(out.split('\n').slice(-2)).toEqual(['  unresolved   1 (resource references, not read yet)', '    versionName (@0x7f120001)'])
  })
})

describe('parseMobileDoctorArgs', () => {
  it('takes no APK, or one resolved against the shell folder', () => {
    expect(parseMobileDoctorArgs([], '/home/u')).toEqual({ file: undefined, json: false })
    expect(parseMobileDoctorArgs(['--json'], '/home/u')).toEqual({ file: undefined, json: true })
    expect(parseMobileDoctorArgs(['dl/app.apk'], '/home/u')).toEqual({ file: '/home/u/dl/app.apk', json: false })
  })

  it.each([
    [['a.apk', 'b.apk'], /one APK/],
    [['--file'], /--file needs a path/],
    [['--fix'], /Unknown flag --fix/]
  ])('refuses %j as a usage error', (argv, message) => {
    expect(() => parseMobileDoctorArgs(argv, '/home/u')).toThrow(MobileUsageError)
    expect(() => parseMobileDoctorArgs(argv, '/home/u')).toThrow(message)
  })
})

describe('renderDoctorReport', () => {
  const report: MobileDoctorReport = {
    ready: false,
    recommended: null,
    fix: 'Add yourself to the kvm group (`sudo usermod -aG kvm $USER`), then log out and back in.',
    apk: { package: 'com.example', min_sdk: 24, target_sdk: 35, abis: [] },
    sdk: { path: '/sdk', source: 'ANDROID_HOME' },
    adb: { path: '/sdk/platform-tools/adb', version: '1.0.41' },
    emulator: { path: '/sdk/emulator/emulator' },
    virtualization: { status: 'no_permission', detail: '/dev/kvm exists but this user cannot open it' },
    devices: [],
    avds: [],
    checks: [
      { id: 'sdk', status: 'ok', summary: '/sdk (ANDROID_HOME)', fix: null },
      { id: 'virtualization', status: 'fail', summary: '/dev/kvm exists but this user cannot open it', fix: 'x' },
      { id: 'devices', status: 'skipped', summary: 'no device connected', fix: null }
    ]
  }

  it('prints the verdict, one line per check, and the one next step', () => {
    expect(renderDoctorReport(report).split('\n')).toEqual([
      'Not ready to run com.example.',
      '  ok    sdk            /sdk (ANDROID_HOME)',
      '  FAIL  virtualization /dev/kvm exists but this user cannot open it',
      '  -     devices        no device connected',
      '',
      'Next: Add yourself to the kvm group (`sudo usermod -aG kvm $USER`), then log out and back in.'
    ])
  })

  it('names the recommended device when ready, with no next step', () => {
    const out = renderDoctorReport({ ...report, ready: true, fix: null, apk: null, recommended: { kind: 'avd', name: 'pixel-36' } })
    expect(out.split('\n')[0]).toBe('Ready: use virtual device pixel-36.')
    expect(out, 'no Next line when ready').not.toContain('Next:')
  })
})

describe('parseMobileOpenArgs', () => {
  it('resolves the app and --profile against the shell folder and maps each flag to a tool argument', () => {
    expect(parseMobileOpenArgs(['dl/app.apk'], '/home/u')).toEqual({ file: '/home/u/dl/app.apk', json: false })
    expect(
      parseMobileOpenArgs(['app.nawi.mobile.yaml', '--target', 'emulator-5554', '--headless', '--no-grant', '--profile', 'out.nawi.mobile.yaml', '--boot-timeout-ms', '60000', '--json'], '/home/u')
    ).toEqual({
      file: '/home/u/app.nawi.mobile.yaml',
      json: true,
      target: 'emulator-5554',
      headless: true,
      grant: false,
      profile: '/home/u/out.nawi.mobile.yaml',
      boot_timeout_ms: 60000
    })
    expect(parseMobileOpenArgs(['--no-profile', '--file', '/a/app.apk'], '/home/u')).toEqual({ file: '/a/app.apk', json: false, save_profile: false })
    expect(parseMobileOpenArgs(['/a/app.apk', '--learn-onboarding'], '/home/u'), '--learn-onboarding -> learn_onboarding').toEqual({ file: '/a/app.apk', json: false, learn_onboarding: true })
  })

  it.each([
    [[], /Which app\?/],
    [['a.apk', 'b.apk'], /Give one APK or profile/],
    [['a.apk', '--target'], /--target needs a value/],
    [['a.apk', '--boot-timeout-ms', '1m'], /whole number/],
    [['a.apk', '--boot-timeout-ms', '5000'], /from 10000 to 900000/],
    [['a.apk', '--profile', 'p.nawi.mobile.yaml', '--no-profile'], /contradict/],
    [['a.apk', '--force'], /Unknown flag --force/]
  ])('refuses %j', (argv, message) => {
    expect(() => parseMobileOpenArgs(argv, '/home/u')).toThrow(MobileUsageError)
    expect(() => parseMobileOpenArgs(argv, '/home/u')).toThrow(message)
  })
})

describe('readProfileText (the CLI reads a profile only to find its sign_in references)', () => {
  const fs = (size: number, isFile = true) => ({ statSync: () => ({ isFile: () => isFile, size }), readFileSync: () => 'sign_in: ...' })

  it('reads a profile file within the size limit', () => {
    expect(readProfileText('/home/u/app.nawi.mobile.yaml', fs(100))).toBe('sign_in: ...')
  })

  it.each([
    ['an .apk', '/home/u/app.apk', fs(100)],
    ['a profile over 64 KiB', '/home/u/app.nawi.mobile.yaml', fs(64 * 1024 + 1)],
    ['a folder named like a profile', '/home/u/x.nawi.mobile.yaml', fs(0, false)],
    ['a file that is gone', '/home/u/x.nawi.mobile.yaml', { statSync: () => { throw new Error('ENOENT') }, readFileSync: () => '' }]
  ])('leaves %s to the app (null)', (_, file, f) => {
    expect(readProfileText(file, f)).toBeNull()
  })
})

describe('renderOpenResult', () => {
  const result: MobileOpenReport = {
    ok: true,
    fix: null,
    package: 'com.example',
    target: { kind: 'avd', name: 'pixel-36', serial: 'emulator-5554', api: 36, booted: true },
    permissions: { granted: ['android.permission.CAMERA'], not_granted: [] },
    settings: { requested: { locale: 'en-US', dark_mode: false, font_scale: 1, animations: false, network: true }, applied: ['animations'], not_applied: [] },
    launched: { activity: 'com.example.Main', total_time_ms: 300, pid: 7 },
    first_screen: null,
    onboarding: null,
    sign_in: null,
    steps: [
      { id: 'doctor', status: 'ok', summary: 'virtual device pixel-36 (API 36)', fix: null },
      { id: 'boot', status: 'ok', summary: 'pixel-36 booted as emulator-5554', fix: null },
      { id: 'grant', status: 'warn', summary: 'granted 1 of 2', fix: 'Those permissions will be asked for in a dialog.' },
      { id: 'settings', status: 'ok', summary: 'animations off', fix: null }
    ],
    doctor: null,
    apk: '/home/u/app.apk',
    sha256: null,
    profile: '/home/u/com.example.nawi.mobile.yaml',
    profile_error: null,
    apk_changed: true
  }

  it('prints where it runs, one line per step, the profile, and a warning\'s note', () => {
    expect(renderOpenResult(result).split('\n')).toEqual([
      'com.example is running on virtual device pixel-36 (emulator-5554).',
      '  ok    doctor       virtual device pixel-36 (API 36)',
      '  ok    boot         pixel-36 booted as emulator-5554',
      '  warn  grant        granted 1 of 2',
      '  ok    settings     animations off',
      '',
      'The .apk changed since the profile was saved (its SHA-256 differs); the profile now records the new one.',
      '',
      'Profile: /home/u/com.example.nawi.mobile.yaml',
      '',
      'Note: Those permissions will be asked for in a dialog.'
    ])
  })

  it('prints a note for every warning step, in step order', () => {
    const out = renderOpenResult({
      ...result,
      apk_changed: false,
      steps: [...result.steps, { id: 'first_screen', status: 'warn', summary: 'an intro screen ("Skip" button)', fix: 'Tap "Skip" to go past it.' }]
    }).split('\n')
    expect(out).toContain('  warn  first_screen an intro screen ("Skip" button)')
    expect(out.slice(-2)).toEqual(['Note: Those permissions will be asked for in a dialog.', 'Note: Tap "Skip" to go past it.'])
  })

  it('ends with the one next step when it is not running', () => {
    const out = renderOpenResult({ ...result, ok: false, fix: 'Reconnect R58M.', target: { ...result.target!, kind: 'device', name: 'R58M', serial: 'R58M' }, profile: null, apk_changed: true })
    expect(out.split('\n')[0]).toBe('com.example is not running on device R58M.')
    expect(out.split('\n').at(-1)).toBe('Next: Reconnect R58M.')
    expect(out, 'no profile was written, so it must not claim one was updated').toContain('(its SHA-256 differs).')
  })
})
