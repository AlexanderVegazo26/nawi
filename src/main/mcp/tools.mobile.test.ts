import { afterAll, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const { makeZip } = await import('../mobile/fixtures/make-zip')
const { TOOLS } = await import('./tools')
const { dispatch } = await import('./dispatch')
const { parseMobileProfile, sha256File, stringifyMobileProfile } = await import('../mobile/profile')

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
    launched: { activity: 'dev.nawi.sample.MainActivity', total_time_ms: 300, pid: 7 },
    steps: [],
    doctor: null,
    ...over
  })
  const apkPath = () => join(home, 'sample.apk')
  const savedProfile = () => join(home, 'dev.nawi.sample.nawi.mobile.yaml')

  it('opens an APK on the best device and saves a profile next to it that records what ran', async () => {
    openCalls.length = 0
    openResult = running()
    const r = await open({ file: apkPath() })
    expect(openCalls[0], 'request handed to openApp').toMatchObject({ apkFile: apkPath(), target: null, grant: null, activity: null, headless: false })
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
        launch: { activity: 'dev.nawi.sample.MainActivity' }
      }
    })
  })

  it('reopens from the profile with its target, permissions and activity, and writes it back in place', async () => {
    openResult = running()
    await open({ file: apkPath() })
    const edited = readFileSync(savedProfile(), 'utf8').replace(/^\s*- android\.permission\.(POST_NOTIFICATIONS|READ_CONTACTS)\n/gm, '').replace(/target:\n\s+kind: avd\n\s+name: Pixel_API_36\n/, 'target: null\n').replace('dev.nawi.sample.MainActivity', 'dev.nawi.sample.Other')
    writeFileSync(savedProfile(), edited)
    openCalls.length = 0
    openResult = running({ launched: { activity: 'dev.nawi.sample.Other', total_time_ms: 1, pid: 8 } })
    const r = await open({ file: savedProfile(), headless: true })
    expect(openCalls[0], 'request from the profile').toMatchObject({ target: null, grant: ['android.permission.CAMERA'], activity: 'dev.nawi.sample.Other', headless: true })
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
    const r = await open({ file: savedProfile(), target: 'R58M' })
    expect(r).toMatchObject({ ok: true, apk_changed: true, profile: savedProfile() })
    const again = parseMobileProfile(readFileSync(savedProfile(), 'utf8'))
    expect(again.ok && again.profile).toEqual({ ...pinned, app: { ...app, version_code: 42, version_name: '1.4.2', sha256: await sha256File(apkPath()) } })
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
