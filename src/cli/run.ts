import { join, resolve } from 'node:path'

/** Mirrors the app's limits (`src/main/flow-run.ts`, the run_flow schema) so a bad value is a usage error here. */
export const FLOW_FILE_SUFFIX = '.nawi.yaml'
export const MAX_FLOW_FILE_BYTES = 1024 * 1024
const STEP_TIMEOUT_RANGE = { min: 100, max: 600_000 }

/**
 * `nawi run <file> [--headless] [--var name=value ...]` — the CLI half of the
 * `run_flow` tool (roadmap F3b). Pure functions, so the argument handling and
 * the exit-code contract are unit-tested without a running app.
 *
 * The one thing this adds over the generic command path: it reads the flow
 * file's `${env.NAME}` and `${secret.name}` references and sends exactly those
 * values from this shell — never the whole environment. The app itself never
 * hands its own environment to a flow.
 */

export const RUN_USAGE = `nawi run <file.nawi.yaml> [--headless] [--var name=value ...] [--cdp-endpoint 9222]
                [--step-timeout-ms 5000] [--screenshots all|failed|off] [--junit report.xml] [--json]

  Replays a flow file in a fresh browser and prints each step's result.
  --var name=value     Override a var the flow declares (repeatable).
  --headless           Run the browser without a window.
  --cdp-endpoint <p>   Open a tab in a browser already listening for DevTools on this machine.
  --junit <file>       Also write the run's JUnit XML there (for CI test reporters).
  --screenshots <m>    Page screenshots in the record: all (before/after every step, the default),
                       failed (only the page the failing step left) or off. Secret fields are masked.
  Every run is saved as a run record (run.json, junit.xml, step screenshots); its folder is printed.
  ${'${env.NAME}'} values come from this shell's environment; ${'${secret.name}'} values from
  NAWI_SECRET_<name> (or NAWI_SECRET_<NAME>). Only names the flow file or a --var mentions are sent.
  Exit 0 when every step passed, 1 when a step failed or the run could not start.`

export interface RunArgs {
  file: string
  vars: Record<string, string>
  headless: boolean
  cdp_endpoint?: string
  step_timeout_ms?: number
  screenshots?: 'all' | 'failed' | 'off'
  /** Absolute path to copy the run's JUnit XML to. */
  junit?: string
  json: boolean
}

export class RunUsageError extends Error {}

/** Parses `run`'s own flags. Relative paths resolve against the shell's cwd: the app runs elsewhere. */
export function parseRunArgs(argv: string[], cwd: string): RunArgs {
  let file: string | undefined
  const vars: Record<string, string> = {}
  const out: Omit<RunArgs, 'file' | 'vars'> = { headless: false, json: false }

  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new RunUsageError(`${flag} needs a value.`)
    return v
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    switch (token) {
      case '--headless':
        out.headless = true
        break
      case '--json':
        out.json = true
        break
      case '--var': {
        const pair = value(i++, '--var')
        const eq = pair.indexOf('=')
        if (eq <= 0) throw new RunUsageError(`--var takes name=value, got "${pair}".`)
        vars[pair.slice(0, eq)] = pair.slice(eq + 1)
        break
      }
      case '--junit':
        out.junit = resolve(cwd, value(i++, '--junit'))
        break
      case '--cdp-endpoint':
        out.cdp_endpoint = value(i++, '--cdp-endpoint')
        break
      case '--screenshots': {
        const mode = value(i++, '--screenshots')
        if (mode !== 'all' && mode !== 'failed' && mode !== 'off') {
          throw new RunUsageError(`--screenshots takes all, failed or off, got "${mode}".`)
        }
        out.screenshots = mode
        break
      }
      case '--step-timeout-ms': {
        const raw = value(i++, '--step-timeout-ms')
        const ms = Number(raw)
        if (!Number.isInteger(ms) || ms < STEP_TIMEOUT_RANGE.min || ms > STEP_TIMEOUT_RANGE.max) {
          throw new RunUsageError(
            `--step-timeout-ms takes a whole number from ${STEP_TIMEOUT_RANGE.min} to ${STEP_TIMEOUT_RANGE.max}, got "${raw}".`
          )
        }
        out.step_timeout_ms = ms
        break
      }
      default:
        if (token.startsWith('--')) throw new RunUsageError(`Unknown flag "${token}" for run.`)
        if (file !== undefined) throw new RunUsageError(`run takes one flow file, got "${file}" and "${token}".`)
        file = token
    }
  }
  if (file === undefined) throw new RunUsageError('run needs a flow file.')
  // The report path is cleared before the run; it must never be the flow itself.
  if (out.junit !== undefined && out.junit === resolve(cwd, file)) {
    throw new RunUsageError('--junit must name a report file, not the flow file.')
  }
  return { file: resolve(cwd, file), vars, ...out }
}

/** Same shape the app's interpolator accepts, including `${ env.NAME }` with spaces. */
const REF = /\$\{\s*(env|secret)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}/g
/** A whole-line YAML comment: a commented-out step must not pull a value out of the shell. */
const COMMENT_LINE = /^\s*#.*$/gm

/**
 * The env and secret names a flow refers to: in the file (whole-line comments
 * ignored) and in `--var` values, which may themselves be `${secret.x}`.
 */
export function flowReferences(text: string, varValues: string[] = []): { env: string[]; secret: string[] } {
  const env = new Set<string>()
  const secret = new Set<string>()
  const source = [text.replace(COMMENT_LINE, ''), ...varValues].join('\n')
  for (const [, ns, name] of source.matchAll(REF)) (ns === 'env' ? env : secret).add(name)
  return { env: [...env], secret: [...secret] }
}

/**
 * The flow text the CLI may read to find those names, or null. Only a regular
 * `*.nawi.yaml` file within the size limit is read; anything else is left for
 * the app to refuse with the real reason (`/dev/zero` must not hang the CLI).
 */
export function readFlowText(file: string, fs: TextFs): string | null {
  return file.endsWith(FLOW_FILE_SUFFIX) ? readBoundedText(file, MAX_FLOW_FILE_BYTES, fs) : null
}

export interface TextFs {
  statSync(p: string): { isFile(): boolean; size: number }
  readFileSync(p: string, e: 'utf8'): string
}

/** A regular file of at most `maxBytes`, as text; null for anything else (or unreadable). */
export function readBoundedText(file: string, maxBytes: number, fs: TextFs): string | null {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > maxBytes) return null
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** The values to send for those names: only the ones this shell actually has. */
export function inputsFor(
  refs: { env: string[]; secret: string[] },
  environment: Readonly<Record<string, string | undefined>>
): { env: Record<string, string>; secrets: Record<string, string> } {
  const env: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  for (const name of refs.env) {
    const v = environment[name]
    if (v !== undefined) env[name] = v
  }
  for (const name of refs.secret) {
    const v = environment[`NAWI_SECRET_${name}`] ?? environment[`NAWI_SECRET_${name.toUpperCase()}`]
    if (v !== undefined) secrets[name] = v
  }
  return { env, secrets }
}

interface ReportStep {
  id: string
  action: string
  status: string
  durationMs?: number
  /** `layer`/`fallback` since roadmap AI1. */
  matched?: { index: number; selector: Record<string, unknown>; layer?: string; fallback?: boolean }
  error?: string
  consoleErrors?: Array<{ source: string; message: string }>
  consoleErrorsDropped?: number
  failedRequests?: Array<{ method: string; url: string; status?: number; error?: string }>
  failedRequestsDropped?: number
  /** Screenshot paths inside run_dir. */
  shots?: { before?: string; after?: string }
}

type ReportEvidence = Pick<ReportStep, 'consoleErrors' | 'consoleErrorsDropped' | 'failedRequests' | 'failedRequestsDropped'>

export interface RunReport {
  flow: string
  status: 'passed' | 'failed'
  duration_ms: number
  error?: string
  steps: ReportStep[]
  opening?: ReportEvidence
  run_dir?: string
  record_error?: string
}

const MARK: Record<string, string> = { passed: 'ok  ', failed: 'FAIL', skipped: 'skip', not_run: '--  ' }
/** Evidence lines shown per kind and step; the run record has them all. */
const SHOWN_PER_KIND = 3
const MAX_LINE_CHARS = 200

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS)}…` : flat
}

/** Console errors and failed requests under a step, a few of each, then how many more. */
function evidenceLines(e: ReportEvidence, indent: string): string[] {
  const lines: string[] = []
  const consoleErrors = e.consoleErrors ?? []
  for (const c of consoleErrors.slice(0, SHOWN_PER_KIND)) lines.push(`${indent}console ${c.source}: ${oneLine(c.message)}`)
  const moreConsole = Math.max(0, consoleErrors.length - SHOWN_PER_KIND) + (e.consoleErrorsDropped ?? 0)
  if (moreConsole > 0) lines.push(`${indent}… ${moreConsole} more console error${moreConsole === 1 ? '' : 's'}`)
  const requests = e.failedRequests ?? []
  for (const r of requests.slice(0, SHOWN_PER_KIND)) {
    const why = r.status !== undefined ? `HTTP ${r.status}` : (r.error ?? 'failed')
    lines.push(`${indent}request ${r.method} ${oneLine(r.url)}: ${why}`)
  }
  const moreRequests = Math.max(0, requests.length - SHOWN_PER_KIND) + (e.failedRequestsDropped ?? 0)
  if (moreRequests > 0) lines.push(`${indent}… ${moreRequests} more failed request${moreRequests === 1 ? '' : 's'}`)
  return lines
}

/** One line per step, then a summary; failures carry the replayer's reason. */
export function renderRun(report: RunReport): string {
  const lines = [`${report.flow}`]
  if (report.opening) {
    const opening = evidenceLines(report.opening, '       ')
    if (opening.length > 0) lines.push('  while opening the target:', ...opening)
  }
  for (const step of report.steps) {
    const ms = step.durationMs !== undefined ? ` (${step.durationMs} ms)` : ''
    lines.push(`  ${MARK[step.status] ?? step.status} ${step.id} ${step.action}${ms}`)
    if (step.error) lines.push(`       ${step.error}`)
    if (step.status === 'passed' && step.matched?.fallback) {
      // Still passing, but a more stable locator stopped matching: say so before it fails too.
      lines.push(`       fallback: found by locator ${step.matched.index} (${step.matched.layer ?? 'unknown layer'}); a more stable locator found nothing, update the flow`)
    }
    if (step.status === 'failed' && step.shots?.after !== undefined && report.run_dir) {
      lines.push(`       screenshot: ${join(report.run_dir, step.shots.after)}`)
    }
    lines.push(...evidenceLines(step, '       '))
  }
  const count = (s: string): number => report.steps.filter((x) => x.status === s).length
  if (report.error) lines.push(`error: ${report.error}`)
  lines.push(
    `${report.status === 'passed' ? 'PASSED' : 'FAILED'}: ${count('passed')} passed, ${count('failed')} failed, ` +
      `${count('not_run')} not run, ${count('skipped')} skipped in ${report.duration_ms} ms`
  )
  if (report.run_dir) lines.push(`record: ${report.run_dir}`)
  if (report.record_error) lines.push(`record not saved: ${report.record_error}`)
  return lines.join('\n')
}

/** The CLI contract: 0 when the run passed, 1 otherwise. */
export function runExitCode(report: Pick<RunReport, 'status'>): 0 | 1 {
  return report.status === 'passed' ? 0 : 1
}
