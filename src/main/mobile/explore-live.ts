import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { RUN_ID_RE } from '../run-record'
import { runMobileDoctor } from './doctor'
import { exploreApp, type ExploreHost, type ExploreRequest, type ExploreResult, type ExploreScreen } from './explore'
import { defaultOpenHost, readScreen } from './open'
import { PACKAGE_RE, TARGET_RE } from './profile'
import { parseDensity } from './study'
import { appPackage, defaultStudyHost, pickTarget, type LiveStudyResult, type StudyHost } from './study-live'
import { secretRedactor } from '../../shared/flow/interpolate'
import { MAX_NEVER_PRESS_WORDS, NEVER_PRESS_WORD_RE } from '../../shared/mobile'

/**
 * Roadmap M3 (fourth slice, M3c2): explore the app a connected device shows now and build its screen graph, the way
 * mobile_study picks the device (a connected one, never booted) and measures it (`wm density`). The exploration
 * itself is exploreApp (M3c): safe taps only, Back after each, depth / screen / tap / time budgets. Nothing is
 * installed or launched: start the app with mobile_open first. Electron-free; adb, the clock and the delays are
 * injectable, so tests drive a simulated app.
 */

export interface ExploreLiveHost extends StudyHost, ExploreHost {}

export function defaultExploreLiveHost(): ExploreLiveHost {
  const { delay, now } = defaultOpenHost()
  return { ...defaultStudyHost(), delay, now }
}

export { MAX_NEVER_PRESS_WORDS, NEVER_PRESS_WORD_RE }

export interface LiveExploreRequest {
  /** An adb serial or the AVD name of a running emulator; default: the only device connected. */
  target?: string | null
  /** The app to explore; default: the app in front. It must be in front when the run starts. */
  package?: string | null
  maxDepth?: number
  maxScreens?: number
  maxTaps?: number
  timeBudgetMs?: number
  /** Words added to the never-press list for this app. */
  neverPress?: readonly string[]
  /** Values typed into the app (name -> value), scrubbed from the result. */
  secrets?: Readonly<Record<string, string>>
  signal?: AbortSignal
  onScreen?: (screen: ExploreScreen, found: number) => void
  /** Where each screenshot goes as soon as it is taken (screenshotSpool); default: kept in memory. */
  storeScreenshot?: ExploreRequest['storeScreenshot']
}

export interface LiveExploreResult {
  /** The exploration ran: at least the start screen is in the graph (`exploration.stopped` says why it ended). */
  ok: boolean
  /** The one next step when not ok. */
  fix: string | null
  /** What went wrong when not ok, one sentence. */
  error: string | null
  target: LiveStudyResult['target']
  package: string | null
  density_dpi: number | null
  exploration: ExploreResult | null
}

const SHELL_TIMEOUT_MS = 30_000

export async function exploreLiveApp(req: LiveExploreRequest, host: ExploreLiveHost = defaultExploreLiveHost()): Promise<LiveExploreResult> {
  if (req.target != null && !TARGET_RE.test(req.target)) throw new Error(`"${req.target}" is not an adb serial or AVD name.`)
  if (req.package != null && !PACKAGE_RE.test(req.package)) throw new Error(`"${req.package}" is not an Android package name.`)
  const neverPress = req.neverPress ?? []
  if (neverPress.length > MAX_NEVER_PRESS_WORDS) throw new Error(`at most ${MAX_NEVER_PRESS_WORDS} never-press words, got ${neverPress.length}.`)
  const badWord = neverPress.find((w) => !NEVER_PRESS_WORD_RE.test(w))
  if (badWord !== undefined) throw new Error(`"${badWord.slice(0, 40)}" is not a never-press word (letters and digits, up to 40 characters).`)
  const secrets = Object.entries(req.secrets ?? {}).filter(([, v]) => v.length > 0)
  const redact = secretRedactor(secrets)
  const result: LiveExploreResult = { ok: false, fix: null, error: null, target: null, package: null, density_dpi: null, exploration: null }
  const stop = (error: string, fix: string): LiveExploreResult => ({ ...result, error: redact(error), fix: redact(fix) })

  const doctor = await runMobileDoctor(null, host)
  const adb = doctor.adb?.path
  if (!adb) return stop('adb is not available', doctor.fix ?? 'Install the Android SDK Platform-Tools and set ANDROID_HOME.')
  const target = await pickTarget(doctor, host, adb, req.target ?? null, 'explore')
  if ('fix' in target) return stop(target.error, target.fix)
  result.target = target
  const { serial } = target

  let pkg = req.package ?? null
  if (pkg === null) {
    const screen = await readScreen(host, adb, serial)
    if ('skipped' in screen) {
      return stop(screen.skipped, `Check that ${serial} shows an unlocked screen and answers \`adb -s ${serial} shell uiautomator dump\`, then retry.`)
    }
    pkg = appPackage(screen)
    if (pkg === null) {
      return stop("only Android's own windows are on screen (a permission prompt, the notification shade)", 'Get past it (mobile_open with learn_onboarding taps it), or name the app with package, then explore again.')
    }
    // The home screen is not an app to explore: each tap on it would launch another installed app.
    if (pkg === (await homePackage(host, adb, serial))) {
      result.package = null
      return stop(`the home screen (${pkg}) is in front, not an app`, `Start the app first (\`nawi mobile-open <file.apk> --target ${target.name}\`), or name it with package, then explore again.`)
    }
  }
  result.package = pkg
  const density = await host.exec(adb, ['-s', serial, 'shell', 'wm density'], SHELL_TIMEOUT_MS)
  result.density_dpi = density.code === 0 ? parseDensity(density.stdout) : null

  const exploration = await exploreApp(
    {
      adb,
      serial,
      package: pkg,
      densityDpi: result.density_dpi,
      maxDepth: req.maxDepth,
      maxScreens: req.maxScreens,
      maxTaps: req.maxTaps,
      timeBudgetMs: req.timeBudgetMs,
      neverPress,
      secrets: req.secrets,
      signal: req.signal,
      onScreen: req.onScreen,
      storeScreenshot: req.storeScreenshot
    },
    host
  )
  // exploreApp scrubs the studies; its notes can quote a label, which a secret may have been typed into.
  const scrubbed: ExploreResult = { ...exploration, notes: exploration.notes.map(redact) }
  if (scrubbed.start === null) {
    const why = scrubbed.notes[0]?.replace(/^Stopped: /, '').replace(/\.$/, '') ?? `the exploration stopped (${scrubbed.stopped})`
    const fix =
      scrubbed.stopped === 'not_in_app'
        ? `Bring ${pkg} to the front (\`nawi mobile-open <file.apk> --target ${target.name}\` starts it), then explore again.`
        : scrubbed.stopped === 'cancelled'
          ? 'It was cancelled (or agent access was paused in Nawi) before the first screen was read: resume, then explore again.'
          : `Check that ${serial} shows an unlocked screen and answers \`adb -s ${serial} shell uiautomator dump\`, then retry.`
    return { ...stop(why, fix), exploration: scrubbed }
  }
  return { ...result, ok: true, exploration: scrubbed }
}

/**
 * The package of the device's home screen (launcher), or null when the device does not say. Read-only:
 * `cmd package resolve-activity` resolves the HOME intent without starting anything.
 */
export async function homePackage(host: ExploreLiveHost, adb: string, serial: string): Promise<string | null> {
  const r = await host.exec(adb, ['-s', serial, 'shell', HOME_ACTIVITY_LINE], SHELL_TIMEOUT_MS)
  if (r.code !== 0) return null
  // --brief prints a priority line, then `package/activity`.
  const last = r.stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''
  const m = /^([A-Za-z][\w.]*)\/[\w.$]+$/.exec(last)
  return m ? m[1] : null
}

export const HOME_ACTIVITY_LINE = 'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME'

/** How many saved explorations to keep (oldest go first), like the saved studies. */
export const DEFAULT_KEEP_EXPLORATIONS = 50

const SCREEN_ID_RE = /^s-[0-9a-f]{12}$/

export interface SavedExploration {
  target: LiveExploreResult['target']
  package: string
  density_dpi: number | null
  taken_at: string
  exploration: ExploreResult
}

/** The folder an exploration is assembled in before writeExploration renames it to `<root>/<id>`. */
function explorationTemp(root: string, id: string): string {
  if (!RUN_ID_RE.test(id)) throw new Error(`not an exploration id: ${JSON.stringify(id)}`)
  return join(root, `.tmp-${id}`)
}

/**
 * A storeScreenshot for exploreApp that writes each PNG into the exploration's temp folder as the screen is found,
 * so the run holds no screenshots in memory; writeExploration then keeps them, discardExploration drops them.
 */
export function screenshotSpool(root: string, id: string): (screenId: string, png: Uint8Array) => Promise<string> {
  const temp = explorationTemp(root, id)
  return async (screenId, png) => {
    if (!SCREEN_ID_RE.test(screenId)) throw new Error(`not a screen id: ${JSON.stringify(screenId)}`)
    await fs.mkdir(temp, { recursive: true })
    const file = join(temp, `${screenId}.png`)
    await fs.writeFile(file, png)
    return file
  }
}

/** Remove what screenshotSpool wrote for an exploration that will not be saved. */
export async function discardExploration(root: string, id: string): Promise<void> {
  await fs.rm(explorationTemp(root, id), { recursive: true, force: true })
}

/**
 * Save an exploration as `<root>/<id>/graph.json` + `<screen_id>.png` per screen with a screenshot (in memory, or
 * already in the temp folder from screenshotSpool), written to a temp folder and renamed so a folder that exists is
 * complete. Returns the folder and each screenshot's path.
 */
export async function writeExploration(root: string, id: string, saved: SavedExploration): Promise<{ dir: string; screenshots: Map<string, string> }> {
  const temp = explorationTemp(root, id)
  const bad = saved.exploration.screens.find((s) => !SCREEN_ID_RE.test(s.screen_id))
  if (bad) throw new Error(`not a screen id: ${JSON.stringify(bad.screen_id)}`)
  await fs.mkdir(root, { recursive: true })
  const dir = join(root, id)
  const screenshots = new Map<string, string>()
  const { exploration, ...facts } = saved
  try {
    await fs.mkdir(temp, { recursive: true })
    for (const s of exploration.screens) {
      const name = `${s.screen_id}.png`
      if (s.screenshot) await fs.writeFile(join(temp, name), s.screenshot)
      else if (s.screenshot_file === join(temp, name)) await fs.access(s.screenshot_file)
      else if (s.screenshot_file) await fs.copyFile(s.screenshot_file, join(temp, name))
      else continue
      screenshots.set(s.screen_id, join(dir, name))
    }
    const graph = {
      exploration_id: id,
      ...facts,
      start: exploration.start,
      stopped: exploration.stopped,
      taps: exploration.taps,
      notes: exploration.notes,
      screens: exploration.screens.map(({ screenshot, screenshot_file, ...s }) => ({ ...s, screenshot: screenshot || screenshot_file ? `${s.screen_id}.png` : null })),
      edges: exploration.edges,
      skipped: exploration.skipped
    }
    await fs.writeFile(join(temp, 'graph.json'), `${JSON.stringify(graph, null, 2)}\n`)
    await fs.rename(temp, dir)
  } catch (err) {
    await fs.rm(temp, { recursive: true, force: true })
    throw err
  }
  return { dir, screenshots }
}
