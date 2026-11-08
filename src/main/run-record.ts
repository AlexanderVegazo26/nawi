import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ConsoleError, FailedRequest, StepEvidence } from './replay/evidence'
import type { FlowRun, StepRun } from './replay/replay'
import { anchorMissText } from './replay/visual-anchor'

/**
 * Roadmap F4a: the run record. Every `run_flow` / `nawi run` leaves one folder
 * in the app's data directory:
 *
 *     runs/<run-id>/run.json            what ran, where, and how each step went
 *     runs/<run-id>/junit.xml           the same result for CI test reporters
 *     runs/<run-id>/report.html         the same result as one self-contained page (F4c, run-report.ts)
 *     runs/<run-id>/steps/NNN-<id>.png  screenshots the flow's `screenshot` steps took
 *     runs/<run-id>/steps/NNN-<id>.before.jpg / .after.jpg
 *                                       the page around each step (F4b2), when the run took them
 *
 * Per step it also keeps what the page did meanwhile (F4b): console errors,
 * failed requests (status >= 400 or no response) and the URL after the step.
 * These are optional fields, so a reader of version 1 records keeps working.
 * So are AI1's: each matched locator names its layer (testid/id/role/text/css,
 * or `visual` with a `score` when the step's reference crop was found on screen,
 * recorded as `{ image }` at index `selectors.length`) and whether it was a fallback, the record lists the steps that passed only
 * through a fallback (`fallback_step_ids`, the flow drifting from the app),
 * and a step carries its `intent`.
 *
 * Electron-free and pure apart from the write, so the format is tested without
 * an app. The folder is written under a temporary name and renamed into place,
 * so a reader never sees a half-written run. The text in it comes from the
 * replayer's report, which has already scrubbed secret values, and typed
 * values are never in it. In every screenshot, fields the run typed a secret
 * into are drawn as discs (the replayer masks them before capturing); a secret
 * the page itself echoes elsewhere as text is not masked.
 */

export const RUN_RECORD_VERSION = 1
/** How many runs the app keeps; older ones are deleted after each new run. */
export const DEFAULT_KEEP_RUNS = 200
/**
 * How many apply_heal replays (records with `heal_of`) are kept, on top of
 * the `keep` ordinary runs: a burst of heal attempts never pushes real runs out.
 */
export const KEPT_HEAL_REPLAYS = 20
/**
 * Empty file in the folder of a run with `heal_of`, so pruneRuns can tell the
 * two kinds apart without parsing every run.json.
 */
export const HEAL_REPLAY_MARKER = 'heal-replay'

/** `20261102T103900123Z-a1b2c3`: sorts by start time, and is safe as a folder name everywhere. */
export const RUN_ID_RE = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/
const STEP_ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,63}'
const STEP_ID_RE = new RegExp(`^${STEP_ID}$`)
/** A screenshot file inside a run folder, relative to it (`steps/003-save.after.jpg`). */
export const RUN_ASSET_RE = new RegExp(`^steps/\\d{3}(?:-${STEP_ID})?(?:\\.png|\\.(?:before|after)\\.jpg)$`)
/** Folders a write in progress uses; one older than this was left by a crash. */
const STALE_TEMP_MS = 60 * 60 * 1000

export function newRunId(startedAt: number, random: () => string = () => randomBytes(3).toString('hex')): string {
  const iso = new Date(startedAt).toISOString() // 2026-11-02T10:39:00.123Z
  return `${iso.slice(0, 19).replace(/[-:]/g, '')}${iso.slice(20, 23)}Z-${random()}`
}

export interface RunEnvironment {
  app_version?: string
  os: { platform: string; release: string; arch: string }
  /** From `Browser.getVersion`; absent when the run ended before a browser was opened. */
  browser?: { product: string; protocol_version?: string }
  /** The page's CSS viewport when the run ended. */
  viewport?: { width: number; height: number; device_scale_factor: number }
}

type EvidenceKey = keyof StepEvidence

/** The evidence as run.json spells it. */
export interface RecordedEvidence {
  console_errors?: ConsoleError[]
  console_errors_dropped?: number
  failed_requests?: FailedRequest[]
  failed_requests_dropped?: number
}

export interface RecordedStep
  extends Omit<StepRun, 'screenshotPng' | 'shots' | 'startedAt' | 'durationMs' | EvidenceKey>,
    RecordedEvidence {
  /** Page URL after the step, scrubbed of secrets and token-like parameters. */
  url?: string
  /** ISO time the step started; absent for steps that never ran. */
  started_at?: string
  duration_ms?: number
  /** Path of the step's screenshot, relative to the run folder. */
  screenshot?: string
  /**
   * The page before and after the step (JPEG), relative to the run folder. A
   * step's `before` is usually the previous step's `after` file: the same
   * moment, stored once.
   */
  shots?: ShotFiles
}

/** Screenshot files of one step, relative to the run folder. */
export interface ShotFiles {
  before?: string
  after?: string
}

export interface RunRecord {
  version: typeof RUN_RECORD_VERSION
  run_id: string
  flow: { name: string; file: string; sha256: string }
  status: FlowRun['status']
  started_at: string
  duration_ms: number
  error?: string
  failed_step_id?: string
  totals: { passed: number; failed: number; skipped: number; not_run: number }
  environment: RunEnvironment
  /** Console errors and failed requests while the target was opening, before the first step. */
  opening?: RecordedEvidence
  /** The page's URL when the run ended, scrubbed. */
  final_url?: string
  /**
   * Steps that passed although a more stable locator found nothing (their
   * target came from a fallback): the flow no longer matches the app as recorded.
   * Absent when there are none.
   */
  fallback_step_ids?: string[]
  /**
   * Set when this run is apply_heal's replay of the healing proposals of run
   * `heal_of`: it replayed proposed flow text, not the file's bytes, so
   * `flow.sha256` is that text's hash (the file holds it only if the heal was
   * written). Absent for ordinary runs.
   */
  heal_of?: string
  steps: RecordedStep[]
}

function recordedEvidence(e: Omit<StepEvidence, 'url'>): RecordedEvidence {
  return {
    ...(e.consoleErrors?.length ? { console_errors: e.consoleErrors } : {}),
    ...(e.consoleErrorsDropped ? { console_errors_dropped: e.consoleErrorsDropped } : {}),
    ...(e.failedRequests?.length ? { failed_requests: e.failedRequests } : {}),
    ...(e.failedRequestsDropped ? { failed_requests_dropped: e.failedRequestsDropped } : {})
  }
}

export interface RunRecordInput {
  runId: string
  flow: { name: string; file: string; sha256: string }
  run: FlowRun
  environment: RunEnvironment
  /** The run whose healing proposals this run replayed (apply_heal). */
  healOf?: string
}

/** The record plus the screenshot files it refers to (relative path → PNG bytes). */
export function buildRunRecord(input: RunRecordInput): { record: RunRecord; assets: Map<string, Buffer> } {
  const { run } = input
  const assets = new Map<string, Buffer>()
  // Step ids are schema-checked already; checked again because this one becomes a file name.
  const stem = (index: number, id: string): string => `steps/${String(index + 1).padStart(3, '0')}${STEP_ID_RE.test(id) ? `-${id}` : ''}`
  /** File of each shot already written, by its base64 text: an identical shot is stored once. */
  const shotFiles = new Map<string, string>()
  const shotFile = (data: string, name: string): string => {
    const known = shotFiles.get(data)
    if (known !== undefined) return known
    assets.set(name, Buffer.from(data, 'base64'))
    shotFiles.set(data, name)
    return name
  }
  const steps = run.steps.map((step, index): RecordedStep => {
    const {
      screenshotPng,
      shots,
      startedAt,
      durationMs,
      consoleErrors,
      consoleErrorsDropped,
      failedRequests,
      failedRequestsDropped,
      url,
      ...rest
    } = step
    const out: RecordedStep = {
      ...rest,
      ...(url !== undefined ? { url } : {}),
      ...recordedEvidence({ consoleErrors, consoleErrorsDropped, failedRequests, failedRequestsDropped })
    }
    if (startedAt !== undefined) out.started_at = new Date(startedAt).toISOString()
    if (durationMs !== undefined) out.duration_ms = durationMs
    if (screenshotPng !== undefined) {
      const name = `${stem(index, step.id)}.png`
      assets.set(name, Buffer.from(screenshotPng, 'base64'))
      out.screenshot = name
    }
    if (shots && (shots.before !== undefined || shots.after !== undefined)) {
      out.shots = {
        ...(shots.before !== undefined ? { before: shotFile(shots.before, `${stem(index, step.id)}.before.jpg`) } : {}),
        ...(shots.after !== undefined ? { after: shotFile(shots.after, `${stem(index, step.id)}.after.jpg`) } : {})
      }
    }
    return out
  })
  const count = (status: StepRun['status']): number => run.steps.filter((s) => s.status === status).length
  const opening = run.opening && recordedEvidence(run.opening)
  // Passed steps only: a failed step's own error is what to read, not the drift note.
  const fallbacks = run.steps.filter((s) => s.status === 'passed' && s.matched?.fallback === true).map((s) => s.id)
  const record: RunRecord = {
    version: RUN_RECORD_VERSION,
    run_id: input.runId,
    flow: input.flow,
    status: run.status,
    started_at: new Date(run.startedAt).toISOString(),
    duration_ms: run.durationMs,
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.failedStepId !== undefined ? { failed_step_id: run.failedStepId } : {}),
    totals: { passed: count('passed'), failed: count('failed'), skipped: count('skipped'), not_run: count('not_run') },
    environment: input.environment,
    ...(opening && Object.keys(opening).length > 0 ? { opening } : {}),
    ...(run.finalUrl !== undefined ? { final_url: run.finalUrl } : {}),
    ...(fallbacks.length > 0 ? { fallback_step_ids: fallbacks } : {}),
    ...(input.healOf !== undefined ? { heal_of: input.healOf } : {}),
    steps
  }
  return { record, assets }
}

/** Characters XML 1.0 cannot carry at all (most C0 controls, lone surrogates, U+FFFE/U+FFFF). */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export function xmlEscape(value: string): string {
  return value
    .replace(NOT_XML, '�')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const seconds = (ms: number | undefined): string => ((ms ?? 0) / 1000).toFixed(3)

/** The selector as one readable token, for failure text. */
export function describe(selector: Record<string, unknown>): string {
  return Object.entries(selector)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
}

/** `matched locator 1 (role, fallback) role=button name=Save`, for text output. */
export function matchedLine(matched: NonNullable<RecordedStep['matched']>): string {
  // Records written before AI1 have no layer: say nothing rather than guess.
  const layer = typeof matched.layer === 'string' ? ` (${matched.layer}${matched.fallback ? ', fallback' : ''})` : ''
  return `matched locator ${matched.index}${layer} ${describe(matched.selector as Record<string, unknown>)}${scoreText(matched.score)}`
}

/** ` score=0.987` for a visual-anchor match, else nothing. */
export function scoreText(score: unknown): string {
  return typeof score === 'number' ? ` score=${score}` : ''
}

/** Why a locator missed: invalid, no match, N matches; for the visual anchor, in its own words. */
export function missReason(miss: NonNullable<RecordedStep['misses']>[number]): string {
  if (miss.invalid) return `invalid: ${miss.invalid}`
  if ('image' in miss.selector) return anchorMissText(miss)
  return miss.found === 0 ? 'no match' : `${miss.found} matches`
}

function failureDetail(step: RecordedStep): string {
  const lines = [step.error ?? 'the step failed']
  if (step.intent !== undefined) lines.push(`  intent: ${step.intent}`)
  for (const miss of step.misses ?? []) {
    const why = missReason(miss)
    lines.push(`  locator ${miss.index} ${describe(miss.selector as Record<string, unknown>)}: ${why}`)
  }
  if (step.matched) lines.push(`  ${matchedLine(step.matched)}`)
  if (step.suggested) {
    const s = step.suggested
    lines.push(`  suggested (unverified, score ${s.score}): ${s.role || 'control'} "${s.name}" -> ${s.candidates.map((c) => describe(c as Record<string, unknown>)).join(' | ')}`)
  }
  if (step.url !== undefined) lines.push(`  page: ${step.url}`)
  if (step.shots?.after !== undefined) lines.push(`  screenshot after the step: ${step.shots.after} (in the run folder)`)
  lines.push(...evidenceLines(step).map((l) => `  ${l}`))
  return lines.join('\n')
}

/** Console errors and failed requests as text lines, for JUnit. */
export function evidenceLines(e: RecordedEvidence): string[] {
  const lines: string[] = []
  for (const c of e.console_errors ?? []) lines.push(`console ${c.source}: ${c.message}`)
  if (e.console_errors_dropped) lines.push(`(${e.console_errors_dropped} more console errors not kept)`)
  for (const r of e.failed_requests ?? []) {
    lines.push(`request ${r.method} ${r.url}: ${r.status !== undefined ? `HTTP ${r.status}` : (r.error ?? 'failed')}`)
  }
  if (e.failed_requests_dropped) lines.push(`(${e.failed_requests_dropped} more failed requests not kept)`)
  return lines
}

/**
 * JUnit XML (the dialect CI test reporters read): one `<testsuite>` per flow
 * and one `<testcase>` per step. A failed step is a `<failure>` naming each
 * locator that missed; a disabled step or a step after the failure is
 * `<skipped>`. A run that failed before any step (missing inputs, the run was
 * stopped) gets an extra `(run)` test case with an `<error>`, so a reporter
 * never shows such a run as green.
 */
export function toJUnitXml(record: RunRecord): string {
  const runError = record.status === 'failed' && record.failed_step_id === undefined
  const tests = record.steps.length + (runError ? 1 : 0)
  const skipped = record.totals.skipped + record.totals.not_run
  const suite = xmlEscape(record.flow.name)
  const counts = `tests="${tests}" failures="${record.totals.failed}" errors="${runError ? 1 : 0}" skipped="${skipped}" time="${seconds(record.duration_ms)}"`
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="nawi" ${counts}>`,
    // The JUnit schema's timestamp has no fraction or zone; started_at is UTC.
    `  <testsuite name="${suite}" ${counts} timestamp="${record.started_at.slice(0, 19)}">`,
    '    <properties>',
    `      <property name="nawi.run_id" value="${xmlEscape(record.run_id)}"/>`,
    `      <property name="nawi.flow_file" value="${xmlEscape(record.flow.file)}"/>`,
    `      <property name="nawi.flow_sha256" value="${record.flow.sha256}"/>`,
    '    </properties>'
  ]
  // What failed while the target was opening belongs to no step; a run error repeats it in its own case below.
  const opening = evidenceLines(record.opening ?? {})
  if (opening.length > 0 && !runError) {
    out.push(`    <system-err>${xmlEscape(['while opening the target:', ...opening].join('\n'))}</system-err>`)
  }
  for (const step of record.steps) {
    const open = `    <testcase classname="${suite}" name="${xmlEscape(`${step.id} (${step.action})`)}" time="${seconds(step.duration_ms)}"`
    const evidence = evidenceLines(step)
    if (step.status === 'passed') {
      // A passing step can still have logged errors: CI reporters show <system-err> next to the test.
      if (evidence.length === 0) out.push(`${open}/>`)
      else out.push(`${open}>`, `      <system-err>${xmlEscape(evidence.join('\n'))}</system-err>`, '    </testcase>')
    } else if (step.status === 'failed') {
      out.push(
        `${open}>`,
        `      <failure message="${xmlEscape(step.error ?? 'the step failed')}" type="step_failed">${xmlEscape(failureDetail(step))}</failure>`,
        '    </testcase>'
      )
    } else {
      const why = step.status === 'skipped' ? 'disabled in the flow' : 'not run: an earlier step failed or the run stopped'
      out.push(`${open}>`, `      <skipped message="${why}"/>`, '    </testcase>')
    }
  }
  if (runError) {
    const message = record.error ?? 'the run failed before any step'
    const body = [message, ...evidenceLines(record.opening ?? {}).map((l) => `  ${l}`)].join('\n')
    out.push(
      `    <testcase classname="${suite}" name="(run)" time="0.000">`,
      `      <error message="${xmlEscape(message)}" type="run_failed">${xmlEscape(body)}</error>`,
      '    </testcase>'
    )
  }
  out.push('  </testsuite>', '</testsuites>', '')
  return out.join('\n')
}

/**
 * Writes `runs/<run-id>/` atomically (temporary folder, then rename) and
 * returns its path. Never overwrites an existing run.
 */
export async function writeRunRecord(
  runsRoot: string,
  record: RunRecord,
  assets: Map<string, Buffer>,
  /** The self-contained HTML report (`toHtmlReport`), saved as report.html. */
  reportHtml?: string
): Promise<string> {
  if (!RUN_ID_RE.test(record.run_id)) throw new Error(`not a run id: ${JSON.stringify(record.run_id)}`)
  if (record.heal_of !== undefined && !RUN_ID_RE.test(record.heal_of)) throw new Error(`not a run id: ${JSON.stringify(record.heal_of)}`)
  await fs.mkdir(runsRoot, { recursive: true })
  const final = join(runsRoot, record.run_id)
  const temp = join(runsRoot, `.tmp-${record.run_id}`)
  try {
    await fs.mkdir(temp)
    if (assets.size > 0) await fs.mkdir(join(temp, 'steps'))
    for (const [name, bytes] of assets) {
      if (!RUN_ASSET_RE.test(name)) throw new Error(`unsafe asset name ${name}`)
      await fs.writeFile(join(temp, name), bytes)
    }
    await fs.writeFile(join(temp, 'junit.xml'), toJUnitXml(record))
    if (reportHtml !== undefined) await fs.writeFile(join(temp, 'report.html'), reportHtml)
    if (record.heal_of !== undefined) await fs.writeFile(join(temp, HEAL_REPLAY_MARKER), '')
    // run.json last: its presence in a folder means the run is complete.
    await fs.writeFile(join(temp, 'run.json'), `${JSON.stringify(record, null, 2)}\n`)
    await fs.rename(temp, final)
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  return final
}

/**
 * Deletes all but the newest `keep` runs (by run id, which sorts by start
 * time), apply_heal replays beyond the newest KEPT_HEAL_REPLAYS (they don't
 * count toward `keep`), and temporary folders a crashed write left behind (older than an
 * hour, so a run being written right now is safe). Only folders named like a
 * run id are touched; anything else a user put in the folder stays. Returns
 * the names it deleted.
 */
export async function pruneRuns(runsRoot: string, keep: number = DEFAULT_KEEP_RUNS, now: number = Date.now()): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = await fs.readdir(runsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const runs = entries
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
  const ordinary: string[] = []
  const replays: string[] = []
  for (const name of runs) {
    const marked = await fs.access(join(runsRoot, name, HEAL_REPLAY_MARKER)).then(
      () => true,
      () => false
    )
    ;(marked ? replays : ordinary).push(name)
  }
  const oldest = (names: string[], kept: number): string[] => names.slice(0, Math.max(0, names.length - Math.max(0, kept)))
  const doomed = [...oldest(ordinary, keep), ...oldest(replays, Math.min(KEPT_HEAL_REPLAYS, keep))].sort()
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('.tmp-') || !RUN_ID_RE.test(e.name.slice(5))) continue
    const stat = await fs.stat(join(runsRoot, e.name)).catch(() => null)
    if (stat && now - stat.mtimeMs > STALE_TEMP_MS) doomed.push(e.name)
  }
  for (const name of doomed) await fs.rm(join(runsRoot, name), { recursive: true, force: true })
  return doomed
}

/** What `list_runs` shows of a run: enough to pick one, without its steps. */
export interface RunSummary {
  run_id: string
  flow: RunRecord['flow']
  status: RunRecord['status']
  started_at: string
  duration_ms: number
  totals: RunRecord['totals']
  failed_step_id?: string
  error?: string
  /** Present on apply_heal's replays: the run whose proposals were replayed. */
  heal_of?: string
}

export function summarizeRun(record: RunRecord): RunSummary {
  return {
    run_id: record.run_id,
    flow: record.flow,
    status: record.status,
    started_at: record.started_at,
    duration_ms: record.duration_ms,
    totals: record.totals,
    ...(record.failed_step_id !== undefined ? { failed_step_id: record.failed_step_id } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.heal_of !== undefined ? { heal_of: record.heal_of } : {})
  }
}

/**
 * Reads one run record. Returns null when there is no such run, or its run.json
 * is unreadable, not JSON, or not a version this build knows (a newer app wrote
 * it): a reader never shows a half-understood record as if it were whole. The
 * id is checked against the run-id pattern first, so it can never walk out of
 * the runs folder.
 */
export async function readRunRecord(runsRoot: string, runId: string): Promise<RunRecord | null> {
  if (!RUN_ID_RE.test(runId)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(join(runsRoot, runId, 'run.json'), 'utf8'))
  } catch {
    return null
  }
  const r = parsed as Partial<RunRecord> | null
  if (!r || typeof r !== 'object' || r.version !== RUN_RECORD_VERSION || r.run_id !== runId || !Array.isArray(r.steps)) return null
  // The fields list_runs and the report read: a record without them is not whole.
  const t = r.totals as Partial<RunRecord['totals']> | undefined
  if (
    (r.status !== 'passed' && r.status !== 'failed') ||
    typeof r.started_at !== 'string' ||
    typeof r.duration_ms !== 'number' ||
    typeof r.flow?.name !== 'string' ||
    typeof r.flow.file !== 'string' ||
    (r.heal_of !== undefined && (typeof r.heal_of !== 'string' || !RUN_ID_RE.test(r.heal_of))) ||
    [t?.passed, t?.failed, t?.skipped, t?.not_run].some((n) => typeof n !== 'number')
  ) {
    return null
  }
  return r as RunRecord
}

export interface ListRunsOptions {
  /** At most this many, newest first (default 20). */
  limit?: number
  status?: RunRecord['status']
  /** Only runs of this flow file, by the resolved (symlink-free) absolute path the run recorded. */
  flowFile?: string
}

/** The newest runs first, skipping folders that are not complete, readable version-1 runs. */
export async function listRuns(runsRoot: string, options: ListRunsOptions = {}): Promise<RunSummary[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = await fs.readdir(runsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const ids = entries
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse()
  const limit = Math.max(0, options.limit ?? 20)
  const out: RunSummary[] = []
  for (const id of ids) {
    if (out.length >= limit) break
    const record = await readRunRecord(runsRoot, id)
    if (!record) continue
    if (options.status !== undefined && record.status !== options.status) continue
    if (options.flowFile !== undefined && record.flow.file !== options.flowFile) continue
    out.push(summarizeRun(record))
  }
  return out
}
