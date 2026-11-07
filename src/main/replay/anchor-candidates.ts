import { rankCandidates, type SelectorDescriptor, type SelectorStrategy } from '../cdp/selectors'
import { toFlowSelector } from '../../shared/flow/from-recording'
import { SelectorSchema, type Selector } from '../../shared/flow/schema'

/**
 * Roadmap F6c: when a step matched only through its reference crop, the run
 * records the locators of the element the crop found, so a heal proposal can
 * put a real locator in front of the drifted ones. The page probe describes
 * the element the way the recorder does (each candidate with its uniqueness,
 * measured at that moment); this turns that into flow locators.
 *
 * Only candidates that matched exactly that one element are kept, ranked like
 * a recording (FR-STA.6), and at most MAX_ANCHOR_CANDIDATES. Left out: nth-child
 * paths, framework-generated ids and CSS on build-hashed class names (they
 * change on the next DOM change, render or build, which is how a step drifts
 * in the first place); page text holding `${` (a flow would read it as a
 * placeholder); and a candidate holding one of the run's secret values (dropped
 * rather than scrubbed: a scrubbed locator would not match).
 */

export const MAX_ANCHOR_CANDIDATES = 3

const STRATEGIES: ReadonlySet<string> = new Set<SelectorStrategy>(['testid', 'id', 'role-name', 'text', 'css', 'nth-child'])

/** rankCandidates penalties that mean the locator will not outlive this build or render. */
const isUnstable = (penalty: string): boolean => penalty === 'generated-id' || penalty.startsWith('hashed-class:')

function isDescriptor(value: unknown): value is SelectorDescriptor {
  const d = value as Partial<SelectorDescriptor> | null
  return (
    !!d &&
    typeof d === 'object' &&
    typeof d.strategy === 'string' &&
    STRATEGIES.has(d.strategy) &&
    typeof d.selector === 'string' &&
    typeof d.unique === 'boolean' &&
    (d.id === undefined || typeof d.id === 'string') &&
    (d.classNames === undefined || (Array.isArray(d.classNames) && d.classNames.every((c) => typeof c === 'string')))
  )
}

/**
 * Flow locators for the element a crop found, best first, from what the page
 * helper `candidates` answered (anything else, e.g. null, gives []).
 * `redact` is the run's secret scrubber: a candidate it would change is dropped.
 */
export function anchorCandidates(raw: unknown, redact: (text: string) => string = (t) => t): Selector[] {
  if (!Array.isArray(raw)) return []
  const ranked = rankCandidates(raw.filter(isDescriptor))
  const out: Selector[] = []
  const seen = new Set<string>()
  for (const c of ranked) {
    if (out.length >= MAX_ANCHOR_CANDIDATES) break
    if (!c.unique || c.strategy === 'nth-child' || c.penalties.some(isUnstable)) continue
    const selector = toFlowSelector(c.strategy, c.selector)
    if (!selector || !SelectorSchema.safeParse(selector).success) continue
    const key = JSON.stringify(selector)
    const values = Object.values(selector).filter((v): v is string => typeof v === 'string')
    if (seen.has(key) || values.some((v) => v.includes('${') || redact(v) !== v)) continue
    seen.add(key)
    out.push(selector)
  }
  return out
}
