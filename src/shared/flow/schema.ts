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

const varName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a letter or "_" followed by letters, digits or "_"')

/**
 * One locator. A step lists several, most stable first (FR-STA.6's ranking:
 * test id > id > role + accessible name > CSS), so the replayer can fall back
 * when the first no longer matches.
 */
export const SelectorSchema = z.union([
  z.strictObject({ testid: nonEmpty }),
  z.strictObject({ id: nonEmpty }),
  z.strictObject({ role: nonEmpty, name: z.string().optional() }),
  z.strictObject({ css: nonEmpty })
])

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
  .refine(
    (p) =>
      !/^[\\/]/.test(p) &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p) &&
      !p.split(/[\\/]/).includes('..'),
    { message: 'must be a relative path inside the flow\'s folder (no leading "/", drive letter, scheme or "..")' }
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

const common = {
  id: stepId,
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
  z.strictObject({ kind: z.literal('desktop'), app: nonEmpty })
])

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

const PLACEHOLDER = /\$\{([^}]*)\}/g
const REFERENCE = /^([A-Za-z_]+)\.([A-Za-z_][A-Za-z0-9_]*)$/

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
