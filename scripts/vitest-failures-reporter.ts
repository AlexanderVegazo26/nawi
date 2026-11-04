// Vitest reporter for scripts/test-agent.ts: writes each failed test's errors with Vitest's expected/received diff,
// plus errors no test owns (unhandled rejections, a throw after a test ended), to $TEST_AGENT_FAILURES (JSON).
// Vitest's own JSON report keeps only the first error line and its stack, so without this the summary could not
// show expected vs actual. Used only through test-agent.ts: `--reporter=./scripts/vitest-failures-reporter.ts`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Reporter, SerializedError, TestModule } from 'vitest/node'

export interface ErrorDetail {
  name?: string
  message: string
  diff?: string
  stack?: string
}

export interface FailuresFile {
  /** `file` is absolute (Vitest's moduleId); `name` is TestCase.fullName: suites and test joined by " > ". */
  tests: { file: string; name: string; errors: ErrorDetail[] }[]
  unhandled: ErrorDetail[]
}

const detail = (e: SerializedError & { diff?: unknown }): ErrorDetail => ({
  name: typeof e.name === 'string' ? e.name : undefined,
  message: String(e.message ?? ''),
  diff: typeof e.diff === 'string' ? e.diff : undefined,
  stack: typeof e.stack === 'string' ? e.stack : undefined
})

export default class FailuresReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>, unhandledErrors: ReadonlyArray<SerializedError>): void {
    const outputFile = process.env.TEST_AGENT_FAILURES
    if (!outputFile) return
    const report: FailuresFile = { tests: [], unhandled: unhandledErrors.map(detail) }
    for (const m of testModules) {
      for (const t of m.children.allTests('failed')) {
        report.tests.push({ file: m.moduleId, name: t.fullName, errors: (t.result().errors ?? []).map(detail) })
      }
    }
    mkdirSync(path.dirname(outputFile), { recursive: true })
    writeFileSync(outputFile, JSON.stringify(report, null, 2))
  }
}
