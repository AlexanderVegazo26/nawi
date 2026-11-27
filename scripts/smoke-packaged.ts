// Launches the PACKAGED app (the executable electron-builder produced, not `electron .`) and proves it starts.
//
//   node scripts/smoke-packaged.ts                 smoke the build for this machine's OS and CPU
//   node scripts/smoke-packaged.ts --arch x64      smoke another architecture's build (macOS: through Rosetta)
//
// Run it after `npm run dist:<os>` / `npm run package`. It starts `<app> --serve` (the headless engine behind
// `nawi serve`: no window, no display needed), waits for the "ready" line, then stops it and checks it exited.
// That is the launch path that failed on Apple Silicon for v0.1.0, and nothing else in CI started a packaged build.
//
// On macOS it also checks the bundle's signature first: an app whose bundle seal does not match its contents is
// what Gatekeeper reports as "damaged", so `codesign --verify --deep --strict` must pass and `_CodeSignature` must
// exist. Exit code: 0 started, 1 failed, 2 usage / no build found.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const READY = /nawi serve: ready on http:\/\/127\.0\.0\.1:\d+/
const START_TIMEOUT_MS = 45_000
/** Rosetta translates the whole Electron binary on a cold first launch, which takes far longer than a native start. */
const ROSETTA_START_TIMEOUT_MS = 240_000
const STOP_TIMEOUT_MS = 15_000

export type Arch = 'x64' | 'arm64'

/** Where electron-builder leaves the unpacked app for a platform and architecture, relative to `release/`. */
export function unpackedDir(platform: NodeJS.Platform, arch: Arch): string {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac'
  if (platform === 'win32') return arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked'
  return arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked'
}

/** Candidate executables inside an unpacked app directory, most likely first. */
export function executableCandidates(platform: NodeJS.Platform, dir: string, productName = 'Nawi'): string[] {
  if (platform === 'darwin') return [path.join(dir, `${productName}.app`, 'Contents', 'MacOS', productName)]
  if (platform === 'win32') return [path.join(dir, `${productName}.exe`)]
  return [path.join(dir, productName.toLowerCase()), path.join(dir, productName)]
}

/** The arguments the smoke launch uses; Linux needs `--no-sandbox` because an unpacked build's chrome-sandbox is not setuid. */
export function launchArgs(platform: NodeJS.Platform, userDataDir: string): string[] {
  const args = ['--serve', '--user-data-dir', userDataDir]
  if (platform === 'linux') args.unshift('--no-sandbox')
  return args
}

function run(cmd: string, args: string[]): { status: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

/** macOS only: the bundle must be sealed and consistent, or Gatekeeper calls it damaged. Returns a failure or null. */
function checkMacSignature(exe: string): string | null {
  const app = exe.slice(0, exe.indexOf('.app') + 4)
  if (!existsSync(path.join(app, 'Contents', '_CodeSignature', 'CodeResources'))) {
    return `${app} has no Contents/_CodeSignature/CodeResources: the bundle is unsealed, which Gatekeeper reports as "damaged" on Apple Silicon`
  }
  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  if (verify.status !== 0) return `codesign --verify --deep --strict failed for ${app}:\n${verify.out}`
  console.log(`smoke-packaged: ${app} is sealed and verifies`)
  return null
}

function launch(exe: string, platform: NodeJS.Platform, arch: Arch): Promise<string | null> {
  const profile = mkdtempSync(path.join(tmpdir(), 'nawi-smoke-'))
  const rosetta = platform === 'darwin' && arch !== (process.arch as Arch)
  const startTimeoutMs = rosetta ? ROSETTA_START_TIMEOUT_MS : START_TIMEOUT_MS
  const cmd = rosetta ? 'arch' : exe
  const args = rosetta ? [`-${arch === 'x64' ? 'x86_64' : 'arm64'}`, exe, ...launchArgs(platform, profile)] : launchArgs(platform, profile)
  const env: NodeJS.ProcessEnv = { ...process.env, NAWI_MCP_CONFIG: path.join(profile, 'mcp.json') }
  if (platform === 'linux') {
    delete env['DISPLAY']
    delete env['WAYLAND_DISPLAY']
  }
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env })
    let log = ''
    let settled = false
    let ready = false
    const finish = (failure: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(startTimer)
      if (child.exitCode === null && !child.killed) child.kill()
      rmSync(profile, { recursive: true, force: true })
      resolve(failure)
    }
    const startTimer = setTimeout(
      () => finish(`no ready line within ${startTimeoutMs / 1000} s. Output:\n${log || '(none)'}`),
      startTimeoutMs
    )
    const onData = (d: Buffer): void => {
      log += d.toString()
      if (ready || !READY.test(log)) return
      ready = true
      console.log('smoke-packaged: the packaged app started and answered')
      clearTimeout(startTimer)
      // A clean stop is part of the check: a build that starts but cannot shut down is also broken.
      const stopTimer = setTimeout(() => finish(`started but did not stop within ${STOP_TIMEOUT_MS / 1000} s`), STOP_TIMEOUT_MS)
      child.once('exit', () => {
        clearTimeout(stopTimer)
        finish(null)
      })
      child.kill('SIGTERM')
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (d: Buffer) => {
      log += d.toString()
    })
    child.once('error', (err) => finish(`could not start ${exe}: ${err.message}`))
    child.once('exit', (code, signal) => {
      if (settled || READY.test(log)) return
      finish(`exited before it was ready (code ${code}, signal ${signal}). Output:\n${log || '(none)'}`)
    })
  })
}

async function main(argv: string[]): Promise<number> {
  const archFlag = argv.indexOf('--arch')
  const arch = (archFlag >= 0 ? argv[archFlag + 1] : process.arch) as Arch
  if (arch !== 'x64' && arch !== 'arm64') {
    console.error('usage: node scripts/smoke-packaged.ts [--arch x64|arm64]')
    return 2
  }
  const platform = process.platform
  const dir = path.resolve('release', unpackedDir(platform, arch))
  const exe = executableCandidates(platform, dir).find((c) => existsSync(c))
  if (!exe) {
    const have = existsSync('release') ? readdirSync('release').join(', ') : '(no release/ directory)'
    console.error(`smoke-packaged: no ${platform}/${arch} build at ${dir}. release/ holds: ${have}. Run the dist script first.`)
    return 2
  }
  console.log(`smoke-packaged: ${exe}`)
  const failure = (platform === 'darwin' ? checkMacSignature(exe) : null) ?? (await launch(exe, platform, arch))
  if (failure) {
    console.error(`smoke-packaged: FAILED: ${failure}`)
    return 1
  }
  console.log('smoke-packaged: ok')
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
