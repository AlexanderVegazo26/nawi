import { z } from 'zod'

/**
 * Flow files (`*.nawi.yaml`) — the editable, versionable form of a recording.
 *
 * A flow is the source of truth for record → edit → replay → test: people and
 * agents edit the YAML, the replayer (later) executes it, and the run record
 * points back at step ids. This module owns the model and its validation; the
 * YAML text handling lives in `./yaml.ts`.
 *
 * Strict on purpose. A flow is hand-edited, so a typo'd key (`selector:` for
 * `selectors:`, `expect: { visble: true }`) must be a loud error with a line
 * number, not a silently ignored field that makes a step do less than its
 * author thinks. A future format change bumps `version`.
 *
 * Node-free: `src/shared/**` also compiles into the renderer (the flow editor).
 */

export const FLOW_VERSION = 1

/** Conventional file suffix; editors can map it to the published JSON Schema. */
export const FLOW_FILE_SUFFIX = '.nawi.yaml'

export const FLOW_ACTIONS = [
  'click',
  'fill',
  'press',
  'select',
  'hover',
  'scroll',
  'navigate',
  'wait',
  'assert',
  'screenshot'
] as const

export type FlowAction = (typeof FLOW_ACTIONS)[number]

/**
 * `${namespace.name}` placeholders a flow may use. `vars` are declared in the
 * file; `env` and `secret` are resolved at run time and never written into it,
 * so a recording of a password field stores `${secret.name}`, not the password.
 */
export const INTERPOLATION_NAMESPACES = ['vars', 'env', 'secret'] as const

const nonEmpty = z.string().regex(/\S/, 'must not be empty or blank')

/** Step ids are referenced by run records, diffs and "run from here". */
const stepId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'must be 1-64 letters, digits, "_" or "-", starting with a letter or digit')

/**
 * Keys that are not data in a JS object: `obj.__proto__ = x` sets the
 * prototype, and `constructor`/`prototype` shadow built-ins. Refused as any key
 * (by `parseFlow`) and as var names (here), so a flow `stringifyFlow` writes
 * always parses back.
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

const varName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a letter or "_" followed by letters, digits or "_"')
  .refine((n) => !RESERVED_KEYS.has(n), { message: 'is a reserved name (__proto__, constructor, prototype)' })

/** An Android application id (`com.example.app`): the `package` of an android flow target. */
export const ANDROID_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/

/** Longest `{ text }` locator a flow accepts. */
export const MAX_TEXT_LOCATOR_CHARS = 500

/**
 * One locator. A step lists several, most stable first (FR-STA.6's ranking:
 * test id > id > role + accessible name > visible text > CSS), so the replayer
 * can fall back when the first no longer matches (roadmap AI1: layered
 * locators). `text` is the element's whole visible text, whitespace runs
 * folded and trimmed; it matches the innermost element showing exactly that.
 *
 * Android flows (roadmap M5) use `id` for the view's resource id
 * (`com.example:id/save`), `desc` for its content description and `text` for
 * its text, each compared exactly; `desc` exists only there.
 */
export const SelectorSchema = z.union([
  z.strictObject({ testid: nonEmpty }),
  z.strictObject({ id: nonEmpty }),
  z.strictObject({ desc: nonEmpty.max(MAX_TEXT_LOCATOR_CHARS) }),
  z.strictObject({ role: nonEmpty, name: z.string().optional() }),
  z.strictObject({ text: nonEmpty.max(MAX_TEXT_LOCATOR_CHARS) }),
  z.strictObject({ css: nonEmpty })
])

/** The kinds of locator a step can list (its "layers"), most stable first. */
export const LOCATOR_LAYERS = ['testid', 'id', 'desc', 'role', 'text', 'css'] as const
export type LocatorLayer = (typeof LOCATOR_LAYERS)[number]

/** Which layer a locator belongs to, for run records ("matched by role"). */
export function locatorLayer(selector: Selector): LocatorLayer {
  if ('testid' in selector) return 'testid'
  if ('id' in selector) return 'id'
  if ('desc' in selector) return 'desc'
  if ('role' in selector) return 'role'
  if ('text' in selector) return 'text'
  return 'css'
}

const pixel = z.number().finite()

/**
 * Assets a flow points at (reference crops) live next to the flow file. A path
 * that is absolute, has a drive letter or scheme, or climbs out with `..` would
 * let a shared flow make the app read an arbitrary file, so it is refused here,
 * before anything loads it.
 */
const relativeAssetPath = z
  .string()
  .regex(/\S/, 'must not be empty or blank')
  .describe(
    'Relative path inside the flow\'s folder: no leading / or \\, drive letter, scheme, ".." segment, "%" or control characters (enforced by parseFlow; the loader must also resolve and contain it).'
  )
  .refine(
    (p) =>
      !/^[\\/]/.test(p) &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p) &&
      !p.split(/[\\/]/).includes('..') &&
      // Percent-encoding and control characters have no place in a file name
      // here, and `%2e%2e` is how a dot-segment check is usually walked around.
      !/%|[\u0000-\u001f\u007f]/.test(p),
    { message: 'must be a relative path inside the flow\'s folder (no leading "/", drive letter, scheme, "..", "%" or control characters)' }
  )

export const StepTargetSchema = z.strictObject({
  selectors: z.array(SelectorSchema).min(1, 'needs at least one selector'),
  /** Recorded box `[x, y, width, height]` in CSS px, for the vision fallback. */
  bbox: z
    .tuple([pixel, pixel, pixel.nonnegative(), pixel.nonnegative()])
    .optional(),
  /** Reference crop relative to the flow file, for visual diff and vision replay. */
  image: relativeAssetPath.optional()
})

export const ExpectSchema = z
  .strictObject({
    visible: z.boolean().optional(),
    enabled: z.boolean().optional(),
    text: z.string().optional(),
    url: z.string().optional()
  })
  .refine((e) => Object.values(e).some((v) => v !== undefined), {
    message: 'needs at least one of visible, enabled, text, url'
  })

/**
 * What a step is for, in one plain sentence ("Open the invoice list"), so a
 * person, a healing proposal or a failure triage can tell whether a match is
 * still the right element after the UI changed (roadmap AI1). One line: it is
 * shown next to the step in run records and reports.
 */
export const MAX_INTENT_CHARS = 300

const intent = z
  .string()
  .regex(/\S/, 'must not be empty or blank')
  .max(MAX_INTENT_CHARS, `must be one sentence (at most ${MAX_INTENT_CHARS} characters)`)
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), { message: 'must be one line (no line breaks or control characters)' })

const common = {
  id: stepId,
  /** What the step is for (roadmap AI1); additive to version 1. */
  intent: intent.optional(),
  /** Human description; becomes guide text later. */
  note: z.string().optional(),
  /** Kept in the file but skipped by the replayer. */
  disabled: z.boolean().optional(),
  timeout_ms: z.number().int().positive().max(600_000).optional()
}

const target = StepTargetSchema
const optionalTarget = StepTargetSchema.optional()

export const StepSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...common, action: z.literal('click'), target }),
  z.strictObject({ ...common, action: z.literal('hover'), target }),
  z.strictObject({ ...common, action: z.literal('fill'), target, value: z.string() }),
  z.strictObject({ ...common, action: z.literal('select'), target, value: z.string() }),
  z.strictObject({ ...common, action: z.literal('press'), target: optionalTarget, key: nonEmpty }),
  z.strictObject({
    ...common,
    action: z.literal('scroll'),
    target: optionalTarget,
    delta: z.tuple([pixel, pixel]).optional()
  }),
  z.strictObject({ ...common, action: z.literal('navigate'), url: nonEmpty }),
  z
    .strictObject({
      ...common,
      action: z.literal('wait'),
      target: optionalTarget,
      ms: z.number().int().positive().max(600_000).optional()
    })
    .refine((s) => s.target !== undefined || s.ms !== undefined, {
      message: 'a wait step needs a target to wait for or ms to sleep'
    }),
  z
    .strictObject({ ...common, action: z.literal('assert'), target: optionalTarget, expect: ExpectSchema })
    .refine(
      (s) =>
        s.target !== undefined ||
        (s.expect.url !== undefined &&
          s.expect.visible === undefined &&
          s.expect.enabled === undefined &&
          s.expect.text === undefined),
      { message: 'an element assertion needs a target (only expect.url can be checked without one)' }
    ),
  z.strictObject({ ...common, action: z.literal('screenshot'), target: optionalTarget })
])

export const FlowTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('browser'), url: nonEmpty }),
  z.strictObject({ kind: z.literal('desktop'), app: nonEmpty }),
  /** An installed Android app on a device or emulator (roadmap M5); steps act only on its own windows. */
  z.strictObject({
    kind: z.literal('android'),
    package: z.string().max(255).regex(ANDROID_PACKAGE_RE, 'must be an Android package name such as com.example.app')
  })
])

/**
 * What an android flow can do today (roadmap M5a): tap, type, Android's keys,
 * deep links, waits and element assertions. The rest is refused by parseFlow
 * with a message, instead of being skipped at replay.
 */
export const ANDROID_ACTIONS = ['click', 'fill', 'press', 'navigate', 'wait', 'assert'] as const satisfies readonly FlowAction[]

/** Keys an android `press` step may name, and the key event each sends. */
export const ANDROID_KEYS: Readonly<Record<string, string>> = {
  Back: 'KEYCODE_BACK',
  Home: 'KEYCODE_HOME',
  AppSwitch: 'KEYCODE_APP_SWITCH',
  Enter: 'KEYCODE_ENTER',
  Tab: 'KEYCODE_TAB',
  Escape: 'KEYCODE_ESCAPE',
  Backspace: 'KEYCODE_DEL',
  Delete: 'KEYCODE_FORWARD_DEL',
  ArrowUp: 'KEYCODE_DPAD_UP',
  ArrowDown: 'KEYCODE_DPAD_DOWN',
  ArrowLeft: 'KEYCODE_DPAD_LEFT',
  ArrowRight: 'KEYCODE_DPAD_RIGHT'
}

const ANDROID_LAYERS: ReadonlySet<LocatorLayer> = new Set(['id', 'desc', 'text'])

const FlowShape = z.strictObject({
  version: z.literal(FLOW_VERSION, { error: `must be ${FLOW_VERSION} (the only flow format version this build reads)` }),
  name: nonEmpty,
  description: z.string().optional(),
  target: FlowTargetSchema,
  vars: z.record(varName, z.string()).optional(),
  steps: z.array(StepSchema)
})

export type Selector = z.infer<typeof SelectorSchema>
export type StepTarget = z.infer<typeof StepTargetSchema>
export type FlowStep = z.infer<typeof StepSchema>
export type FlowTarget = z.infer<typeof FlowTargetSchema>
export type Flow = z.infer<typeof FlowShape>

export const PLACEHOLDER = /\$\{([^}]*)\}/g
export const REFERENCE = /^([A-Za-z_]+)\.([A-Za-z_][A-Za-z0-9_]*)$/

/** Every `${...}` in a string, with what is wrong with it (if anything). */
export function placeholderProblems(
  value: string,
  declaredVars: ReadonlySet<string>,
  allowVars: boolean
): string[] {
  const problems: string[] = []
  for (const [whole, inner] of value.matchAll(PLACEHOLDER)) {
    const ref = REFERENCE.exec(inner.trim())
    if (!ref) {
      problems.push(`${whole} is not a reference; use \${vars.<name>}, \${env.<NAME>} or \${secret.<name>}`)
      continue
    }
    const [, ns, name] = ref
    if (!(INTERPOLATION_NAMESPACES as readonly string[]).includes(ns)) {
      problems.push(`${whole} uses unknown namespace "${ns}"; expected one of ${INTERPOLATION_NAMESPACES.join(', ')}`)
    } else if (ns === 'vars' && !allowVars) {
      problems.push(`${whole}: vars may only reference env or secret, not other vars`)
    } else if (ns === 'vars' && !declaredVars.has(name)) {
      problems.push(`${whole} refers to an undeclared var; declare "${name}" under vars`)
    }
  }
  return problems
}

/** The fields of a step that are interpolated at run time. */
const INTERPOLATED_FIELDS = ['value', 'url', 'key'] as const
/** Assertion expectations are interpolated too (`expect: { url: "${env.BASE}/x" }`). */
const INTERPOLATED_EXPECT_FIELDS = ['url', 'text'] as const

/**
 * Cross-field rules a per-field schema cannot express: unique step ids and
 * placeholders that resolve.
 */
export const FlowSchema = FlowShape.superRefine((flow, ctx) => {
  const declared = new Set(Object.keys(flow.vars ?? {}))

  for (const [name, value] of Object.entries(flow.vars ?? {})) {
    for (const message of placeholderProblems(value, declared, false)) {
      ctx.addIssue({ code: 'custom', path: ['vars', name], message })
    }
  }

  if (flow.target.kind === 'browser') {
    for (const message of placeholderProblems(flow.target.url, declared, true)) {
      ctx.addIssue({ code: 'custom', path: ['target', 'url'], message })
    }
  }
  const android = flow.target.kind === 'android'

  const firstIndex = new Map<string, number>()
  flow.steps.forEach((step, i) => {
    const seen = firstIndex.get(step.id)
    if (seen === undefined) firstIndex.set(step.id, i)
    else {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', i, 'id'],
        message: `duplicate step id "${step.id}" (first used by steps[${seen}])`
      })
    }

    for (const field of INTERPOLATED_FIELDS) {
      const value = (step as Record<string, unknown>)[field]
      if (typeof value !== 'string') continue
      for (const message of placeholderProblems(value, declared, true)) {
        ctx.addIssue({ code: 'custom', path: ['steps', i, field], message })
      }
    }

    for (const message of android ? androidStepProblems(step) : []) {
      ctx.addIssue({ code: 'custom', path: ['steps', i, ...message.path], message: message.text })
    }
    const stepTarget = 'target' in step ? step.target : undefined
    stepTarget?.selectors.forEach((selector, k) => {
      if (!android && 'desc' in selector) {
        ctx.addIssue({ code: 'custom', path: ['steps', i, 'target', 'selectors', k], message: 'desc (an Android content description) is only for android flows' })
      }
    })

    if (step.action === 'assert') {
      for (const field of INTERPOLATED_EXPECT_FIELDS) {
        const value = step.expect[field]
        if (value === undefined) continue
        for (const message of placeholderProblems(value, declared, true)) {
          ctx.addIssue({ code: 'custom', path: ['steps', i, 'expect', field], message })
        }
      }
    }
  })
})

/** Why an android flow can't run `step` as written: each with the path under the step it is about. */
function androidStepProblems(step: FlowStep): Array<{ path: Array<string | number>; text: string }> {
  const out: Array<{ path: Array<string | number>; text: string }> = []
  if (!(ANDROID_ACTIONS as readonly string[]).includes(step.action)) {
    out.push({ path: ['action'], text: `"${step.action}" steps are not supported in android flows yet; use one of ${ANDROID_ACTIONS.join(', ')}` })
    return out
  }
  const t = 'target' in step ? step.target : undefined
  t?.selectors.forEach((selector, k) => {
    const layer = locatorLayer(selector)
    if (!ANDROID_LAYERS.has(layer)) out.push({ path: ['target', 'selectors', k], text: `android flows find views by id (resource id), desc (content description) or text, not ${layer}` })
  })
  if (t?.image !== undefined) out.push({ path: ['target', 'image'], text: 'reference crops are not used by android flows yet' })
  if (t?.bbox !== undefined) out.push({ path: ['target', 'bbox'], text: 'bbox is not used by android flows yet' })
  if (step.action === 'press') {
    if (t !== undefined) out.push({ path: ['target'], text: 'an android press sends the key to the app as it is; tap a field first with a click step' })
    if (!Object.prototype.hasOwnProperty.call(ANDROID_KEYS, step.key)) out.push({ path: ['key'], text: `android flows can press ${Object.keys(ANDROID_KEYS).join(', ')}` })
  }
  if (step.action === 'assert' && step.expect.url !== undefined) out.push({ path: ['expect', 'url'], text: 'an Android app has no URL to check; assert on a view instead' })
  return out
}

/**
 * The published JSON Schema for editors (`# yaml-language-server: $schema=...`)
 * and other tools. Cross-field rules (unique ids, placeholder references) are
 * enforced by `parseFlow` only.
 */
export function flowJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://github.com/AlexanderVegazo26/nawi/blob/main/docs/schemas/flow.v1.schema.json',
    title: 'Nawi flow (version 1)',
    ...(z.toJSONSchema(FlowShape, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>)
  }
}
