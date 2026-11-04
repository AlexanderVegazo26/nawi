import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  overallExit,
  parseTscOutput,
  renderSummary,
  rerunCommand,
  vitestResults,
  type SummaryContext,
  type VitestJson
} from './test-agent-report.ts'
import type { FailuresFile } from './vitest-failures-reporter.ts'

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'nawi-test-agent-'))
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

const suite = (
  name: string,
  status: string,
  assertionResults: VitestJson['testResults'][number]['assertionResults'],
  message?: string
): VitestJson['testResults'][number] => ({ name, status, message, assertionResults })

const json = (testResults: VitestJson['testResults'], counts: Partial<VitestJson> = {}): VitestJson => ({
  numTotalTests: 0,
  numPassedTests: 0,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults,
  ...counts
})

describe('parseTscOutput', () => {
  it('reads each diagnostic as file, line, col, code and message, joining indented continuation lines', () => {
    const out = [
      "src/main/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src\\renderer\\b.tsx(3,1): error TS2345: Argument of type '{ x: 1; }' is not assignable to parameter of type 'Y'.",
      "  Object literal may only specify known properties, and 'x' does not exist in type 'Y'.",
      ''
    ].join('\n')
    const { errors, other } = parseTscOutput(out)
    expect(errors, `parsed from:\n${out}`).toEqual([
      { file: 'src/main/a.ts', line: 12, col: 5, code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." },
      {
        file: 'src/renderer/b.tsx',
        line: 3,
        col: 1,
        code: 'TS2345',
        message:
          "Argument of type '{ x: 1; }' is not assignable to parameter of type 'Y'.\n  Object literal may only specify known properties, and 'x' does not exist in type 'Y'."
      }
    ])
    expect(other, 'no non-diagnostic lines in this output').toBe('')
  })

  it('keeps output that is not a file diagnostic (a broken tsconfig) so the summary can show it', () => {
    const { errors, other } = parseTscOutput("error TS5083: Cannot read file '/x/tsconfig.node.json'.\n")
    expect(errors, 'a config error has no file:line').toEqual([])
    expect(other).toBe("error TS5083: Cannot read file '/x/tsconfig.node.json'.")
  })
})

describe('rerunCommand', () => {
  it('anchors and escapes the name as a -t regex and quotes it for the shell', () => {
    expect(rerunCommand("parser > rejects (a+b) in 'x'", 'src/a.test.ts')).toBe(
      `npx vitest run src/a.test.ts -t '^parser > rejects \\(a\\+b\\) in '\\''x'\\''$'`
    )
  })
})

describe('vitestResults', () => {
  it('reports a failed test at the stack frame in its file, with the source line, the diff and a rerun', () => {
    const file = path.join(cwd, 'src/x.test.ts')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "describe('g', () => {\n  it('t', () => {\n    expect(sum(1, 1), 'sum').toBe(3)\n  })\n})\n")
    const details: FailuresFile = {
      tests: [{ file, name: 'g > t', errors: [{ name: 'AssertionError', message: 'sum: expected 2 to be 3', diff: '- Expected\n+ Received\n\n- 3\n+ 2' }] }],
      unhandled: []
    }
    const r = vitestResults(
      json(
        [
          suite(file, 'failed', [
            {
              ancestorTitles: ['g'],
              title: 't',
              status: 'failed',
              failureMessages: [`AssertionError: sum: expected 2 to be 3\n    at ${file}:3:30\n    at node_modules/vitest/x.js:1:1`],
              location: { line: 2, column: 3 }
            },
            { ancestorTitles: ['g'], title: 'ok', status: 'passed', failureMessages: [] }
          ])
        ],
        { numTotalTests: 2, numPassedTests: 1, numFailedTests: 1 }
      ),
      cwd,
      details
    )
    expect(r.counts, 'counts come from the JSON report').toEqual({ files: 1, tests: 2, passed: 1, failed: 1, skipped: 0 })
    expect(r.failures, 'one failure for the one failed test').toEqual([
      {
        name: 'g > t',
        at: 'src/x.test.ts:3',
        source: "expect(sum(1, 1), 'sum').toBe(3)",
        message: 'AssertionError: sum: expected 2 to be 3\n\n- Expected\n+ Received\n\n- 3\n+ 2',
        rerun: "npx vitest run src/x.test.ts -t '^g > t$'"
      }
    ])
  })

  it('falls back to the JSON message without stack frames or colour when the reporter has no details', () => {
    const file = path.join(cwd, 'a.test.ts')
    const r = vitestResults(
      json([
        suite(file, 'failed', [
          {
            ancestorTitles: [],
            title: 't',
            status: 'failed',
            failureMessages: ['\u001b[31mError: boom\u001b[39m\n    at somewhere:1:1'],
            location: { line: 7, column: 1 }
          }
        ])
      ]),
      cwd
    )
    expect(r.failures[0], 'no frame in the file: the test location is used').toMatchObject({ at: 'a.test.ts:7', message: 'Error: boom' })
  })

  it('reports a file that failed to load as one failure that reruns the file', () => {
    const file = path.join(cwd, 'broken.test.ts')
    const r = vitestResults(json([suite(file, 'failed', [], `SyntaxError: Unexpected token\n    at ${file}:4:2`)]), cwd)
    expect(r.failures).toEqual([
      { name: 'broken.test.ts', at: 'broken.test.ts:4', message: 'SyntaxError: Unexpected token', rerun: 'npx vitest run broken.test.ts' }
    ])
  })

  it('lists files whose tests were all skipped, and not files with only some skipped', () => {
    const skipped = { ancestorTitles: [], title: 's', status: 'skipped', failureMessages: [] }
    const passed = { ancestorTitles: [], title: 'p', status: 'passed', failureMessages: [] }
    const r = vitestResults(
      json([suite(path.join(cwd, 'all.test.ts'), 'skipped', [skipped, skipped]), suite(path.join(cwd, 'some.test.ts'), 'passed', [skipped, passed])], {
        numPendingTests: 3
      }),
      cwd
    )
    expect(r.skippedFiles).toEqual([{ file: 'all.test.ts', count: 2 }])
    expect(r.counts.skipped).toBe(3)
  })

  it('names an unhandled error at its first frame in the repo, outside node_modules', () => {
    const r = vitestResults(json([]), cwd, {
      tests: [],
      unhandled: [
        {
          name: 'Error',
          message: 'late boom',
          stack: `Error: late boom\n    at ${cwd}/node_modules/x/y.js:1:1\n    at Timeout._onTimeout (${cwd}/src/main/timer.ts:42:11)`
        }
      ]
    })
    expect(r.failures).toEqual([
      { name: 'Unhandled Error (no test owns it)', at: 'src/main/timer.ts:42', message: 'Error: late boom', rerun: 'npx vitest run src/main/timer.ts' }
    ])
  })
})

describe('overallExit and renderSummary', () => {
  const pass = { project: 'node', command: 'npx tsc -p tsconfig.node.json', exitCode: 0, errors: [], other: '' }
  const unit = (failed: number, skipped = 0, exitCode = failed ? 1 : 0): SummaryContext['unit'] => ({
    command: 'npx vitest run',
    exitCode,
    results: { counts: { files: 1, tests: 3, passed: 3 - failed - skipped, failed, skipped }, failures: [], skippedFiles: [] }
  })
  const ctx = (over: Partial<SummaryContext>): SummaryContext => ({ reportDir: '.test-report', typecheck: [pass], unit: unit(0), notRun: [], ...over })

  it.each([
    ['everything ran and passed', ctx({}), 0, 'PASS'],
    ['a test failed', ctx({ unit: unit(1) }), 1, 'FAIL'],
    ['vitest exited 1 with every test passed (unhandled error)', ctx({ unit: unit(0, 0, 1) }), 1, 'FAIL'],
    ['vitest wrote no report', ctx({ unit: { command: 'npx vitest run', exitCode: 1 } }), 1, 'FAIL'],
    ['typecheck failed', ctx({ typecheck: [{ ...pass, exitCode: 2, other: 'error TS5083' }] }), 1, 'FAIL'],
    ['a test was skipped', ctx({ unit: unit(0, 1) }), 3, 'INCOMPLETE'],
    ['typecheck was not run', ctx({ typecheck: [], notRun: ['typecheck (--no-typecheck)'] }), 3, 'INCOMPLETE']
  ])('%s -> exit %i, %s', (_label, c, exit, verdict) => {
    expect(overallExit(c), JSON.stringify(c)).toBe(exit)
    expect(renderSummary(c).split('\n')[0]).toBe(`# test:agent: ${verdict}`)
  })

  it('shows a typecheck failure with no parsed diagnostics as tsc printed it', () => {
    const md = renderSummary(ctx({ typecheck: [{ ...pass, exitCode: 2, other: "error TS5083: Cannot read file 'x'." }] }))
    expect(md).toContain('## Type errors: node')
    expect(md).toContain("```\nerror TS5083: Cannot read file 'x'.\n```")
  })

  it('fences a failure message containing backticks with a longer fence', () => {
    const c = ctx({
      unit: {
        ...unit(1)!,
        results: { ...unit(1)!.results!, failures: [{ name: 't', at: 'a.ts:1', message: 'has ``` inside', rerun: 'npx vitest run a.ts' }] }
      }
    })
    expect(renderSummary(c)).toContain('````\nhas ``` inside\n````')
  })
})
