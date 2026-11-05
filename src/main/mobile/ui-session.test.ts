import { describe, expect, it } from 'vitest'
import { ToolError } from '../mcp/errors'
import type { MobileProgress } from '@shared/mobile'
import type { OpenStepId } from './open'
import type { ScreenFrame } from './screen'
import { MobileOpenBusyError, MobileUiSession, type MobileUiDeps, type OpenOutcome } from './ui-session'

/**
 * The window's side of roadmap M1d: a dropped .apk goes through the injected open (mobile_open's body), each step
 * reaches the window as it starts, every outcome comes back as a view (failed step + fix, cancelled), and screen
 * frames are only served for a device this window opened an app on.
 */

const APK = '/home/u/apps/demo.apk'

function outcome(over: Partial<OpenOutcome> = {}): OpenOutcome {
  return {
    ok: true,
    fix: null,
    package: 'com.example.demo',
    target: { kind: 'avd', name: 'loop-api36', serial: 'emulator-5560', api: 36, booted: true },
    permissions: { granted: ['android.permission.CAMERA'], not_granted: [] },
    settings: { requested: { locale: 'en-US', dark_mode: false, font_scale: 1, animations: false, network: true }, applied: ['animations', 'dark_mode', 'font_scale', 'locale', 'network'], not_applied: [] },
    launched: { activity: 'com.example.demo.MainActivity', total_time_ms: 812, pid: 4242 },
    first_screen: null,
    onboarding: null,
    sign_in: null,
    steps: [
      { id: 'doctor', status: 'ok', summary: 'virtual device loop-api36 (API 36)', fix: null },
      { id: 'boot', status: 'ok', summary: 'loop-api36 booted as emulator-5560', fix: null },
      { id: 'install', status: 'ok', summary: 'com.example.demo 1.0 installed on emulator-5560', fix: null },
      { id: 'grant', status: 'ok', summary: 'granted 1: android.permission.CAMERA', fix: null },
      { id: 'settings', status: 'ok', summary: 'animations off, dark mode off, font scale 1, locale en-US', fix: null },
      { id: 'launch', status: 'ok', summary: 'com.example.demo.MainActivity started in 812 ms (pid 4242)', fix: null }
    ],
    doctor: null,
    profile: '/home/u/apps/com.example.demo.nawi.mobile.yaml',
    profile_error: null,
    ...over
  }
}

interface Harness {
  session: MobileUiSession
  emitted: MobileProgress[]
  opens: { file: string; signal: AbortSignal; onStep: (id: OpenStepId, summary: string) => void }[]
  captures: { adb: string; serial: string }[]
  adbLookups: number
  /** Finish the open in progress. */
  finish: (r: OpenOutcome | Error) => void
}

function harness(opts: { adb?: string | null; frame?: ScreenFrame } = {}): Harness {
  const h = { emitted: [], opens: [], captures: [], adbLookups: 0 } as unknown as Harness
  let settle: ((r: OpenOutcome | Error) => void) | null = null
  const deps: MobileUiDeps = {
    open: (file, o) => {
      h.opens.push({ file, ...o })
      return new Promise((resolve, reject) => {
        settle = (r) => (r instanceof Error ? reject(r) : resolve(r))
        // Like openApp: an abort rejects with the signal's reason before the next step.
        o.signal.addEventListener('abort', () => reject(o.signal.reason), { once: true })
      })
    },
    findAdb: async () => {
      h.adbLookups++
      return opts.adb === undefined ? '/sdk/platform-tools/adb' : opts.adb
    },
    capture: async (adb, serial) => {
      h.captures.push({ adb, serial })
      return opts.frame ?? { ok: true, png: new Uint8Array([1]), width: 1, height: 1 }
    },
    emit: (p) => h.emitted.push(p)
  }
  h.session = new MobileUiSession(deps)
  h.finish = (r) => {
    if (!settle) throw new Error('no open is waiting')
    settle(r)
  }
  return h
}

describe('MobileUiSession.open', () => {
  it('sends each step to the window as it starts, tagged with the open id, then returns the read step + every open step', async () => {
    const h = harness()
    const pending = h.session.open(APK)
    expect(h.session.busy, 'busy while the open runs').toBe(true)
    expect(h.opens.map((o) => o.file), 'file handed to mobile_open').toEqual([APK])
    h.opens[0].onStep('doctor', 'checking the Android setup')
    h.opens[0].onStep('boot', 'booting loop-api36 as emulator-5560')
    h.finish(outcome())
    const view = await pending
    expect(h.emitted, 'progress events in order').toEqual([
      { openId: 1, id: 'read', summary: 'reading the app file' },
      { openId: 1, id: 'doctor', summary: 'checking the Android setup' },
      { openId: 1, id: 'boot', summary: 'booting loop-api36 as emulator-5560' }
    ])
    expect(view.steps.map((s) => `${s.id}:${s.status}`), 'step list of a successful open').toEqual(['read:ok', 'doctor:ok', 'boot:ok', 'install:ok', 'grant:ok', 'settings:ok', 'launch:ok'])
    expect(view, 'view of a successful open').toMatchObject({ openId: 1, ok: true, cancelled: false, fix: null, package: 'com.example.demo', profile: '/home/u/apps/com.example.demo.nawi.mobile.yaml' })
    expect(view.steps[0].summary, 'read step names the package').toBe('com.example.demo')
    expect(h.session.busy, 'not busy afterwards').toBe(false)
  })

  it('returns a failed open as a view with its step and fix, and serves no screen for it', async () => {
    const h = harness()
    const pending = h.session.open(APK)
    const fix = 'Turn on hardware virtualization, then retry.'
    h.finish(outcome({ ok: false, fix, target: null, launched: null, profile: null, steps: [{ id: 'doctor', status: 'fail', summary: 'virtual devices can\'t start here', fix }] }))
    const view = await pending
    expect(view, 'failed view').toMatchObject({ ok: false, cancelled: false, fix })
    expect(view.steps.map((s) => `${s.id}:${s.status}`), 'steps of a failed open').toEqual(['read:ok', 'doctor:fail'])
    await expect(h.session.screen('emulator-5560'), 'screen of a device no app was opened on').rejects.toThrow(/No app was opened on that device/)
  })

  it('turns a file Nawi refuses (ToolError with a fix) into a failed read step, without repeating the fix in the summary', async () => {
    const h = harness()
    const pending = h.session.open('/home/u/apps/demo.aab')
    const fix = 'Convert it with bundletool build-apks --mode=universal, then open the .apk.'
    h.finish(new ToolError('NOT_IMPLEMENTED', `This is an Android App Bundle (.aab), not an APK. ${fix}`, { file: '/home/u/apps/demo.aab', fix }))
    const view = await pending
    expect(view, 'view for an .aab').toMatchObject({ ok: false, cancelled: false, fix, package: null })
    expect(view.steps, 'read step for an .aab').toEqual([{ id: 'read', status: 'fail', summary: 'This is an Android App Bundle (.aab), not an APK.', fix }])
  })

  it('rethrows an unexpected error instead of hiding it in a view, and is free for the next open', async () => {
    const h = harness()
    const pending = h.session.open(APK)
    h.finish(new Error('EIO: i/o error, read'))
    await expect(pending, 'unexpected error').rejects.toThrow('EIO')
    expect(h.session.busy, 'busy after an error').toBe(false)
  })

  it('refuses a second open while one runs', async () => {
    const h = harness()
    const first = h.session.open(APK)
    await expect(h.session.open(APK), 'second open while busy').rejects.toBeInstanceOf(MobileOpenBusyError)
    expect(h.opens.length, 'mobile_open calls').toBe(1)
    h.finish(outcome())
    await first
  })

  it('cancel aborts the open, returns a cancelled view and drops step events that arrive after it', async () => {
    const h = harness()
    const pending = h.session.open(APK)
    h.opens[0].onStep('doctor', 'checking the Android setup')
    expect(h.session.cancel(), 'cancel while running').toBe(true)
    h.opens[0].onStep('boot', 'late step after cancel')
    const view = await pending
    expect(view, 'cancelled view').toMatchObject({ ok: false, cancelled: true, fix: null, steps: [] })
    expect(h.opens[0].signal.aborted, 'signal handed to mobile_open aborted').toBe(true)
    expect(h.emitted.map((e) => e.id), 'events sent').toEqual(['read', 'doctor'])
    expect(h.session.cancel(), 'cancel with nothing running').toBe(false)
  })

  it('reports a real failure that lands after Cancel instead of calling it cancelled', async () => {
    // The .apk read doesn't take the signal: it can fail on its own after the user pressed Cancel.
    const fix = 'Check the path, then drop the file again.'
    let fail!: () => void
    const session = new MobileUiSession({
      open: () => new Promise((_resolve, reject) => (fail = () => reject(new ToolError('NOT_FOUND', `No file at ${APK}. ${fix}`, { file: APK, fix })))),
      findAdb: async () => null,
      capture: async () => ({ ok: false, error: 'x', fix: 'x' }),
      emit: () => {}
    })
    const pending = session.open(APK)
    session.cancel()
    fail()
    const view = await pending
    expect(view, 'view for a failure after cancel').toMatchObject({ cancelled: false, ok: false, fix })
    expect(view.steps.map((s) => `${s.id}:${s.status}`), 'steps').toEqual(['read:fail'])
  })

  it('numbers opens so the window can tell them apart', async () => {
    const h = harness()
    const a = h.session.open(APK)
    h.finish(outcome())
    const b = (await a, h.session.open(APK))
    h.finish(outcome())
    expect([(await a).openId, (await b).openId], 'open ids').toEqual([1, 2])
  })

  it.each([
    ['a relative path', 'demo.apk'],
    ['an empty string', ''],
    ['a number', 42],
    ['a path with a newline', '/home/u/a\n.apk'],
    ['a path with a NUL byte', '/home/u/a\0.apk'],
    ['a path longer than 4096', `/${'a'.repeat(4100)}.apk`]
  ])('rejects %s from the renderer without calling mobile_open', async (_name, file) => {
    const h = harness()
    await expect(h.session.open(file), `open(${JSON.stringify(String(file).slice(0, 30))})`).rejects.toThrow(/Drop an .apk file/)
    expect(h.opens.length, 'mobile_open calls').toBe(0)
    expect(h.session.busy, 'busy after a refused path').toBe(false)
  })
})

describe('MobileUiSession.screen', () => {
  it('serves frames for the device an app was opened on, looking adb up per frame (an SDK installed meanwhile is found)', async () => {
    const h = harness()
    const pending = h.session.open(APK)
    h.finish(outcome())
    await pending
    const a = await h.session.screen('emulator-5560')
    await h.session.screen('emulator-5560')
    expect(a.ok, 'first frame').toBe(true)
    expect(h.captures, 'capture calls').toEqual([
      { adb: '/sdk/platform-tools/adb', serial: 'emulator-5560' },
      { adb: '/sdk/platform-tools/adb', serial: 'emulator-5560' }
    ])
    expect(h.adbLookups, 'adb lookups').toBe(2)
  })

  it.each([['another serial', 'emulator-5554'], ['a non-string', { serial: 'emulator-5560' }], ['undefined', undefined]])(
    'refuses %s',
    async (_name, serial) => {
      const h = harness()
      const pending = h.session.open(APK)
      h.finish(outcome())
      await pending
      await expect(h.session.screen(serial), `screen(${JSON.stringify(serial)})`).rejects.toThrow(/No app was opened on that device/)
      expect(h.captures.length, 'capture calls').toBe(0)
    }
  )

  it('returns the platform-tools fix when adb has gone missing', async () => {
    const h = harness({ adb: null })
    const pending = h.session.open(APK)
    h.finish(outcome())
    await pending
    const frame = await h.session.screen('emulator-5560')
    expect(frame, 'frame without adb').toMatchObject({ ok: false, error: 'adb is not available', fix: expect.stringMatching(/Platform-Tools/) })
    expect(h.captures.length, 'capture calls').toBe(0)
  })
})
