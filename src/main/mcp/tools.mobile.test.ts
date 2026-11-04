import { afterAll, describe, expect, it, vi } from 'vitest'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const { makeZip } = await import('../mobile/fixtures/make-zip')
const { TOOLS } = await import('./tools')
const { dispatch } = await import('./dispatch')

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
