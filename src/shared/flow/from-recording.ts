import { z } from 'zod'
import { FLOW_VERSION, FlowSchema, RESERVED_KEYS, type Flow, type FlowStep, type FlowTarget, type Selector } from './schema'

/**
 * Recording → flow (roadmap F2).
 *
 * Turns the input events a browser recording harvested (`input_events.ndjson`:
 * clicks, field values, non-character keys, scrolls) into a version 1 flow that
 * a person or an agent can read, edit and later replay.
 *
 * What it does with each event:
 *  - `click` → a `click` step, unless the next thing the user did was type into
 *    the same field (a fill focuses the field itself, so that click is noise).
 *  - `input` → a `fill` step (a `select` step for a `<select>`); consecutive
 *    inputs on one field collapse into one step holding the final value.
 *    A field the probe marked secret (FR-SEC.2) never has a value here: it
 *    becomes `${secret.<name>}`, resolved at run time, never stored.
 *  - `keydown` → a `press` step, except modifiers and editing keys inside a
 *    text field (the fill already holds their result).
 *  - Dropped as noise, and counted: scrolls and resizes (a replayer scrolls a
 *    target into view itself), inputs on checkboxes/radios (the click is the
 *    action), events without a usable locator, and malformed lines.
 *
 * The start URL is scrubbed of credentials (`user:pass@`, token/code/key/
 * session/signature parameters in the query or fragment): see scrubStartUrl.
 *
 * The input is untrusted: the NDJSON file is written from page-side events and
 * can be hand-edited, so every line is validated here and a bad one is skipped,
 * never thrown on. The output always passes `FlowSchema` (checked before
 * returning), so it can go straight to `stringifyFlow`.
 *
 * Node-free, like the rest of `src/shared/flow`.
 */

export const SKIP_REASONS = [
  'malformed',
  'no_target',
  'scroll',
  'resize',
  'toggle_input',
  'focus_click',
  'modifier_key',
  'editing_key',
  'placeholder_text',
  'unfillable_input',
  'unsupported'
] as const

export type SkipReason = (typeof SKIP_REASONS)[number]

/* ------------------------------------------------------------------ *
 * Start URL scrubbing
 * ------------------------------------------------------------------ */

/**
 * Parameter names (lowercased, punctuation removed) that carry a credential:
 * reset/magic-link tokens, OAuth codes and implicit-grant tokens, API keys,
 * session ids, presigned-URL signatures.
 */
const CREDENTIAL_PARAMS = new Set([
  'token', 'code', 'auth', 'authorization', 'key', 'apikey', 'secret', 'password', 'passwd', 'pwd', 'pass',
  'session', 'sessionid', 'sid', 'sig', 'signature', 'jwt', 'otp', 'ticket', 'credential', 'credentials',
  'samlresponse'
])
const CREDENTIAL_SUFFIX = /(token|secret|password|passwd|signature|apikey|sessionid|credentials?|jwt|otp)$/

function paramName(piece: string): string {
  const raw = piece.split('=', 1)[0].replace(/\+/g, ' ')
  let name = raw
  try {
    name = decodeURIComponent(raw)
  } catch {
    // A malformed %-escape: judge the raw text.
  }
  return name
}

function isCredentialParam(name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return CREDENTIAL_PARAMS.has(key) || CREDENTIAL_SUFFIX.test(key)
}

/** Drops credential params from an `a=1&b=2` string; returns the rest, untouched otherwise. */
function scrubParams(params: string, removed: string[]): string {
  return params
    .split('&')
    .filter((piece) => {
      const name = paramName(piece)
      if (!isCredentialParam(name)) return true
      if (!removed.includes(name)) removed.push(name)
      return false
    })
    .join('&')
}

/**
 * The recording's URL may hold credentials: `user:pass@` in the authority, a
 * reset or magic-link token in the query, an OAuth implicit-grant token in the
 * fragment (`#access_token=...`, also `#/route?token=...`). A flow file is
 * meant to be shared, so those are removed. Everything else is kept byte for
 * byte (no URL re-serialization), and a URL with nothing to remove comes back
 * unchanged. Returns the removed parameter names (never their values).
 */
export function scrubStartUrl(url: string): { url: string; userinfo: boolean; removed: string[] } {
  const removed: string[] = []
  let rest = url
  let userinfo = false
  const authority = /^([a-z][a-z\d+.-]*:\/\/)[^/?#]*@/i.exec(rest)
  if (authority) {
    rest = authority[1] + rest.slice(authority[0].length)
    userinfo = true
  }

  const hashAt = rest.indexOf('#')
  let base = hashAt === -1 ? rest : rest.slice(0, hashAt)
  let fragment = hashAt === -1 ? null : rest.slice(hashAt + 1)

  const queryAt = base.indexOf('?')
  if (queryAt !== -1) {
    const query = scrubParams(base.slice(queryAt + 1), removed)
    base = base.slice(0, queryAt) + (query ? `?${query}` : '')
  }

  if (fragment !== null) {
    const fragQueryAt = fragment.indexOf('?')
    if (fragQueryAt !== -1) {
      // A hash route with its own query: `#/reset?token=...`.
      const query = scrubParams(fragment.slice(fragQueryAt + 1), removed)
      fragment = fragment.slice(0, fragQueryAt) + (query ? `?${query}` : '')
    } else if (/^[^/]*=/.test(fragment)) {
      // A fragment that is itself a parameter list: `#access_token=...&token_type=bearer`.
      fragment = scrubParams(fragment, removed)
    }
  }

  if (removed.length === 0 && !userinfo) return { url, userinfo, removed }
  const out = base + (fragment ? `#${fragment}` : '')
  // A bare `?token=...` would scrub to nothing, and a flow needs a start URL.
  return { url: /\S/.test(out) ? out : 'about:blank', userinfo, removed }
}

export interface FlowFromRecordingOptions {
  name: string
  target: FlowTarget
  description?: string
}

export interface FlowFromRecordingResult {
  flow: Flow
  /** Events that produced no step, by reason. Reasons with no events are absent. */
  skipped: Partial<Record<SkipReason, number>>
  /** Input events folded into an earlier fill/select on the same field. */
  merged: number
  /** Things a person should look at before replaying the flow. */
  warnings: string[]
}

/* ------------------------------------------------------------------ *
 * Input validation (lenient: unknown keys are fine, wrong types are not)
 * ------------------------------------------------------------------ */

const CandidateIn = z.object({ strategy: z.string(), value: z.string() })

const TargetIn = z.object({
  role: z.string().nullish(),
  accessible_name: z.string().nullish(),
  text: z.string().nullish(),
  bounds: z.array(z.number()).nullish(),
  selectors: z.array(z.unknown()).nullish(),
  input_type: z.string().nullish()
})

const EventIn = z.object({
  t_ms: z.number().finite(),
  type: z.string(),
  target: TargetIn.nullish(),
  value_redacted: z.boolean().optional(),
  key: z.string().optional()
})

type RecordedEvent = z.infer<typeof EventIn>
type RecordedTarget = z.infer<typeof TargetIn>

/* ------------------------------------------------------------------ *
 * Selectors: the harvest's ranked candidates → flow selectors
 * ------------------------------------------------------------------ */

// The probe escapes only `"` (as `\"`), never a backslash, so the quoted part
// is everything up to the closing `"]`: a value ending in `\` stays parseable.
const TESTID_RE = /^\[data-testid="(.*)"\]$/s
const PLAIN_ID_RE = /^#([A-Za-z_][A-Za-z0-9_-]*)$/
const ROLE_NAME_RE = /^role=([^[\]"]+)\[name="(.*)"\]$/s

const unescapeQuotes = (s: string): string => s.replace(/\\"/g, '"')

/**
 * One harvest candidate as a flow selector, or null when it can't be one.
 * Exported for tests. Candidate values are what the page probe writes:
 * `[data-testid="x"]`, `#x` (CSS-escaped), `role=button[name="Save"]`, and
 * CSS paths for `css`/`nth_child`.
 */
export function toFlowSelector(strategy: string, value: string): Selector | null {
  if (!/\S/.test(value)) return null
  switch (strategy) {
    case 'testid': {
      const m = TESTID_RE.exec(value)
      // Other test-id attributes (data-qa, data-test...) stay as the CSS the probe wrote.
      return m && /\S/.test(m[1]) ? { testid: unescapeQuotes(m[1]) } : { css: value }
    }
    case 'id': {
      const m = PLAIN_ID_RE.exec(value)
      return m ? { id: m[1] } : { css: value }
    }
    case 'role_name':
    case 'role-name': {
      const m = ROLE_NAME_RE.exec(value)
      if (!m || !/\S/.test(m[1])) return null
      return { role: m[1].trim(), name: unescapeQuotes(m[2]) }
    }
    case 'css':
    case 'nth_child':
      return { css: value }
    default:
      return null
  }
}

function flowSelectors(target: RecordedTarget | null | undefined): Selector[] {
  const out: Selector[] = []
  const seen = new Set<string>()
  for (const raw of target?.selectors ?? []) {
    const c = CandidateIn.safeParse(raw)
    if (!c.success) continue
    const sel = toFlowSelector(c.data.strategy, c.data.value)
    if (!sel) continue
    const key = JSON.stringify(sel)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(sel)
  }
  return out
}

/** The element's tag, read off the last segment of a CSS path candidate. */
function tagOf(target: RecordedTarget | null | undefined): string | null {
  for (const raw of target?.selectors ?? []) {
    const c = CandidateIn.safeParse(raw)
    if (!c.success || (c.data.strategy !== 'nth_child' && c.data.strategy !== 'css')) continue
    const last = c.data.value.split('>').pop()?.trim() ?? ''
    const m = /^([a-z][a-z0-9-]*)/i.exec(last)
    if (m) return m[1].toLowerCase()
  }
  return null
}

function bboxOf(target: RecordedTarget | null | undefined): [number, number, number, number] | undefined {
  const b = target?.bounds
  if (!b || b.length !== 4 || !b.every(Number.isFinite) || b[2] < 0 || b[3] < 0) return undefined
  return [b[0], b[1], b[2], b[3]]
}

/* ------------------------------------------------------------------ *
 * Keys and roles
 * ------------------------------------------------------------------ */

const TEXT_ENTRY_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])
const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'])
const TOGGLE_INPUT_TYPES = new Set(['checkbox', 'radio'])
/**
 * `<input>` types a fill can't replay (the replayer's isEditable refuses them):
 * the probe calls them all "textbox", so only the recorded input type tells.
 * Date and time pickers are not here: the replayer sets those directly.
 */
const UNFILLABLE_INPUT_TYPES: Record<string, string> = {
  file: 'file picker',
  range: 'slider',
  color: 'color picker',
  hidden: 'hidden field',
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button'
}
const MODIFIER_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Fn', 'FnLock', 'Hyper', 'Super',
  'CapsLock', 'NumLock', 'ScrollLock', 'Symbol', 'SymbolLock',
  // IME composition, not a key the user meant to press.
  'Process', 'Dead', 'Unidentified', 'Compose'
])
const EDITING_KEYS = new Set([
  'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Insert'
])
/** Named keys only (`Enter`, `F5`, `ArrowDown`): the listener never sends single characters, so one here is forged. */
const KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,31}$/

/* ------------------------------------------------------------------ *
 * Secret placeholder names
 * ------------------------------------------------------------------ */

function slug(text: string): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/, '')
  if (!s) return ''
  return /^[0-9]/.test(s) ? `field_${s}` : s
}

/** A readable base name for a secret field, from its most stable locator. */
function secretBase(selectors: Selector[]): string {
  for (const sel of selectors) {
    const text = 'testid' in sel ? sel.testid : 'id' in sel ? sel.id : 'role' in sel ? sel.name ?? '' : ''
    const s = slug(text)
    if (s) return RESERVED_KEYS.has(s) ? `${s}_value` : s
  }
  return 'secret'
}

/* ------------------------------------------------------------------ *
 * Conversion
 * ------------------------------------------------------------------ */

/** A step before ids are assigned (`Omit` distributed over the union). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type DraftStep = DistributiveOmit<FlowStep, 'id'>

interface Pending {
  step: DraftStep
  /** Identity of the element, for coalescing; null when the step has no target. */
  targetKey: string | null
  /** fill/select only: the value is our `${secret.*}` placeholder, not typed text. */
  secret?: boolean
  /** fill/select only: how the field is described in its note. */
  label?: string
}

function describe(target: RecordedTarget | null | undefined): string {
  const name = target?.accessible_name?.trim()
  if (name) return `"${name.length > 80 ? `${name.slice(0, 77)}...` : name}"`
  const role = target?.role?.trim()
  return role ? `the ${role}` : 'the element'
}

export function flowFromRecording(
  events: readonly unknown[],
  options: FlowFromRecordingOptions
): FlowFromRecordingResult {
  const skipped: Partial<Record<SkipReason, number>> = {}
  const skip = (reason: SkipReason): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }
  const warnings: string[] = []
  let merged = 0
  let valueless = 0

  const valid: RecordedEvent[] = []
  for (const raw of events) {
    const parsed = EventIn.safeParse(raw)
    if (parsed.success) valid.push(parsed.data)
    else skip('malformed')
  }
  // Stable: events with equal timestamps keep their file order.
  valid.sort((a, b) => a.t_ms - b.t_ms)

  const steps: Pending[] = []
  const secretNames = new Map<string, string>()
  const usedSecretNames = new Set<string>()

  const secretFor = (targetKey: string, selectors: Selector[]): string => {
    const known = secretNames.get(targetKey)
    if (known) return known
    const base = secretBase(selectors)
    let name = base
    for (let n = 2; usedSecretNames.has(name); n++) name = `${base}_${n}`
    usedSecretNames.add(name)
    secretNames.set(targetKey, name)
    return name
  }

  /** Fields left out because replay can't fill them, by description, in recording order. */
  const unfillable = new Map<string, string>()

  for (const event of valid) {
    const target = event.target ?? null
    const selectors = flowSelectors(target)
    const targetKey = selectors.length > 0 ? JSON.stringify(selectors) : null
    const stepTarget = (): NonNullable<Extract<FlowStep, { action: 'click' }>['target']> => {
      const bbox = bboxOf(target)
      return bbox ? { selectors, bbox } : { selectors }
    }
    const role = target?.role?.trim().toLowerCase() ?? ''

    switch (event.type) {
      case 'click': {
        if (!targetKey) {
          skip('no_target')
          break
        }
        steps.push({ step: { action: 'click', target: stepTarget(), note: `Click ${describe(target)}` }, targetKey })
        break
      }

      case 'input': {
        if (!targetKey) {
          skip('no_target')
          break
        }
        const inputType = target?.input_type?.trim().toLowerCase() ?? ''
        if (TOGGLE_ROLES.has(role) || TOGGLE_INPUT_TYPES.has(inputType)) {
          skip('toggle_input')
          break
        }
        if (Object.hasOwn(UNFILLABLE_INPUT_TYPES, inputType)) {
          // e.g. a file picker's value is "C:\fakepath\cv.pdf": replayed as a
          // fill it would fail, and it names the user's file. Left out, not kept.
          const kind = UNFILLABLE_INPUT_TYPES[inputType]
          const name = target?.accessible_name?.trim()
          unfillable.set(targetKey, name ? `the ${kind} ${describe(target)}` : `a ${kind}`)
          skip('unfillable_input')
          break
        }
        const redacted = event.value_redacted === true
        if (!redacted && typeof target?.text !== 'string') {
          // No value and not secret: the probe reads `value` only from form
          // fields, so this is e.g. a rich-text editor. An empty fill would clear
          // the field on replay, so the event is left out and counted instead.
          valueless++
          skip('unsupported')
          break
        }
        // A redacted event never carries a value; if one claims to, it is ignored.
        // Typed text is kept as is here, even with "${" in it: the recorder sends
        // one event per keystroke, so only the field's final value (checked after
        // the loop) says whether the fill can be written.
        const value = redacted ? `\${secret.${secretFor(targetKey, selectors)}}` : target?.text ?? ''
        const action = tagOf(target) === 'select' ? 'select' : 'fill'
        const verb = action === 'select' ? 'Choose an option in' : 'Fill'
        const label = `${verb} ${describe(target)}`
        // A click that only focused this field is noise, even when it came back
        // to a field already being filled (moving the caret): drop it first, so
        // the input still merges into that field's fill.
        if (steps.at(-1)?.targetKey === targetKey && steps.at(-1)?.step.action === 'click') {
          steps.pop()
          skip('focus_click')
        }
        const last = steps.at(-1)
        if (last && last.targetKey === targetKey && last.step.action === action) {
          const prev = last.step as Extract<DraftStep, { action: 'fill' | 'select' }>
          // Once a field has been secret it stays secret, and its note says so.
          if (redacted && !last.secret) {
            last.secret = true
            prev.note = `${last.label ?? label} (secret, supplied at run time)`
          }
          if (redacted || !last.secret) prev.value = value
          merged++
          break
        }
        steps.push({
          step: {
            action,
            target: stepTarget(),
            value,
            note: redacted ? `${label} (secret, supplied at run time)` : label
          } as DraftStep,
          targetKey,
          secret: redacted,
          label
        })
        break
      }

      case 'keydown': {
        const key = event.key
        if (key === undefined || !KEY_RE.test(key)) {
          skip('malformed')
          break
        }
        if (MODIFIER_KEYS.has(key)) {
          skip('modifier_key')
          break
        }
        if (EDITING_KEYS.has(key) && (TEXT_ENTRY_ROLES.has(role) || tagOf(target) === 'select')) {
          skip('editing_key')
          break
        }
        steps.push({
          step: targetKey
            ? { action: 'press', target: stepTarget(), key, note: `Press ${key} in ${describe(target)}` }
            : { action: 'press', key, note: `Press ${key}` },
          targetKey
        })
        break
      }

      case 'scroll':
        skip('scroll')
        break
      case 'resize':
        skip('resize')
        break
      default:
        // `navigate` events carry no URL today; anything else is from a newer probe.
        skip('unsupported')
    }
  }

  // A field whose final typed value holds "${" can't be written: a flow reads
  // that as a placeholder. Leave the whole fill out, once per field, and say so.
  const writable = steps.filter((p) => {
    const step = p.step
    if ((step.action !== 'fill' && step.action !== 'select') || p.secret || !step.value.includes('${')) return true
    skip('placeholder_text')
    warnings.push(
      `The value typed into ${p.label?.replace(/^(Fill|Choose an option in) /, '') ?? 'a field'} contains "\${", which flow files reserve for ` +
        'placeholders, so that step was left out. Add it by hand, or put the value in a var.'
    )
    return false
  })

  let flowTarget = options.target
  if (flowTarget.kind === 'browser') {
    const scrubbed = scrubStartUrl(flowTarget.url)
    if (scrubbed.url !== flowTarget.url) {
      flowTarget = { kind: 'browser', url: scrubbed.url }
      const parts = [
        ...(scrubbed.userinfo ? ['a user name/password'] : []),
        ...(scrubbed.removed.length > 0
          ? [`credential-looking parameter${scrubbed.removed.length === 1 ? '' : 's'} (${scrubbed.removed.join(', ')})`]
          : [])
      ]
      warnings.push(
        `Removed ${parts.join(' and ')} from the start URL so the flow can be shared; ` +
          'if replay needs them, add them back as ${secret.<name>} placeholders.'
      )
    }
  }
  if (flowTarget.kind === 'browser' && flowTarget.url.includes('${')) {
    // `$` is safe to percent-encode in a URL, and `${` would read as a placeholder.
    flowTarget = { kind: 'browser', url: flowTarget.url.replace(/\$/g, '%24') }
    warnings.push('The start URL contained "${"; its "$" characters were written as %24.')
  }

  if (unfillable.size > 0) {
    const n = unfillable.size
    warnings.push(
      `Left out what was entered in ${n === 1 ? 'a field' : `${n} fields`} a flow can't fill ` +
        `(${[...new Set(unfillable.values())].join('; ')}); set ${n === 1 ? 'it' : 'them'} by hand before replaying.`
    )
  }
  if (valueless > 0) {
    warnings.push(
      `${valueless} input event${valueless === 1 ? '' : 's'} carried no value (for example typing in a rich-text editor) ` +
        'and were left out; add those steps by hand.'
    )
  }
  if (writable.length === 0) {
    warnings.push('No replayable steps were found in this recording.')
  }
  if (secretNames.size > 0) {
    const names = [...secretNames.values()].map((n) => `secret.${n}`).join(', ')
    warnings.push(`Supply these secrets at run time: ${names}.`)
  }

  const flow: Flow = {
    version: FLOW_VERSION,
    name: /\S/.test(options.name) ? options.name : 'Recording',
    ...(options.description !== undefined ? { description: options.description } : {}),
    target: flowTarget,
    steps: writable.map((p, i) => ({ id: `s${i + 1}`, ...p.step }) as FlowStep)
  }

  const checked = FlowSchema.safeParse(flow)
  if (!checked.success) {
    // A bug here, not bad input: every input path above is meant to yield a valid flow.
    throw new Error(`flowFromRecording built an invalid flow: ${checked.error.message}`)
  }
  // `flow`, not `checked.data`: it keeps the readable key order (id, action, target, value, note).
  return { flow, skipped, merged, warnings }
}
