import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * UX-PRM.2 — "no dead ends" for the two failure routes that had one.
 *
 * Both tests here exist because a green suite hid the gap rather than reporting
 * it. They are deliberately end-to-end: the defects were in the *reachability*
 * of a surface (which branch runs, which window is mounted, which channel is
 * broadcast), and a unit test that renders the card directly cannot see any of
 * that.
 */

let app: ElectronApplication
let win: Page
let userDataDir: string
/**
 * Console output of main and of every window, the hidden recorder included
 * (`[displayMedia]`, `[recording]`, `[recorder]` lines). A failure here is
 * otherwise only "element not found", with nothing saying whether the request
 * was denied, never answered, or answered and not broadcast.
 */
const logs: string[] = []

test.beforeAll(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'nawi-prm-'))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: process.cwd()
  })
  app.on('console', (msg) => logs.push(`[main ${msg.type()}] ${msg.text()}`))
  app.on('window', (page) => {
    const name = page.url().split('/').pop() || 'window'
    page.on('console', (msg) => logs.push(`[${name} ${msg.type()}] ${msg.text()}`))
  })
  win = await app.firstWindow()
  win.on('console', (msg) => logs.push(`[main-window ${msg.type()}] ${msg.text()}`))
  await win.waitForLoadState('domcontentloaded')
})

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return
  // Logs first, then a bounded status read: a wedged renderer must not stop
  // the hook from printing what it already has.
  const consoleTail = `App console, last 60 lines:\n${logs.slice(-60).join('\n') || '(none)'}`
  console.log(`\n--- ${testInfo.title} ---\n${consoleTail}\n`)
  let timer: ReturnType<typeof setTimeout> | undefined
  const status = await Promise.race([
    win
      .evaluate(() => window.api.getRecordingStatus())
      .then((s) => JSON.stringify(s))
      .catch((err: unknown) => `unavailable (${String(err)})`),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('unavailable (no answer within 3 s)'), 3_000)
    })
  ]).finally(() => clearTimeout(timer))
  const report = `Recording status at failure: ${status}\n\n${consoleTail}`
  // Printed so it lands in the CI log next to the failure, and attached for the HTML report.
  console.log(`Recording status at failure: ${status}\n`)
  await testInfo.attach('app-console.txt', { body: report, contentType: 'text/plain' })
})

test.afterAll(async () => {
  await app?.close()
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
})

/**
 * Pins what Electron actually reports on this platform.
 *
 * No test anywhere pinned a status value, which is why the Windows reading
 * could silently be the opposite of what two code comments claimed. Read in the
 * *main* process, because that is the only place `systemPreferences` exists.
 *
 * On Windows the screen assertion is exact: `'screen'` reports `'granted'`
 * unconditionally, and nothing throws. If a future Electron starts modelling
 * screen capture as a Windows permission, this goes red and the reachability
 * decision in `CaptureView` has to be revisited.
 *
 * Microphone and camera are NOT unconditional on Windows: they follow the
 * machine's privacy settings (the GitHub Windows runner reports `'denied'` for
 * the microphone). No product code reads them, so they are only required to be
 * read without throwing and to be a documented status.
 */
test('the OS media-access status this platform reports is what the code assumes', async () => {
  const raw = await app.evaluate(({ systemPreferences }) => {
    const read = (kind: 'screen' | 'microphone' | 'camera'): string => {
      try {
        return systemPreferences.getMediaAccessStatus(kind)
      } catch (err) {
        return `threw: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    return { platform: process.platform, screen: read('screen'), mic: read('microphone'), camera: read('camera') }
  })

  if (raw.platform === 'win32') {
    expect(raw.screen, 'Windows screen access is expected to be granted unconditionally').toBe('granted')
    for (const kind of ['mic', 'camera'] as const) {
      expect(
        ['granted', 'denied', 'restricted', 'not-determined', 'unknown'],
        `Windows ${kind} access status should be a documented value (privacy-setting dependent)`
      ).toContain(raw[kind])
    }
  }

  /*
   * On every platform, what main hands the renderer must be one of the five
   * values `ScreenAccess` allows — including where the API is absent and throws
   * (`getMediaAccessStatus` is documented as macOS/Windows), which
   * `screenPermission()` promises to degrade to 'unknown' rather than to
   * 'granted'. Asserted on the mapped value, not the raw one: the raw reading
   * is deliberately allowed to be a throw here, and asserting a shape over it
   * would fail on a platform where throwing is the correct behaviour.
   */
  const state = await win.evaluate(() => window.api.getScreenPermission())
  expect(state.ok).toBe(true)
  if (!state.ok) return
  expect(['granted', 'denied', 'restricted', 'not-determined', 'unknown']).toContain(
    state.value.screen
  )
  // Where the raw read succeeded, the mapping must not alter it.
  if (!raw.screen.startsWith('threw:')) expect(state.value.screen).toBe(raw.screen)
})

/**
 * A recording denied inside the hidden recorder window must reach the user.
 *
 * The trigger is a source id that no longer exists: main's display-media
 * handler refuses it deliberately (no `?? real[0]` fallback), `getDisplayMedia`
 * rejects in the recorder window, and the engine reports it. That is exactly
 * the shape of an OS denial — a renderer-origin failure — without needing a
 * real permission prompt, which cannot be denied on demand on Windows.
 *
 * Before the fix the whole chain ended at a `console.error` in `recorder.tsx`:
 * the failure was published as a *status*, never as `recordingFailed`, and the
 * only other surface (the HUD's error line) was written into a window the same
 * call hides. The user saw nothing at all.
 */
test('a recording that fails inside the recorder window surfaces a recovery card', async () => {
  // From the *library* view: the recovery card lives in CaptureView, which is
  // not mounted here. That is why the subscription is owned by App — a
  // subscription inside an unmounted component misses the broadcast entirely.
  await win.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'New capture' })).toBeHidden()

  const denyRecording = async (): Promise<void> => {
    const started = await win.evaluate(() =>
      window.api.startRecording({
        sourceId: 'window:0123456789:0',
        tracks: { system: false, mic: false, camera: false },
        countdown: false
      })
    )
    expect(started.ok).toBe(true)
  }

  // Capture what the engine actually reported, so the card's detail line can be
  // compared against it verbatim rather than against a pattern. Without this,
  // replacing `detail={permissionDetail}` with a fixed string like "Something
  // went wrong" would keep every other assertion here green while destroying
  // the reason for rendering the real message at all.
  await win.evaluate(() => {
    const w = window as unknown as { __lastRecordingFailure?: string }
    w.__lastRecordingFailure = undefined
    window.api.onRecordingFailed((error: string) => {
      w.__lastRecordingFailure = error
    })
  })

  await denyRecording()

  // The failure has to bring the user to the surface that can act on it.
  await expect(win.getByRole('heading', { name: 'New capture' })).toBeVisible({ timeout: 20_000 })

  // The actionable surface: the recovery card, not a six-second toast.
  const card = win.getByTestId('permission-recovery')
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card.getByRole('button', { name: /check again/i })).toBeVisible()
  await expect(card.getByRole('button', { name: /Open System Settings/i })).toBeVisible()

  // The card must say what actually went wrong, not only offer a settings pane
  // — otherwise a non-permission failure is rendered as a permission problem.
  const detail = card.getByTestId('permission-recovery-detail')
  await expect(detail).toBeVisible()
  // Deliberately not matched against a wording: the text comes from the OS via
  // `getDisplayMedia`, and it varies ("Invalid capture constraints", "Permission
  // denied", …). What must hold is that the card carries the *real* message
  // rather than only permission copy, so this asserts a non-empty one.
  const reported = await win.evaluate(
    () => (window as unknown as { __lastRecordingFailure?: string }).__lastRecordingFailure
  )
  expect(typeof reported).toBe('string')
  expect(reported).not.toBe('')
  // Verbatim, not a pattern: the text comes from the OS via `getDisplayMedia`
  // and varies ("Invalid capture constraints", "Permission denied", …), so the
  // check that means something is that the card shows *this* recording's real
  // message rather than any wording of our own.
  const detailText = ((await detail.textContent()) ?? '').replace('What went wrong:', '').trim()
  expect(detailText).toBe(reported)

  // "Check again" must lead somewhere. With no source to retry (this recording
  // was started outside the picker) the honest destination is the picker.
  await card.getByRole('button', { name: /check again/i }).click()
  await expect(win.getByRole('dialog', { name: 'Choose what to record' })).toBeVisible()
  await win.getByRole('button', { name: /Cancel/ }).click()
  await expect(card).toBeHidden()

  /*
   * The same denial twice.
   *
   * What this proves, precisely: the second failure carries an identical
   * message, so anything comparing by value would drop it and the card would
   * never come back — the `seq` counter is what makes the repeat explicit.
   *
   * What it does NOT prove, despite looking like it might: that a recording
   * left *active* by an earlier failure can be restarted. The first failure
   * here is `openScreen` throwing, which is caught and sets `phase = 'idle'`,
   * so the engine is never active on this second attempt. The active-engine
   * case is covered where it can actually be constructed — at engine level, in
   * `src/renderer/lib/recorder.test.ts`, by injecting a chunk-write failure.
   */
  await denyRecording()
  await expect(card).toBeVisible({ timeout: 20_000 })
})
