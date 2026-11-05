import { PLACEHOLDER, REFERENCE, type Flow } from './schema'

/**
 * Run-time resolution of `${vars.*}`, `${env.*}` and `${secret.*}` in a flow.
 *
 * `parseFlow` already guarantees every placeholder is well formed and every
 * `vars` reference is declared, so the only thing that can be wrong here is a
 * value the run did not supply: an unset environment variable or a secret the
 * store does not have. Those are found up front, for every step that will run,
 * so a replay never half-runs a flow and then stops at step 7 for a missing
 * password.
 *
 * Secret values are kept so callers can scrub them from anything they report
 * (`redact`): a failed `assert` that prints the page's text must not print a
 * password the flow typed into it.
 */

export interface FlowInputs {
  /** `${env.NAME}`; pass `process.env` from a CLI, a curated map from the app. */
  env?: Readonly<Record<string, string | undefined>>
  /** `${secret.name}`, from the OS keychain or the run's own prompt. Never stored in the flow. */
  secret?: (name: string) => string | undefined
}

export class MissingFlowInputsError extends Error {
  /** The references that could not be resolved, e.g. `env.TEST_EMAIL`, `secret.app_password`. */
  readonly missing: string[]

  constructor(missing: string[]) {
    super(
      `the flow needs ${missing.length === 1 ? 'a value' : 'values'} the run did not provide: ${missing
        .map((m) => `\${${m}}`)
        .join(', ')}`
    )
    this.name = 'MissingFlowInputsError'
    this.missing = missing
  }
}

export interface FlowInterpolator {
  /** Replace every placeholder in `value`. Only call it with strings from the flow it was built for. */
  interpolate(value: string): string
  /** Replace each secret value that appears in `text` with its `${secret.name}` placeholder. */
  redact(text: string): string
}

export interface InterpolationScope {
  /** Count `target.url` as used (false when the run attaches to an already-open page). Default true. */
  includeTarget?: boolean
}

/** The strings of a flow that are interpolated at run time (disabled steps excluded). */
export function interpolatedStrings(flow: Flow, scope: InterpolationScope = {}): string[] {
  const out: string[] = []
  if (flow.target.kind === 'browser' && scope.includeTarget !== false) out.push(flow.target.url)
  for (const step of flow.steps) {
    if (step.disabled) continue
    if ('value' in step) out.push(step.value)
    if ('url' in step) out.push(step.url)
    if ('key' in step) out.push(step.key)
    if (step.action === 'assert') {
      if (step.expect.url !== undefined) out.push(step.expect.url)
      if (step.expect.text !== undefined) out.push(step.expect.text)
    }
  }
  return out
}

function references(value: string): Array<[ns: string, name: string]> {
  const refs: Array<[string, string]> = []
  for (const [, inner] of value.matchAll(PLACEHOLDER)) {
    const ref = REFERENCE.exec(inner.trim())
    if (ref) refs.push([ref[1], ref[2]])
  }
  return refs
}

/**
 * Build the interpolator for one run, or throw `MissingFlowInputsError` naming
 * every value the flow needs and the run lacks.
 */
export function createInterpolator(
  flow: Flow,
  inputs: FlowInputs = {},
  scope: InterpolationScope = {}
): FlowInterpolator {
  const env = inputs.env ?? {}
  const secrets = new Map<string, string>()
  const missing = new Set<string>()

  const lookup = (ns: string, name: string): string | undefined => {
    if (ns === 'env') {
      const v = Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined
      if (v === undefined) missing.add(`env.${name}`)
      return v
    }
    if (ns === 'secret') {
      if (secrets.has(name)) return secrets.get(name)
      const v = inputs.secret?.(name)
      if (v === undefined) missing.add(`secret.${name}`)
      else secrets.set(name, v)
      return v
    }
    return undefined
  }

  // vars may only reference env/secret (parseFlow enforces it), so one pass resolves them.
  const vars = new Map<string, string>()
  const resolveVar = (name: string): string => {
    const cached = vars.get(name)
    if (cached !== undefined) return cached
    const raw = flow.vars?.[name] ?? ''
    const value = raw.replace(PLACEHOLDER, (whole, inner: string) => {
      const ref = REFERENCE.exec(inner.trim())
      return ref ? lookup(ref[1], ref[2]) ?? whole : whole
    })
    vars.set(name, value)
    return value
  }

  for (const value of interpolatedStrings(flow, scope)) {
    for (const [ns, name] of references(value)) {
      if (ns === 'vars') resolveVar(name)
      else lookup(ns, name)
    }
  }
  if (missing.size > 0) throw new MissingFlowInputsError([...missing].sort())

  const interpolate = (value: string): string =>
    value.replace(PLACEHOLDER, (whole, inner: string) => {
      const ref = REFERENCE.exec(inner.trim())
      if (!ref) return whole
      const [, ns, name] = ref
      if (ns === 'vars') return resolveVar(name)
      const v = lookup(ns, name)
      if (v === undefined) throw new MissingFlowInputsError([`${ns}.${name}`])
      return v
    })

  const redact = (text: string): string => redactSecrets(text, secrets)

  return { interpolate, redact }
}

/**
 * Replace each secret value (in any of the forms secretPattern matches) in `text` with its `${secret.name}`
 * placeholder. Longest first, so a secret that contains another is scrubbed whole.
 */
export function redactSecrets(text: string, secrets: Iterable<readonly [name: string, value: string]>): string {
  let out = text
  const order = [...secrets].filter(([, v]) => v.length > 0).sort((a, b) => b[1].length - a[1].length)
  for (const [name, value] of order) out = out.replace(secretPattern(value), () => `\${secret.${name}}`)
  return out
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `%e2` → `%[eE]2`: percent-encoding hex may be either case. */
const hexEither = (byte: number): string =>
  byte
    .toString(16)
    .toUpperCase()
    .padStart(2, '0')
    .replace(/[A-F]/g, (h) => `[${h}${h.toLowerCase()}]`)

/**
 * A secret as it may show up in what a run reports: typed as is, or
 * percent-encoded character by character (however the browser chose to encode
 * a URL: it leaves `&` and `\` alone but not `"` or spaces), with whitespace
 * runs folded or turned into `+`, and the ends trimmed (the page's own
 * `innerText` folds "a  b" to "a b" before the replayer sees it). A secret that
 * is only whitespace is matched exactly.
 */
export function secretPattern(secret: string): RegExp {
  const core = secret.trim()
  if (core === '') return new RegExp(escapeRegex(secret), 'g')
  const encoder = new TextEncoder()
  const parts: string[] = []
  for (const run of core.match(/\s+|\S/gu) ?? []) {
    if (/^\s/.test(run)) {
      parts.push('(?:\\s|\\+|%(?:20|09|0[aA]|0[dD]))+')
      continue
    }
    const encoded = [...encoder.encode(run)].map((b) => `%${hexEither(b)}`).join('')
    parts.push(`(?:${escapeRegex(run)}|${encoded})`)
  }
  return new RegExp(parts.join(''), 'g')
}
