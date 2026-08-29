import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
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
