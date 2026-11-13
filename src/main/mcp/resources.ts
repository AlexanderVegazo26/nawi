import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from './errors'
import { RUN_ASSET_RE, RUN_ID_RE, listRuns, readRunRecord } from '../run-record'
import { within } from '../flow-run'

/**
 * Roadmap AI12: saved runs as MCP resources.
 *
 * Every run record (F4) is a folder of files an agent may want to read without
 * a tool call: the record itself, its JUnit and HTML reports, and the step
 * screenshots. They are addressed as
 *
 *     nawi://runs/<run-id>/run.json
 *     nawi://runs/<run-id>/report.html
 *     nawi://runs/<run-id>/junit.xml
 *     nawi://runs/<run-id>/network.har (browser runs, roadmap DT1: the run's requests by step)
 *     nawi://runs/<run-id>/steps/<NNN-step>.png | .before.jpg | .after.jpg | .before.png | .after.png (Android)
 *
 * `resources/list` names the record and report of the newest runs;
 * `resources/templates/list` gives the URI patterns for any run (the ids come
 * from `list_runs`, the screenshot names from the record's steps).
 *
 * Electron-free: the server passes the runs folder in, so this is tested
 * against a temporary folder. A URI is parsed against the same patterns the
 * writer uses (run id, asset names), so it can only ever name a file the run
 * writer could have written; the real path is checked to stay inside that
 * run's own folder too (which must itself be a real folder in the runs
 * folder), and the file read is the checked real path, so a symlink planted in
 * a run folder cannot point a read elsewhere.
 */

export const RUN_URI_PREFIX = 'nawi://runs/'
/** How many runs `resources/list` names (each gives up to two resources). */
export const LISTED_RUNS = 50
/** A resource is read whole into one JSON-RPC message; refuse anything larger than this. */
export const MAX_RESOURCE_BYTES = 8 * 1024 * 1024

const RECORD_FILES = {
  'run.json': 'application/json',
  'report.html': 'text/html',
  'junit.xml': 'application/xml'
} as const

export interface ResourceDescriptor {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType: string
  size?: number
}

export interface ResourceTemplate {
  uriTemplate: string
  name: string
  title: string
  description: string
  mimeType?: string
}

export type ResourceContents =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string }

export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    uriTemplate: `${RUN_URI_PREFIX}{run_id}/run.json`,
    name: 'run-record',
    title: 'Run record',
    description: 'What a saved flow run did, step by step (the same record get_run returns). Run ids come from list_runs.',
    mimeType: 'application/json'
  },
  {
    uriTemplate: `${RUN_URI_PREFIX}{run_id}/report.html`,
    name: 'run-report',
    title: 'Run report',
    description: 'The run as one self-contained HTML page with its screenshots inlined.',
    mimeType: 'text/html'
  },
  {
    uriTemplate: `${RUN_URI_PREFIX}{run_id}/junit.xml`,
    name: 'run-junit',
    title: 'Run JUnit XML',
    description: 'The run result for CI test reporters.',
    mimeType: 'application/xml'
  },
  {
    uriTemplate: `${RUN_URI_PREFIX}{run_id}/network.har`,
    name: 'run-network',
    title: 'Run network log (HAR)',
    description:
      "Browser runs: every request the run sent, as HAR 1.2, each entry tagged with the step that sent it (`_step_id`, or `_opening`) and its time since the run started (`_t_ms`). No bodies; secrets scrubbed. Present when run.json has `network_har`.",
    mimeType: 'application/json'
  },
  {
    uriTemplate: `${RUN_URI_PREFIX}{run_id}/{+screenshot}`,
    name: 'run-screenshot',
    title: 'Run screenshot',
    description:
      "A screenshot from the run: a step's `screenshot`, `shots.before` or `shots.after` path in run.json (steps/003-save.after.jpg; Android device screens are .png)."
  }
]

export interface RunUri {
  runId: string
  /** Path inside the run folder: run.json, report.html, junit.xml, network.har or steps/<file>. */
  file: string
  mimeType: string
}

/** Parses a run resource URI, or returns null for anything that is not exactly one. */
export function parseRunUri(uri: string): RunUri | null {
  if (!uri.startsWith(RUN_URI_PREFIX)) return null
  const rest = uri.slice(RUN_URI_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const runId = rest.slice(0, slash)
  const file = rest.slice(slash + 1)
  if (!RUN_ID_RE.test(runId)) return null
  if (Object.hasOwn(RECORD_FILES, file)) return { runId, file, mimeType: RECORD_FILES[file as keyof typeof RECORD_FILES] }
  if (RUN_ASSET_RE.test(file)) {
    const mimeType = file.endsWith('.har') ? 'application/json' : file.endsWith('.png') ? 'image/png' : 'image/jpeg'
    return { runId, file, mimeType }
  }
  return null
}

/** The record and (when the run has one) the HTML report of the newest runs, newest first. */
export async function listRunResources(runsRoot: string, limit: number = LISTED_RUNS): Promise<ResourceDescriptor[]> {
  const runs = await listRuns(runsRoot, { limit })
  const reports = await Promise.all(runs.map((run) => fs.lstat(join(runsRoot, run.run_id, 'report.html')).catch(() => null)))
  const out: ResourceDescriptor[] = []
  runs.forEach((run, i) => {
    const label = `${run.flow.name}: ${run.status}`
    const when = `started ${run.started_at}, ${run.totals.passed} passed, ${run.totals.failed} failed`
    out.push({
      uri: `${RUN_URI_PREFIX}${run.run_id}/run.json`,
      name: `${run.run_id}/run.json`,
      title: `Run ${label}`,
      description: `Run record (${when}).`,
      mimeType: RECORD_FILES['run.json']
    })
    const report = reports[i]
    // Not offered when a read would refuse it as too large.
    if (report?.isFile() && report.size <= MAX_RESOURCE_BYTES) {
      out.push({
        uri: `${RUN_URI_PREFIX}${run.run_id}/report.html`,
        name: `${run.run_id}/report.html`,
        title: `Report ${label}`,
        description: `HTML report (${when}).`,
        mimeType: RECORD_FILES['report.html'],
        size: report.size
      })
    }
  })
  return out
}

/** Reads one run resource. Throws `ToolError` INVALID_ARGUMENTS, NOT_FOUND or UNAVAILABLE (too large). */
export async function readRunResource(runsRoot: string, uri: unknown): Promise<ResourceContents> {
  if (typeof uri !== 'string') throw new ToolError('INVALID_ARGUMENTS', 'resources/read requires a string "uri"')
  const parsed = parseRunUri(uri)
  if (!parsed) {
    throw new ToolError(
      'INVALID_ARGUMENTS',
      `Not a Nawi run resource: expected ${RUN_URI_PREFIX}<run_id>/run.json, report.html, junit.xml, network.har or steps/<file> (see resources/templates/list).`,
      { uri }
    )
  }
  const missing = (): ToolError =>
    new ToolError('NOT_FOUND', `No resource ${uri}. Call list_runs for the runs that exist, and get_run for a run's files.`, { uri })

  // A run folder that is not a whole record (being written, damaged, from a
  // newer app) is not shown at all, the same rule as list_runs/get_run.
  if (!(await readRunRecord(runsRoot, parsed.runId))) throw missing()

  // Resolved once, then only the resolved path is used: a link swapped in after
  // the check cannot redirect the read.
  let real: string
  let runReal: string
  let root: string
  try {
    ;[real, runReal, root] = await Promise.all([
      fs.realpath(join(runsRoot, parsed.runId, parsed.file)),
      fs.realpath(join(runsRoot, parsed.runId)),
      fs.realpath(runsRoot)
    ])
  } catch {
    throw missing()
  }
  if (runReal !== join(root, parsed.runId) || !within(runReal, real)) throw missing()
  const handle = await fs.open(real, 'r').catch(() => null)
  if (!handle) throw missing()
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw missing()
    if (stat.size > MAX_RESOURCE_BYTES) {
      throw new ToolError(
        'UNAVAILABLE',
        `${uri} is ${stat.size} bytes, more than the ${MAX_RESOURCE_BYTES} a resource read returns. Open it from the run folder instead.`,
        { uri, size: stat.size, limit: MAX_RESOURCE_BYTES }
      )
    }
    const bytes = await handle.readFile()
    return parsed.mimeType.startsWith('image/')
      ? { uri, mimeType: parsed.mimeType, blob: bytes.toString('base64') }
      : { uri, mimeType: parsed.mimeType, text: bytes.toString('utf8') }
  } finally {
    await handle.close()
  }
}
