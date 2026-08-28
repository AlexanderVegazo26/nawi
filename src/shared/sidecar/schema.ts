import { z } from 'zod'
import type {
  Sidecar,
  SidecarRead
} from './types'

/**
 * DC-4 runtime validation.
 *
 * Two parsers over one definition:
 *
 *  - `SidecarStrict` — the **write** path. Every object level is
 *    `z.strictObject`, so a typo'd or stale field is a loud failure at the only
 *    point where we still control the bytes.
 *  - `SidecarLoose`  — the **read** path. Every object level is
 *    `z.looseObject`, because DC-6 requires consumers to ignore unknown fields
 *    and zod's default behaviour is to *strip* them. Stripping is silent data
 *    loss: a field a newer writer added would vanish the moment an older reader
 *    round-tripped the file.
 *
 * The looseness has to be per-level, not just at the root — `.passthrough()` on
 * the root does nothing for `state_layer.some_new_field`. Hence the whole shape
 * is built once by a factory parameterised on the object constructor, so the two
 * parsers cannot drift from each other. The read path in `main/sidecar/store.ts`
 * belts this brace by returning the raw `JSON.parse` result after validation,
 * making unknown-field preservation structural rather than dependent on zod's
 * catchall semantics.
 *
 * The renderer must never import this module — only `./types` with `import type`.
 */

type ObjectMaker<C extends z.core.$ZodObjectConfig> = <T extends z.core.$ZodLooseShape>(
  shape: T
) => z.ZodObject<T, C>

/* ------------------------------------------------------------------ *
 * Leaf schemas shared by both parsers
 * ------------------------------------------------------------------ */

const bounds4 = z.tuple([z.number(), z.number(), z.number(), z.number()])
const relPath = z.string().min(1)
/** FR-STA.6 requires a stability score in [0, 1]; anything else is a bug, not data. */
const stability = z.number().min(0).max(1)

function leaves<C extends z.core.$ZodObjectConfig>(o: ObjectMaker<C>) {
  const viewport = o({ w: z.number(), h: z.number(), dpr: z.number() })

  const displayRef = o({ id: z.string(), bounds: bounds4, dpr: z.number() })

  const surface = o({
    type: z.enum(['browser', 'desktop', 'mobile_emulator', 'headless']),
    app: z.string(),
    url: z.string().nullable(),
    os: z.string(),
    locale: z.string(),
    viewport,
    displays: z.array(displayRef)
  })

  const pixelLayer = o({
    frames: z.array(o({ t_ms: z.number(), path: relPath, sha256: z.string() })),
    video: o({ path: relPath, codec: z.string(), fps: z.number() }).nullable(),
    audio_tracks: z.array(o({ kind: z.enum(['mic', 'system']), path: relPath }))
  })

  const timedFileRef = o({ t_ms: z.number(), path: relPath })
  const harRef = o({ path: relPath, truncated: z.boolean() })
  /** ADR-001. `count` lets a consumer size a query before opening the file. */
  const ndjsonRef = o({ path: relPath, count: z.number().int().min(0) })

  const consoleEntry = o({
    t_ms: z.number(),
    level: z.enum(['log', 'info', 'warn', 'error', 'debug']),
    message: z.string(),
    stack: z.string().nullable()
  })

  const selectorCandidate = o({
    strategy: z.enum(['testid', 'id', 'role_name', 'css', 'nth_child']),
    value: z.string(),
    stability
  })

  const inputEvent = o({
    t_ms: z.number(),
    type: z.enum(['click', 'keydown', 'scroll', 'navigate', 'resize']),
    coordinates: o({ x: z.number(), y: z.number() }).nullable(),
    target: o({
      role: z.string().nullable(),
      accessible_name: z.string().nullable(),
      text: z.string().nullable(),
      bounds: bounds4.nullable(),
      selectors: z.array(selectorCandidate)
    }).nullable(),
    value_redacted: z.boolean()
  })

  const agentTrace = o({
    t_ms: z.number(),
    agent_id: z.string(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    result: z.string(),
    reasoning_summary: z.string().nullable()
  })

  const unavailable = o({
    source: z.enum([
      'dom_snapshot',
      'accessibility_tree',
      'console_log',
      'network_har',
      'input_events',
      'agent_trace'
    ]),
    reason: z.enum([
      'unsupported_surface',
      'permission_denied',
      'capture_failed',
      'disabled_by_policy'
    ])
  })

  const derived = o({
    transcript: o({ path: relPath }).nullable(),
    ocr: o({ path: relPath }).nullable(),
    summary: z.string().nullable(),
    tags: z.array(z.string())
  })

  const redaction = o({
    region: bounds4,
    kind: z.enum(['pixelate', 'blur', 'solid']),
    reason: z.string(),
    applied_to: z.array(z.enum(['pixel', 'dom', 'ocr', 'ax', 'har', 'input']))
  })

  const provenance = o({
    ai_edited_regions: z.array(bounds4),
    generator: z.string()
  })

  return {
    surface,
    pixelLayer,
    timedFileRef,
    harRef,
    ndjsonRef,
    consoleEntry,
    inputEvent,
    agentTrace,
    unavailable,
    derived,
    redaction,
    provenance
  }
}

/**
 * Root shape. `stateLayer` is injected because the two parsers legitimately
 * differ there: the reader also accepts DC-4's literal inline arrays.
 */
function rootShape<C extends z.core.$ZodObjectConfig, S extends z.core.SomeType>(
  parts: ReturnType<typeof leaves<C>>,
  stateLayer: S
) {
  return {
    schema_version: z.string(),
    capture_id: z.string(),
    kind: z.enum(['screenshot', 'recording', 'guide']),
    created_at: z.string(),
    duration_ms: z.number().nullable(),
    supersedes: z.string().nullable(),
    surface: parts.surface,
    pixel_layer: parts.pixelLayer,
    state_layer: stateLayer,
    derived: parts.derived,
    redactions: z.array(parts.redaction),
    provenance: parts.provenance
  }
}

/* ------------------------------------------------------------------ *
 * The write parser
 * ------------------------------------------------------------------ */

const strictLeaves = leaves(z.strictObject)

const strictStateLayer = z.strictObject({
  dom_snapshot: strictLeaves.timedFileRef.nullable(),
  accessibility_tree: strictLeaves.timedFileRef.nullable(),
  console_log: strictLeaves.ndjsonRef.nullable(),
  network_har: strictLeaves.harRef.nullable(),
  input_events: strictLeaves.ndjsonRef.nullable(),
  agent_trace: z.array(strictLeaves.agentTrace),
  unavailable: z.array(strictLeaves.unavailable)
})

/** The only shape `writeSidecar` will accept. */
export const SidecarStrict = z.strictObject(rootShape(strictLeaves, strictStateLayer))

/* ------------------------------------------------------------------ *
 * The read parser
 * ------------------------------------------------------------------ */

const looseLeaves = leaves(z.looseObject)

const looseStateLayer = z.looseObject({
  dom_snapshot: looseLeaves.timedFileRef.nullable(),
  accessibility_tree: looseLeaves.timedFileRef.nullable(),
  // ADR-001: our own `{path, count}` ref, *or* DC-4's literal inline array, so a
  // sidecar written by another conforming implementation still loads.
  console_log: z.union([
    looseLeaves.ndjsonRef,
    z.array(looseLeaves.consoleEntry),
    z.null()
  ]),
  network_har: looseLeaves.harRef.nullable(),
  input_events: z.union([
    looseLeaves.ndjsonRef,
    z.array(looseLeaves.inputEvent),
    z.null()
  ]),
  agent_trace: z.array(looseLeaves.agentTrace),
  unavailable: z.array(looseLeaves.unavailable)
})

/** DC-6's "consumers must ignore unknown fields", with preservation. */
export const SidecarLoose = z.looseObject(rootShape(looseLeaves, looseStateLayer))

/* ------------------------------------------------------------------ *
 * Compile-time drift guards
 * ------------------------------------------------------------------ */

/** Bidirectional identity: a one-way `extends` would miss a field the schema forgot. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/**
 * If either of the two constants below stops compiling, `types.ts` and this file
 * have drifted and one of them is lying to its consumers. Exported (rather than
 * a local) so `noUnusedLocals` keeps them.
 */
export const STRICT_SCHEMA_MATCHES_TYPES: Equals<z.infer<typeof SidecarStrict>, Sidecar> = true

/**
 * One-way for the loose parser: its inferred type carries zod's catchall index
 * signatures, so it is deliberately *wider* than `SidecarRead` and can never be
 * `Equals` to it. Assignability is the honest assertion here.
 */
export const LOOSE_SCHEMA_MATCHES_READ_TYPES: z.infer<typeof SidecarLoose> extends SidecarRead
  ? true
  : false = true

/* ------------------------------------------------------------------ *
 * Parse helpers
 * ------------------------------------------------------------------ */

export type SidecarParseResult =
  | { ok: true; value: SidecarRead }
  | { ok: false; error: string }

/**
 * Validates an untrusted value against the read parser.
 *
 * Returns `input` itself on success rather than zod's output. Even with loose
 * objects everywhere, letting the parser's return value become the canonical
 * object makes DC-6 preservation depend on zod's catchall staying enabled at
 * every level forever. Returning the caller's own parsed JSON makes it a
 * property of the code instead of a property of the dependency.
 */
export function parseSidecar(input: unknown): SidecarParseResult {
  const result = SidecarLoose.safeParse(input)
  if (!result.success) {
    return { ok: false, error: z.prettifyError(result.error) }
  }
  return { ok: true, value: input as SidecarRead }
}

/** Validates on the write path. Rejects unknown fields — see the module note. */
export function parseSidecarStrict(input: unknown): { ok: true; value: Sidecar } | { ok: false; error: string } {
  const result = SidecarStrict.safeParse(input)
  if (!result.success) {
    return { ok: false, error: z.prettifyError(result.error) }
  }
  return { ok: true, value: result.data }
}
