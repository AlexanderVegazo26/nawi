import { test, expect } from '@playwright/test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * `nawi serve` (roadmap AI11): the built CLI starts the real app headless, other CLI commands attach to it, and a
 * stop removes its endpoint file. Spawned with `node` like a user's shell would; no Playwright Electron launch.
 *
 * On Linux the display variables are removed, so this also proves serve mode needs no display server.
 */

const CLI = join(process.cwd(), 'out', 'cli', 'index.js')
const execFileAsync = promisify(execFile)

let profile: string
let serve: ChildProcess
let stdout = ''
let stderr = ''

function serveEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (process.platform === 'linux') {
    delete env['DISPLAY']
    delete env['WAYLAND_DISPLAY']
  }
  return env
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFileAsync(process.execPath, [CLI, ...args], {
      env: { ...serveEnv(), NAWI_MCP_CONFIG: join(profile, 'mcp.json') }
    })
    return { code: 0, ...r }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

test.beforeAll(async () => {
  profile = await fs.mkdtemp(join(tmpdir(), 'nawi-serve-e2e-'))
  serve = spawn(process.execPath, [CLI, 'serve', '--user-data-dir', profile], { env: serveEnv() })
  serve.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
  serve.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
  await expect
    .poll(() => (serve.exitCode === null ? stdout : `exited ${serve.exitCode}`), {
      message: `nawi serve never printed its ready line; stderr:\n${stderr.slice(-2000)}`,
      timeout: 30_000
    })
    .toContain('nawi serve: ready on http://127.0.0.1:')
})

test.afterAll(async () => {
  if (serve && serve.exitCode === null && serve.pid !== undefined) {
    // Killing the CLI alone would orphan the app on Windows; take the whole tree.
    if (process.platform === 'win32') await execFileAsync('taskkill', ['/pid', String(serve.pid), '/T', '/F']).catch(() => undefined)
    else serve.kill('SIGTERM')
    await new Promise((resolve) => (serve.exitCode === null ? serve.once('exit', resolve) : resolve(null)))
  }
  await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined)
})

test('publishes its endpoint in the profile and never prints the token', async () => {
  const info = JSON.parse(await fs.readFile(join(profile, 'mcp.json'), 'utf8')) as { url: string; token: string }
  expect(stdout, 'ready line names the published endpoint').toContain(info.url)
  expect(stdout + stderr, 'the bearer token must never be printed').not.toContain(info.token)
})

test('other CLI commands attach to it', async () => {
  const tools = await cli(['tools', '--json'])
  expect(tools.code, `nawi tools failed: ${tools.stderr}`).toBe(0)
  const names = (JSON.parse(tools.stdout) as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
  expect(names, 'tools/list through the daemon').toContain('run_flow')
  const runs = await cli(['runs', '--json'])
  expect(runs.code, `nawi runs failed: ${runs.stderr}`).toBe(0)
})

test('a second serve on the same profile exits 3 and leaves the first running', async () => {
  const second = await cli(['serve', '--user-data-dir', profile])
  expect(second.code, `second serve: ${second.stderr}`).toBe(3)
  expect(second.stderr).toContain('Nawi is already running')
  expect(serve.exitCode, 'first daemon still up').toBeNull()
})

test('SIGTERM stops it with exit 0 and removes mcp.json', async () => {
  // Node's SIGTERM on Windows is TerminateProcess: nothing can shut down gracefully there.
  test.skip(process.platform === 'win32', 'no catchable SIGTERM on Windows')
  const exited = new Promise<number | null>((resolve) => serve.once('exit', (code) => resolve(code)))
  serve.kill('SIGTERM')
  expect(await exited, `serve exit code; stderr:\n${stderr.slice(-2000)}`).toBe(0)
  await expect(fs.access(join(profile, 'mcp.json')), 'mcp.json must be removed on a clean stop').rejects.toThrow()
})
