import { describe, expect, it } from 'vitest'
import type { ApkInfo } from '../main/mobile/apk'
import { MobileUsageError, parseMobileInspectArgs, renderApkInfo } from './mobile'

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
    unresolved: []
  }

  it('prints one line per fact, runtime permissions by short name, links and exports indented', () => {
    expect(renderApkInfo(base).split('\n')).toEqual([
      'com.example 2.0 (7)',
      '  SDK          min 24, target 35',
      '  launcher     com.example.Main',
      '  ABIs         arm64-v8a',
      '  debuggable   no',
      '  permissions  2 (1 runtime: CAMERA)',
      '  deep links   1',
      '    https://example.test/x* (verified) -> com.example.Links',
      '  exported     1',
      '    receiver com.example.Boot (implicit: intent filter, no android:exported)'
    ])
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
