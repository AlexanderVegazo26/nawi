import { createHash } from 'node:crypto'
import { frontPackage, labelOf, type UiLocator } from './blockers'
import { colorHex, formatRatio, measureTextContrast, MIN_RATIO, MIN_RATIO_LARGE } from './contrast'
import type { UiBounds, UiNode, UiScreen } from './hierarchy'
import type { RgbImage } from './png'

/**
 * Roadmap M3 (first slice, M3a): study one screen of an Android app from its `uiautomator dump`
 * (src/main/mobile/hierarchy.ts). Offline and pure, so fixture dumps pin every rule. Reading a live device with a
 * screenshot is study-live.ts (M3b, mobile_study); the safe exploration that builds a screen graph from it is
 * explore.ts (M3c).
 *
 * - Inventory: every element a test or a person can act on or read (clickable, long-clickable, checkable,
 *   focusable, scrollable, or carrying text / a content description / a hint), with the shortest locator that finds
 *   it again and what that locator rests on.
 * - Screen id: a short hash of the screen's structure (window packages, classes, view ids, nesting, rotation, and
 *   the labels of the controls outside lists) that stays the same across runs while the content changes: no
 *   typed or listed text, no bounds, list rows collapsed into their list. Two runs that reach the same screen get
 *   the same id, so their results can be compared.
 * - Findings, each with one fix: an unlabeled control (missing_label), a touch target under 48 dp
 *   (small_touch_target), a view id shared by unrelated views (duplicate_resource_id), a control without a view id
 *   (missing_resource_id; one screen-level finding when the screen has no view ids at all, as in Flutter or
 *   Compose apps), a control that only its text or its position finds (fragile_locator), and, given a screenshot of
 *   the same screen, a text drawn with too little contrast against its background (low_contrast, M3b2: contrast.ts).
 *
 * The dump comes from the app under test: nothing here runs or resolves what it reads, and a password field's text
 * never leaves this module.
 */

export type FindingKind = 'missing_label' | 'small_touch_target' | 'duplicate_resource_id' | 'missing_resource_id' | 'fragile_locator' | 'low_contrast'
export type FindingSeverity = 'error' | 'warning' | 'info'

/** What the element's locator rests on: a unique view id is the sturdiest, its position (no locator) the weakest. */
export type LocatorBasis = 'resource_id' | 'content_desc' | 'text' | 'index'

/** Android's minimum touch target (Material, Android accessibility guidelines and the Play pre-launch report). */
export const MIN_TOUCH_DP = 48

/** At most this many texts get their contrast measured (each reads up to 200,000 pixels; a dump can hold 10,000). */
export const MAX_CONTRAST_TEXTS = 500

/** Containers whose children repeat (rows, cells, pages): their rows share view ids by design. */
const COLLECTION_RE = /(?:^|\.)(?:RecyclerView|ListView|GridView|ExpandableListView|ViewPager2?)$/
/** Scroll views hold one child (the content), never rows. */
const SCROLL_VIEW_RE = /(?:^|\.)(?:Nested|Horizontal)?ScrollView$/

export interface StudyElement {
  /** The node's position in the dump (UiNode.i). */
  i: number
  class: string
  package: string
  resource_id: string
  content_desc: string
  /** '' for a password field, whatever the dump said. */
  text: string
  hint: string
  /** What a screen reader announces: its own text, description or hint, else (for a control) its children's labels. */
  label: string
  bounds: UiBounds | null
  clickable: boolean
  long_clickable: boolean
  checkable: boolean
  focusable: boolean
  scrollable: boolean
  enabled: boolean
  password: boolean
  /**
   * The shortest locator that matches this element and nothing else on the screen (for a control without one, its
   * first child that has one); null when none does.
   */
  locator: UiLocator | null
  locator_basis: LocatorBasis
  /** A row (or a view inside a row) of a list, grid or pager. */
  in_collection: boolean
}

export interface StudyFinding {
  kind: FindingKind
  severity: FindingSeverity
  /** UiNode.i of the element it is about; null for a finding about the whole screen. */
  element: number | null
  /** One sentence: what is wrong, naming the element. */
  summary: string
  /** One sentence: what to change in the app. */
  fix: string
}

export interface ScreenStudy {
  /** `s-` + 12 hex characters; see the module comment for what it is built from. */
  screen_id: string
  /** The package of the window in front (the first node that names one, as in blockers.ts), or null. */
  package: string | null
  rotation: number
  /** The density touch targets were measured with; null skips small_touch_target (see notes). */
  density_dpi: number | null
  elements: StudyElement[]
  findings: StudyFinding[]
  /** What the study could not check, one sentence each. */
  notes: string[]
}

export interface StudyOptions {
  /** The app under test: findings only look at its views (Android's own dialogs are not the app's to fix). */
  package?: string | null
  /** From `wm density` (see parseDensity); without it touch targets are not measured. */
  densityDpi?: number | null
  /** A screenshot of the same screen (png.ts decodePng); without it contrast is not checked (see notes). */
  screenshot?: RgbImage | null
  /** Why there is no screenshot, for the note (e.g. "a secret value is on the screen"). */
  noScreenshotReason?: string | null
  /**
   * The on-screen keyboard was up when the screenshot was taken (`dumpsys input_method`): the dump has no window for
   * it, so where it covers the app is unknown and contrast is not checked.
   */
  keyboardShown?: boolean
}

/**
 * The density `wm density` reports: the override when one is set (that is what the app draws with), else the
 * physical one. Null when the output has neither.
 */
export function parseDensity(output: string): number | null {
  const read = (label: string): number | null => {
    const m = new RegExp(`^${label} density:\\s*(\\d{2,4})\\s*$`, 'm').exec(output)
    const n = m ? Number(m[1]) : NaN
    return n >= 72 && n <= 1280 ? n : null
  }
  return read('Override') ?? read('Physical')
}

const shortClass = (cls: string): string => cls.slice(cls.lastIndexOf('.') + 1) || 'view'
const actionable = (n: UiNode): boolean => n.clickable || n.long_clickable || n.checkable
const visible = (b: UiBounds | null): b is UiBounds => b !== null && b.right > b.left && b.bottom > b.top
const isTextField = (n: UiNode): boolean => /(?:^|\.)(?:EditText|AutoCompleteTextView|TextInputEditText)$/.test(n.class)
const boundsText = (b: UiBounds | null): string => (b ? `[${b.left},${b.top}][${b.right},${b.bottom}]` : '(no bounds)')

/** The node's descendants, in document order (they follow it until the depth returns to its own). */
function descendants(nodes: UiNode[], n: UiNode): UiNode[] {
  const out: UiNode[] = []
  for (let j = n.i + 1; j < nodes.length && nodes[j].depth > n.depth; j++) out.push(nodes[j])
  return out
}

/** A text field's text is what was typed into it (or the secret, for a password): never a label or a locator. */
const typedText = (n: UiNode): boolean => n.password || isTextField(n)
const squash = (s: string): string => s.trim().replace(/\s+/g, ' ')

/** The node's own name: a text field by its description or hint, anything else by its text or description. */
const ownLabel = (n: UiNode): string => (typedText(n) ? squash(n.content_desc) || squash(n.hint) : labelOf(n) || squash(n.hint))

/** Own label first; else, for a control, what a screen reader merges from its children (a label inside a button layout). */
function accessibleLabel(nodes: UiNode[], n: UiNode): string {
  const own = ownLabel(n)
  // Only a control speaks for its children; a list or layout is announced child by child.
  if (own || typedText(n) || !actionable(n)) return own
  return descendants(nodes, n)
    .map(ownLabel)
    .filter(Boolean)
    .join(' ')
    .slice(0, 200)
}

/**
 * How many nodes carry each value a locator can use, so "matches this node and nothing else" is a lookup instead of
 * a scan (a dump can hold 10,000 nodes, and the app under test chooses them).
 */
function uniquenessIndex(nodes: UiNode[]): Map<string, number> {
  const counts = new Map<string, number>()
  const add = (k: string): void => {
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  for (const n of nodes) {
    if (n.resource_id) add(`r\u0000${n.resource_id}`)
    if (n.content_desc) add(`c\u0000${n.content_desc}`)
    if (n.text) add(`t\u0000${n.text}`)
    if (n.resource_id && n.text) add(`rt\u0000${n.resource_id}\u0000${n.text}`)
    if (n.resource_id && n.content_desc) add(`rc\u0000${n.resource_id}\u0000${n.content_desc}`)
  }
  return counts
}

/**
 * The shortest locator that matches `n` and nothing else, in blockers.ts locatorFor's order (id, description, text,
 * id + text, id + description); never by typed text.
 */
function locatorOf(counts: Map<string, number>, n: UiNode): UiLocator | null {
  const text = typedText(n) ? '' : n.text
  const unique = (k: string): boolean => counts.get(k) === 1
  if (n.resource_id && unique(`r\u0000${n.resource_id}`)) return { resource_id: n.resource_id }
  if (n.content_desc && unique(`c\u0000${n.content_desc}`)) return { content_desc: n.content_desc }
  if (text && unique(`t\u0000${text}`)) return { text }
  if (n.resource_id && text && unique(`rt\u0000${n.resource_id}\u0000${text}`)) return { resource_id: n.resource_id, text }
  if (n.resource_id && n.content_desc && unique(`rc\u0000${n.resource_id}\u0000${n.content_desc}`)) return { resource_id: n.resource_id, content_desc: n.content_desc }
  return null
}

/**
 * The node's own locator; for a control without one (a clickable row or button layout), the first of its visible
 * descendants that has one: a tap on that child's center lands inside the control, as blockers.ts taps labels. A
 * descendant that is a control of its own (a switch in a settings row) is skipped: its tap is its own, not the row's.
 */
function findBy(nodes: UiNode[], counts: Map<string, number>, n: UiNode): UiLocator | null {
  const own = locatorOf(counts, n)
  if (own !== null || !actionable(n)) return own
  for (const d of descendants(nodes, n)) {
    if (actionable(d) || !visible(d.bounds)) continue
    const loc = locatorOf(counts, d)
    if (loc !== null) return loc
  }
  return null
}

function basisOf(loc: UiLocator | null): LocatorBasis {
  if (loc === null) return 'index'
  if (loc.text !== undefined) return 'text'
  if (loc.resource_id !== undefined) return 'resource_id'
  return 'content_desc'
}

/**
 * Whether each node is a list / grid / pager: a known collection class, or (Compose's LazyColumn, custom lists, all
 * dumped as plain views) a scrollable view other than a scroll view whose children repeat: two or more of them
 * share a class and a view id.
 */
export function collectionFlags(nodes: UiNode[]): boolean[] {
  const seen = new Map<number, Set<string>>()
  const repeats = new Set<number>()
  for (const n of nodes) {
    if (n.parent === null) continue
    const key = `${n.class}\u0000${n.resource_id}`
    const kids = seen.get(n.parent) ?? new Set<string>()
    if (kids.has(key)) repeats.add(n.parent)
    kids.add(key)
    seen.set(n.parent, kids)
  }
  return nodes.map((n) => COLLECTION_RE.test(n.class) || (n.scrollable && !SCROLL_VIEW_RE.test(n.class) && repeats.has(n.i)))
}

/** For each node, whether it sits inside a list / grid / pager (the container itself is not "inside"). */
function collectionMembership(nodes: UiNode[], isCollection: boolean[]): boolean[] {
  const inside: boolean[] = []
  for (const n of nodes) inside.push(n.parent !== null && (inside[n.parent] || isCollection[n.parent]))
  return inside
}

/**
 * The bounds a control is cut to: its nearest scrolling ancestor's (a list, a scroll view), else its window's.
 * uiautomator clips a partly scrolled-off view to what is visible, so a side on that edge is not its real size.
 */
function clipBox(nodes: UiNode[], n: UiNode): UiBounds | null {
  let cur = n.parent === null ? null : nodes[n.parent]
  while (cur !== null) {
    if (cur.scrollable || cur.parent === null) return cur.bounds
    cur = nodes[cur.parent]
  }
  return null
}

/** The screen id studyScreen gives this screen, without the rest of the study (cheap enough to call after every tap). */
export function screenIdOf(screen: UiScreen): string {
  return screenId(screen, collectionMembership(screen.nodes, collectionFlags(screen.nodes)))
}

function screenId(screen: UiScreen, inCollection: boolean[]): string {
  const lines = [`rotation ${screen.rotation}`]
  for (const n of screen.nodes) {
    if (inCollection[n.i]) continue
    // Only a control's own label: its children's text can be content (a counter, a name), a field's is typed.
    const label = actionable(n) && !typedText(n) ? labelOf(n) : ''
    lines.push([n.depth, n.package, n.class, n.resource_id, label].join('\u0000'))
  }
  return `s-${createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12)}`
}

function describe(n: UiNode, label: string): string {
  return label ? `"${label.length > 60 ? `${label.slice(0, 57)}...` : label}" (${shortClass(n.class)})` : `the ${shortClass(n.class)} at ${boundsText(n.bounds)}`
}

const intersects = (a: UiBounds, b: UiBounds): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

const area = (b: UiBounds): number => (b.right - b.left) * (b.bottom - b.top)
const inside = (a: UiBounds, b: UiBounds): boolean => a.left >= b.left && a.top >= b.top && a.right <= b.right && a.bottom <= b.bottom

/**
 * low_contrast findings for the app's visible, enabled texts (disabled text is exempt in WCAG), measured on the
 * screenshot. Skipped, with a note: a text under a window of another package (a permission prompt, the notification
 * shade), and every text of a window that holds a smaller window (the app's own dialog, sheet or popup sits on top
 * of it, usually behind a dimming scrim). The status bar is the one window inside others that covers nothing.
 */
function contrastFindings(nodes: UiNode[], image: RgbImage, keyboard: boolean, ours: (n: UiNode) => boolean, labels: Map<number, string>, notes: string[]): StudyFinding[] {
  const roots = nodes.filter((n) => n.parent === null && visible(n.bounds)).map((n) => ({ n, b: n.bounds as UiBounds }))
  const rootOf: number[] = []
  for (const n of nodes) rootOf.push(n.parent === null ? n.i : rootOf[n.parent])
  const behind = new Set(
    roots.filter((r) => roots.some((q) => q !== r && q.n.package !== 'com.android.systemui' && inside(q.b, r.b) && area(q.b) < area(r.b))).map((r) => r.n.i)
  )
  const width = Math.max(0, ...roots.map((r) => r.b.right))
  const height = Math.max(0, ...roots.map((r) => r.b.bottom))
  if (keyboard) {
    notes.push('Contrast was not checked: the on-screen keyboard is up and the screen dump does not say where it is (hide it, then study again).')
    return []
  }
  if (width > image.width || height > image.height) {
    notes.push(`Contrast was not checked: the screenshot is ${image.width}x${image.height} px but the screen dump reaches ${width}x${height} (the screen rotated or changed between them).`)
    return []
  }
  const texts = nodes.filter((n) => ours(n) && n.enabled && !n.password && n.text.trim() !== '' && visible(n.bounds))
  const findings: StudyFinding[] = []
  let covered = 0
  let unmeasured = 0
  const measured = texts.slice(0, MAX_CONTRAST_TEXTS)
  for (const n of measured) {
    const b = n.bounds as UiBounds
    if (behind.has(rootOf[n.i]) || roots.some((r) => !ours(r.n) && r.n.package !== '' && intersects(r.b, b))) {
      covered++
      continue
    }
    const m = measureTextContrast(image, b)
    if (!m.ok) {
      unmeasured++
      continue
    }
    const { ratio, text, background } = m.contrast
    if (ratio >= MIN_RATIO) continue
    const colours = `${colorHex(text)} on ${colorHex(background)}`
    findings.push({
      kind: 'low_contrast',
      severity: ratio < MIN_RATIO_LARGE ? 'error' : 'warning',
      element: n.i,
      summary:
        ratio < MIN_RATIO_LARGE
          ? `${describe(n, labels.get(n.i) ?? '')} has a contrast of ${formatRatio(ratio)} (${colours}), under the ${MIN_RATIO_LARGE}:1 minimum even for large text.`
          : `${describe(n, labels.get(n.i) ?? '')} has a contrast of ${formatRatio(ratio)} (${colours}), under the ${MIN_RATIO}:1 minimum for normal text (enough only for large text: 18 sp, or 14 sp bold; the dump does not give the text size).`,
      fix: `Darken the text or lighten its background (or the reverse) until they reach ${MIN_RATIO}:1.`
    })
  }
  if (covered > 0) notes.push(`Contrast was not measured for ${covered} text${covered === 1 ? '' : 's'} under another window (a dialog, a sheet or a system prompt).`)
  if (unmeasured > 0) {
    notes.push(
      `Contrast was not measured for ${unmeasured} text${unmeasured === 1 ? '' : 's'}: too small, on a busy background (an image or a gradient), or with no text pixels found (none drawn, or drawn in nearly the background's colour: check those by eye).`
    )
  }
  if (texts.length > measured.length) notes.push(`Contrast was measured for the first ${MAX_CONTRAST_TEXTS} of ${texts.length} texts only.`)
  return findings
}

export function studyScreen(screen: UiScreen, opts: StudyOptions = {}): ScreenStudy {
  const { nodes } = screen
  const pkg = opts.package ?? null
  const density = opts.densityDpi ?? null
  const inCollection = collectionMembership(nodes, collectionFlags(nodes))
  const counts = uniquenessIndex(nodes)
  const labels = new Map<number, string>()
  const elements: StudyElement[] = []
  for (const n of nodes) {
    const label = accessibleLabel(nodes, n)
    labels.set(n.i, label)
    const inventory = actionable(n) || n.focusable || n.scrollable || n.text.trim() !== '' || n.content_desc.trim() !== '' || n.hint.trim() !== ''
    if (!inventory) continue
    const locator = findBy(nodes, counts, n)
    elements.push({
      i: n.i,
      class: n.class,
      package: n.package,
      resource_id: n.resource_id,
      content_desc: n.content_desc,
      text: n.password ? '' : n.text,
      hint: n.hint,
      label,
      bounds: n.bounds,
      clickable: n.clickable,
      long_clickable: n.long_clickable,
      checkable: n.checkable,
      focusable: n.focusable,
      scrollable: n.scrollable,
      enabled: n.enabled,
      password: n.password,
      locator,
      locator_basis: basisOf(locator),
      in_collection: inCollection[n.i]
    })
  }

  const ours = (n: UiNode): boolean => pkg === null || n.package === pkg
  const controls = nodes.filter((n) => ours(n) && actionable(n) && n.enabled && visible(n.bounds))
  const findings: StudyFinding[] = []
  const notes: string[] = []
  const byI = new Map(elements.map((e) => [e.i, e]))

  for (const n of controls) {
    const label = labels.get(n.i) ?? ''
    if (!label) {
      findings.push({
        kind: 'missing_label',
        severity: 'error',
        element: n.i,
        summary: `${describe(n, '')} has no text, content description or hint, so a screen reader announces it as an unlabeled ${shortClass(n.class)}.`,
        fix: isTextField(n)
          ? 'Give the field a hint (android:hint) or a label view pointing at it (android:labelFor).'
          : 'Set android:contentDescription (Compose: Modifier.semantics { contentDescription = ... }) to what it does.'
      })
    }
  }

  if (density === null) {
    notes.push('Touch targets were not measured: the screen density is unknown (pass the `wm density` reading).')
  } else {
    const px = (MIN_TOUCH_DP * density) / 160
    for (const n of controls) {
      const b = n.bounds as UiBounds
      const w = b.right - b.left
      const h = b.bottom - b.top
      if (w >= px && h >= px) continue
      // A side cut by the edge of its list or window is the visible part, not the target's size.
      const clip = clipBox(nodes, n)
      const cutX = clip !== null && (b.left <= clip.left || b.right >= clip.right)
      const cutY = clip !== null && (b.top <= clip.top || b.bottom >= clip.bottom)
      if ((w >= px || cutX) && (h >= px || cutY)) continue
      const dp = (v: number): number => Math.round((v * 160) / density)
      findings.push({
        kind: 'small_touch_target',
        severity: 'warning',
        element: n.i,
        summary: `${describe(n, labels.get(n.i) ?? '')} is ${dp(w)}x${dp(h)} dp, under the ${MIN_TOUCH_DP}x${MIN_TOUCH_DP} dp minimum touch target.`,
        fix: `Make it at least ${MIN_TOUCH_DP}x${MIN_TOUCH_DP} dp (android:minWidth/minHeight or padding; Compose: Modifier.minimumInteractiveComponentSize()).`
      })
    }
  }

  const idGroups = new Map<string, UiNode[]>()
  for (const n of nodes) {
    // Android's own ids (android:id/content, android:id/text1 in stock rows) are not the app's to rename.
    if (!ours(n) || !n.resource_id || n.resource_id.startsWith('android:id/') || !visible(n.bounds)) continue
    const group = idGroups.get(n.resource_id)
    if (group) group.push(n)
    else idGroups.set(n.resource_id, [n])
  }
  for (const [id, group] of idGroups) {
    const outside = group.filter((n) => !inCollection[n.i])
    if (group.length < 2 || outside.length === 0) continue
    const rows = group.length - outside.length
    findings.push({
      kind: 'duplicate_resource_id',
      severity: 'warning',
      element: outside[0].i,
      summary:
        rows === 0
          ? `${group.length} views share the view id ${id}, so a test can't tell them apart by id.`
          : `${outside.length} view${outside.length === 1 ? '' : 's'} outside a list share${outside.length === 1 ? 's' : ''} the view id ${id} with ${rows} list row view${rows === 1 ? '' : 's'}, so a test can't tell them apart by id.`,
      fix: `Give each of them its own id (or, if they are rows of a list, render them through a RecyclerView/LazyColumn).`
    })
  }

  const appNodes = nodes.filter(ours)
  if (controls.length > 0 && !appNodes.some((n) => n.resource_id && !n.resource_id.startsWith('android:id/'))) {
    findings.push({
      kind: 'missing_resource_id',
      severity: 'info',
      element: null,
      summary: `No view on this screen has a view id, so tests can only find its ${controls.length} control${controls.length === 1 ? '' : 's'} by text, description or position.`,
      fix: 'Expose test ids: Compose Modifier.testTag + semantics { testTagsAsResourceId = true }, Flutter Semantics(identifier: ...), React Native testID, or android:id on views.'
    })
  } else {
    for (const n of controls) {
      // A row's or a button layout's child with a unique id serves as its id.
      if (n.resource_id || inCollection[n.i] || byI.get(n.i)?.locator_basis === 'resource_id') continue
      findings.push({
        kind: 'missing_resource_id',
        severity: 'info',
        element: n.i,
        summary: `${describe(n, labels.get(n.i) ?? '')} has no view id.`,
        fix: 'Give it an android:id (Compose: Modifier.testTag with testTagsAsResourceId) so tests find it whatever its text says.'
      })
    }
  }

  for (const n of controls) {
    const e = byI.get(n.i)
    // List rows are found by what they show ("tap Item 2"); that is how tests are meant to pick a row.
    if (!e || e.in_collection || (e.locator_basis !== 'text' && e.locator_basis !== 'index')) continue
    findings.push({
      kind: 'fragile_locator',
      severity: 'warning',
      element: n.i,
      summary:
        e.locator_basis === 'text'
          ? `${describe(n, e.label)} can only be found by its visible text, which changes with copy edits and translations.`
          : `${describe(n, e.label)} matches no unique id, description or text, so a test can only find it by position.`,
      fix: 'Give it a unique view id or test tag (or a unique content description) and find it by that.'
    })
  }

  if (opts.screenshot) {
    findings.push(...contrastFindings(nodes, opts.screenshot, opts.keyboardShown === true, ours, labels, notes))
  } else {
    notes.push(`Contrast was not checked: ${opts.noScreenshotReason?.replace(/\.$/, '') || 'there is no screenshot of the screen'}.`)
  }
  return {
    screen_id: screenId(screen, inCollection),
    package: frontPackage(nodes),
    rotation: screen.rotation,
    density_dpi: density,
    elements,
    findings,
    notes
  }
}
