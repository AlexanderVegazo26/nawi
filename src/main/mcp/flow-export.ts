import { flowFromRecording, stringifyFlow, FLOW_FILE_SUFFIX, type FlowTarget, type SkipReason } from '@shared/flow'
import type { SidecarRead, UnavailableReason } from '@shared/sidecar/types'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { isNdjsonRef } from '@shared/sidecar/types'
import { isSafeRelPath } from '../sidecar/paths'
import { readEntries } from './projection'

/**
 * `export_flow`'s work, kept free of Electron so it can be tested against a real
 * revision directory: read a revision's input events (NDJSON side file or the
 * inline DC-4 array) and turn them into flow YAML.
 */

/**
 * The most input events one export reads. The harvest keeps at most 50 000 per
 * recording, so this only bites on a hand-made or foreign sidecar, where it
 * bounds memory; the reply then says the flow covers only the start.
 */
export const MAX_EXPORT_EVENTS = 50_000

export class NoInputEventsError extends Error {
  /** `unreadable`: the sidecar names an events file that is missing, unreadable or outside the revision. */
  constructor(readonly reason: UnavailableReason | 'not_harvested' | 'unreadable') {
    super(`no input events (${reason})`)
  }
}

export interface FlowExport {
  revision: string
  /** A suggested file name; nothing is written. */
  file_name: string
  steps: number
  /** Input events read from the revision. */
  events: number
  merged: number
  skipped: Partial<Record<SkipReason, number>>
  warnings: string[]
  flow_yaml: string
}

export async function flowFromSidecar(options: {
  revisionDir: string
  sidecar: SidecarRead
  revision: string
  name?: string
  /** Tests only: a smaller cap than MAX_EXPORT_EVENTS. */
  maxEvents?: number
}): Promise<FlowExport> {
  const maxEvents = options.maxEvents ?? MAX_EXPORT_EVENTS
  const { sidecar } = options
  const source = sidecar.state_layer.input_events
  if (source === null) {
    const reason = sidecar.state_layer.unavailable.find((u) => u.source === 'input_events')?.reason
    throw new NoInputEventsError(reason ?? 'not_harvested')
  }

  // readEntries yields nothing for a file it can't open (get_state_layer reports
  // that as an empty page); an export would turn it into an empty flow that
  // looks like a recording with no input, so check the file first.
  if (isNdjsonRef(source as never)) {
    const path = (source as { path?: unknown }).path
    if (typeof path !== 'string' || !isSafeRelPath(path)) throw new NoInputEventsError('unreadable')
    try {
      await access(join(options.revisionDir, path), constants.R_OK)
    } catch {
      throw new NoInputEventsError('unreadable')
    }
  }

  const events: Record<string, unknown>[] = []
  let truncated = false
  for await (const entry of readEntries(options.revisionDir, source)) {
    if (events.length >= maxEvents) {
      truncated = true
      break
    }
    events.push(entry)
  }

  const surface = sidecar.surface
  const hasUrl = typeof surface.url === 'string' && /\S/.test(surface.url)
  // A browser recording that didn't save its start page is still a browser flow:
  // its steps use page selectors, which a desktop target can never replay.
  const missingStartUrl = !hasUrl && surface.type === 'browser'
  const target: FlowTarget = hasUrl
    ? { kind: 'browser', url: surface.url as string }
    : missingStartUrl
      ? { kind: 'browser', url: 'about:blank' }
      : { kind: 'desktop', app: /\S/.test(surface.app) ? surface.app : 'unknown' }
  const name = options.name && /\S/.test(options.name) ? options.name : `Recording ${sidecar.created_at}`
  const result = flowFromRecording(events, { name, target })

  const warnings = [
    ...(truncated
      ? [`Only the first ${maxEvents} input events were read; the flow covers the start of the recording only.`]
      : []),
    ...(missingStartUrl
      ? [
          "The recording didn't save the page it started on, so the flow starts on about:blank; " +
            'set target.url to that page before replaying.'
        ]
      : []),
    ...result.warnings
  ]

  return {
    revision: options.revision,
    file_name: `${fileSlug(name)}${FLOW_FILE_SUFFIX}`,
    steps: result.flow.steps.length,
    events: events.length,
    merged: result.merged,
    skipped: result.skipped,
    warnings,
    flow_yaml: stringifyFlow(result.flow)
  }
}

function fileSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return s || 'recording'
}
