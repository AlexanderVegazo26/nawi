/**
 * DC-4 capture sidecar — pure TypeScript shape.
 *
 * ZERO imports, deliberately. The renderer consumes this with `import type`, so
 * nothing here can drag zod (or anything else) into the web bundle. `schema.ts`
 * holds the runtime validator and a compile-time guard asserting the two cannot
 * drift.
 *
 * Two shapes are exported:
 *  - `Sidecar`     — the canonical *write* shape. Every DC-2 source key is
 *                    required-and-nullable, never optional: `?:` would let
 *                    `JSON.stringify` drop the key entirely, which is precisely
 *                    what DC-2 forbids.
 *  - `SidecarRead` — what a reader may legitimately encounter, which is wider:
 *                    an externally-authored DC-4 sidecar carries `console_log`
 *                    and `input_events` as inline arrays (see ADR-001).
 *
 * Unknown fields are preserved on read (DC-6) at runtime; they are intentionally
 * not modelled as an index signature here, because one would silently swallow
 * property typos at every call site.
 */

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/** `[x, y, w, h]`, as DC-4 writes bounds. */
export type Bounds4 = [number, number, number, number]

export type SidecarKind = 'screenshot' | 'recording' | 'guide'
export type SurfaceType = 'browser' | 'desktop' | 'mobile_emulator' | 'headless'

export interface Viewport {
  w: number
  h: number
  dpr: number
}

export interface DisplayRef {
  id: string
  bounds: Bounds4
  dpr: number
}

export interface Surface {
  type: SurfaceType
  app: string
  /** Null on surfaces that have no URL (a desktop capture). */
  url: string | null
  os: string
  locale: string
  viewport: Viewport
  displays: DisplayRef[]
}

/* ------------------------------------------------------------------ *
 * Pixel layer
 * ------------------------------------------------------------------ */

export interface FrameRef {
  t_ms: number
  /** Relative to the revision directory. Never absolute, never escaping it. */
  path: string
  sha256: string
}

export interface VideoRef {
  path: string
  codec: string
  fps: number
}

export type AudioTrackKind = 'mic' | 'system'

export interface AudioTrackRef {
  kind: AudioTrackKind
  path: string
}

export interface PixelLayer {
  frames: FrameRef[]
  video: VideoRef | null
  audio_tracks: AudioTrackRef[]
}

/* ------------------------------------------------------------------ *
 * State layer
 * ------------------------------------------------------------------ */

/** A file reference carrying the DC-1 offset at which it was taken. */
export interface TimedFileRef {
  t_ms: number
  path: string
}

export interface HarRef {
  path: string
  truncated: boolean
}

/**
 * ADR-001: an NDJSON side file plus its entry count, replacing DC-4's inline
 * array. `count` is what makes the ref useful without opening the file — an
 * agent can decide whether a query is worth the read.
 */
export interface NdjsonRef {
  path: string
  count: number
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface ConsoleEntry {
  t_ms: number
  level: ConsoleLevel
  message: string
  stack: string | null
}

export type SelectorStrategy = 'testid' | 'id' | 'role_name' | 'css' | 'nth_child'

export interface SelectorCandidate {
  strategy: SelectorStrategy
  value: string
  /** FR-STA.6: in [0, 1]. */
  stability: number
}

export interface InputTarget {
  role: string | null
  accessible_name: string | null
  text: string | null
  bounds: Bounds4 | null
  /** FR-STA.6 requires all candidates, ranked — not just the winner. */
  selectors: SelectorCandidate[]
}

export type InputEventType = 'click' | 'keydown' | 'scroll' | 'navigate' | 'resize'

export interface InputEvent {
  t_ms: number
  type: InputEventType
  coordinates: { x: number; y: number } | null
  target: InputTarget | null
  /** FR-SEC.2: true when the value was suppressed at ingest and never recorded. */
  value_redacted: boolean
}

export interface AgentTraceEntry {
  t_ms: number
  agent_id: string
  tool: string
  arguments: Record<string, unknown>
  result: string
  reasoning_summary: string | null
}

export type UnavailableSource =
  | 'dom_snapshot'
  | 'accessibility_tree'
  | 'console_log'
  | 'network_har'
  | 'input_events'
  | 'agent_trace'

export type UnavailableReason =
  | 'unsupported_surface'
  | 'permission_denied'
  | 'capture_failed'
  | 'disabled_by_policy'

export interface UnavailableEntry {
  source: UnavailableSource
  reason: UnavailableReason
}

/**
 * DC-2: every source key below is present on every sidecar. A source that could
 * not be attempted is `null` *and* carries a matching `unavailable[]` entry —
 * both, never one or the other, and never an omitted key.
 */
export interface StateLayer {
  dom_snapshot: TimedFileRef | null
  accessibility_tree: TimedFileRef | null
  console_log: NdjsonRef | null
  network_har: HarRef | null
  input_events: NdjsonRef | null
  agent_trace: AgentTraceEntry[]
  unavailable: UnavailableEntry[]
}

/* ------------------------------------------------------------------ *
 * Derived, redaction, provenance
 * ------------------------------------------------------------------ */

export interface PathRef {
  path: string
}

export interface Derived {
  transcript: PathRef | null
  ocr: PathRef | null
  summary: string | null
  tags: string[]
}

export type RedactionKind = 'pixelate' | 'blur' | 'solid'
export type RedactionTarget = 'pixel' | 'dom' | 'ocr' | 'ax' | 'har' | 'input'

export interface Redaction {
  region: Bounds4
  kind: RedactionKind
  reason: string
  /** DC-3: which layers the redaction was applied to, in the same transaction. */
  applied_to: RedactionTarget[]
}

export interface Provenance {
  ai_edited_regions: Bounds4[]
  generator: string
}

/* ------------------------------------------------------------------ *
 * Root
 * ------------------------------------------------------------------ */

/** The canonical write shape. Produced only by sealing a draft. */
export interface Sidecar {
  schema_version: string
  /**
   * ADR-001: a `randomUUID()`, not DC-4's ULID example. `library.ts`'s `UUID_RE`
   * is a path-traversal control and widening it would be a security regression.
   */
  capture_id: string
  kind: SidecarKind
  /** ISO-8601. */
  created_at: string
  /** Null for screenshots. */
  duration_ms: number | null
  /**
   * DC-6: a revision pointer, e.g. `"v1"`. Null on an original. A revision never
   * edits its predecessor — the superseded file stays byte-identical forever.
   */
  supersedes: string | null
  surface: Surface
  pixel_layer: PixelLayer
  state_layer: StateLayer
  derived: Derived
  redactions: Redaction[]
  provenance: Provenance
}

/* ------------------------------------------------------------------ *
 * Read shape
 * ------------------------------------------------------------------ */

/**
 * What a reader may encounter. Wider than `StateLayer` on exactly two fields:
 * a sidecar authored by another DC-4 implementation carries them inline, and
 * silently rejecting it would make us non-conformant with the contract we claim.
 */
export interface StateLayerRead extends Omit<StateLayer, 'console_log' | 'input_events'> {
  console_log: NdjsonRef | ConsoleEntry[] | null
  input_events: NdjsonRef | InputEvent[] | null
}

export interface SidecarRead extends Omit<Sidecar, 'state_layer'> {
  state_layer: StateLayerRead
}

/** Narrows the read-shape union to our own side-file form. */
export function isNdjsonRef(value: NdjsonRef | unknown[] | null): value is NdjsonRef {
  return value !== null && !Array.isArray(value)
}
