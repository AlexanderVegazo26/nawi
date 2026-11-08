import type { FlowStep, Selector } from '../../shared/flow/schema'

/**
 * Roadmap F6c-2: when nothing found a step's target (no locator, no reference
 * crop), the run looks at what the page offers instead. The page helper
 * `snapshot` lists the visible controls with their role and accessible name
 * (the probe's rules: the ones `{ role, name }` locators replay with), the
 * page's accessibility snapshot at the moment the step failed. This module
 * picks the control whose name best matches what the step was for: its
 * `intent`, and the names its own locators were looking for (a role + name,
 * a text, the words of a test id or id). The run records that control's own
 * locators as a suggestion, unverified: a heal proposal puts them in front,
 * and only apply_heal's replay of the whole flow can show they are right.
 *
 * Pure and deterministic: the same snapshot and step always give the same
 * answer. Word overlap, not a model: a renamed "Save" button that now says
 * "Save note" is found, a page with two equally close controls gives no
 * suggestion at all (a guess between them would be a coin toss).
 */

/** One control of the page's accessibility snapshot, as replay.js `snapshot` lists it. */
export interface SnapshotEntry {
  /** Its position in the page helper's list, to ask for its locators. */
  i: number
  role: string
  name: string
  /** A text field (input, textarea, contenteditable) a `fill` can type into. */
  editable: boolean
  /** A `<select>` (or a role that picks options) a `select` step can use. */
  select: boolean
}

export interface Suggestion {
  /** The snapshot entry suggested. */
  entry: SnapshotEntry
  /** How well its name matches the step, 0..1. */
  score: number
  /** What it matched: the step's intent, or the names its own locators looked for. */
  basis: 'intent' | 'locators'
}

/** Below this a control is not close enough to suggest. */
export const MIN_SUGGEST_SCORE = 0.5
/** Added when the control has the role the step's own role locator asked for. */
const SAME_ROLE_BONUS = 0.15
/** The best control must beat the runner-up by this much, else the page offers two equally good answers. */
const MIN_MARGIN = 0.1
/** Float slack for the threshold and margin checks (0.6 - 0.5 is 0.0999...). */
const EPSILON = 1e-9
/** Longest name compared (a control named by a paragraph is not a control name). */
const MAX_NAME_CHARS = 200

/**
 * Words that say what kind of thing or action a step is, not which one: they
 * are in almost every intent ("Click the Save button") and would make every
 * button look alike. English and Spanish, the languages flows are written in.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'on', 'of', 'in', 'into', 'and', 'or', 'for', 'with', 'from', 'by', 'at', 'it', 'this', 'that',
  'my', 'our', 'your', 'is', 'be', 'then', 'click', 'clicks', 'press', 'tap', 'hit', 'choose', 'pick', 'select', 'open',
  'go', 'button', 'btn', 'link', 'field', 'input', 'box', 'textbox', 'menu', 'item', 'option', 'tab', 'enter', 'type',
  'fill', 'write', 'hover', 'over', 'scroll', 'wait', 'check', 'assert', 'make', 'sure', 'see', 'el', 'la', 'los',
  'las', 'un', 'una', 'de', 'del', 'en', 'y', 'o', 'con', 'para', 'por', 'al', 'boton', 'enlace', 'campo', 'pulsar',
  'hacer', 'clic', 'escribir', 'elegir', 'abrir'
])

/**
 * The meaningful words of a text, folded: lower case, accents off, camelCase
 * and `snake_case`/`kebab-case` split, `${...}` placeholders left out (their
 * value is the run's, not the control's name), stop words and one-letter
 * words dropped.
 */
export function words(text: string): Set<string> {
  const plain = text
    .replace(/\$\{[^}]*\}/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
  const out = new Set<string>()
  for (const w of plain.split(/[^\p{L}\p{N}]+/u)) {
    if (w.length > 1 && !STOP_WORDS.has(w)) out.add(w)
  }
  return out
}

/** Dice similarity of two word sets: 1 = the same words, 0 = none shared. */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return (2 * shared) / (a.size + b.size)
}

/** What a failed step was looking for: the words of its intent and of its own locators, and the roles they asked for. */
export interface StepQuery {
  intent: Set<string>
  locators: Set<string>
  roles: Set<string>
}

export function stepQuery(step: Pick<FlowStep, 'intent'>, selectors: Selector[]): StepQuery {
  const locators = new Set<string>()
  const roles = new Set<string>()
  for (const s of selectors) {
    const named = 'role' in s ? s.name : 'text' in s ? s.text : 'testid' in s ? s.testid : 'id' in s ? s.id : undefined
    if ('role' in s) roles.add(s.role)
    if (typeof named === 'string') for (const w of words(named)) locators.add(w)
  }
  return { intent: words(step.intent ?? ''), locators, roles }
}

/** Could this control take the step's action at all? */
function fits(action: FlowStep['action'], entry: SnapshotEntry): boolean {
  if (action === 'fill') return entry.editable
  if (action === 'select') return entry.select
  return true
}

function isEntry(value: unknown): value is SnapshotEntry {
  const e = value as Partial<SnapshotEntry> | null
  return (
    !!e &&
    typeof e === 'object' &&
    Number.isInteger(e.i) &&
    typeof e.role === 'string' &&
    typeof e.name === 'string' &&
    typeof e.editable === 'boolean' &&
    typeof e.select === 'boolean'
  )
}

/**
 * The control to suggest for a step nothing found, from the page helper's
 * snapshot (anything that is not a list of entries gives null), or null when
 * no control is close enough or two are equally close.
 */
export function pickSuggestion(raw: unknown, action: FlowStep['action'], query: StepQuery): Suggestion | null {
  if (!Array.isArray(raw) || (query.intent.size === 0 && query.locators.size === 0)) return null
  const scored: Suggestion[] = []
  for (const entry of raw) {
    if (!isEntry(entry) || !fits(action, entry)) continue
    const name = words(entry.name.slice(0, MAX_NAME_CHARS))
    const byIntent = dice(query.intent, name)
    const byLocators = dice(query.locators, name)
    if (byIntent === 0 && byLocators === 0) continue
    const bonus = query.roles.has(entry.role) ? SAME_ROLE_BONUS : 0
    const basis = byIntent >= byLocators ? 'intent' : 'locators'
    // Uncapped while comparing: capping first would make an exact name with the right role tie a near one.
    scored.push({ entry, score: Math.max(byIntent, byLocators) + bonus, basis })
  }
  // Best first; equal scores keep document order, so the answer never depends on sort stability.
  scored.sort((x, y) => y.score - x.score || x.entry.i - y.entry.i)
  const [best, next] = scored
  if (!best || best.score < MIN_SUGGEST_SCORE - EPSILON) return null
  if (next && best.score - next.score < MIN_MARGIN - EPSILON) return null
  return { ...best, score: Math.round(Math.min(1, best.score) * 1000) / 1000 }
}
