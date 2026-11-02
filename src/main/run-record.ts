import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { FlowRun, StepRun } from './replay/replay'

/**
 * Roadmap F4a: the run record. Every `run_flow` / `nawi run` leaves one folder
 * in the app's data directory:
 *
 *     runs/<run-id>/run.json            what ran, where, and how each step went
 *     runs/<run-id>/junit.xml           the same result for CI test reporters
 *     runs/<run-id>/steps/NNN-<id>.png  screenshots the flow's `screenshot` steps took
 *
 * Electron-free and pure apart from the write, so the format is tested without
 * an app. The folder is written under a temporary name and renamed into place,
 * so a reader never sees a half-written run. The text in it comes from the
 * replayer's report, which has already scrubbed secret values, and typed
 * values are never in it. Screenshots are saved as the page showed them:
 * password fields are masked by the browser, but a secret typed into an
 * ordinary text field is visible in a later screenshot step's PNG.
 */

export const RUN_RECORD_VERSION = 1
/** How many runs the app keeps; older ones are deleted after each new run. */
export const DEFAULT_KEEP_RUNS = 200

/** `20261102T103900123Z-a1b2c3`: sorts by start time, and is safe as a folder name everywhere. */
export const RUN_ID_RE = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/
const STEP_ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,63}'
const STEP_ID_RE = new RegExp(`^${STEP_ID}$`)
const ASSET_RE = new RegExp(`^steps/\\d{3}(?:-${STEP_ID})?\\.png$`)
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

export interface RecordedStep extends Omit<StepRun, 'screenshotPng' | 'startedAt' | 'durationMs'> {
  /** ISO time the step started; absent for steps that never ran. */
  started_at?: string
  duration_ms?: number
  /** Path of the step's screenshot, relative to the run folder. */
  screenshot?: string
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
  steps: RecordedStep[]
}

export interface RunRecordInput {
  runId: string
  flow: { name: string; file: string; sha256: string }
  run: FlowRun
  environment: RunEnvironment
}

/** The record plus the screenshot files it refers to (relative path → PNG bytes). */
export function buildRunRecord(input: RunRecordInput): { record: RunRecord; assets: Map<string, Buffer> } {
  const { run } = input
  const assets = new Map<string, Buffer>()
  const steps = run.steps.map((step, index): RecordedStep => {
    const { screenshotPng, startedAt, durationMs, ...rest } = step
    const out: RecordedStep = { ...rest }
    if (startedAt !== undefined) out.started_at = new Date(startedAt).toISOString()
    if (durationMs !== undefined) out.duration_ms = durationMs
    if (screenshotPng !== undefined) {
      // Step ids are schema-checked already; checked again because this one becomes a file name.
      const name = `steps/${String(index + 1).padStart(3, '0')}${STEP_ID_RE.test(step.id) ? `-${step.id}` : ''}.png`
      assets.set(name, Buffer.from(screenshotPng, 'base64'))
      out.screenshot = name
    }
    return out
  })
  const count = (status: StepRun['status']): number => run.steps.filter((s) => s.status === status).length
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
function describe(selector: Record<string, unknown>): string {
  return Object.entries(selector)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
}

function failureDetail(step: RecordedStep): string {
  const lines = [step.error ?? 'the step failed']
  for (const miss of step.misses ?? []) {
    const why = miss.invalid ? `invalid: ${miss.invalid}` : miss.found === 0 ? 'no match' : `${miss.found} matches`
    lines.push(`  locator ${miss.index} ${describe(miss.selector as Record<string, unknown>)}: ${why}`)
  }
  if (step.matched) lines.push(`  matched locator ${step.matched.index} ${describe(step.matched.selector as Record<string, unknown>)}`)
  return lines.join('\n')
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
  for (const step of record.steps) {
    const open = `    <testcase classname="${suite}" name="${xmlEscape(`${step.id} (${step.action})`)}" time="${seconds(step.duration_ms)}"`
    if (step.status === 'passed') {
      out.push(`${open}/>`)
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
    const message = xmlEscape(record.error ?? 'the run failed before any step')
    out.push(
      `    <testcase classname="${suite}" name="(run)" time="0.000">`,
      `      <error message="${message}" type="run_failed">${message}</error>`,
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
export async function writeRunRecord(runsRoot: string, record: RunRecord, assets: Map<string, Buffer>): Promise<string> {
  if (!RUN_ID_RE.test(record.run_id)) throw new Error(`not a run id: ${JSON.stringify(record.run_id)}`)
  await fs.mkdir(runsRoot, { recursive: true })
  const final = join(runsRoot, record.run_id)
  const temp = join(runsRoot, `.tmp-${record.run_id}`)
  try {
    await fs.mkdir(temp)
    if (assets.size > 0) await fs.mkdir(join(temp, 'steps'))
    for (const [name, bytes] of assets) {
      if (!ASSET_RE.test(name)) throw new Error(`unsafe asset name ${name}`)
      await fs.writeFile(join(temp, name), bytes)
    }
    await fs.writeFile(join(temp, 'junit.xml'), toJUnitXml(record))
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
 * time), and temporary folders a crashed write left behind (older than an
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
  const doomed = runs.slice(0, Math.max(0, runs.length - Math.max(0, keep)))
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('.tmp-') || !RUN_ID_RE.test(e.name.slice(5))) continue
    const stat = await fs.stat(join(runsRoot, e.name)).catch(() => null)
    if (stat && now - stat.mtimeMs > STALE_TEMP_MS) doomed.push(e.name)
  }
  for (const name of doomed) await fs.rm(join(runsRoot, name), { recursive: true, force: true })
  return doomed
}
