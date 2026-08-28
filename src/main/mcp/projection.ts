import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { isSafeRelPath } from '../sidecar/paths'
import { isNdjsonRef } from '@shared/sidecar/types'
import type { ConsoleLevel, InputEventType, SidecarRead } from '@shared/sidecar/types'

/**
 * FR-AGT.2 — field projection, filtering and pagination over the state layer.
 *
 * Two properties drive every design choice here, and both come straight from the
 * acceptance block:
 *
 *  1. **The budget is in bytes, not entries.** "the response is under 32 KB" is a
 *     statement about the serialized artifact. A `limit`-style budget cannot
 *     satisfy it — a handful of console errors carrying full stack traces is
 *     already past 32 KB at `limit: 20`. So entries are serialized one at a time,
 *     `Buffer.byteLength` is accumulated, and emission stops *before* the cap is
 *     crossed rather than after.
 *  2. **The 40 MB state layer is never fully parsed.** NDJSON side files
 *     (ADR-001) are read by a streaming line scan, so peak memory is one line and
 *     a 40 MB console log costs the same as a 40 KB one. `JSON.parse` of the
 *     whole file would make the requirement unsatisfiable at any budget.
 *
 * Deliberately **electron-free** and side-effect-free at import: it takes the
 * revision directory as an argument, exactly as `sidecar/store.ts` does, so it is
 * unit-testable against a temp directory without booting an app.
 *
 * Every argument reaching this module came from an MCP client, i.e. from a
 * process we do not control. Nothing here trusts a field, a path, a number or a
 * cursor without checking it.
 */

/* ------------------------------------------------------------------ *
 * Query
 * ------------------------------------------------------------------ */

export const PROJECTABLE_FIELDS = [
  'dom_snapshot',
  'accessibility_tree',
  'console_log',
  'network_har',
  'input_events',
  'agent_trace',
  'unavailable'
] as const

export type ProjectableField = (typeof PROJECTABLE_FIELDS)[number]

/** Fields whose contents are paginated entry-by-entry against the byte budget. */
const PAGINATED_FIELDS = ['console_log', 'input_events', 'agent_trace'] as const
type PaginatedField = (typeof PAGINATED_FIELDS)[number]

export interface StateLayerQuery {
  /** Absent or empty means every field. */
  fields?: ProjectableField[]
  /** Console filter. Absent means every level. */
  level?: ConsoleLevel[]
  /** Input-event filter. Absent means every type. */
  type?: InputEventType[]
  /** Opaque; produced by a previous call. */
  cursor?: string | null
  /** Hard ceiling on the serialized response. Defaults to and is capped at 32 KB. */
  max_bytes?: number
}

/**
 * The acceptance names 32 KB, so that is both the default and the ceiling: a
 * client cannot raise it past the number the requirement is measured against.
 */
export const MAX_RESPONSE_BYTES = 32768

/**
 * Envelope allowance held back from the entry budget.
 *
 * The cap applies to the whole serialized response, not to the entries alone, so
 * the keys, brackets, commas, `next_cursor` and `truncated` all have to be paid
 * for. Reserving up front means the result is under budget *by construction*
 * rather than by measuring afterwards and hoping.
 */
const ENVELOPE_RESERVE = 1024

/** Longest single string field kept on an entry that has to be shrunk to fit. */
const MIN_FIELD_KEEP = 120

/* ------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------ */

/** One projected entry: the source object plus the two clauses that must survive. */
export type ProjectedEntry = Record<string, unknown> & {
  /** DC-1 / FR-AGT.2: never stripped, whatever else the projection drops. */
  t_ms: number
  /** FR-AGT.2: "a link to the corresponding video timestamp". */
  video_url: string
}

export interface ProjectedField {
  /** Entries emitted for this field in this page. */
  entries?: ProjectedEntry[]
  /** For file-backed fields, the reference itself — small, so it is never paginated. */
  ref?: unknown
  /**
   * The source's own total entry count, *before* any filter or budget — taken
   * from the NDJSON ref, so it costs nothing. Deliberately not the post-filter
   * count: computing that needs the full 40 MB scan this module exists to avoid.
   */
  available?: number
  /** True when this field ran out of budget mid-way. */
  truncated?: boolean
  /** DC-2: null with a reason, rather than an omitted key. */
  unavailable?: string
}

export interface ProjectionResult {
  capture_id: string
  schema_version: string
  kind: string
  /** Which fields this response actually speaks about. */
  fields: ProjectableField[]
  state_layer: Partial<Record<ProjectableField, ProjectedField>>
  /** Non-null when entries remain; pass it back verbatim as `cursor`. */
  next_cursor: string | null
  /** True when anything at all was held back by the byte budget. */
  truncated: boolean
  /** Serialized size of this very object. Informational; see `serializeResult`. */
  bytes: number
}

/* ------------------------------------------------------------------ *
 * Argument validation — everything below crossed a trust boundary
 * ------------------------------------------------------------------ */

const CONSOLE_LEVELS: readonly ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug']
const INPUT_TYPES: readonly InputEventType[] = [
  'click',
  'keydown',
  'scroll',
  'navigate',
  'resize'
]

export function isProjectableField(v: unknown): v is ProjectableField {
  return typeof v === 'string' && (PROJECTABLE_FIELDS as readonly string[]).includes(v)
}

/**
 * A cursor is `<field>:<offset>`.
 *
 * It is echoed back to us by the client, so it is re-validated rather than
 * trusted: the field must be one we paginate and the offset a non-negative safe
 * integer. A malformed cursor restarts from the beginning instead of throwing —
 * an agent that mangled one should get data, not a stack trace.
 */
export function parseCursor(cursor: string | null | undefined): {
  field: PaginatedField
  offset: number
} | null {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 128) return null
  const at = cursor.lastIndexOf(':')
  if (at <= 0) return null
  const field = cursor.slice(0, at)
  const offset = Number(cursor.slice(at + 1))
  if (!(PAGINATED_FIELDS as readonly string[]).includes(field)) return null
  if (!Number.isSafeInteger(offset) || offset < 0) return null
  return { field: field as PaginatedField, offset }
}

function formatCursor(field: PaginatedField, offset: number): string {
  return `${field}:${offset}`
}

/** Coerces an untrusted query object into one this module will act on. */
export function sanitizeQuery(raw: unknown): StateLayerQuery {
  const q = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  const fields = Array.isArray(q.fields)
    ? [...new Set(q.fields.filter(isProjectableField))]
    : undefined

  const level = Array.isArray(q.level)
    ? q.level.filter((l): l is ConsoleLevel => CONSOLE_LEVELS.includes(l as ConsoleLevel))
    : typeof q.level === 'string' && CONSOLE_LEVELS.includes(q.level as ConsoleLevel)
      ? [q.level as ConsoleLevel]
      : undefined

  const type = Array.isArray(q.type)
    ? q.type.filter((t): t is InputEventType => INPUT_TYPES.includes(t as InputEventType))
    : typeof q.type === 'string' && INPUT_TYPES.includes(q.type as InputEventType)
      ? [q.type as InputEventType]
      : undefined

  // Clamped, never merely defaulted: a client asking for 10 MB does not get to
  // move the number the acceptance is measured against.
  const requested = typeof q.max_bytes === 'number' && Number.isFinite(q.max_bytes)
    ? Math.floor(q.max_bytes)
    : MAX_RESPONSE_BYTES
  const max_bytes = Math.max(ENVELOPE_RESERVE + 256, Math.min(requested, MAX_RESPONSE_BYTES))

  return {
    fields: fields && fields.length > 0 ? fields : undefined,
    level: level && level.length > 0 ? level : undefined,
    type: type && type.length > 0 ? type : undefined,
    cursor: typeof q.cursor === 'string' ? q.cursor : null,
    max_bytes
  }
}

/* ------------------------------------------------------------------ *
 * Video links (FR-AGT.2)
 * ------------------------------------------------------------------ */

/**
 * `capture://asset/<id>#t=<seconds>` — the media-fragment form, so the link is
 * directly seekable by the same scheme the app already serves assets on.
 *
 * This is the acceptance clause easiest to drop, so it is applied centrally in
 * `project()` rather than by each field's reader.
 */
export function videoUrl(captureId: string, tMs: number): string {
  const seconds = Math.max(0, tMs) / 1000
  return `capture://asset/${captureId}#t=${seconds.toFixed(3)}`
}

/* ------------------------------------------------------------------ *
 * Byte accounting
 * ------------------------------------------------------------------ */

function byteLen(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
}

/**
 * Shrinks an entry that does not fit the remaining budget.
 *
 * **Why this exists at all:** if an oversized entry were simply never emitted,
 * `next_cursor` would point at it forever and a paging agent would loop without
 * ever advancing — a livelock that looks like a hang, not an error. So an entry
 * always advances the cursor: its long string fields are cut down with an
 * explicit marker, and the entry is flagged so a consumer can tell a shortened
 * message from a genuinely short one.
 *
 * `t_ms` and `video_url` are never touched — they are the two things the
 * acceptance requires to survive projection.
 */
function shrinkEntry(entry: ProjectedEntry, budget: number): ProjectedEntry {
  const out: ProjectedEntry = { ...entry, truncated_fields: [] as string[] }
  const marks: string[] = []

  // Longest strings first: cutting the biggest field recovers the most bytes per
  // field lost, so fewer fields end up damaged overall.
  const strings = Object.entries(entry)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .filter(([k]) => k !== 'video_url')
    .sort((a, b) => b[1].length - a[1].length)

  for (const [key, value] of strings) {
    if (byteLen(out) <= budget) break
    if (value.length <= MIN_FIELD_KEEP) continue
    out[key] = `${value.slice(0, MIN_FIELD_KEEP)}…[truncated]`
    marks.push(key)
  }

  // Still too large even with every string cut — drop the non-essential objects
  // rather than emit something that breaks the budget.
  if (byteLen(out) > budget) {
    for (const [key, value] of Object.entries(out)) {
      if (key === 't_ms' || key === 'video_url' || key === 'truncated_fields') continue
      if (typeof value === 'object' && value !== null) {
        out[key] = null
        marks.push(key)
      }
      if (byteLen(out) <= budget) break
    }
  }

  out.truncated_fields = marks
  return out
}

/* ------------------------------------------------------------------ *
 * Entry sources
 * ------------------------------------------------------------------ */

/**
 * Yields entries for a paginated field, from an NDJSON side file or an inline
 * array, whichever the sidecar carries (ADR-001 / DC-6 read shape).
 *
 * The NDJSON path is a streaming line scan. A line that will not parse is
 * skipped rather than aborting the query: one corrupt line in a 40 MB harvest
 * must not make the whole state layer unreadable.
 */
async function* readEntries(
  revisionDir: string,
  source: unknown
): AsyncGenerator<Record<string, unknown>> {
  if (source === null || source === undefined) return

  if (Array.isArray(source)) {
    for (const item of source) {
      if (typeof item === 'object' && item !== null) yield item as Record<string, unknown>
    }
    return
  }

  if (!isNdjsonRef(source as never)) return
  const ref = source as { path: string }
  // The path comes out of a sidecar file, which a user can hand-edit — so it is
  // checked against the same allowlist the writer used before it is joined.
  if (typeof ref.path !== 'string' || !isSafeRelPath(ref.path)) return

  const absolute = join(revisionDir, ref.path)
  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(absolute, { encoding: 'utf8' })
  } catch {
    return
  }

  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (line.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof parsed === 'object' && parsed !== null) {
        yield parsed as Record<string, unknown>
      }
    }
  } catch {
    // A read error mid-scan yields what was already produced. The caller reports
    // `truncated`, so the shortfall is visible rather than silent.
  } finally {
    lines.close()
    stream.destroy()
  }
}

function matchesConsole(entry: Record<string, unknown>, levels?: ConsoleLevel[]): boolean {
  if (!levels) return true
  return levels.includes(entry.level as ConsoleLevel)
}

function matchesInput(entry: Record<string, unknown>, types?: InputEventType[]): boolean {
  if (!types) return true
  return types.includes(entry.type as InputEventType)
}

/**
 * DC-1 says an event that cannot be timestamped is dropped, not guessed — so an
 * entry without a usable `t_ms` is not projected. Inventing a zero here would
 * manufacture a video link pointing at the wrong moment.
 */
function timestampOf(entry: Record<string, unknown>): number | null {
  const t = entry.t_ms
  return typeof t === 'number' && Number.isFinite(t) ? t : null
}

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

export interface ProjectOptions {
  /** Absolute path of the revision directory holding the NDJSON side files. */
  revisionDir: string
  sidecar: SidecarRead
  query?: unknown
}

/**
 * Projects a sidecar's state layer under a byte budget.
 *
 * Paginated fields are walked in a fixed order so a cursor means the same thing
 * across calls. The budget is spent in that order; the first field that runs out
 * of room produces `next_cursor` and everything after it is reported as
 * `truncated` rather than silently omitted.
 */
export async function project(options: ProjectOptions): Promise<ProjectionResult> {
  const { revisionDir, sidecar } = options
  const query = sanitizeQuery(options.query)
  const captureId = sidecar.capture_id
  const state = sidecar.state_layer
  const selected: ProjectableField[] = query.fields ?? [...PROJECTABLE_FIELDS]

  const result: ProjectionResult = {
    capture_id: captureId,
    schema_version: sidecar.schema_version,
    kind: sidecar.kind,
    fields: selected,
    state_layer: {},
    next_cursor: null,
    truncated: false,
    bytes: 0
  }

  // DC-2: a source that was attempted and is unavailable is reported, never
  // omitted. `unavailable` is cheap and is always answered when asked for.
  const unavailableFor = (field: ProjectableField): string | undefined =>
    state.unavailable.find((u) => u.source === field)?.reason

  if (selected.includes('unavailable')) {
    result.state_layer.unavailable = { ref: state.unavailable }
  }

  // File-backed refs are a few dozen bytes each and are not worth paginating.
  for (const field of ['dom_snapshot', 'accessibility_tree', 'network_har'] as const) {
    if (!selected.includes(field)) continue
    const value = state[field]
    result.state_layer[field] = value === null
      ? { ref: null, unavailable: unavailableFor(field) ?? 'not_harvested' }
      : { ref: value }
  }

  let budget = (query.max_bytes ?? MAX_RESPONSE_BYTES) - ENVELOPE_RESERVE - byteLen(result)
  const resume = parseCursor(query.cursor)
  let reached = resume === null

  for (const field of PAGINATED_FIELDS) {
    if (!selected.includes(field)) continue

    // Skip forward to the field the cursor names; earlier fields were fully
    // delivered by the call that produced it.
    if (!reached && resume?.field !== field) continue
    const startOffset = !reached && resume ? resume.offset : 0
    reached = true

    const source = field === 'agent_trace' ? state.agent_trace : state[field]
    const bucket: ProjectedField = { entries: [] }
    result.state_layer[field] = bucket

    if (source === null) {
      bucket.entries = undefined
      bucket.unavailable = unavailableFor(field) ?? 'not_harvested'
      continue
    }

    if (isNdjsonRef(source as never) && typeof (source as { count?: number }).count === 'number') {
      bucket.available = (source as { count: number }).count
    } else if (Array.isArray(source)) {
      bucket.available = source.length
    }

    // `index` counts *matching* entries, so a cursor stays valid under the same
    // filter regardless of how many non-matching rows sit between them.
    let index = 0
    let stopped = false

    for await (const raw of readEntries(revisionDir, source)) {
      if (field === 'console_log' && !matchesConsole(raw, query.level)) continue
      if (field === 'input_events' && !matchesInput(raw, query.type)) continue

      const tMs = timestampOf(raw)
      if (tMs === null) continue

      const position = index++
      if (position < startOffset) continue

      const entry: ProjectedEntry = { ...raw, t_ms: tMs, video_url: videoUrl(captureId, tMs) }
      // +1 for the separating comma; the array brackets are inside the reserve.
      const cost = byteLen(entry) + 1

      if (cost > budget) {
        if (budget > MIN_FIELD_KEEP * 2) {
          // Fits once shrunk: emit it so the cursor advances past it. Never
          // leaving an oversized entry unemitted is what stops a paging loop.
          const shrunk = shrinkEntry(entry, budget - 1)
          if (byteLen(shrunk) + 1 <= budget) {
            bucket.entries?.push(shrunk)
            budget -= byteLen(shrunk) + 1
            result.next_cursor = formatCursor(field, position + 1)
          } else {
            result.next_cursor = formatCursor(field, position)
          }
        } else {
          result.next_cursor = formatCursor(field, position)
        }
        bucket.truncated = true
        result.truncated = true
        stopped = true
        break
      }

      bucket.entries?.push(entry)
      budget -= cost
    }

    if (stopped) break
  }

  // Fields never reached because the budget ran out are reported, not dropped —
  // otherwise an agent cannot tell "empty" from "you did not get this yet".
  if (result.truncated) {
    for (const field of PAGINATED_FIELDS) {
      if (!selected.includes(field)) continue
      if (result.state_layer[field]) continue
      result.state_layer[field] = { truncated: true }
    }
  }

  result.bytes = byteLen(result)
  return result
}

/**
 * The exact bytes a caller should transmit, and the number the acceptance is
 * measured against.
 *
 * `bytes` is written into the object before serialization, so writing it changes
 * the length by at most the digits of the count; the envelope reserve covers
 * that with several hundred bytes to spare.
 */
export function serializeResult(result: ProjectionResult): string {
  return JSON.stringify(result)
}
