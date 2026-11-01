import { flowFromRecording, stringifyFlow, FLOW_FILE_SUFFIX, type FlowTarget, type SkipReason } from '@shared/flow'
import type { SidecarRead, UnavailableReason } from '@shared/sidecar/types'
import { readEntries } from './projection'

/**
 * `export_flow`'s work, kept free of Electron so it can be tested against a real
 * revision directory: read a revision's input events (NDJSON side file or the
 * inline DC-4 array) and turn them into flow YAML.
 */

export class NoInputEventsError extends Error {
  constructor(readonly reason: UnavailableReason | 'not_harvested') {
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
}): Promise<FlowExport> {
  const { sidecar } = options
  const source = sidecar.state_layer.input_events
  if (source === null) {
    const reason = sidecar.state_layer.unavailable.find((u) => u.source === 'input_events')?.reason
    throw new NoInputEventsError(reason ?? 'not_harvested')
  }

  const events: Record<string, unknown>[] = []
  for await (const entry of readEntries(options.revisionDir, source)) events.push(entry)

  const surface = sidecar.surface
  const target: FlowTarget =
    surface.url && /\S/.test(surface.url)
      ? { kind: 'browser', url: surface.url }
      : { kind: 'desktop', app: /\S/.test(surface.app) ? surface.app : 'unknown' }
  const name = options.name && /\S/.test(options.name) ? options.name : `Recording ${sidecar.created_at}`
  const result = flowFromRecording(events, { name, target })

  return {
    revision: options.revision,
    file_name: `${fileSlug(name)}${FLOW_FILE_SUFFIX}`,
    steps: result.flow.steps.length,
    events: events.length,
    merged: result.merged,
    skipped: result.skipped,
    warnings: result.warnings,
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
