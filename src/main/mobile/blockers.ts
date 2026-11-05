import type { UiNode, UiScreen } from './hierarchy'

/**
 * Roadmap M2 (third slice, M2c): what stands between a freshly launched app and its real first screen. From one
 * screen dump (src/main/mobile/hierarchy.ts) it names the first-run blockers a test would trip over and, where a
 * single tap gets past one, the element to tap, as a locator that finds it again on the next run:
 *
 * - `permission_dialog`: Android's own permission prompt (the permission controller's window), e.g. a permission
 *   `pm grant` could not grant. Tap: the "allow" button (while using the app, when Android offers that).
 * - `consent`: a cookie / privacy / terms screen with an accept button.
 * - `intro`: a welcome or what's-new screen with Skip / Get started / Not now (or Next, on a screen without text
 *   fields).
 * - `login_wall`: a sign-in form (a password field, or a sign-in button next to a text field). No tap: getting past
 *   it needs a test account, which never goes into a profile.
 *
 * Heuristics on visible labels only (English for now); never a package-chosen name. Pure, so tests pin it.
 */

export type BlockerKind = 'permission_dialog' | 'consent' | 'intro' | 'login_wall'

/** Finds one element again: every field given must match exactly. */
export interface UiLocator {
  resource_id?: string
  content_desc?: string
  text?: string
}

export interface FirstRunBlocker {
  kind: BlockerKind
  /** What is on screen, e.g. 'Android asks: "Allow Demo to take pictures?"'. */
  summary: string
  /** The element that gets past it, or null when no single tap does (a sign-in form, an ambiguous button). */
  tap: UiLocator | null
  /** The visible label of that element, for messages ("While using the app"). */
  tap_label: string | null
  /** One sentence: what to do about it. */
  fix: string
}

export interface FirstScreen {
  /** The package of the window in front (the app itself, Android's permission controller, another app...). */
  package: string | null
  blockers: FirstRunBlocker[]
}

/** The packages that draw Android's runtime permission prompt, across versions and vendors. */
export const PERMISSION_PACKAGES: ReadonlySet<string> = new Set([
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
  'com.android.packageinstaller',
  'com.google.android.packageinstaller'
])

/** The prompt's "allow" buttons by view id, best first: the narrowest grant that lets the app go on. */
const ALLOW_IDS = ['permission_allow_foreground_only_button', 'permission_allow_button', 'permission_allow_one_time_button', 'permission_allow_all_button']

/** Button labels, best first; compared after trimming, lower-casing and dropping trailing punctuation. */
const CONSENT_LABELS = [
  'accept all',
  'accept all cookies',
  'allow all',
  'allow all cookies',
  'accept',
  'accept cookies',
  'accept and continue',
  'accept & continue',
  'agree and continue',
  'agree & continue',
  'i agree',
  'agree',
  'i accept',
  'consent',
  'got it',
  'ok',
  'continue'
]
/** Words that make a screen a consent screen (an OK button alone is not one). */
const CONSENT_WORDS = /\b(cookies?|consent|privacy|personal data|terms of (service|use)|gdpr|(ad|app) tracking|personali[sz]ed ads)\b/i
/** Generic labels that only mean "accept" on a screen without text fields (on a form they submit it). */
const GENERIC_CONSENT = new Set(['got it', 'ok', 'continue'])
const INTRO_LABELS = ['skip', 'skip intro', 'get started', 'not now', 'maybe later', 'no thanks', 'no, thanks', 'later', 'continue as guest']
/** "Next" only counts on a screen without text fields (on a form it submits what was typed). */
const INTRO_NEXT = ['next']
const SIGN_IN_LABELS = /^(sign in|log in|login|sign up|create (an )?account|continue with .{1,40})$/

export const norm = (s: string): string =>
  s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!…:]+$/, '')
    .toLowerCase()

export const labelOf = (n: UiNode): string => (n.text.trim() || n.content_desc.trim()).replace(/\s+/g, ' ')

/** The node or one of its three nearest ancestors is clickable (a label inside a button layout). */
function tappable(nodes: UiNode[], n: UiNode): boolean {
  let cur: UiNode | null = n
  for (let hops = 0; cur && hops < 4; hops++) {
    if (cur.clickable && cur.enabled) return true
    cur = cur.parent === null ? null : nodes[cur.parent]
  }
  return false
}

/** The shortest locator that matches `n` and nothing else on the screen; null when none does. */
export function locatorFor(nodes: UiNode[], n: UiNode): UiLocator | null {
  const candidates: UiLocator[] = []
  if (n.resource_id) candidates.push({ resource_id: n.resource_id })
  if (n.content_desc) candidates.push({ content_desc: n.content_desc })
  if (n.text) candidates.push({ text: n.text })
  if (n.resource_id && n.text) candidates.push({ resource_id: n.resource_id, text: n.text })
  if (n.resource_id && n.content_desc) candidates.push({ resource_id: n.resource_id, content_desc: n.content_desc })
  for (const loc of candidates) if (findAll(nodes, loc).length === 1) return loc
  return null
}

export function matches(n: UiNode, loc: UiLocator): boolean {
  if (loc.resource_id === undefined && loc.content_desc === undefined && loc.text === undefined) return false
  return (
    (loc.resource_id === undefined || n.resource_id === loc.resource_id) &&
    (loc.content_desc === undefined || n.content_desc === loc.content_desc) &&
    (loc.text === undefined || n.text === loc.text)
  )
}

export function findAll(nodes: UiNode[], loc: UiLocator): UiNode[] {
  return nodes.filter((n) => matches(n, loc))
}

/** The first label in `labels` order that a tappable node of `pool` carries. */
function pick(nodes: UiNode[], pool: UiNode[], labels: readonly string[]): UiNode | null {
  for (const label of labels) {
    const hit = pool.find((n) => norm(labelOf(n)) === label && tappable(nodes, n) && n.bounds !== null)
    if (hit) return hit
  }
  return null
}

function withTap(nodes: UiNode[], kind: BlockerKind, summary: string, hit: UiNode | null, fix: (label: string) => string, noTap: string): FirstRunBlocker {
  const tap = hit ? locatorFor(nodes, hit) : null
  const label = hit ? labelOf(hit) : null
  return tap && label ? { kind, summary, tap, tap_label: label, fix: fix(label) } : { kind, summary, tap: null, tap_label: null, fix: noTap }
}

const quote = (s: string, max = 120): string => `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`

/** The package of the window in front: the first node that names one (Android's prompt sits on top of the app). */
export const frontPackage = (nodes: readonly UiNode[]): string | null => nodes.find((n) => n.package !== '')?.package ?? null

/** The blockers on one screen of `pkg`, front-most first (Android's prompt sits on top of the app). */
export function findFirstRunBlockers(screen: UiScreen, pkg: string): FirstScreen {
  const nodes = screen.nodes
  const front = frontPackage(nodes)
  const blockers: FirstRunBlocker[] = []

  const prompt = nodes.filter((n) => PERMISSION_PACKAGES.has(n.package))
  if (prompt.length > 0) {
    const message = prompt.find((n) => n.resource_id.endsWith(':id/permission_message'))?.text.trim()
    const allow = ALLOW_IDS.map((id) => prompt.find((n) => n.resource_id.endsWith(`:id/${id}`) && n.enabled && n.bounds !== null)).find((n) => n !== undefined) ?? null
    blockers.push(
      withTap(
        nodes,
        'permission_dialog',
        message ? `Android asks: ${quote(message)}` : 'Android shows a permission prompt',
        allow,
        (label) => `Tap ${quote(label)} to go on, or grant that permission before launch (the profile's permissions.grant) so the prompt never shows.`,
        'Answer the prompt on the device, or grant that permission before launch (the profile\'s permissions.grant) so it never shows.'
      )
    )
  }

  const app = nodes.filter((n) => n.package === pkg)
  if (app.length > 0) {
    const field = app.some((n) => /EditText$/.test(n.class))
    const words = app.some((n) => CONSENT_WORDS.test(n.text) || CONSENT_WORDS.test(n.content_desc))
    // A form's footer ("By continuing you agree to our Terms of Service") is not a consent screen: there, only an
    // explicit accept button counts.
    const consent = words ? pick(nodes, app, field ? CONSENT_LABELS.filter((l) => !GENERIC_CONSENT.has(l)) : CONSENT_LABELS) : null
    if (consent) {
      blockers.push(
        withTap(nodes, 'consent', `a consent screen (${quote(labelOf(consent), 40)} button)`, consent, (label) => `Tap ${quote(label)} to accept it for this test device.`, '')
      )
    }
    const intro = pick(nodes, app, INTRO_LABELS) ?? (field ? null : pick(nodes, app, INTRO_NEXT))
    if (intro) {
      blockers.push(withTap(nodes, 'intro', `an intro screen (${quote(labelOf(intro), 40)} button)`, intro, (label) => `Tap ${quote(label)} to go past it.`, ''))
    }
    const password = app.some((n) => n.password)
    const signIn = app.find((n) => SIGN_IN_LABELS.test(norm(labelOf(n))) && tappable(nodes, n))
    if (password || (field && signIn)) {
      blockers.push({
        kind: 'login_wall',
        summary: password ? 'a sign-in form (password field)' : `a sign-in screen (${quote(labelOf(signIn as UiNode), 40)})`,
        tap: null,
        tap_label: null,
        fix: 'Sign in on the device once with a test account (the app keeps the session), then open it again; never put the password in the profile.'
      })
    }
  }
  // A blocker whose tap could not be pinned down still needs a fix sentence.
  for (const b of blockers) if (!b.fix) b.fix = `Several elements look the same, so Nawi can't name one to tap: get past ${b.kind === 'consent' ? 'the consent screen' : 'the intro'} on the device by hand.`
  return { package: front, blockers }
}
