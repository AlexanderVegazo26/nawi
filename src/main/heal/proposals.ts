import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isSeq, stringify, type Document, type YAMLMap, type YAMLSeq } from 'yaml'
import { formatFlowDocument, parseFlow } from '../../shared/flow/yaml'
import { locatorLayer, SelectorSchema, type Flow, type LocatorLayer, type Selector } from '../../shared/flow/schema'
import { resolveFlowFile } from '../flow-run'
import { missReason, type RecordedStep, type RunRecord } from '../run-record'
import { unifiedDiff } from './diff'

/**
 * Roadmap F6, first slice: healing proposals from a saved run. When a step
 * passed only because a lower locator layer matched (an earlier, more stable
 * locator found nothing or was broken: `matched.fallback`), the flow is
 * drifting from the app. The proposal is a reviewable YAML patch for that
 * step: the locator that matched moves to the front and the ones that found
 * nothing are dropped. Nothing is written: this only reads the run record and
 * the flow file, and never rewrites a flow (the "no silent rewriting" rule).
 *
 * The patch edits the flow file's own YAML nodes by position (comments and
 * `${vars.x}` placeholders stay as written), and only when the file is still
 * the one the run replayed (same sha256): positions in an edited file could
 * point at other locators.
 *
 * Roadmap F6c: a step that matched only through its reference crop has no
 * locator of its own to move up, but the run recorded the found element's own
 * locators (`matched.candidates`, each unique on the page when it was found).
 * The proposal puts those in front (`added`) and drops the locators that found
 * nothing; apply_heal's replay then proves they hold. Steps it cannot heal
 * from the record alone are listed with the reason: a crop-only match without
 * candidates (an older run, or the element had no unique locator) and steps
 * where nothing matched; a later slice proposes candidates for those.
 */

export type FlowStatus = 'current' | 'changed' | 'missing' | 'invalid'

export interface DroppedLocator {
  selector: Selector
  /** What it found in the run, worded as in run-info and the report: `no match` or `invalid: <why>`. */
  reason: string
}

export interface HealProposal {
  step_id: string
  action: RecordedStep['action']
  intent?: string
  /**
   * The layer the run matched through: a locator layer the proposal moves to
   * the front, or `visual` (the reference crop), whose element's own locators
   * the proposal adds in front (`added`).
   */
  layer: LocatorLayer | 'visual'
  /** The step's locators as the flow file has them now, and as the proposal has them. */
  selectors_before: Selector[]
  selectors_after: Selector[]
  dropped: DroppedLocator[]
  /**
   * Locators that are not in the flow yet (visual matches only): the found
   * element's own, measured unique by the run. Not proven to find it again
   * until a replay does (apply_heal replays before it writes).
   */
  added: Selector[]
  /** Why this is believed: what the run saw, from its record. */
  evidence: {
    matched: NonNullable<RecordedStep['matched']>
    misses: NonNullable<RecordedStep['misses']>
    url?: string
    /** Before/after screenshots of the step, relative to the run folder. */
    shots?: RecordedStep['shots']
  }
  /** The patch for this step alone, against the flow file. */
  diff: string
}

export interface Unhealed {
  step_id: string
  status: RecordedStep['status']
  reason: string
}

export interface HealReport {
  run_id: string
  flow: { name: string; file: string }
  /**
   * `current`: the file is the one the run replayed, proposals are against it.
   * `changed`: it was edited since (sha256 differs): run the flow again first.
   * `missing`: it is gone or can no longer be read. `invalid`: it no longer parses.
   */
  flow_status: FlowStatus
  proposals: HealProposal[]
  unhealed: Unhealed[]
  /** Every proposal applied together, against the flow file; '' when there is none. */
  diff: string
  note?: string
}


/** The `target.selectors` sequence of the step with this id, or null when the document has no such step. */
function selectorsNode(doc: Document, stepId: string): YAMLSeq | null {
  const steps = doc.get('steps')
  if (!isSeq(steps)) return null
  for (const item of steps.items) {
    if (!isMap(item)) continue
    const id = (item as YAMLMap).get('id')
    if (id !== stepId) continue
    const target = (item as YAMLMap).get('target')
    if (!isMap(target)) return null
    const selectors = (target as YAMLMap).get('selectors')
    return isSeq(selectors) ? (selectors as YAMLSeq) : null
  }
  return null
}

/** A locator with a `${...}` placeholder: whether it finds anything depends on the vars and env of the run. */
const hasPlaceholder = (selector: Selector): boolean => Object.values(selector).some((v) => typeof v === 'string' && v.includes('${'))

/**
 * A step's new locator list: an index keeps the flow's locator at that
 * position, a selector is a new one (F6c's `added`).
 */
type Order = Array<number | Selector>

/**
 * The new order of a step's locators: the matched one first (for a visual
 * match, the found element's own locators: `candidates`, reusing a flow
 * locator that is the same one); those that found nothing (or broke) before
 * it gone, except ones with a placeholder, which one run's values cannot
 * condemn: they stay, after the match. Null when the run gives no reason to
 * change the list.
 */
function healedOrder(step: RecordedStep, selectors: Selector[]): { order: Order; dropped: number[]; added: Selector[] } | null {
  const matched = step.matched
  if (!matched) return null
  const visual = matched.layer === 'visual' && matched.index === selectors.length
  if (!visual && matched.index >= selectors.length) return null
  const missed = (step.misses ?? []).filter((m) => m.index < matched.index && (m.found === 0 || m.invalid !== undefined)).map((m) => m.index)
  if (!visual) {
    if (missed.length === 0) return null
    const dropped = missed.filter((i) => !hasPlaceholder(selectors[i]))
    const order = [matched.index, ...selectors.map((_, i) => i).filter((i) => i !== matched.index && !dropped.includes(i))]
    return { order, dropped, added: [] }
  }
  // A layer the flow fills from a placeholder is the run's value of it, not a locator for every run: leave it out.
  const templated = new Set(selectors.filter(hasPlaceholder).map(locatorLayer))
  const candidates = (matched.candidates ?? []).filter((c) => SelectorSchema.safeParse(c).success && !templated.has(locatorLayer(c)) && !hasPlaceholder(c))
  if (candidates.length === 0) return null
  const front = candidates.map((c) => {
    const at = selectors.findIndex((s) => isDeepStrictEqual(s, c))
    return at === -1 ? c : at
  })
  const kept = front.filter((f): f is number => typeof f === 'number')
  const dropped = missed.filter((i) => !hasPlaceholder(selectors[i]) && !kept.includes(i))
  const order: Order = [...front, ...selectors.map((_, i) => i).filter((i) => !kept.includes(i) && !dropped.includes(i))]
  return { order, dropped, added: front.filter((f): f is Selector => typeof f !== 'number') }
}

/** The locator list `order` describes. */
const orderedSelectors = (selectors: Selector[], order: Order): Selector[] => order.map((o) => (typeof o === 'number' ? selectors[o] : o))

/** A new locator as one line of YAML, in the inline style flows use (`{ css: "#save" }`). */
const selectorYaml = (selector: Selector): string => stringify(selector, { collectionStyle: 'flow', lineWidth: 0 }).trim()

function applyOrder(doc: Document, seq: YAMLSeq, order: Order): void {
  seq.items = order.map((o) => (typeof o === 'number' ? seq.items[o] : doc.createNode(o, { flow: true })))
}

interface TextEdit {
  start: number
  end: number
  text: string
}

/**
 * The edit that reorders a locator list in the file's own text, touching
 * nothing else: an inline list (`[a, b]`) is rewritten from its items' source
 * text; a block list moves whole item lines (with their trailing comments).
 * Null when the layout is not one of those (comment lines between items, two
 * items on a line...): the caller then writes the document out instead.
 */
function reorderEdit(text: string, seq: YAMLSeq, order: Order): TextEdit | null {
  const ranges = seq.items.map((item) => (item as { range?: [number, number, number] | null }).range)
  if (!seq.range || ranges.some((r) => !r)) return null
  const items = ranges as Array<[number, number, number]>
  if (seq.flow) {
    if (text[seq.range[0]] !== '[') return null
    const end = text.lastIndexOf(']', seq.range[1])
    if (end < seq.range[0]) return null
    const between = text.slice(seq.range[0] + 1, end)
    if (between.includes('#') && /(^|\s)#/.test(between.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, ''))) return null
    const itemText = (o: number | Selector): string => (typeof o === 'number' ? text.slice(items[o][0], items[o][1]) : selectorYaml(o))
    return { start: seq.range[0], end: end + 1, text: `[${order.map(itemText).join(', ')}]` }
  }
  const lineStart = (at: number): number => text.lastIndexOf('\n', at - 1) + 1
  const lineEnd = (at: number): number => {
    const nl = text.indexOf('\n', at)
    return nl === -1 ? text.length : nl + 1
  }
  const spans = items.map(([start, valueEnd]) => [lineStart(start), lineEnd(Math.max(start, valueEnd - 1))] as const)
  for (let i = 0; i < spans.length; i++) {
    // Each item starts its own line with its "- " indicator, and the next item starts on the very next line.
    if (!/^[ \t]*-[ \t]+$/.test(text.slice(spans[i][0], items[i][0]))) return null
    if (i > 0 && spans[i][0] !== spans[i - 1][1]) return null
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const pieces = spans.map(([a, b]) => (text.slice(a, b).endsWith('\n') ? text.slice(a, b) : `${text.slice(a, b)}${eol}`))
  // A new item takes the first item's "- " prefix (its indent).
  const prefix = text.slice(spans[0][0], items[0][0])
  const joined = order.map((o) => (typeof o === 'number' ? pieces[o] : `${prefix}${selectorYaml(o)}${eol}`)).join('')
  const last = spans[spans.length - 1][1]
  return { start: spans[0][0], end: last, text: text.slice(0, last).endsWith('\n') ? joined : joined.slice(0, -eol.length) }
}

function applyEdits(text: string, edits: TextEdit[]): string {
  let out = text
  for (const e of [...edits].sort((x, y) => y.start - x.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

/** Does `text` parse as a flow whose steps have exactly these locator lists (and are otherwise the same flow)? */
function hasSelectors(text: string, original: Flow, wanted: Map<string, Selector[]>): boolean {
  const parsed = parseFlow(text)
  if (!parsed.ok) return false
  const expected = {
    ...original,
    steps: original.steps.map((s) => (wanted.has(s.id) && 'target' in s && s.target ? { ...s, target: { ...s.target, selectors: wanted.get(s.id)! } } : s))
  }
  return isDeepStrictEqual(parsed.flow, expected)
}

/**
 * The flow text with these steps' locators reordered: spliced into the file's
 * own text when its layout allows (only those lines change), else the whole
 * document written out again (a correct patch, with some layout noise). Either
 * way the result must parse to the same flow with only those lists changed;
 * null when it does not (a list shared with another step through a YAML alias).
 */
function patchedText(text: string, doc: Document, flow: Flow, changes: Change[]): string | null {
  const wanted = new Map(
    changes.map(({ stepId, order }) => {
      const step = flow.steps.find((s) => s.id === stepId)!
      const selectors = ('target' in step && step.target ? step.target.selectors : []) as Selector[]
      return [stepId, orderedSelectors(selectors, order)] as const
    })
  )
  const edits = changes.map(({ stepId, order }) => reorderEdit(text, selectorsNode(doc, stepId)!, order))
  if (edits.every((e): e is TextEdit => e !== null)) {
    const spliced = applyEdits(text, edits)
    if (hasSelectors(spliced, flow, wanted)) return spliced
  }
  const copy = doc.clone()
  for (const { stepId, order } of changes) applyOrder(copy, selectorsNode(copy, stepId)!, order)
  const written = formatFlowDocument(copy)
  return hasSelectors(written, flow, wanted) ? written : null
}

/**
 * The proposals for one run, given the flow file's text as it is now (null
 * when it could not be read). Pure: the caller reads the record and the file.
 */
export function healProposals(record: RunRecord, flowFile: Buffer | string | null, displayName: string = basename(record.flow.file)): HealReport {
  return analyse(record, flowFile, displayName).report
}

/**
 * The flow text with the proposals for these steps applied (all of them when
 * `stepIds` is undefined), for apply_heal. `text` is null when the report has
 * no proposal for one of the steps (see `missing`) or none at all; `diff` is
 * the patch for exactly those steps.
 */
export function healedFlow(
  record: RunRecord,
  flowFile: Buffer | string | null,
  stepIds?: string[],
  displayName: string = basename(record.flow.file)
): { report: HealReport; step_ids: string[]; missing: string[]; text: string | null; diff: string } {
  const { report, patch } = analyse(record, flowFile, displayName)
  const known = report.proposals.map((p) => p.step_id)
  const wanted = stepIds ?? known
  const missing = wanted.filter((id) => !known.includes(id))
  if (!patch || wanted.length === 0 || missing.length > 0) return { report, step_ids: wanted, missing, text: null, diff: '' }
  const text = patch(wanted)
  return { report, step_ids: wanted, missing, text, diff: text === null ? '' : unifiedDiff(patch.original, text, displayName) }
}

type Patch = ((stepIds: string[]) => string | null) & { original: string }

interface Change {
  stepId: string
  order: Order
}

function analyse(record: RunRecord, flowFile: Buffer | string | null, displayName: string): { report: HealReport; patch?: Patch } {
  const base = { run_id: record.run_id, flow: { name: record.flow.name, file: record.flow.file } }
  const candidates = record.steps.filter((s) => s.status === 'passed' && s.matched?.fallback === true)
  const unhealed: Unhealed[] = []
  for (const step of record.steps) {
    if (step.status === 'failed' && !step.matched && (step.misses?.length ?? 0) > 0) {
      unhealed.push({ step_id: step.id, status: step.status, reason: 'no locator and no reference crop matched; nothing to propose from this run' })
    }
  }
  const empty = (flow_status: FlowStatus, note?: string): { report: HealReport } => ({
    report: {
      ...base,
      flow_status,
      proposals: [],
      unhealed,
      diff: '',
      ...(note !== undefined ? { note } : {})
    }
  })

  if (flowFile === null) return empty('missing', 'The flow file is gone or can no longer be read, so there is nothing to patch.')
  // The bytes, as run_flow hashed them: text that does not survive a UTF-8 round trip must not look edited.
  const sha = createHash('sha256').update(flowFile).digest('hex')
  const flowText = typeof flowFile === 'string' ? flowFile : flowFile.toString('utf8')
  if (sha !== record.flow.sha256) {
    if (record.heal_of !== undefined) {
      return empty(
        'changed',
        `Run ${record.run_id} was apply_heal's replay of the proposals of run ${record.heal_of}: it ran proposed flow text that is not in the file (the heal was not applied, or the file changed since). Ask for proposals from run ${record.heal_of}, or run the flow again.`
      )
    }
    return empty('changed', 'The flow file changed since this run, so its locators may no longer be where the run saw them. Run the flow again and ask for proposals from that run.')
  }
  const parsed = parseFlow(flowText)
  if (!parsed.ok) return empty('invalid', 'The flow file no longer parses as a flow.')

  const proposals: HealProposal[] = []
  const changes: Change[] = []
  for (const step of candidates) {
    const flowStep = parsed.flow.steps.find((s) => s.id === step.id)
    const before = flowStep && 'target' in flowStep ? flowStep.target?.selectors : undefined
    const node = selectorsNode(parsed.document, step.id)
    if (!before || !node || node.items.length !== before.length) {
      unhealed.push({ step_id: step.id, status: step.status, reason: 'the flow file has no locator list for this step' })
      continue
    }
    const healed = healedOrder(step, before)
    if (!healed) {
      const reason =
        step.matched?.layer === 'visual'
          ? 'only its reference crop matched, and the run recorded no locator that found that element alone (a run from before Nawi recorded them, or the element has none), so there is no locator to propose yet'
          : 'the run marked it as a fallback but recorded no locator that found nothing before the match'
      unhealed.push({ step_id: step.id, status: step.status, reason })
      continue
    }
    const change = { stepId: step.id, order: healed.order }
    const single = patchedText(flowText, parsed.document, parsed.flow, [change])
    if (single === null) {
      const reason =
        healed.added.length > 0
          ? 'the flow with its new locators did not read back as the same flow with only this list changed (the list is shared with another step through a YAML alias, or a new locator does not survive YAML)'
          : 'its locator list is shared with another step (a YAML alias), so it cannot be changed for this step alone'
      unhealed.push({ step_id: step.id, status: step.status, reason })
      continue
    }
    changes.push(change)
    const matched = step.matched!
    proposals.push({
      step_id: step.id,
      action: step.action,
      ...(step.intent !== undefined ? { intent: step.intent } : {}),
      layer: matched.layer === 'visual' ? 'visual' : locatorLayer(before[matched.index]),
      selectors_before: before,
      selectors_after: orderedSelectors(before, healed.order),
      dropped: healed.dropped.map((i) => ({
        selector: before[i],
        reason: missReason((step.misses ?? []).find((m) => m.index === i)!)
      })),
      added: healed.added,
      evidence: {
        matched,
        misses: step.misses ?? [],
        ...(step.url !== undefined ? { url: step.url } : {}),
        ...(step.shots !== undefined ? { shots: step.shots } : {})
      },
      diff: unifiedDiff(flowText, single, displayName)
    })
  }
  // Steps in run order, so the report reads like the flow.
  const order = new Map(record.steps.map((s, i) => [s.id, i]))
  unhealed.sort((x, y) => (order.get(x.step_id) ?? 0) - (order.get(y.step_id) ?? 0))
  const patch: Patch = Object.assign(
    (stepIds: string[]): string | null => {
      const chosen = changes.filter((c) => stepIds.includes(c.stepId))
      return chosen.length > 0 ? patchedText(flowText, parsed.document, parsed.flow, chosen) : null
    },
    { original: flowText }
  )
  return {
    report: {
      ...base,
      flow_status: 'current',
      proposals,
      unhealed,
      diff: changes.length > 0 ? unifiedDiff(flowText, patch(changes.map((c) => c.stepId)) ?? flowText, displayName) : ''
    },
    patch
  }
}

/** Reads the flow file a run replayed (the same checks run_flow makes), or null when it cannot be read any more. */
export async function readRunFlow(record: RunRecord, roots: string[] = [homedir()]): Promise<Buffer | null> {
  try {
    const real = await resolveFlowFile(record.flow.file, roots)
    return await fs.readFile(real)
  } catch {
    return null
  }
}
