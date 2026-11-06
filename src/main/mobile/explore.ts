import type { Exec, ExecResult } from './doctor'
import { findAll, frontPackage, norm, type UiLocator } from './blockers'
import { center, type UiNode, type UiScreen } from './hierarchy'
import { KEYBOARD_SHOWN_LINE, readScreen } from './open'
import { decodePng, type RgbImage } from './png'
import { captureScreen, type BinaryExec } from './screen'
import { collectionFlags, screenIdOf, studyScreen, type ScreenStudy, type StudyElement } from './study'
import { scrubStudy, showsSecret } from './study-live'

/**
 * Roadmap M3 (third slice, M3c): explore an app that is already open on a device and build its screen graph. From
 * the screen in front, tap each control that is safe to tap, read the screen that follows, go back, and repeat
 * depth first within a depth, screen, tap and time budget. Every screen is studied once (M3a's inventory, stable
 * screen id and findings, plus contrast from a screenshot, M3b2), so the graph's nodes are screen ids and its edges
 * are the taps between them.
 *
 * Safe means nothing is destroyed, bought, sent or typed:
 * - never pressed: a control whose label, description or view id says delete, remove, pay, buy, send, save, sign
 *   out, ... (NEVER_PRESS, a few languages, plus words the caller adds); the run reports each one it left alone.
 * - never touched: text fields and switches, checkboxes and radio buttons (a tap types or changes a setting), and
 *   rows that hold one (a settings row toggles its switch); a control whose centre is covered by another control
 *   (a card with a Delete button in its middle); disabled controls; other apps' and Android's own windows.
 * - the on-screen keyboard is hidden after every screen change, so no tap ever lands on a key.
 * - lists: rows are tapped in order until two rows of the same list open the same screen (a list of notes); rows
 *   that each open a different screen (a settings list) are all tapped.
 * A tap that leaves the app (a browser, the share sheet) is recorded and backed out of. A tap that lands on a screen
 * further up the current path (an Up button) is recorded too, and the path is tapped again to come back. When Back
 * leads somewhere unexpected the run stops and says where it got lost: it never taps blindly to recover.
 *
 * Secret values typed into the app (a sign-in) are scrubbed from every study, and a screen that shows one keeps no
 * screenshot. Electron-free; adb, the clock and the delays are injectable, so tests drive a simulated app.
 */

export interface ExploreHost {
  exec: Exec
  execBinary: BinaryExec
  delay(ms: number, signal?: AbortSignal): Promise<void>
  /** Milliseconds on a monotonic clock (the time budget). */
  now(): number
}

export interface ExploreRequest {
  adb: string
  serial: string
  /** The app to explore; it must be in front when the run starts. */
  package: string
  /** From `wm density` (study.ts parseDensity); without it touch targets are not measured. */
  densityDpi?: number | null
  /** Taps from the start screen to the deepest screen explored (default DEFAULT_MAX_DEPTH). */
  maxDepth?: number
  /** Distinct screens to find before stopping (default DEFAULT_MAX_SCREENS). */
  maxScreens?: number
  /** Taps on the app's controls before stopping, Back and path replays not counted (default DEFAULT_MAX_TAPS). */
  maxTaps?: number
  /** Wall time before stopping (default DEFAULT_TIME_BUDGET_MS). */
  timeBudgetMs?: number
  /** Words added to NEVER_PRESS for this app (e.g. "archive"). */
  neverPress?: readonly string[]
  /** Take a screenshot of each new screen (default true); without one, contrast is not checked. */
  screenshots?: boolean
  /** Values typed into the app (name -> value), scrubbed from the result. */
  secrets?: Readonly<Record<string, string>>
  signal?: AbortSignal
}

export interface ExploreTap {
  locator: UiLocator
  label: string
}

export interface ExploreScreen {
  screen_id: string
  /** Taps from the start screen. */
  depth: number
  /** The taps that first reached it from the start screen. */
  path: ExploreTap[]
  study: ScreenStudy
  screenshot: Uint8Array | null
  /** Why there is no screenshot (null when there is one, or none was asked for). */
  screenshot_error: string | null
}

/**
 * screen: it opened another screen of the app (`to`); same_screen: the screen id did not change; left_app: another
 * app or an Android window came to the front (`to` is null).
 */
export type ExploreEdgeResult = 'screen' | 'same_screen' | 'left_app'

export interface ExploreEdge {
  from: string
  to: string | null
  tap: ExploreTap
  result: ExploreEdgeResult
  /** For left_app: the package that came to the front. */
  package?: string
}

export type ExploreSkipReason = 'never_press' | 'text_field' | 'toggle' | 'covered' | 'no_locator' | 'repeated_row' | 'gone'

export interface ExploreSkip {
  screen_id: string
  label: string
  locator: UiLocator | null
  reason: ExploreSkipReason
}

/**
 * done: every safe control within the depth was tapped; max_*: a budget ran out; not_in_app: the app was not in
 * front at the start; lost: after a tap and Back the app was on a screen the path does not lead back from;
 * unreadable: the screen could not be read; device_error: adb could not tap or press Back; cancelled: the signal fired.
 */
export type ExploreStop = 'done' | 'max_screens' | 'max_taps' | 'max_time' | 'not_in_app' | 'lost' | 'unreadable' | 'device_error' | 'cancelled'

export interface ExploreResult {
  /** The start screen's id; null when the run could not read it or the app was not in front. */
  start: string | null
  /** In the order they were found. */
  screens: ExploreScreen[]
  /** In the order they were tapped; every `to` is in `screens`. */
  edges: ExploreEdge[]
  skipped: ExploreSkip[]
  stopped: ExploreStop
  /** Taps on the app's controls (Back and path replays not counted). */
  taps: number
  /** What the run could not do, one sentence each. */
  notes: string[]
}

export const DEFAULT_MAX_DEPTH = 3
export const DEFAULT_MAX_SCREENS = 30
export const DEFAULT_MAX_TAPS = 200
export const DEFAULT_TIME_BUDGET_MS = 10 * 60_000
/** Wait after a tap or Back before reading the screen (transitions are short with animations off). */
export const EXPLORE_SETTLE_MS = 1_000
/** Backs pressed to leave a screen that opened copies of itself (a "next item" button). */
export const MAX_BACKS = 4

/**
 * Words that mark a control the run never presses: it destroys, pays, sends, saves, joins or signs out. Matched as
 * whole words (or phrases) against the label, the description and the view id split into words. English plus the
 * commonest Spanish, Portuguese, French, German and Italian labels; apps in other languages add theirs.
 */
export const NEVER_PRESS: readonly string[] = [
  'delete', 'remove', 'erase', 'clear', 'reset', 'wipe', 'discard', 'trash', 'archive', 'uninstall', 'deactivate', 'close account',
  'unlink', 'disconnect', 'revoke', 'forget', 'unpair', 'leave', 'unfollow', 'cancel subscription', 'cancel order',
  'pay', 'buy', 'purchase', 'checkout', 'check out', 'order', 'subscribe', 'unsubscribe', 'donate', 'transfer', 'upgrade',
  'send', 'post', 'publish', 'submit', 'reply', 'invite', 'report', 'block', 'call', 'dial',
  'save', 'confirm', 'accept', 'agree', 'allow', 'install', 'update', 'sign up', 'register', 'create account',
  'sign out', 'signout', 'log out', 'logout', 'log off', 'sign off',
  'eliminar', 'borrar', 'excluir', 'apagar', 'supprimer', 'effacer', 'löschen', 'entfernen', 'elimina', 'cancella',
  'pagar', 'comprar', 'payer', 'acheter', 'bezahlen', 'kaufen', 'paga', 'acquista',
  'enviar', 'envoyer', 'senden', 'invia', 'guardar', 'salvar', 'enregistrer', 'speichern', 'salva',
  'cerrar sesión', 'sair', 'déconnexion', 'se déconnecter', 'abmelden', 'esci'
]

const SHELL_TIMEOUT_MS = 30_000
const KEYBOARD_SETTLE_MS = 500
const TEXT_FIELD_RE = /(?:^|\.)(?:EditText|AutoCompleteTextView|MultiAutoCompleteTextView|SearchView|TextInputEditText|AppCompatEditText)$/
const words = (s: string): string => norm(s).replace(/[^\p{L}\p{N}|]+/gu, ' ').trim()

/** `com.example:id/btnSignOut` -> "btn Sign Out". */
function idWords(resourceId: string): string {
  const name = resourceId.slice(resourceId.indexOf('/') + 1)
  return name.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2').replace(/[^\p{L}\p{N}]+/gu, ' ')
}

/** The never-press word an element carries, or null. */
export function neverPressWord(e: Pick<StudyElement, 'label' | 'content_desc' | 'resource_id'>, list: readonly string[] = NEVER_PRESS): string | null {
  const haystack = ` ${[e.label, e.content_desc, idWords(e.resource_id)].map(words).join(' | ')} `
  for (const w of list) {
    const needle = words(w)
    if (needle && haystack.includes(` ${needle} `)) return w
  }
  return null
}

interface Candidate {
  locator: UiLocator
  label: string
  /** The list the control is a row of (or sits in a row of), else null. */
  list: number | null
}

/** For each node: it is, or holds, a text field or a switch/checkbox/radio button (a tap types or changes it). */
function holdsInput(nodes: readonly UiNode[]): { toggle: boolean[]; field: boolean[] } {
  const toggle = nodes.map(() => false)
  const field = nodes.map(() => false)
  for (const n of nodes) {
    const isField = TEXT_FIELD_RE.test(n.class) || n.password
    if (!n.checkable && !isField) continue
    for (let cur: UiNode | null = n; cur; cur = cur.parent === null ? null : nodes[cur.parent]) {
      if (n.checkable) toggle[cur.i] = true
      if (isField) field[cur.i] = true
    }
  }
  return { toggle, field }
}

/** The controls of `pkg` to tap on this screen, in screen order, and the ones left alone with why. */
export function tapCandidates(screen: UiScreen, study: ScreenStudy, pkg: string, neverPress: readonly string[]): { taps: Candidate[]; skipped: ExploreSkip[] } {
  const taps: Candidate[] = []
  const skipped: ExploreSkip[] = []
  const { nodes } = screen
  const input = holdsInput(nodes)
  const isList = collectionFlags(nodes)
  const listOf = (n: UiNode): number | null => {
    for (let cur = n.parent === null ? null : nodes[n.parent]; cur; cur = cur.parent === null ? null : nodes[cur.parent]) if (isList[cur.i]) return cur.i
    return null
  }
  for (const e of study.elements) {
    const node = nodes[e.i]
    if (!node || e.package !== pkg || !e.clickable || !e.enabled || e.bounds === null) continue
    if (e.bounds.right <= e.bounds.left || e.bounds.bottom <= e.bounds.top) continue
    const label = e.label || e.content_desc || e.resource_id || e.class
    const skip = (reason: ExploreSkipReason): void => {
      skipped.push({ screen_id: study.screen_id, label, locator: e.locator, reason })
    }
    if (input.field[e.i]) skip('text_field')
    else if (input.toggle[e.i]) skip('toggle')
    else if (neverPressWord(e, neverPress) !== null) skip('never_press')
    else if (e.locator === null) skip('no_locator')
    else taps.push({ locator: e.locator, label, list: e.in_collection ? listOf(node) : null })
  }
  return { taps, skipped }
}

const contains = (b: UiNode['bounds'], x: number, y: number): boolean => b !== null && x >= b.left && x < b.right && y >= b.top && y < b.bottom

/**
 * Where to tap the one element `locator` finds: its centre, unless another control (a button inside a card, a view
 * drawn over it) is under that point. A skip reason when it can't be tapped safely.
 */
export function tapPoint(screen: UiScreen, locator: UiLocator): { x: number; y: number } | { skip: 'gone' | 'covered' } {
  const hits = findAll(screen.nodes, locator).filter((n) => n.bounds !== null)
  if (hits.length !== 1 || hits[0].bounds === null) return { skip: 'gone' }
  const at = center(hits[0].bounds)
  const own = new Set<number>()
  for (let cur: UiNode | null = hits[0]; cur; cur = cur.parent === null ? null : screen.nodes[cur.parent]) own.add(cur.i)
  const other = screen.nodes.some((n) => !own.has(n.i) && (n.clickable || n.long_clickable || n.checkable) && n.enabled && contains(n.bounds, at.x, at.y))
  return other ? { skip: 'covered' } : at
}

class Stop extends Error {
  constructor(readonly reason: ExploreStop) {
    super(reason)
  }
}

const failed = (r: ExecResult): boolean => r.code !== 0 || !!r.error
const said = (r: ExecResult): string => (r.stderr || r.stdout).split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? (r.error === 'timeout' ? 'no answer' : `exit code ${r.code}`)

export async function exploreApp(req: ExploreRequest, host: ExploreHost): Promise<ExploreResult> {
  const { adb, serial, package: pkg, signal } = req
  const maxDepth = req.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxScreens = req.maxScreens ?? DEFAULT_MAX_SCREENS
  const maxTaps = req.maxTaps ?? DEFAULT_MAX_TAPS
  const timeBudget = req.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS
  const neverPress = [...NEVER_PRESS, ...(req.neverPress ?? [])]
  const secrets = Object.entries(req.secrets ?? {}).filter(([, v]) => v.length > 0)
  const startedAt = host.now()
  const result: ExploreResult = { start: null, screens: [], edges: [], skipped: [], stopped: 'done', taps: 0, notes: [] }
  const known = new Map<string, ExploreScreen>()

  const shell = async (line: string): Promise<void> => {
    const r = await host.exec(adb, ['-s', serial, 'shell', line], SHELL_TIMEOUT_MS)
    if (failed(r)) {
      result.notes.push(`Stopped: \`${line}\` failed on ${serial} (${said(r)}).`)
      throw new Stop('device_error')
    }
  }
  const wait = async (ms: number): Promise<void> => {
    await host.delay(ms, signal)
    if (signal?.aborted) throw new Stop('cancelled')
  }
  /** Read the screen with the on-screen keyboard hidden (the dump leaves it out, so a tap could land on a key). */
  const read = async (): Promise<UiScreen> => {
    for (let attempt = 0; ; attempt++) {
      const r = await readScreen(host, adb, serial)
      if ('skipped' in r) {
        result.notes.push(`Stopped: ${r.skipped}.`)
        throw new Stop('unreadable')
      }
      const ime = await host.exec(adb, ['-s', serial, 'shell', KEYBOARD_SHOWN_LINE], SHELL_TIMEOUT_MS)
      if (failed(ime) || !/mInputShown=true/.test(ime.stdout)) return r
      if (attempt > 0) {
        result.notes.push('Stopped: the on-screen keyboard stays up after Back, so a tap could type into the app.')
        throw new Stop('device_error')
      }
      await shell('input keyevent KEYCODE_BACK')
      await wait(KEYBOARD_SETTLE_MS)
    }
  }
  const tap = async (at: { x: number; y: number }): Promise<void> => {
    // Only numbers reach the shell: the coordinates come from the dump's bounds, parsed as integers.
    await shell(`input tap ${at.x} ${at.y}`)
    await wait(EXPLORE_SETTLE_MS)
  }
  const back = async (): Promise<void> => {
    await shell('input keyevent KEYCODE_BACK')
    await wait(EXPLORE_SETTLE_MS)
  }

  /** Study a screen seen for the first time (with its screenshot) and add it to the graph. */
  const addScreen = async (screen: UiScreen, depth: number, path: ExploreTap[]): Promise<ExploreScreen> => {
    let png: Uint8Array | null = null
    let image: RgbImage | null = null
    let error: string | null = null
    if (req.screenshots !== false) {
      if (secrets.length > 0 && showsSecret(screen, secrets)) error = 'not taken: a secret value typed into the app is on the screen, and a screenshot cannot be scrubbed'
      else {
        const frame = await captureScreen(adb, serial, host.execBinary)
        if (!frame.ok) error = frame.error
        else {
          const decoded = decodePng(frame.png)
          if (decoded.ok) {
            png = frame.png
            image = decoded.image
          } else error = `the screenshot could not be read (${decoded.error})`
        }
      }
    }
    const reason = req.screenshots === false ? 'no screenshots were asked for' : error && `there is no screenshot (${error})`
    const study = scrubStudy(studyScreen(screen, { package: pkg, densityDpi: req.densityDpi ?? null, screenshot: image, noScreenshotReason: reason }), secrets)
    const entry: ExploreScreen = { screen_id: study.screen_id, depth, path, study, screenshot: png, screenshot_error: error }
    known.set(study.screen_id, entry)
    result.screens.push(entry)
    return entry
  }

  /** Bring the app back to the top of `stack` from `now` by tapping the path again; stops the run as lost if it can't. */
  const returnTo = async (stack: ExploreScreen[], now: UiScreen): Promise<UiScreen> => {
    let cur = now
    const front = frontPackage(cur.nodes)
    const at = front === pkg ? stack.findIndex((x) => x.screen_id === screenIdOf(cur)) : -1
    if (at === -1) {
      result.notes.push(`Stopped: on the way back to ${stack[stack.length - 1].screen_id} the app showed ${front === pkg ? screenIdOf(cur) : `another app (${front ?? 'unknown'})`}, which the explored path does not lead back from.`)
      throw new Stop('lost')
    }
    for (let k = at + 1; k < stack.length; k++) {
      const step = stack[k].path[stack[k].path.length - 1]
      const point = tapPoint(cur, step.locator)
      if ('skip' in point) {
        result.notes.push(`Stopped: "${step.label}" can't be tapped on ${stack[k - 1].screen_id} any more (${point.skip}), so the path back to ${stack[k].screen_id} is gone.`)
        throw new Stop('lost')
      }
      await tap(point)
      cur = await read()
      if (frontPackage(cur.nodes) !== pkg || screenIdOf(cur) !== stack[k].screen_id) {
        result.notes.push(`Stopped: tapping "${step.label}" again did not lead back to ${stack[k].screen_id}.`)
        throw new Stop('lost')
      }
    }
    return cur
  }

  /** Press Back out of `left` (and out of copies of it a tap stacked up), then return to the top of `stack`. */
  const backOut = async (stack: ExploreScreen[], left: string | null): Promise<UiScreen> => {
    let cur: UiScreen
    let backs = 0
    do {
      await back()
      cur = await read()
    } while (++backs < MAX_BACKS && left !== null && frontPackage(cur.nodes) === pkg && screenIdOf(cur) === left)
    return returnTo(stack, cur)
  }

  const checkBudgets = (): void => {
    if (signal?.aborted) throw new Stop('cancelled')
    if (result.taps >= maxTaps) throw new Stop('max_taps')
    if (host.now() - startedAt >= timeBudget) throw new Stop('max_time')
  }

  const visit = async (stack: ExploreScreen[], screen: UiScreen): Promise<void> => {
    const here = stack[stack.length - 1]
    if (here.depth >= maxDepth) return
    const { taps, skipped } = tapCandidates(screen, here.study, pkg, neverPress)
    result.skipped.push(...skipped)
    // Per list: where its rows led; once two rows lead to the same place, the rest are rows of the same kind.
    const rowTargets = new Map<number, Set<string>>()
    const listsDone = new Set<number>()
    let cur = screen
    for (const c of taps) {
      const skip = (reason: ExploreSkipReason): void => {
        result.skipped.push({ screen_id: here.screen_id, label: c.label, locator: c.locator, reason })
      }
      if (c.list !== null && listsDone.has(c.list)) {
        skip('repeated_row')
        continue
      }
      checkBudgets()
      const point = tapPoint(cur, c.locator)
      if ('skip' in point) {
        skip(point.skip)
        continue
      }
      const edgeTap: ExploreTap = { locator: c.locator, label: c.label }
      await tap(point)
      result.taps++
      const after = await read()
      const front = frontPackage(after.nodes)
      const id = front === pkg ? screenIdOf(after) : null
      if (c.list !== null) {
        const target = id ?? `app:${front ?? ''}`
        const seen = rowTargets.get(c.list) ?? new Set<string>()
        if (seen.has(target)) listsDone.add(c.list)
        rowTargets.set(c.list, seen.add(target))
      }
      if (id === null) {
        result.edges.push({ from: here.screen_id, to: null, tap: edgeTap, result: 'left_app', package: front ?? '' })
        cur = await backOut(stack, null)
        continue
      }
      if (id === here.screen_id) {
        result.edges.push({ from: here.screen_id, to: id, tap: edgeTap, result: 'same_screen' })
        cur = after
        continue
      }
      if (stack.some((x) => x.screen_id === id)) {
        // Up (or a link) to a screen on the current path: tap the path again instead of pressing Back.
        result.edges.push({ from: here.screen_id, to: id, tap: edgeTap, result: 'screen' })
        cur = await returnTo(stack, after)
        continue
      }
      if (!known.has(id) && known.size >= maxScreens) {
        // The tap already opened a screen the graph won't keep: leave it, so the device ends on a screen of the graph
        // (the tap and time budgets stop before a tap, so they already do). If that fails, the Stop it throws (lost,
        // device_error, cancelled) says where the device is better than max_screens would.
        result.notes.push(`Stopped: the budget of ${maxScreens} screens was reached; ${id} (from "${c.label}" on ${here.screen_id}) was left unexplored.`)
        await backOut(stack, id)
        throw new Stop('max_screens')
      }
      result.edges.push({ from: here.screen_id, to: id, tap: edgeTap, result: 'screen' })
      if (!known.has(id)) {
        const next = await addScreen(after, here.depth + 1, [...here.path, edgeTap])
        await visit([...stack, next], after)
      }
      cur = await backOut(stack, id)
    }
  }

  try {
    const first = await read()
    const front = frontPackage(first.nodes)
    if (front !== pkg) {
      result.notes.push(`${pkg} is not in front (${front ?? 'nothing'} is): open it first, then explore.`)
      result.stopped = 'not_in_app'
      return result
    }
    const start = await addScreen(first, 0, [])
    result.start = start.screen_id
    await visit([start], first)
  } catch (err) {
    if (!(err instanceof Stop)) throw err
    result.stopped = err.reason
  }
  return result
}
