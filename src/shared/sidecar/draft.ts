import { SCHEMA_VERSION } from './version'
import type {
  AgentTraceEntry,
  Derived,
  HarRef,
  NdjsonRef,
  PixelLayer,
  Redaction,
  Sidecar,
  SidecarKind,
  Surface,
  TimedFileRef,
  UnavailableEntry,
  UnavailableReason,
  UnavailableSource
} from './types'

/**
 * The mutable, in-memory sidecar the harvester fills in.
 *
 * A capture is assembled incrementally and out of order — the DOM snapshot lands
 * before the recording stops, console entries trickle in throughout, and the
 * network HAR is only complete at the end. Building the immutable `Sidecar`
 * directly would mean either a half-built object typed as if it were finished,
 * or a pile of `Partial<>`s that nothing can validate. This is the honest
 * intermediate: mutable by design, and convertible exactly once, by `finalize`.
 *
 * `finalize` is *not* `seal` — sealing (the FR-SEC.2 redaction chokepoint) is a
 * separate step that consumes this output. This module deliberately knows
 * nothing about redaction policy.
 *
 * ZERO runtime imports beyond `./version`, both of which are dependency-free.
 */

export interface SidecarDraft {
  readonly capture_id: string
  kind: SidecarKind
  created_at: string
  duration_ms: number | null
  supersedes: string | null
  surface: Surface
  pixel_layer: PixelLayer
  state_layer: {
    dom_snapshot: TimedFileRef | null
    accessibility_tree: TimedFileRef | null
    console_log: NdjsonRef | null
    network_har: HarRef | null
    input_events: NdjsonRef | null
    agent_trace: AgentTraceEntry[]
    unavailable: UnavailableEntry[]
  }
  derived: Derived
  redactions: Redaction[]
  generator: string
}

export interface DraftInit {
  capture_id: string
  kind: SidecarKind
  surface: Surface
  /** ISO-8601; defaults to now. */
  created_at?: string
  generator: string
}

/** The DC-2 sources that must resolve to either a value or an `unavailable` entry. */
const REQUIRED_SOURCES = [
  'dom_snapshot',
  'accessibility_tree',
  'console_log',
  'network_har',
  'input_events'
] as const

type RequiredSource = (typeof REQUIRED_SOURCES)[number]

export function createDraft(init: DraftInit): SidecarDraft {
  return {
    capture_id: init.capture_id,
    kind: init.kind,
    created_at: init.created_at ?? new Date().toISOString(),
    duration_ms: null,
    supersedes: null,
    surface: init.surface,
    pixel_layer: { frames: [], video: null, audio_tracks: [] },
    state_layer: {
      // Present-and-null from birth, so a source nobody ever touched cannot
      // disappear from the output by omission (DC-2).
      dom_snapshot: null,
      accessibility_tree: null,
      console_log: null,
      network_har: null,
      input_events: null,
      agent_trace: [],
      unavailable: []
    },
    derived: { transcript: null, ocr: null, summary: null, tags: [] },
    redactions: [],
    generator: init.generator
  }
}

/**
 * Records that a source could not be attempted.
 *
 * DC-2 needs *both* halves — the key nulled and a reason logged — so this is one
 * call rather than two things a caller can half-remember. Nulls the reference
 * even if something had previously been set, because "unavailable" is a stronger
 * statement than a stale partial result.
 */
export function markUnavailable(
  draft: SidecarDraft,
  source: UnavailableSource,
  reason: UnavailableReason
): void {
  if (source !== 'agent_trace') {
    draft.state_layer[source] = null
  }
  const existing = draft.state_layer.unavailable.find((u) => u.source === source)
  if (existing) {
    existing.reason = reason
    return
  }
  draft.state_layer.unavailable.push({ source, reason })
}

/**
 * Records that a source *was* obtained, clearing any earlier unavailability so a
 * retry that succeeds does not leave a contradictory sidecar behind.
 */
export function setSource<K extends RequiredSource>(
  draft: SidecarDraft,
  source: K,
  value: NonNullable<SidecarDraft['state_layer'][K]>
): void {
  draft.state_layer[source] = value
  draft.state_layer.unavailable = draft.state_layer.unavailable.filter((u) => u.source !== source)
}

export function addAgentTrace(draft: SidecarDraft, entry: AgentTraceEntry): void {
  draft.state_layer.agent_trace.push(entry)
}

export function addRedaction(draft: SidecarDraft, redaction: Redaction): void {
  draft.redactions.push(redaction)
}

/** Sources that are neither present nor explained. */
export function missingDc2Reasons(draft: SidecarDraft): RequiredSource[] {
  return REQUIRED_SOURCES.filter(
    (source) =>
      draft.state_layer[source] === null &&
      !draft.state_layer.unavailable.some((u) => u.source === source)
  )
}

/**
 * Freezes a draft into the canonical write shape.
 *
 * Throws when DC-2 is unsatisfied rather than emitting a sidecar that quietly
 * claims a source was absent for no reason. A harvester that genuinely did not
 * try must say so with `markUnavailable` — "we never attempted this" is a fact a
 * consumer needs, and an unexplained null is indistinguishable from a bug.
 */
export function finalize(
  draft: SidecarDraft,
  options: { supersedes?: string | null } = {}
): Sidecar {
  const missing = missingDc2Reasons(draft)
  if (missing.length > 0) {
    throw new Error(
      `DC-2 violation: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} null with no unavailable[] reason. ` +
        'Call markUnavailable() for every source that could not be attempted.'
    )
  }

  return {
    schema_version: SCHEMA_VERSION,
    capture_id: draft.capture_id,
    kind: draft.kind,
    created_at: draft.created_at,
    duration_ms: draft.duration_ms,
    supersedes: options.supersedes ?? draft.supersedes,
    surface: draft.surface,
    pixel_layer: {
      frames: [...draft.pixel_layer.frames],
      video: draft.pixel_layer.video,
      audio_tracks: [...draft.pixel_layer.audio_tracks]
    },
    state_layer: {
      dom_snapshot: draft.state_layer.dom_snapshot,
      accessibility_tree: draft.state_layer.accessibility_tree,
      console_log: draft.state_layer.console_log,
      network_har: draft.state_layer.network_har,
      input_events: draft.state_layer.input_events,
      agent_trace: [...draft.state_layer.agent_trace],
      unavailable: [...draft.state_layer.unavailable]
    },
    derived: { ...draft.derived, tags: [...draft.derived.tags] },
    redactions: [...draft.redactions],
    provenance: { ai_edited_regions: [], generator: draft.generator }
  }
}
