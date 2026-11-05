import { findAll, findFirstRunBlockers, labelOf, norm, PERMISSION_PACKAGES, type BlockerKind, type UiLocator } from './blockers'
import { center, type UiBounds, type UiNode, type UiScreen } from './hierarchy'

/**
 * Roadmap M2 (fourth slice, M2c part 2): get past an app's first-run screens on every open. A profile's `onboarding`
 * section lists the taps that do it (`{ when: intro, tap: { resource_id: ... } }`), saved from the blockers M2c part 1
 * names; `mobile_open` replays them after launch: read the screen, tap the one saved element that is on it, read the
 * screen again, until none is (or a cap). With `learn_onboarding`, a blocker Nawi can name a tap for is tapped too and
 * saved, so one open learns the whole sequence; that is the user's consent, since a tap accepts a consent screen on
 * that device.
 *
 * A tap only lands on the window in front that it was saved for: while Android's permission prompt is up only a
 * permission_dialog tap is made (on the prompt), otherwise only taps on the app itself, so a saved locator never presses
 * a button of another app or one hidden under a prompt. The same guards as the learner apply on replay: nothing is
 * tapped on a sign-in form, and a generic label (Next, OK, Continue, Got it) is never pressed on a screen with text
 * fields, where it would submit a form. Pure, so tests pin it.
 */

/** The blockers a single tap gets past (a sign-in form isn't one). */
export const ONBOARDING_KINDS = ['permission_dialog', 'consent', 'intro'] as const satisfies readonly BlockerKind[]
export type OnboardingKind = (typeof ONBOARDING_KINDS)[number]

export interface OnboardingTap {
  when: OnboardingKind
  tap: UiLocator
}

/** At most this many taps per open: an intro of a few pages plus a prompt or two; more is a loop. */
export const MAX_ONBOARDING_TAPS = 10
/** At most this many saved taps in a profile. */
export const MAX_ONBOARDING_ENTRIES = 20
/** A locator field in a profile: one line, no control characters, at most this long. */
export const MAX_LOCATOR_FIELD = 500
export const LOCATOR_FIELD_RE = /^[^\x00-\x1f\x7f-\x9f]*$/

/** Labels that mean "go on" on an intro or notice but submit a form on a screen with text fields. */
const FORM_SUBMIT_LABELS = new Set(['next', 'ok', 'continue', 'got it'])

export interface NextTap {
  entry: OnboardingTap
  /** The element to tap (one match, on the right window, with its center on the screen). */
  node: UiNode
  x: number
  y: number
  label: string
  /** Not in the profile yet: proposed by the blocker heuristics (learn mode). */
  learned: boolean
}

const sameLocator = (a: UiLocator, b: UiLocator): boolean => a.resource_id === b.resource_id && a.content_desc === b.content_desc && a.text === b.text

export const sameTap = (a: OnboardingTap, b: OnboardingTap): boolean => a.when === b.when && sameLocator(a.tap, b.tap)

/** A locator a profile can hold (the learner must not propose one the schema would refuse on save). */
export function savableLocator(t: UiLocator): boolean {
  const fields = [t.resource_id, t.content_desc, t.text].filter((v): v is string => v !== undefined)
  return fields.length > 0 && fields.every((v) => v.length > 0 && v.length <= MAX_LOCATOR_FIELD && LOCATOR_FIELD_RE.test(v))
}

/** The screen's area: the union of the top-level windows' bounds (null when the dump has none). */
function screenArea(screen: UiScreen): UiBounds | null {
  let area: UiBounds | null = null
  for (const n of screen.nodes) {
    if (n.parent !== null || n.bounds === null) continue
    area = area ? { left: Math.min(area.left, n.bounds.left), top: Math.min(area.top, n.bounds.top), right: Math.max(area.right, n.bounds.right), bottom: Math.max(area.bottom, n.bounds.bottom) } : { ...n.bounds }
  }
  return area
}

interface Context {
  pkg: string
  /** Android's permission prompt is up: it is modal, so only its own buttons can be tapped. */
  prompt: boolean
  /** The app's window has a text field / a password field. */
  field: boolean
  password: boolean
  area: UiBounds | null
}

function contextOf(screen: UiScreen, pkg: string): Context {
  const app = screen.nodes.filter((n) => n.package === pkg)
  return {
    pkg,
    prompt: screen.nodes.some((n) => PERMISSION_PACKAGES.has(n.package)),
    field: app.some((n) => /EditText$/.test(n.class)),
    password: app.some((n) => n.password),
    area: screenArea(screen)
  }
}

function hit(screen: UiScreen, entry: OnboardingTap, ctx: Context): Omit<NextTap, 'learned'> | null {
  if (entry.when === 'permission_dialog' ? !ctx.prompt : ctx.prompt) return null
  // Never past a sign-in form, and never a generic "go on" label on a form (it would submit it).
  if (entry.when !== 'permission_dialog' && ctx.password) return null
  const found = findAll(screen.nodes, entry.tap)
  // Two matches: which one was meant can't be told, so neither is pressed.
  if (found.length !== 1) return null
  const node = found[0]
  const onWindow = entry.when === 'permission_dialog' ? PERMISSION_PACKAGES.has(node.package) : node.package === ctx.pkg
  if (!node.enabled || node.bounds === null || !onWindow) return null
  if (entry.when !== 'permission_dialog' && ctx.field && FORM_SUBMIT_LABELS.has(norm(labelOf(node)))) return null
  const b = node.bounds
  if (b.right <= b.left || b.bottom <= b.top) return null
  const { x, y } = center(b)
  const area = ctx.area
  if (x < 0 || y < 0 || (area && (x < area.left || x >= area.right || y < area.top || y >= area.bottom))) return null
  return { entry, node, x, y, label: (labelOf(node) || node.resource_id.replace(/^.*:id\//, '')).slice(0, 80) }
}

/**
 * The tap to make on this screen: the first saved entry that is on it, else (learn mode) the front-most blocker Nawi
 * can name a tap for. Null: nothing to tap, onboarding is done (or stuck on something only a person can answer).
 */
export function nextOnboardingTap(screen: UiScreen, pkg: string, saved: readonly OnboardingTap[], learn: boolean): NextTap | null {
  const ctx = contextOf(screen, pkg)
  for (const entry of saved) {
    const h = hit(screen, entry, ctx)
    if (h) return { ...h, learned: false }
  }
  if (!learn) return null
  for (const b of findFirstRunBlockers(screen, pkg).blockers) {
    if (b.tap === null || b.kind === 'login_wall' || !savableLocator(b.tap)) continue
    const h = hit(screen, { when: b.kind, tap: b.tap }, ctx)
    if (h) return { ...h, learned: true }
  }
  return null
}

/**
 * A cheap fingerprint of what is on screen, to notice a tap that changed nothing. It includes the checked and
 * selected state: ticking an "I agree" box or swiping to the next intro page may change nothing else.
 */
export function screenKey(screen: UiScreen): string {
  return screen.nodes
    .map((n) => `${n.package}|${n.class}|${n.resource_id}|${n.text}|${n.content_desc}|${n.enabled ? 1 : 0}${n.checked ? 1 : 0}${n.selected ? 1 : 0}|${n.bounds ? `${n.bounds.left},${n.bounds.top},${n.bounds.right},${n.bounds.bottom}` : ''}`)
    .join('\n')
}

/**
 * `saved` plus the learned taps it doesn't have yet, in the order they were made, capped at MAX_ONBOARDING_ENTRIES;
 * `dropped` counts new taps the cap left out.
 */
export function mergeOnboarding(saved: readonly OnboardingTap[], learned: readonly OnboardingTap[]): { taps: OnboardingTap[]; dropped: number } {
  const taps = [...saved]
  let dropped = 0
  for (const t of learned) {
    if (taps.some((o) => sameTap(o, t))) continue
    if (taps.length >= MAX_ONBOARDING_ENTRIES) dropped++
    else taps.push({ when: t.when, tap: { ...t.tap } })
  }
  return { taps, dropped }
}
