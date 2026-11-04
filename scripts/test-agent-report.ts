// Pure helpers for scripts/test-agent.ts: read tsc's and Vitest's output into failures a fixing agent can act on
// (file:line, expected vs actual, a command that reruns only that failure), and render .test-report/summary.md.
// No I/O except reading a failing test's source line, so tests can feed them recorded output.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ErrorDetail, FailuresFile } from './vitest-failures-reporter.ts'

export interface Failure {
  /** Test name as Vitest's -t matches it (describe titles and the test title joined by " > "), or the file. */
  name: string
  /** Repo-relative file:line of the failing assertion (or the test, when the stack has no frame in the file). */
  at: string
  /** The source line at `at`, trimmed, when it could be read. */
  source?: string
  /** First line of the error ("AssertionError: expected 1 to be 2"), then the diff, without stack frames. */
  message: string
  /** Reruns exactly this failure. */
  rerun: string
}

export interface TypeDiagnostic {
  file: string
  line: number
  col: number
  code: string
  message: string
}

export interface TypecheckStep {
  project: string
  command: string
  exitCode: number
  errors: TypeDiagnostic[]
  /** tsc output that is not a file diagnostic (a bad tsconfig, a crash): shown when exitCode != 0 and errors is empty. */
  other: string
}

export interface UnitStep {
  command: string
  exitCode: number
  /** undefined when Vitest wrote no JSON report (it crashed before running, or was not run). */
  results?: {
    counts: { files: number; tests: number; passed: number; failed: number; skipped: number }
    failures: Failure[]
    /** Files whose tests were all skipped, e.g. browser suites with no Chromium installed: reported, not passed. */
    skippedFiles: { file: string; count: number }[]
  }
}

export interface SummaryContext {
  reportDir: string
  typecheck: TypecheckStep[]
  unit?: UnitStep
  /** Steps the caller chose not to run (flags), named so the summary never reads as a full pass. */
  notRun: string[]
}

/** The parts of Vitest's JSON reporter output that the summary reads. */
export interface VitestJson {
  numTotalTests: number
  numPassedTests: number
  numFailedTests: number
  numPendingTests: number
  numTodoTests: number
  testResults: {
    name: string
    status: string
    message?: string
    assertionResults: {
      ancestorTitles: string[]
      title: string
      status: string
      failureMessages: string[] | null
      location?: { line: number; column: number } | null
    }[]
  }[]
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/

/** tsc --pretty false output -> one entry per diagnostic; indented continuation lines join the message. */
export function parseTscOutput(output: string): { errors: TypeDiagnostic[]; other: string } {
  const errors: TypeDiagnostic[] = []
  const other: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = TSC_LINE.exec(line)
    if (m) {
      errors.push({ file: m[1].replaceAll('\\', '/'), line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] })
    } else if (/^\s/.test(line) && line.trim() && errors.length) {
      errors[errors.length - 1].message += `\n${line.trimEnd()}`
    } else if (line.trim()) {
      other.push(line)
    }
  }
  return { errors, other: other.join('\n') }
}

/** Single-quote for a POSIX shell unless the word is plain. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`
}

/** Vitest -t takes a regex; escape the name so only this test (and same-named ones in the file) match. */
export function rerunCommand(name: string, file: string): string {
  const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
  return `npx vitest run ${shellQuote(file)} -t ${shellQuote(pattern)}`
}

function rel(file: string, cwd: string): string {
  return path.relative(cwd, file).replaceAll('\\', '/') || file
}

/** The line of the first stack frame inside `file` ("at …/x.test.ts:12:5"). */
function lineInStack(text: string, file: string): number | undefined {
  const base = file.replaceAll('\\', '/')
  for (const m of text.replaceAll('\\', '/').matchAll(/([^\s()]+?):(\d+):(\d+)/g)) {
    if (m[1].replace(/^file:\/\//, '').endsWith(base)) return Number(m[2])
  }
  return undefined
}

function readLine(file: string, line: number): string | undefined {
  if (!line || !existsSync(file)) return undefined
  return readFileSync(file, 'utf8').split('\n')[line - 1]?.trim() || undefined
}

/** Strip stack frames and ANSI colour from a failure message, keeping the error line and the diff. */
export function cleanMessage(raw: string): string {
  return raw
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((l) => !/^\s+at /.test(l))
    .join('\n')
    .trim()
}

/** Error line plus Vitest's "- Expected / + Received" diff, when the failures reporter recorded one. */
function withDiff(e: ErrorDetail): string {
  const head = e.name && !e.message.startsWith(e.name) ? `${e.name}: ${e.message}` : e.message
  return cleanMessage(e.diff ? `${head}\n\n${e.diff}` : head)
}

export function vitestResults(
  json: VitestJson,
  cwd: string,
  details?: FailuresFile
): NonNullable<UnitStep['results']> {
  const failures: Failure[] = []
  const errorsOf = new Map(details?.tests.map((t) => [`${t.file}\0${t.name}`, t.errors]))
  const skippedFiles: { file: string; count: number }[] = []
  for (const suite of json.testResults) {
    const file = rel(suite.name, cwd)
    const failed = suite.assertionResults.filter((a) => a.status === 'failed')
    // a file that fails to load (syntax error, bad import, a throw in describe) has a message and no failed tests
    if (suite.status === 'failed' && failed.length === 0) {
      failures.push({
        name: file,
        at: `${file}:${lineInStack(suite.message ?? '', file) ?? 0}`,
        message: cleanMessage(suite.message ?? '') || 'the file failed without a message',
        rerun: `npx vitest run ${shellQuote(file)}`
      })
    }
    for (const a of failed) {
      const name = [...a.ancestorTitles, a.title].join(' > ')
      const raw = (a.failureMessages ?? []).join('\n')
      const line = lineInStack(raw, file) ?? a.location?.line ?? 0
      const first = errorsOf.get(`${suite.name}\0${name}`)?.[0]
      failures.push({
        name,
        at: `${file}:${line}`,
        source: readLine(suite.name, line),
        message: (first ? withDiff(first) : cleanMessage(a.failureMessages?.[0] ?? '')) || 'failed without a message',
        rerun: rerunCommand(name, file)
      })
    }
    const skipped = suite.assertionResults.filter((a) => a.status === 'skipped' || a.status === 'pending').length
    if (skipped && skipped === suite.assertionResults.length) skippedFiles.push({ file, count: skipped })
  }
  // Errors no test owns fail the run (exit 1) with every test passed: name each one or the summary has nothing to fix.
  for (const e of details?.unhandled ?? []) {
    const frame = (e.stack ?? '').replaceAll('\\', '/').split('\n').find((l) => l.includes(`${cwd.replaceAll('\\', '/')}/`) && !l.includes('/node_modules/'))
    const at = /([^\s()]+?):(\d+):\d+/.exec(frame ?? '')
    const file = at && rel(at[1].replace(/^file:\/\//, ''), cwd)
    failures.push({
      name: `Unhandled ${e.name ?? 'error'} (no test owns it)`,
      at: at ? `${file}:${at[2]}` : 'unknown',
      message: withDiff(e) || 'no message',
      rerun: file ? `npx vitest run ${shellQuote(file)}` : 'npx vitest run'
    })
  }
  return {
    counts: {
      files: json.testResults.length,
      tests: json.numTotalTests,
      passed: json.numPassedTests,
      failed: json.numFailedTests,
      skipped: json.numPendingTests + json.numTodoTests
    },
    failures,
    skippedFiles
  }
}

/** 0 everything ran and passed, 1 something failed, 3 nothing failed but something was skipped or not run. */
export function overallExit(ctx: SummaryContext): number {
  const unitFailed = ctx.unit && (ctx.unit.exitCode !== 0 || !ctx.unit.results || ctx.unit.results.counts.failed > 0)
  if (ctx.typecheck.some((t) => t.exitCode !== 0) || unitFailed) return 1
  if (ctx.notRun.length || (ctx.unit?.results?.counts.skipped ?? 0) > 0) return 3
  return 0
}

const fence = (s: string): string => {
  const ticks = '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return `${ticks}\n${s}\n${ticks}`
}

export function renderSummary(ctx: SummaryContext): string {
  const exit = overallExit(ctx)
  const verdict = exit === 0 ? 'PASS' : exit === 1 ? 'FAIL' : 'INCOMPLETE'
  const out: string[] = [`# test:agent: ${verdict}`, '']

  out.push('| step | result | command |', '|---|---|---|')
  for (const t of ctx.typecheck) {
    const result = t.exitCode === 0 ? 'pass' : `FAIL (${t.errors.length || 'no parsed'} errors)`
    out.push(`| typecheck ${t.project} | ${result} | \`${t.command}\` |`)
  }
  if (ctx.unit) {
    const r = ctx.unit.results
    const result = !r
      ? `FAIL (exit ${ctx.unit.exitCode}, no JSON report)`
      : `${r.counts.failed || ctx.unit.exitCode ? 'FAIL' : 'pass'}: ${r.counts.passed}/${r.counts.tests} passed, ${r.counts.failed} failed, ${r.counts.skipped} skipped, ${r.counts.files} files`
    out.push(`| unit (vitest) | ${result} | \`${ctx.unit.command}\` |`)
  }
  for (const n of ctx.notRun) out.push(`| ${n} | not run | |`)
  out.push('')

  for (const t of ctx.typecheck.filter((t) => t.exitCode !== 0)) {
    out.push(`## Type errors: ${t.project}`, '', `Rerun: \`${t.command}\``, '')
    for (const e of t.errors) out.push(`- \`${e.file}:${e.line}:${e.col}\` ${e.code}: ${e.message.split('\n')[0]}`)
    const detail = t.errors.filter((e) => e.message.includes('\n'))
    for (const e of detail) out.push('', `\`${e.file}:${e.line}\``, fence(e.message))
    if (!t.errors.length) out.push(fence(t.other.trim() || `tsc exited ${t.exitCode} without output`))
    out.push('')
  }

  const r = ctx.unit?.results
  if (ctx.unit && !r) {
    out.push('## Unit tests did not report', '', `Vitest exited ${ctx.unit.exitCode} and wrote no JSON report; see \`${ctx.reportDir}/run.log\`.`, '')
  }
  if (r?.failures.length) {
    out.push(`## Failing tests (${r.failures.length})`, '')
    for (const f of r.failures) {
      out.push(`### ${f.name}`, '', `- at: \`${f.at}\``)
      if (f.source) out.push(`- source: \`${f.source.replaceAll('`', "'")}\``)
      out.push(`- rerun: \`${f.rerun}\``, '', fence(f.message), '')
    }
  }
  if (r?.skippedFiles.length) {
    out.push('## Skipped (reported, not passed)', '')
    for (const s of r.skippedFiles) out.push(`- \`${s.file}\`: all ${s.count} tests skipped`)
    out.push('')
  }

  out.push(
    '## Artifacts',
    '',
    `- \`${ctx.reportDir}/run.log\`: full output of every step`,
    `- \`${ctx.reportDir}/results.json\`: Vitest JSON report`,
    `- \`${ctx.reportDir}/junit.xml\`: Vitest JUnit report`,
    `- \`${ctx.reportDir}/failures.json\`: each failed test's errors with the expected/received diff, and unhandled errors`,
    ''
  )
  return out.join('\n')
}
