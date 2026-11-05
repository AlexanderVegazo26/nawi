import { afterAll, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * inspect_apk (roadmap M1) through the real dispatch: the result an agent gets, and how each ApkError kind maps onto
 * the tool's declared codes with the fix in detail. Home is a temp folder, never the user's.
 */

const home = mkdtempSync(join(tmpdir(), 'nawi-mcp-apk-'))
vi.mock('electron', () => ({
  app: { getPath: () => home, getVersion: () => '9.9.9', getLocale: () => 'en-US' },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }) },
  desktopCapturer: {}
}))
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: () => home }
})

// The doctor itself is tested against fake SDK layouts (mobile/doctor.test.ts); here it must not probe this machine.
const doctorCalls: unknown[] = []
vi.mock('../mobile/doctor', () => ({
  runMobileDoctor: async (apk: unknown) => {
    doctorCalls.push(apk)
    return { ready: false, fix: 'stub' }
  }
}))

// openApp (install/launch) is tested against a simulated adb in mobile/open.test.ts; here it records its request.
const openCalls: Record<string, unknown>[] = []
let openResult: Record<string, unknown> = {}
vi.mock('../mobile/open', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mobile/open')>()),
  openApp: async (req: Record<string, unknown>) => {
    openCalls.push(req)
    return openResult
  }
}))

// The live study (adb) is tested against a simulated device in mobile/study-live.test.ts; here it returns a result.
const studyCalls: Record<string, unknown>[] = []
let studyResult: Record<string, unknown> = {}
vi.mock('../mobile/study-live', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mobile/study-live')>()),
  studyLiveScreen: async (req: Record<string, unknown>) => {
    studyCalls.push(req)
    return studyResult
  }
}))

const { makeZip } = await import('../mobile/fixtures/make-zip')
const { TOOLS } = await import('./tools')
const { dispatch } = await import('./dispatch')
const { defaultDeviceSettings, KEEP_DEVICE_SETTINGS, parseMobileProfile, sha256File, stringifyMobileProfile } = await import('../mobile/profile')

const TOKEN = 't'.repeat(43)
const outside = mkdtempSync(join(tmpdir(), 'nawi-mcp-apk-out-'))
copyFileSync(resolve(__dirname, '../mobile/fixtures/sample.apk'), join(home, 'sample.apk'))
copyFileSync(resolve(__dirname, '../mobile/fixtures/sample.apk'), join(outside, 'sample.apk'))
// An .aab is a zip whose manifest lives under base/manifest/.
writeFileSync(join(home, 'app.aab'), makeZip([{ name: 'BundleConfig.pb' }, { name: 'base/manifest/AndroidManifest.xml' }]))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const inspect = (file: unknown) =>
  dispatch(
    { token: TOKEN, tools: TOOLS, isPaused: async () => false },
    { name: 'inspect_apk', args: { file }, authorization: `Bearer ${TOKEN}`, origin: null, callId: 'c1' }
  )

async function refusal(file: string): Promise<{ code: string; message: string; detail: Record<string, unknown> }> {
  try {
    await inspect(file)
  } catch (err) {
    return err as { code: string; message: string; detail: Record<string, unknown> }
  }
  throw new Error(`inspect_apk(${file}) should have been refused`)
}

describe('inspect_apk', () => {
  it('returns the manifest facts of an APK in the home folder', async () => {
    const info = (await inspect(join(home, 'sample.apk'))) as Record<string, unknown>
    expect(info, 'inspect_apk result for the aapt2 fixture').toMatchObject({
      package: 'dev.nawi.sample',
      launcher_activity: 'dev.nawi.sample.MainActivity',
      min_sdk: 26,
      abis: ['arm64-v8a', 'x86_64'],
      debuggable: true
    })
  })

  it.each([
    ['a missing file', () => join(home, 'missing.apk'), 'NOT_FOUND', /Check the path/],
    ['an App Bundle', () => join(home, 'app.aab'), 'NOT_IMPLEMENTED', /bundletool build-apks/],
    ['an APK outside the home folder', () => join(outside, 'sample.apk'), 'INVALID_ARGUMENTS', /Copy the APK into your home folder/],
    ['a relative path', () => 'sample.apk', 'INVALID_ARGUMENTS', /full path/]
  ])('refuses %s with %s and the fix in detail.fix', async (_what, file, code, fix) => {
    const err = await refusal(file())
    expect(err.code, err.message).toBe(code)
    expect(err.detail.fix, `detail of ${code}`).toMatch(fix)
    expect(err.detail.file).toBe(file())
  })
})

describe('mobile_doctor', () => {
  const doctor = (args: Record<string, unknown>) =>
    dispatch(
      { token: TOKEN, tools: TOOLS, isPaused: async () => false },
      { name: 'mobile_doctor', args, authorization: `Bearer ${TOKEN}`, origin: null, callId: 'c2' }
    )

  it('runs with no APK, or with the manifest facts of the APK it was given', async () => {
    doctorCalls.length = 0
    expect(await doctor({}), 'report passed through').toEqual({ ready: false, fix: 'stub' })
    await doctor({ file: join(home, 'sample.apk') })
    expect(doctorCalls[0], 'no file: no APK').toBeNull()
    expect(doctorCalls[1], 'APK facts handed to the doctor').toMatchObject({ package: 'dev.nawi.sample', min_sdk: 26, abis: ['arm64-v8a', 'x86_64'] })
  })

  it.each([
    ['a missing file', () => join(home, 'missing.apk'), 'NOT_FOUND'],
    ['an App Bundle', () => join(home, 'app.aab'), 'NOT_IMPLEMENTED'],
    ['an APK outside the home folder', () => join(outside, 'sample.apk'), 'INVALID_ARGUMENTS']
  ])('refuses %s like inspect_apk does (%s, fix in detail), before probing anything', async (_what, file, code) => {
    doctorCalls.length = 0
    const err = (await doctor({ file: file() }).then(
      () => {
        throw new Error('should have been refused')
      },
      (e: unknown) => e
    )) as { code: string; message: string; detail: Record<string, unknown> }
    expect(err.code, err.message).toBe(code)
    expect(typeof err.detail.fix, 'detail.fix').toBe('string')
    expect(doctorCalls, 'doctor never ran for a refused APK').toEqual([])
  })
})

describe('mobile_open', () => {
  const open = (args: Record<string, unknown>) =>
    dispatch(
      { token: TOKEN, tools: TOOLS, isPaused: async () => false },
      { name: 'mobile_open', args, authorization: `Bearer ${TOKEN}`, origin: null, callId: `c3-${Math.random()}` }
    ) as Promise<Record<string, unknown>>
  const running = (over: Record<string, unknown> = {}) => ({
    ok: true,
    fix: null,
    package: 'dev.nawi.sample',
    target: { kind: 'avd', name: 'Pixel_API_36', serial: 'emulator-5554', api: 36, booted: true },
    permissions: { granted: ['android.permission.CAMERA'], not_granted: [{ name: 'android.permission.RECORD_AUDIO', reason: 'x' }] },
    settings: { requested: defaultDeviceSettings('avd'), applied: ['animations'], not_applied: [] },
    launched: { activity: 'dev.nawi.sample.MainActivity', total_time_ms: 300, pid: 7 },
    steps: [],
    doctor: null,
    ...over
  })
  // The aapt2 fixture has no framework markers: a native app, read through the accessibility tree.
  const NATIVE = { framework: 'native', read: 'accessibility' }
  const apkPath = () => join(home, 'sample.apk')
  const savedProfile = () => join(home, 'dev.nawi.sample.nawi.mobile.yaml')

  it('opens an APK on the best device and saves a profile next to it that records what ran', async () => {
    openCalls.length = 0
    openResult = running()
    const r = await open({ file: apkPath() })
    expect(openCalls[0], 'request handed to openApp').toMatchObject({ apkFile: apkPath(), target: null, grant: null, activity: null, headless: false })
    expect('settings' in openCalls[0] && openCalls[0].settings, 'no profile: openApp picks the defaults for the device it lands on').toBeUndefined()
    expect((openCalls[0].apk as { package: string }).package).toBe('dev.nawi.sample')
    const sha256 = await sha256File(apkPath())
    expect(r).toMatchObject({ ok: true, apk: apkPath(), sha256, apk_changed: null, profile: savedProfile(), profile_error: null })
    const parsed = parseMobileProfile(readFileSync(savedProfile(), 'utf8'))
    expect(parsed, 'saved profile').toEqual({
      ok: true,
      profile: {
        version: 1,
        app: { apk: apkPath(), package: 'dev.nawi.sample', version_code: 42, version_name: '1.4.2', sha256 },
        target: { kind: 'avd', name: 'Pixel_API_36' },
        // The fixture's runtime permissions at API 36 (ACCESS_FINE_LOCATION stops at maxSdkVersion 32).
        permissions: { grant: ['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS', 'android.permission.READ_CONTACTS'] },
        launch: { activity: 'dev.nawi.sample.MainActivity' },
        screen: NATIVE,
        device: { locale: 'en-US', dark_mode: false, font_scale: 1, animations: false, network: true }
      }
    })
  })

  it('writes the same profile byte for byte when the same APK is opened twice (M2 done-when: stable across runs)', async () => {
    rmSync(savedProfile(), { force: true })
    openResult = running()
    await open({ file: apkPath() })
    const first = readFileSync(savedProfile(), 'utf8')
    rmSync(savedProfile())
    await open({ file: apkPath() })
    expect(readFileSync(savedProfile(), 'utf8'), 'second run of the same APK').toBe(first)
    expect(first, 'the saved profile names the read strategy and settings').toMatch(/screen:\n {2}framework: native\n {2}read: accessibility\ndevice:\n {2}locale: en-US\n/)
  })

  it('on a physical phone saves a device section that leaves the phone as it is', async () => {
    rmSync(savedProfile(), { force: true })
    openResult = running({ target: { kind: 'device', name: 'R58M', serial: 'R58M', api: 34, booted: false }, settings: { requested: KEEP_DEVICE_SETTINGS, applied: [], not_applied: [] } })
    await open({ file: apkPath() })
    const saved = parseMobileProfile(readFileSync(savedProfile(), 'utf8'))
    expect(saved.ok && saved.profile.device).toEqual(KEEP_DEVICE_SETTINGS)
  })

  it('reopens from the profile with its target, permissions and activity, and writes it back in place', async () => {
    openResult = running()
    await open({ file: apkPath() })
    const edited = readFileSync(savedProfile(), 'utf8')
      .replace(/^\s*- android\.permission\.(POST_NOTIFICATIONS|READ_CONTACTS)\n/gm, '')
      .replace(/target:\n\s+kind: avd\n\s+name: Pixel_API_36\n/, 'target: null\n')
      .replace('dev.nawi.sample.MainActivity', 'dev.nawi.sample.Other')
      .replace('locale: en-US', 'locale: es-419')
      .replace('dark_mode: false', 'dark_mode: null')
      .replace('network: true', 'network: false')
    expect(edited, 'the test edits the device section').toMatch(/locale: es-419\n {2}dark_mode: null/)
    expect(edited, 'the test turns the network off (an offline run)').toMatch(/\n {2}network: false\n/)
    writeFileSync(savedProfile(), edited)
    openCalls.length = 0
    openResult = running({ launched: { activity: 'dev.nawi.sample.Other', total_time_ms: 1, pid: 8 } })
    const r = await open({ file: savedProfile(), headless: true })
    expect(openCalls[0], 'request from the profile').toMatchObject({
      target: null,
      grant: ['android.permission.CAMERA'],
      activity: 'dev.nawi.sample.Other',
      settings: { locale: 'es-419', dark_mode: null, font_scale: 1, animations: false, network: false },
      settingsOnPhone: false,
      headless: true
    })
    expect(r).toMatchObject({ ok: true, apk_changed: false, profile: savedProfile() })
    expect(readFileSync(savedProfile(), 'utf8'), 'an unchanged APK leaves the edited profile byte for byte').toBe(edited)
    // grant: false sends no permissions; a one-off target doesn't change the profile.
    openCalls.length = 0
    await open({ file: savedProfile(), grant: false, target: 'R58M' })
    expect(openCalls[0]).toMatchObject({ grant: [], target: 'R58M' })
    expect(readFileSync(savedProfile(), 'utf8')).toBe(edited)
  })

  it('refreshes only the app facts of a profile whose APK changed, keeping a null target and activity', async () => {
    openResult = running()
    const app = { apk: apkPath(), package: 'dev.nawi.sample', version_code: 1, version_name: 'old', sha256: 'f'.repeat(64) }
    const pinned = { version: 1 as const, app, target: null, permissions: { grant: ['android.permission.CAMERA'] }, launch: { activity: null } }
    writeFileSync(savedProfile(), stringifyMobileProfile(pinned))
    openCalls.length = 0
    const r = await open({ file: savedProfile(), target: 'R58M' })
    expect(openCalls[0]?.settings, 'a profile from before device settings leaves the device alone').toBeNull()
    expect(r).toMatchObject({ ok: true, apk_changed: true, profile: savedProfile() })
    const again = parseMobileProfile(readFileSync(savedProfile(), 'utf8'))
    expect(again.ok && again.profile, 'app facts and screen refreshed; no device section added').toEqual({
      ...pinned,
      app: { ...app, version_code: 42, version_name: '1.4.2', sha256: await sha256File(apkPath()) },
      screen: NATIVE
    })
  })

  it('saves the taps learned with learn_onboarding, replays them from the profile, and appends new ones', async () => {
    rmSync(savedProfile(), { force: true })
    const intro = { when: 'intro', tap: { resource_id: 'dev.nawi.sample:id/skip' } }
    const allow = { when: 'permission_dialog', tap: { resource_id: 'com.android.permissioncontroller:id/permission_allow_button' } }
    openCalls.length = 0
    openResult = running()
    await open({ file: apkPath() })
    expect(openCalls[0], 'learning is opt-in').toMatchObject({ learnOnboarding: false, onboarding: null })
    let saved = parseMobileProfile(readFileSync(savedProfile(), 'utf8'))
    expect(saved.ok && saved.profile.onboarding, 'nothing learned, no section').toBeUndefined()

    rmSync(savedProfile())
    openCalls.length = 0
    openResult = running({ onboarding: { tapped: [{ ...intro, label: 'Skip', learned: true }] } })
    await open({ file: apkPath(), learn_onboarding: true })
    expect(openCalls[0]).toMatchObject({ learnOnboarding: true })
    saved = parseMobileProfile(readFileSync(savedProfile(), 'utf8'))
    expect(saved.ok && saved.profile.onboarding, 'learned tap saved without its label').toEqual([intro])

    // From the profile: its taps go to openApp; a replayed tap is not saved twice, a newly learned one is appended.
    openCalls.length = 0
    openResult = running({ onboarding: { tapped: [{ ...intro, label: 'Skip', learned: false }, { ...allow, label: 'Allow', learned: true }] } })
    const r = await open({ file: savedProfile(), learn_onboarding: true })
    expect(openCalls[0], 'saved taps replayed').toMatchObject({ onboarding: [intro], learnOnboarding: true })
    expect(r).toMatchObject({ ok: true, profile: savedProfile(), apk_changed: false })
    saved = parseMobileProfile(readFileSync(savedProfile(), 'utf8'))
    expect(saved.ok && saved.profile.onboarding).toEqual([intro, allow])

    // Nothing new learned and the APK unchanged: the profile is left byte for byte.
    const before = readFileSync(savedProfile(), 'utf8')
    openResult = running({ onboarding: { tapped: [{ ...intro, label: 'Skip', learned: false }] } })
    await open({ file: savedProfile() })
    expect(readFileSync(savedProfile(), 'utf8')).toBe(before)
  })

  it('passes a profile\'s sign_in and the call\'s env/secrets to openApp, and keeps the section when it saves', async () => {
    rmSync(savedProfile(), { force: true })
    openResult = running()
    await open({ file: apkPath() })
    const parsed = parseMobileProfile(readFileSync(savedProfile(), 'utf8'))
    if (!parsed.ok) throw new Error('fixture profile')
    const signIn = { fields: [{ field: { resource_id: 'dev.nawi.sample:id/password' }, value: '${secret.app_pw}' }], submit: { text: 'Sign in' } }
    writeFileSync(savedProfile(), stringifyMobileProfile({ ...parsed.profile, sign_in: signIn }))
    openCalls.length = 0
    openResult = running({ onboarding: { tapped: [{ when: 'intro', tap: { text: 'Skip' }, label: 'Skip', learned: true }] } })
    await open({ file: savedProfile(), learn_onboarding: true, env: { TEST_EMAIL: 'qa@example.test' }, secrets: { app_pw: 'pw' } })
    expect(openCalls[0]).toMatchObject({ signIn, inputs: { env: { TEST_EMAIL: 'qa@example.test' }, secrets: { app_pw: 'pw' } } })
    const text = readFileSync(savedProfile(), 'utf8')
    const again = parseMobileProfile(text)
    expect(again.ok && again.profile.sign_in, 'rewritten with the learned tap, sign_in kept').toEqual(signIn)
    expect(text.includes('qa@example.test') || /: pw$/m.test(text), 'no value saved').toBe(false)

    openCalls.length = 0
    await open({ file: apkPath() })
    expect(openCalls[0], 'an .apk has no sign-in').toMatchObject({ signIn: null })
  })

  it('says so when a full onboarding section leaves a learned tap out', async () => {
    rmSync(savedProfile(), { force: true })
    openResult = running()
    await open({ file: apkPath() })
    const full = Array.from({ length: 20 }, (_, i) => ({ when: 'intro', tap: { text: `Page ${i}` } }))
    const parsed = parseMobileProfile(readFileSync(savedProfile(), 'utf8'))
    if (!parsed.ok) throw new Error('fixture profile')
    writeFileSync(savedProfile(), stringifyMobileProfile({ ...parsed.profile, onboarding: full } as never))
    const before = readFileSync(savedProfile(), 'utf8')
    openResult = running({ onboarding: { tapped: [{ when: 'intro', tap: { text: 'Skip' }, label: 'Skip', learned: true }] } })
    const r = await open({ file: savedProfile(), learn_onboarding: true })
    expect(r).toMatchObject({ ok: true, profile: savedProfile(), profile_error: '1 learned onboarding tap was not saved: the profile already holds 20; remove the ones it no longer needs.' })
    expect(readFileSync(savedProfile(), 'utf8'), 'profile untouched').toBe(before)
  })

  it('an APK opened with grant: false still saves its runtime permissions for the next open', async () => {
    rmSync(savedProfile(), { force: true })
    openResult = running({ permissions: { granted: [], not_granted: [] } })
    await open({ file: apkPath(), grant: false })
    const saved = parseMobileProfile(readFileSync(savedProfile(), 'utf8'))
    expect(saved.ok && saved.profile.permissions.grant).toEqual(['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS', 'android.permission.READ_CONTACTS'])
  })

  it('saves nothing when the app did not start, or when asked not to', async () => {
    rmSync(savedProfile(), { force: true })
    openResult = running({ ok: false, fix: 'do this', launched: null })
    expect(await open({ file: apkPath() })).toMatchObject({ ok: false, fix: 'do this', profile: null })
    openResult = running()
    expect(await open({ file: apkPath(), save_profile: false })).toMatchObject({ ok: true, profile: null })
    expect(existsSync(savedProfile()), 'no profile written').toBe(false)
  })

  it('reports a profile it could not save without failing the open', async () => {
    openResult = running()
    const r = await open({ file: apkPath(), profile: join(outside, 'x.nawi.mobile.yaml') })
    expect(r.ok).toBe(true)
    expect(r.profile).toBeNull()
    expect(r.profile_error).toMatch(/inside your home directory/)
  })

  it.each([
    ['a profile for another package', () => {
      const f = join(home, 'other.nawi.mobile.yaml')
      const app = { apk: apkPath(), package: 'com.other.app', version_code: null, version_name: null, sha256: '0'.repeat(64) }
      writeFileSync(f, stringifyMobileProfile({ version: 1, app, target: null, permissions: { grant: [] }, launch: { activity: null } }))
      return f
    }, 'INVALID_ARGUMENTS', /Open the \.apk itself/],
    ['a broken profile', () => {
      const f = join(home, 'broken.nawi.mobile.yaml')
      writeFileSync(f, 'version: 1\n')
      return f
    }, 'INVALID_ARGUMENTS', /open the \.apk again/],
    ['a missing profile', () => join(home, 'gone.nawi.mobile.yaml'), 'NOT_FOUND', /Check the path/],
    ['an APK outside the home folder', () => join(outside, 'sample.apk'), 'INVALID_ARGUMENTS', /Copy the APK/]
  ])('refuses %s (%s, fix in detail) before touching a device', async (_what, file, code, fix) => {
    openCalls.length = 0
    const err = (await open({ file: file() }).then(
      () => {
        throw new Error('should have been refused')
      },
      (e: unknown) => e
    )) as { code: string; message: string; detail: Record<string, unknown> }
    expect(err.code, err.message).toBe(code)
    expect(err.detail.fix).toMatch(fix)
    expect(openCalls, 'openApp never ran').toEqual([])
  })

  it('refuses a target that is not a serial or AVD name at the schema', async () => {
    await expect(open({ file: apkPath(), target: '-s x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  })
})

describe('mobile_study', () => {
  const studyTool = (args: Record<string, unknown>) =>
    dispatch(
      { token: TOKEN, tools: TOOLS, isPaused: async () => false },
      { name: 'mobile_study', args, authorization: `Bearer ${TOKEN}`, origin: null, callId: `c4-${Math.random()}` }
    ) as Promise<Record<string, unknown>>
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const study = { screen_id: 's-0123456789ab', package: 'dev.nawi.sample', rotation: 0, density_dpi: 420, elements: [], findings: [], notes: [] }
  const target = { kind: 'device', name: 'A1', serial: 'A1', api: 34 }

  it('passes target, package and secrets through, saves study.json + screen.png, and returns their paths with the study', async () => {
    studyCalls.length = 0
    studyResult = { ok: true, fix: null, error: null, target, study, screenshot: { png: PNG, width: 1080, height: 2400 }, screenshot_error: null }
    const r = await studyTool({ target: 'A1', package: 'dev.nawi.sample', secrets: { pw: 'x' } })
    expect(studyCalls[0], 'request handed to studyLiveScreen').toEqual({ target: 'A1', package: 'dev.nawi.sample', secrets: { pw: 'x' } })
    expect(r, 'result: ok, the study fields at the top level, where it was saved').toMatchObject({ ok: true, target, screen_id: 's-0123456789ab', density_dpi: 420, screenshot_size: { width: 1080, height: 2400 }, screenshot_error: null })
    expect(r.study_dir).toBe(join(home, 'studies', r.study_id as string))
    expect(readFileSync(r.screenshot as string), 'screen.png holds the PNG bytes').toEqual(Buffer.from(PNG))
    const saved = JSON.parse(readFileSync(join(r.study_dir as string, 'study.json'), 'utf8'))
    expect(saved, 'study.json').toMatchObject({ study_id: r.study_id, target, study, screenshot: 'screen.png' })
  })

  it('returns a device problem as ok: false with the fix, and saves nothing', async () => {
    studyResult = { ok: false, fix: 'Connect a phone.', error: 'no device is connected', target: null, study: null, screenshot: null, screenshot_error: null }
    const before = existsSync(join(home, 'studies')) ? readdirSync(join(home, 'studies')).length : 0
    const r = await studyTool({})
    expect(r).toEqual({ ok: false, error: 'no device is connected', fix: 'Connect a phone.', target: null, study_id: null, study_dir: null, screenshot: null, screenshot_error: null })
    expect(existsSync(join(home, 'studies')) ? readdirSync(join(home, 'studies')).length : 0, 'no study folder written').toBe(before)
  })

  it('saves a study without a screenshot and says why there is none', async () => {
    studyResult = { ok: true, fix: null, error: null, target, study, screenshot: null, screenshot_error: 'not taken: a secret value typed into the app is on the screen' }
    const r = await studyTool({})
    expect(r).toMatchObject({ ok: true, screenshot: null, screenshot_size: null, screenshot_error: 'not taken: a secret value typed into the app is on the screen' })
    expect(readdirSync(r.study_dir as string)).toEqual(['study.json'])
  })

  it('returns at most MAX_STUDY_ELEMENTS elements with the total, and saves them all', async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ i, locator_basis: 'index' }))
    studyResult = { ok: true, fix: null, error: null, target, study: { ...study, elements: many }, screenshot: null, screenshot_error: 'x' }
    const r = await studyTool({})
    expect((r.elements as unknown[]).length).toBe(150)
    expect(r.elements_total).toBe(400)
    const saved = JSON.parse(readFileSync(join(r.study_dir as string, 'study.json'), 'utf8'))
    expect(saved.study.elements.length, 'study.json keeps every element').toBe(400)
  })

  it('still answers when the study cannot be saved, keeping why the screenshot was withheld', async () => {
    rmSync(join(home, 'studies'), { recursive: true, force: true })
    writeFileSync(join(home, 'studies'), 'not a folder')
    try {
      studyResult = { ok: true, fix: null, error: null, target, study, screenshot: null, screenshot_error: 'not taken: a secret value typed into the app is on the screen' }
      const r = await studyTool({})
      expect(r).toMatchObject({ ok: true, study_id: null, study_dir: null, screen_id: 's-0123456789ab', screenshot: null, screenshot_error: 'not taken: a secret value typed into the app is on the screen' })
      expect(r.save_error).toMatch(/the study could not be saved/)
      studyResult = { ...studyResult, screenshot: { png: PNG, width: 1, height: 1 }, screenshot_error: null }
      expect(await studyTool({}), 'a captured screenshot lost with the folder').toMatchObject({ screenshot: null, screenshot_error: 'not saved: see save_error' })
    } finally {
      rmSync(join(home, 'studies'), { force: true })
    }
  })

  it.each([
    ['a target with shell characters', { target: 'a;reboot' }],
    ['a package that is not a package name', { package: '../etc' }]
  ])('refuses %s at the schema without reading the device', async (_why, args) => {
    studyCalls.length = 0
    await expect(studyTool(args)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(studyCalls).toEqual([])
  })
})
