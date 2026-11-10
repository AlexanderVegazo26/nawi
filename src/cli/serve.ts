/**
 * `nawi serve` (roadmap AI11): start the Nawi engine headless, as a local daemon the CLI and MCP clients attach to.
 *
 * The rest of the CLI never launches the app (a shell command must not surprise anyone with a GUI); `serve` is the
 * one explicit request to start it, and even then it opens no window. It runs the installed app (or, in a
 * checkout, the repo's Electron) with `--serve`, in the foreground, and exits with the app's code.
 *
 * Pure helpers only (paths, args, liveness); `index.ts` does the spawning.
 */
import { dirname, join, resolve } from 'node:path'
import { SERVE_FLAG } from '../main/headless'

export const SERVE_USAGE = `nawi serve [--user-data-dir <dir>]

  Runs Nawi without a window, as a local daemon: the agent endpoint (MCP and this
  CLI) comes up, no window opens and no global hotkeys are taken. Stays in the
  foreground until Ctrl-C or SIGTERM, then removes its endpoint file and exits 0.

  --user-data-dir <dir>  Use another profile (library, settings, runs, mcp.json).
                         Point other commands at it with NAWI_MCP_CONFIG=<dir>/mcp.json.

  Exit codes: 0 stopped cleanly, 2 usage, 3 Nawi is already running on that
  profile, the app could not be found, or its agent endpoint could not start.
  Opening the Nawi app while it serves shows a window in the same process.
  Scripts should wait for the endpoint with \`nawi tools\` (exit 3 until it is
  up) rather than parse the ready line. On Windows a stop is a hard kill: the
  next \`nawi serve\` replaces the mcp.json it leaves.
  On Linux with no display (no DISPLAY / WAYLAND_DISPLAY) it starts Chromium's
  headless backend: flows run (\`nawi run --headless\`), screen capture does not.`

export const SERVE_SUMMARY = 'Run Nawi headless as a local daemon (no window) for the CLI and MCP: [--user-data-dir dir].'

export class ServeUsageError extends Error {}

export interface ServeArgs {
  /** Absolute; undefined = the app's default profile. */
  userDataDir?: string
  help?: true
}

export function parseServeArgs(argv: readonly string[], cwd: string): ServeArgs {
  const out: ServeArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--help' || token === '-h') return { help: true }
    const [flag, inline] = token.startsWith('--user-data-dir=') ? ['--user-data-dir', token.slice(16)] : [token, undefined]
    if (flag !== '--user-data-dir') throw new ServeUsageError(`Unknown option "${token}" for nawi serve.`)
    if (out.userDataDir !== undefined) throw new ServeUsageError('--user-data-dir was given twice.')
    const value = inline ?? argv[++i]
    if (value === undefined || value === '' || value.startsWith('--')) throw new ServeUsageError('--user-data-dir needs a directory.')
    out.userDataDir = resolve(cwd, value)
  }
  return out
}

export interface LaunchCommand {
  command: string
  args: string[]
}

/**
 * Where the app binary is, given where this CLI file is.
 *
 * Packaged, the CLI lives at `<resources>/app.asar.unpacked/out/cli/index.js` (electron-builder.yml unpacks it)
 * and the executable sits next to `resources` (Windows/Linux) or in `Contents/MacOS` (macOS). In a checkout it is
 * `<repo>/out/cli/index.js` and the app is the repo run by its own Electron. Returns null when neither exists.
 */
export function findApp(cliFile: string, platform: NodeJS.Platform, exists: (path: string) => boolean): LaunchCommand | null {
  const outDir = dirname(dirname(cliFile))
  const root = dirname(outDir)
  const candidates: LaunchCommand[] = []
  if (root.endsWith('app.asar.unpacked')) {
    const resources = dirname(root)
    const exe =
      platform === 'win32'
        ? join(dirname(resources), 'Nawi.exe')
        : platform === 'darwin'
          ? join(dirname(resources), 'MacOS', 'Nawi')
          : join(dirname(resources), 'nawi')
    candidates.push({ command: exe, args: [] })
  }
  const electronDist = join(root, 'node_modules', 'electron', 'dist')
  const devElectron =
    platform === 'win32'
      ? join(electronDist, 'electron.exe')
      : platform === 'darwin'
        ? join(electronDist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : join(electronDist, 'electron')
  candidates.push({ command: devElectron, args: [root] })
  return candidates.find((c) => exists(c.command)) ?? null
}

/** The full argv for the app: switches Chromium reads, the serve flag, the profile. */
export function serveCommand(app: LaunchCommand, args: ServeArgs, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): LaunchCommand {
  const extra: string[] = []
  // Without a display server the default Linux backend aborts at startup; headless ozone runs with no display at all.
  if (platform === 'linux' && !env['DISPLAY'] && !env['WAYLAND_DISPLAY']) extra.push('--ozone-platform=headless', '--disable-gpu')
  if (args.userDataDir !== undefined) extra.push(`--user-data-dir=${args.userDataDir}`)
  return { command: app.command, args: [...extra, ...app.args, SERVE_FLAG] }
}

/** The child's environment: an inherited ELECTRON_RUN_AS_NODE would turn the app into a bare Node process. */
export function serveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _drop, ...rest } = env
  return rest
}

/** Exit code for the CLI from the app's exit: its own code, or 1 when a signal other than ours ended it. */
export function serveExitCode(code: number | null, signal: NodeJS.Signals | null, forwarded: boolean): number {
  if (code !== null) return code
  return forwarded && (signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGHUP') ? 0 : 1
}

/**
 * What the CLI adds on stderr when the app ended on a signal it did not forward: Chromium aborts (a failed CHECK,
 * the sandbox refusing to start) end in SIGTRAP/SIGABRT, and without this line the only trace is exit code 1.
 * Null when the app exited with its own code or stopped on our forwarded Ctrl-C/SIGTERM/SIGHUP.
 */
export function serveExitNote(code: number | null, signal: NodeJS.Signals | null, forwarded: boolean): string | null {
  if (code !== null || signal === null || serveExitCode(code, signal, forwarded) === 0) return null
  return `nawi serve: the Nawi app was killed by ${signal} before it stopped cleanly (a crash or an outside kill; its own last lines are above).`
}
