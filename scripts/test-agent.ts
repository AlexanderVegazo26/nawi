// The blocking suite (what `npm test` and CI's verify job run) in one command, with a report a fixing agent can act on.
//
//   npm run test:agent                          typecheck (node + web) + every Vitest test
//   npm run test:agent -- src/main/llm          only these Vitest files/filters (typecheck still runs)
//   npm run test:agent -- --no-typecheck        Vitest only (fast inner loop; the summary says typecheck was not run)
//   [--report-dir=<dir>]                        default .test-report
//
// Writes <dir>/summary.md (each type error with file:line:col; each failing test with file:line, its source line,
// expected vs actual and a command that reruns only it; files whose tests were all skipped), results.json and
// junit.xml (Vitest), and run.log (everything printed).
// Exit 0: everything ran and passed. 1: something failed. 3: nothing failed but something was skipped or not run.
// The Playwright E2E suite (`npm run test:e2e`) needs a display and the built app, so it is not part of this.
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  overallExit,
  parseTscOutput,
  renderSummary,
  shellQuote,
  vitestResults,
  type SummaryContext,
  type VitestJson
} from './test-agent-report.ts'
import type { FailuresFile } from './vitest-failures-reporter.ts'

const root = path.resolve(import.meta.dirname, '..')
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'report-dir': { type: 'string', default: '.test-report' },
    'no-typecheck': { type: 'boolean', default: false }
  }
})
const reportDir = path.resolve(root, values['report-dir'])
const shownDir = path.relative(root, reportDir) || '.'
const out = {
  log: path.join(reportDir, 'run.log'),
  json: path.join(reportDir, 'results.json'),
  junit: path.join(reportDir, 'junit.xml'),
  failures: path.join(reportDir, 'failures.json'),
  summary: path.join(reportDir, 'summary.md')
}
// a stale report from an earlier run must never be read as this run's
for (const f of Object.values(out)) rmSync(f, { force: true })
mkdirSync(reportDir, { recursive: true })
const log = createWriteStream(out.log)

// Same conditions as CI and every run: UTC, no colour codes in the parsed output.
const env: NodeJS.ProcessEnv = { ...process.env, TZ: 'UTC', FORCE_COLOR: '0', NO_COLOR: '1', TEST_AGENT_FAILURES: out.failures }

function exec(cmd: string, args: string[]): Promise<{ code: number; output: string }> {
  log.write(`\n$ ${[cmd, ...args].map(shellQuote).join(' ')}\n`)
  const child = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env })
  let output = ''
  const onData = (to: NodeJS.WriteStream) => (b: Buffer) => {
    output += b.toString()
    to.write(b)
    log.write(b)
  }
  child.stdout.on('data', onData(process.stdout))
  child.stderr.on('data', onData(process.stderr))
  return new Promise((resolve) => {
    child.on('error', (e) => {
      log.write(`${e.message}\n`)
      resolve({ code: 127, output: e.message })
    })
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), output }))
  })
}

// Each tool's JS entry under the running Node: no .bin shims, which need a shell on Windows.
const entry = { tsc: 'typescript/bin/tsc', vitest: 'vitest/vitest.mjs' }
const tool = (name: keyof typeof entry, args: string[]) => exec(process.execPath, [path.join(root, 'node_modules', entry[name]), ...args])

const ctx: SummaryContext = { reportDir: shownDir, typecheck: [], notRun: [] }

if (values['no-typecheck']) {
  ctx.notRun.push('typecheck (--no-typecheck)')
} else {
  for (const project of ['node', 'web']) {
    const args = ['--noEmit', '--pretty', 'false', '-p', `tsconfig.${project}.json`]
    const { code, output } = await tool('tsc', args)
    ctx.typecheck.push({ project, command: `npx tsc ${args.join(' ')}`, exitCode: code, ...parseTscOutput(output) })
  }
}

const vitestArgs = [
  'run',
  '--reporter=default',
  '--reporter=json',
  `--outputFile.json=${out.json}`,
  '--reporter=junit',
  `--outputFile.junit=${out.junit}`,
  '--reporter=./scripts/vitest-failures-reporter.ts',
  ...positionals
]
const unit = await tool('vitest', vitestArgs)
function readJson<T>(file: string): T | undefined {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined
  } catch {
    return undefined
  }
}
const json = readJson<VitestJson>(out.json)
ctx.unit = {
  command: ['npx vitest run', ...positionals.map(shellQuote)].join(' '),
  exitCode: unit.code,
  results: json && vitestResults(json, root, readJson<FailuresFile>(out.failures))
}
if (positionals.length) ctx.notRun.push(`the rest of the unit tests (filtered to ${positionals.join(' ')})`)

await new Promise((resolve) => log.end(resolve))
writeFileSync(out.summary, renderSummary(ctx))
console.log(`\ntest:agent report: ${path.join(shownDir, 'summary.md')}`)
process.exit(overallExit(ctx))
