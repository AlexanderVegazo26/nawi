import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * The `nawi` CLI, driven as a real child process against a real running app.
 *
 * This suite exists because the CLI's whole job is to be *executable*: it
 * typechecks and builds whether or not its transport, its argument coercion or
 * its exit codes actually work. Every assertion here therefore spawns the built
 * `out/cli/index.js` with `node` — the same way a user's shell will — rather
 * than importing anything from it.
 *
 * The exit-code contract documented in `src/cli/index.ts` is the API that
 * scripts depend on, so each code is pinned by a test.
 */

const CLI = join(process.cwd(), 'out', 'cli', 'index.js')
const execFileAsync = promisify(execFile)

let app: ElectronApplication
let userDataDir: string

interface Run {
  code: number
  stdout: string
  stderr: string
}

/**
 * Runs the CLI and captures its exit code without throwing.
 *
 * `execFile` rejects on a non-zero exit, and non-zero is the expected outcome
 * for most of these cases — so the rejection is unwrapped back into a plain
 * result. Asserting on a thrown error's shape instead would make a wrong exit
 * code look like a crashed test.
 */
async function run(args: string[], configPath: string): Promise<Run> {
  const env = { ...process.env, NAWI_MCP_CONFIG: configPath }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { env })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

test.beforeAll(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'nawi-cli-e2e-'))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: process.cwd()
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // mcp.json is written asynchronously after the window opens, so this polls
  // rather than reading once and racing the startup.
  const configPath = join(userDataDir, 'mcp.json')
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      const parsed = JSON.parse(await fs.readFile(configPath, 'utf8'))
      if (parsed.url && parsed.token) break
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) throw new Error('mcp.json never appeared under userData')
    await new Promise((r) => setTimeout(r, 200))
  }
})

test.afterAll(async () => {
  await app?.close()
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
})

const config = (): string => join(userDataDir, 'mcp.json')

test('--version reports the packaged version, not a placeholder', async () => {
  const r = await run(['--version'], config())
  expect(r.code).toBe(0)
  // Proves the build-time `define` substitution actually fired; an un-replaced
  // `__APP_VERSION__` would still exit 0 and print something.
  expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
})

test('--help lists the commands and exits 0', async () => {
  const r = await run(['--help'], config())
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('capture-region')
  expect(r.stdout).toContain('nawi <command>')
})

test('a real command reaches the running app and returns its result', async () => {
  // `list` is the safest round trip: it reads the library and mutates nothing,
  // so it proves transport + bearer auth + tool dispatch without side effects.
  const r = await run(['list', '--json'], config())
  expect(r.code).toBe(0)
  expect(() => JSON.parse(r.stdout)).not.toThrow()
})

test('exit 2 — an unknown command is a usage error, with the usage text', async () => {
  const r = await run(['definitely-not-a-command'], config())
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('Unknown command')
  expect(r.stderr).toContain('Usage:')
})

test('exit 2 — a bare positional argument is rejected rather than ignored', async () => {
  const r = await run(['list', 'stray'], config())
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('Expected a --flag')
})

test('exit 3 — the CLI fails fast when Nawi is not running, and never launches it', async () => {
  const r = await run(['list'], join(userDataDir, 'does-not-exist.json'))
  expect(r.code).toBe(3)
  expect(r.stderr).toContain('Nawi is not running')
  // The refusal to launch is a product decision inherited from the stdio
  // bridge; a CLI that started the GUI would pass every other test here.
  expect(r.stderr).toContain('does not launch the app for you')
})

test('flag values are JSON-coerced so numeric tool schemas are satisfied', async () => {
  // capture_region's zod schema requires numbers. If --width sent the string
  // "800" the app would reject it, so a non-schema error proves the coercion.
  const r = await run(
    ['capture-region', '--x', '0', '--y', '0', '--width', '10', '--height', '10', '--json'],
    config()
  )
  // Either it captured, or it failed for a reason that is NOT a type error.
  expect(r.stderr).not.toContain('Expected number')
  expect([0, 1]).toContain(r.code)
})

/* ------------------------------------------------------------------ *
 * nawi run (roadmap F3b). These pin the exit-code contract without a
 * browser; replays against a real Chromium are covered by
 * src/main/flow-run.integration.test.ts.
 * ------------------------------------------------------------------ */

test.describe('nawi run', () => {
  // Flow files must live under the user's home directory, so these do too.
  let flowDir: string
  test.beforeAll(async () => {
    flowDir = await fs.mkdtemp(join(homedir(), '.nawi-cli-e2e-'))
  })
  test.afterAll(async () => {
    await fs.rm(flowDir, { recursive: true, force: true }).catch(() => undefined)
  })

  const NEEDS_ENV = `version: 1
name: Needs env
target: { kind: browser, url: "https://example.invalid/" }
steps:
  - { id: s1, action: fill, target: { selectors: [{ id: email }] }, value: "\${env.NAWI_E2E_EMAIL}" }
  - { id: s2, action: fill, target: { selectors: [{ id: pw }] }, value: "\${secret.pw}" }
`

  test('exit 2 — run without a flow file is a usage error with the run usage', async () => {
    const r = await run(['run'], config())
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('run needs a flow file.')
    expect(r.stderr).toContain('nawi run <file.nawi.yaml>')
  })

  test('exit 1 — a file that is not a flow is refused by the app before it is read', async () => {
    const file = join(flowDir, 'notes.txt')
    await fs.writeFile(file, 'not a flow')
    const r = await run(['run', file], config())
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Only flow files (*.nawi.yaml) can be run.')
  })

  test('exit 1 — missing env and secret inputs fail the run up front and are named', async () => {
    const file = join(flowDir, 'needs.nawi.yaml')
    await fs.writeFile(file, NEEDS_ENV)
    const r = await run(['run', file, '--headless'], config())
    expect(r.code, r.stderr).toBe(1)
    expect(r.stdout).toContain('error: the flow needs values the run did not provide: ${env.NAWI_E2E_EMAIL}, ${secret.pw}')
    expect(r.stdout).toContain('FAILED: 0 passed, 0 failed, 2 not run, 0 skipped')
  })

  test('--junit writes the run record\'s JUnit XML, creating the folder; the record folder is printed', async () => {
    const file = join(flowDir, 'needs-junit.nawi.yaml')
    await fs.writeFile(file, NEEDS_ENV)
    const report = join(flowDir, 'reports', 'nested', 'junit.xml')
    const r = await run(['run', file, '--headless', '--junit', report], config())
    expect(r.code, r.stderr).toBe(1)
    const dir = /^record: (.+)$/m.exec(r.stdout)?.[1]
    expect(dir, r.stdout).toBeTruthy()
    // realpath both sides: Windows may hand back the 8.3 short form of the temp folder.
    const runsRoot = await fs.realpath(join(userDataDir, 'runs'))
    expect((await fs.realpath(dir!)).startsWith(runsRoot), `record folder ${dir} should be under ${runsRoot}`).toBe(true)
    const xml = await fs.readFile(report, 'utf8')
    expect(xml).toContain('<testsuite name="Needs env" tests="3" failures="0" errors="1" skipped="2"')
    expect(xml, 'same report as in the run record').toBe(await fs.readFile(join(dir!, 'junit.xml'), 'utf8'))
    const record = JSON.parse(await fs.readFile(join(dir!, 'run.json'), 'utf8'))
    expect(record).toMatchObject({ version: 1, status: 'failed', flow: { name: 'Needs env' } })
  })

  test('--junit removes a stale report when the run cannot start, so CI never reads an old result', async () => {
    const file = join(flowDir, 'notes-junit.txt')
    await fs.writeFile(file, 'not a flow')
    const report = join(flowDir, 'stale.xml')
    await fs.writeFile(report, '<testsuites tests="1" failures="0"/>')
    const r = await run(['run', file, '--junit', report], config())
    expect(r.code).toBe(1)
    await expect(fs.access(report), 'the stale report must be gone').rejects.toThrow()
  })

  test('exit 1 — --var for a var the flow does not declare is refused', async () => {
    const file = join(flowDir, 'novars.nawi.yaml')
    await fs.writeFile(file, NEEDS_ENV)
    const r = await run(['run', file, '--var', 'who=x'], config())
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('does not declare "who" under vars')
  })
})
