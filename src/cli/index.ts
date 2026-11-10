#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NOT_RUNNING, readEndpoint } from '../mcp/endpoint'
import { postJson, type PostResult } from '../mcp/post'
import {
  COMMANDS,
  FollowUsageError,
  TOOLS_COMMAND_SUMMARY,
  newRuns,
  parseFollow,
  renderTools,
  toolDescriptors,
  type RunSummary
} from './commands'
import {
  RUN_USAGE,
  RunUsageError,
  flowReferences,
  inputsFor,
  parseRunArgs,
  readFlowText,
  renderRun,
  runExitCode,
  type RunReport
} from './run'
import {
  MOBILE_DOCTOR_USAGE,
  MOBILE_INSPECT_USAGE,
  MOBILE_OPEN_USAGE,
  MOBILE_STUDY_USAGE,
  MOBILE_EXPLORE_USAGE,
  MOBILE_RECORD_USAGE,
  MobileUsageError,
  parseMobileDoctorArgs,
  parseMobileInspectArgs,
  parseMobileOpenArgs,
  parseMobileStudyArgs,
  parseMobileExploreArgs,
  parseMobileRecordArgs,
  renderRecordResult,
  type MobileRecordReport,
  readProfileText,
  renderApkInfo,
  renderDoctorReport,
  renderOpenResult,
  renderStudyResult,
  renderExploreResult,
  type MobileOpenReport,
  type MobileStudyReport,
  type MobileExploreReport
} from './mobile'
import type { MobileDoctorReport } from '../main/mobile/doctor'
import type { ApkInfo } from '../main/mobile/apk'
import {
  HEAL_APPLY_USAGE,
  HEAL_USAGE,
  HealUsageError,
  isApplyHealResult,
  isHealReport,
  parseHealApplyArgs,
  parseHealArgs,
  renderApplyHeal,
  renderHealReport
} from './heal'
import {
  SERVE_SUMMARY,
  SERVE_USAGE,
  ServeUsageError,
  findApp,
  parseServeArgs,
  serveCommand,
  serveEnv,
  serveExitCode,
  serveExitNote
} from './serve'

/**
 * `nawi` — the command-line front end to a running Nawi.
 *
 * **Sibling of `stdio-bridge.ts`, not a new authority.** It speaks to exactly
 * the same loopback JSON-RPC endpoint, with the same bearer token, calling the
 * same `tools/call` surface defined in `src/main/mcp/tools.ts`. Every rule the
 * app enforces — the agent kill switch, redaction gating, path confinement —
 * is enforced in main and applies here unchanged. This process contains no tool
 * logic and holds no state, for the same reason the bridge doesn't.
 *
 * **It does not launch the app.** Inherited verbatim from the bridge (see
 * `endpoint.ts`): a shell command silently starting a GUI on someone's desktop
 * is a surprise they never consented to. `nawi` reports that the app is
 * not running and exits non-zero. The one exception is `nawi serve`, the
 * explicit request to start the engine, and it opens no window (serve.ts).
 *
 * **Plain node, zero dependencies, no `electron` import.** A packaged Electron
 * binary cannot serve as a CLI (no usable stdout on Windows — the constraint
 * that created the bridge), so this ships as an unpacked script the platform's
 * `node` runs. `electron-builder.yml` unpacks `out/cli/**` from the asar for
 * precisely that reason.
 *
 * Exit codes are the contract for scripting:
 *   0  success
 *   1  the app reported an error (tool failure, bad arguments, denied by policy)
 *   2  usage error — unknown command or malformed flags
 *   3  Nawi is not running / unreachable
 */

const EXIT_OK = 0
const EXIT_APP_ERROR = 1
const EXIT_USAGE = 2
const EXIT_NOT_RUNNING = 3

const USAGE = `nawi — command-line access to a running Nawi.

Usage:
  nawi <command> [--flag value ...] [--json]

Commands:
${Object.entries(COMMANDS)
  .map(([name, c]) => `  ${name.padEnd(16)}${c.summary}`)
  .join('\n')}
  ${'tools'.padEnd(16)}${TOOLS_COMMAND_SUMMARY}
  ${'serve'.padEnd(16)}${SERVE_SUMMARY}

Global flags:
  --json            Print the raw JSON-RPC result instead of formatted text.
                    ('runs --follow' always prints NDJSON: one run per line.)
  --help, -h        Show this help.
  --version, -v     Show the CLI version.

Values are parsed as JSON when they look like JSON (numbers, true/false, arrays,
objects) and kept as strings otherwise, so --width 800 sends a number and
--name "My shot" sends a string. A flag with no value is the boolean true.

Exit codes: 0 success, 1 the app reported an error, a flow step failed, mobile-doctor found no device, mobile-open did not get the app running, mobile-study could not read the screen, mobile-explore could not explore the app or mobile-record recorded no flow, 2 usage, 3 Nawi not running.

Nawi must already be running (the app, or \`nawi serve\`); no other command starts it for you.

${RUN_USAGE}

${HEAL_USAGE}

${HEAL_APPLY_USAGE}

${MOBILE_INSPECT_USAGE}

${MOBILE_DOCTOR_USAGE}

${MOBILE_OPEN_USAGE}

${MOBILE_STUDY_USAGE}

${MOBILE_EXPLORE_USAGE}

${MOBILE_RECORD_USAGE}

${SERVE_USAGE}`

/**
 * Parses `--flag value` pairs into a tool argument object.
 *
 * JSON-coercing values is what lets one generic parser feed every tool: the
 * schemas in tools.ts are zod, and they reject a string where a number is
 * required. Quoting rules therefore stay the shell's ordinary ones.
 */
function parseArgs(argv: string[]): { args: Record<string, unknown>; json: boolean } {
  const args: Record<string, unknown> = {}
  let json = false

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      throw new Error(`Expected a --flag but found "${token}".`)
    }
    const key = token.slice(2)
    if (key === 'json') {
      json = true
      continue
    }
    const next = argv[i + 1]
    // A bare trailing flag, or one followed by another flag, is a boolean.
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
      continue
    }
    i++
    try {
      args[key] = JSON.parse(next)
    } catch {
      args[key] = next
    }
  }
  return { args, json }
}

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

/**
 * Renders a JSON-RPC result for a terminal.
 *
 * MCP results carry a `content` array of typed parts. Text parts are printed as
 * text; anything else (an image part, for instance) is summarised rather than
 * dumped, because writing base64 image bytes to a TTY is never what the caller
 * wanted. `--json` is the escape hatch for the full payload.
 */
function render(result: unknown): string {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) return JSON.stringify(result, null, 2)

  return content
    .map((part: unknown) => {
      const p = part as { type?: string; text?: string }
      if (p.type === 'text' && typeof p.text === 'string') return p.text
      return `[${p.type ?? 'unknown'} content omitted — re-run with --json for the full payload]`
    })
    .join('\n')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`)
    process.exit(EXIT_OK)
  }
  if (command === '--version' || command === '-v') {
    // Injected at build time so the CLI cannot drift from package.json.
    process.stdout.write(`${__APP_VERSION__}\n`)
    process.exit(EXIT_OK)
  }

  if (command === 'tools') return toolsCommand(argv.slice(1))
  if (command === 'serve') return serveCommandMain(argv.slice(1))

  const entry = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined
  if (!entry) {
    fail(`Unknown command "${command}".\n\n${USAGE}`, EXIT_USAGE)
  }

  if (command === 'run') return runCommand(argv.slice(1))
  if (command === 'heal' && argv.includes('--apply')) return healApplyCommand(argv.slice(1))
  if (command === 'heal') return healCommand(argv.slice(1))
  if (command === 'heal-apply') return healApplyCommand(argv.slice(1))
  if (command === 'mobile-inspect') return mobileInspectCommand(argv.slice(1))
  if (command === 'mobile-doctor') return mobileDoctorCommand(argv.slice(1))
  if (command === 'mobile-open') return mobileOpenCommand(argv.slice(1))
  if (command === 'mobile-study') return mobileStudyCommand(argv.slice(1))
  if (command === 'mobile-explore') return mobileExploreCommand(argv.slice(1))
  if (command === 'mobile-record') return mobileRecordCommand(argv.slice(1))

  let parsed: { args: Record<string, unknown>; json: boolean }
  try {
    parsed = parseArgs(argv.slice(1))
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`, EXIT_USAGE)
  }

  if (command === 'runs') {
    let follow: ReturnType<typeof parseFollow>
    try {
      follow = parseFollow(parsed.args)
    } catch (err) {
      if (err instanceof FollowUsageError) fail(`${err.message}\n\n${USAGE}`, EXIT_USAGE)
      throw err
    }
    if (follow) return followRuns(follow.filter, follow.interval)
  }

  const result = await callTool(entry.tool, parsed.args)
  process.stdout.write(`${parsed.json ? JSON.stringify(result, null, 2) : render(result)}\n`)
  process.exit(EXIT_OK)
}

/** One `tools/call` against the running app; exits with the contract's code on any failure. */
async function callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  return callRpc('tools/call', { name: tool, arguments: args })
}

/** One JSON-RPC request against the running app; exits with the contract's code on any failure. */
async function callRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const endpoint = readEndpoint()
  if (!endpoint) fail(NOT_RUNNING, EXIT_NOT_RUNNING)

  let res: PostResult
  try {
    res = await postJson(
      endpoint.url,
      {
        'content-type': 'application/json',
        authorization: `Bearer ${endpoint.token}`
        // No Origin header: main rejects any non-null Origin as a DNS-rebinding
        // defence, and this is not a browser.
      },
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params
      })
    )
  } catch (err) {
    fail(`${NOT_RUNNING} (${err instanceof Error ? err.message : String(err)})`, EXIT_NOT_RUNNING)
  }

  const text = res.text
  if (text.length === 0) {
    fail(`Nawi returned an empty response (HTTP ${res.status}).`, EXIT_APP_ERROR)
  }

  let frame: { result?: unknown; error?: { message?: string } }
  try {
    frame = JSON.parse(text) as typeof frame
  } catch {
    fail(`Nawi returned a malformed response: ${text.slice(0, 500)}`, EXIT_APP_ERROR)
  }

  if (frame.error) {
    fail(frame.error.message ?? 'Nawi reported an unspecified error.', EXIT_APP_ERROR)
  }
  return frame.result
}

/**
 * `nawi run`: positional file, repeatable --var, and the exit code follows the
 * run (0 passed, 1 failed), not just the call. Env and secret values are sent
 * only for the names the flow refers to.
 */
async function runCommand(argv: string[]): Promise<void> {
  let run: ReturnType<typeof parseRunArgs>
  try {
    run = parseRunArgs(argv, process.cwd())
  } catch (err) {
    if (err instanceof RunUsageError) fail(`${err.message}\n\n${RUN_USAGE}`, EXIT_USAGE)
    throw err
  }
  // Unreadable or not a flow file here: the app reports the real problem.
  const text = readFlowText(run.file, { statSync, readFileSync }) ?? ''
  const { env, secrets } = inputsFor(flowReferences(text, Object.values(run.vars)), process.env)
  const { json, junit, ...args } = run
  // A report left from an earlier run must not be read as this run's result if this one errors out.
  if (junit !== undefined) {
    try {
      rmSync(junit, { force: true })
    } catch (err) {
      fail(`Cannot use ${junit} for the JUnit report: ${err instanceof Error ? err.message : String(err)}`, EXIT_USAGE)
    }
  }
  const result = (await callTool('run_flow', { ...args, env, secrets })) as {
    structuredContent?: RunReport
  }
  const report = result?.structuredContent
  if (!report || !Array.isArray(report.steps)) {
    fail(`Nawi returned an unexpected run_flow result: ${JSON.stringify(result).slice(0, 500)}`, EXIT_APP_ERROR)
  }
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : renderRun(report)}\n`)
  if (junit !== undefined) {
    // CI asked for a report file: a missing one must fail the job, not leave the reporter reading a stale file.
    if (!report.run_dir) fail(`No JUnit report: the run record was not saved (${report.record_error ?? 'no run_dir'}).`, EXIT_APP_ERROR)
    try {
      mkdirSync(dirname(junit), { recursive: true })
      copyFileSync(join(report.run_dir, 'junit.xml'), junit)
    } catch (err) {
      fail(`Could not write the JUnit report to ${junit}: ${err instanceof Error ? err.message : String(err)}`, EXIT_APP_ERROR)
    }
  }
  process.exit(runExitCode(report))
}

/** `nawi heal <run_id>`: positional run id; prints the proposals and the diff, never writes the flow. */
async function healCommand(argv: string[]): Promise<void> {
  let args: ReturnType<typeof parseHealArgs>
  try {
    args = parseHealArgs(argv)
  } catch (err) {
    if (err instanceof HealUsageError) fail(`${err.message}\n\n${HEAL_USAGE}`, EXIT_USAGE)
    throw err
  }
  const result = (await callTool('get_heal_proposals', { run_id: args.run_id })) as { structuredContent?: unknown }
  const report = result?.structuredContent
  if (!isHealReport(report)) {
    fail(`Nawi returned an unexpected get_heal_proposals result: ${JSON.stringify(result).slice(0, 500)}`, EXIT_APP_ERROR)
  }
  process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : renderHealReport(report)}\n`)
  process.exit(EXIT_OK)
}

/**
 * `nawi heal-apply <run_id>` (and `nawi heal <run_id> --apply`): typing the command is the consent apply_heal asks
 * for. The flow's env/secret names are read from its file (get_heal_proposals names it), as `nawi run` does.
 */
async function healApplyCommand(argv: string[]): Promise<void> {
  let args: ReturnType<typeof parseHealApplyArgs>
  try {
    args = parseHealApplyArgs(argv)
  } catch (err) {
    if (err instanceof HealUsageError) fail(`${err.message}\n\n${HEAL_APPLY_USAGE}`, EXIT_USAGE)
    throw err
  }
  const proposals = ((await callTool('get_heal_proposals', { run_id: args.run_id })) as { structuredContent?: unknown })?.structuredContent
  if (!isHealReport(proposals)) {
    fail(`Nawi returned an unexpected get_heal_proposals result: ${JSON.stringify(proposals).slice(0, 500)}`, EXIT_APP_ERROR)
  }
  const text = readFlowText(proposals.flow.file, { statSync, readFileSync }) ?? ''
  const { env, secrets } = inputsFor(flowReferences(text, Object.values(args.vars)), process.env)
  const { json, run_id, step_ids, ...rest } = args
  const result = (
    (await callTool('apply_heal', { run_id, ...(step_ids ? { step_ids } : {}), confirm: true, ...rest, env, secrets })) as {
      structuredContent?: unknown
    }
  )?.structuredContent
  if (!isApplyHealResult(result)) {
    fail(`Nawi returned an unexpected apply_heal result: ${JSON.stringify(result).slice(0, 500)}`, EXIT_APP_ERROR)
  }
  process.stdout.write(`${json ? JSON.stringify(result, null, 2) : renderApplyHeal(result)}\n`)
  process.exit(result.applied ? EXIT_OK : EXIT_APP_ERROR)
}

/** `nawi mobile-inspect <file.apk>`: positional file resolved here, the reading done by the app's inspect_apk. */
async function mobileInspectCommand(argv: string[]): Promise<void> {
  let args: ReturnType<typeof parseMobileInspectArgs>
  try {
    args = parseMobileInspectArgs(argv, process.cwd())
  } catch (err) {
    if (err instanceof MobileUsageError) fail(`${err.message}\n\n${MOBILE_INSPECT_USAGE}`, EXIT_USAGE)
    throw err
  }
  const result = (await callTool('inspect_apk', { file: args.file })) as { structuredContent?: ApkInfo }
  const info = result?.structuredContent
  if (!info || typeof info.package !== 'string') {
    fail(`Nawi returned an unexpected inspect_apk result: ${JSON.stringify(result).slice(0, 500)}`, EXIT_APP_ERROR)
  }
  process.stdout.write(`${args.json ? JSON.stringify(info, null, 2) : renderApkInfo(info)}\n`)
  process.exit(EXIT_OK)
}

/** `nawi mobile-doctor [file.apk]`: exit 0 when a device can run it, 1 with the fix when not. */
async function mobileDoctorCommand(argv: string[]): Promise<void> {
  let args: ReturnType<typeof parseMobileDoctorArgs>
  try {
    args = parseMobileDoctorArgs(argv, process.cwd())
  } catch (err) {
    if (err instanceof MobileUsageError) fail(`${err.message}\n\n${MOBILE_DOCTOR_USAGE}`, EXIT_USAGE)
    throw err
  }
  const result = (await callTool('mobile_doctor', args.file === undefined ? {} : { file: args.file })) as { structuredContent?: MobileDoctorReport }
  const report = result?.structuredContent
  if (!report || typeof report.ready !== 'boolean' || !Array.isArray(report.checks)) {
    fail(`Nawi returned an unexpected mobile_doctor result: ${JSON.stringify(result).slice(0, 500)}`, EXIT_APP_ERROR)
  }
  process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : renderDoctorReport(report)}\n`)
  process.exit(report.ready ? EXIT_OK : EXIT_APP_ERROR)
}

async function mobileOpenCommand(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseMobileOpenArgs>
  try {
    parsed = parseMobileOpenArgs(argv, process.cwd())
  } catch (err) {
    if (err instanceof MobileUsageError) fail(`${err.message}\n\n${MOBILE_OPEN_USAGE}`, EXIT_USAGE)
    throw err
  }
  const { json, ...args } = parsed
  // A profile's sign_in values: only the names it mentions, from this shell (like `nawi run`).
  const text = readProfileText(args.file, { statSync, readFileSync })
  const inputs = text === null ? {} : inputsFor(flowReferences(text), process.env)
  const result = (await callTool('mobile_open', { ...args, ...inputs })) as { structuredContent?: MobileOpenReport }
  const report = result?.structuredContent
  if (!report || typeof report.ok !== 'boolean' || !Array.isArray(report.steps)) {
    fail(`Nawi returned an unexpected mobile_open result: ${JSON.stringify(result).slice(0, 500)}`, EXIT_APP_ERROR)
  }
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : renderOpenResult(report)}\n`)
  process.exit(report.ok ? EXIT_OK : EXIT_APP_ERROR)
}

/** `nawi mobile-study`: exit 0 when the screen was studied, 1 with the fix when not. */
async function mobileStudyCommand(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseMobileStudyArgs>
  try {
    parsed = parseMobileStudyArgs(argv)
  } catch (err) {
    if (err instanceof MobileUsageError) fail(`${err.message}\n\n${MOBILE_STUDY_USAGE}`, EXIT_USAGE)
    throw err
  }
  const { json, secret, ...args } = parsed
  // Only the named secrets, from this shell (like `nawi run`); a name the shell lacks is simply not scrubbed.
  const { secrets } = inputsFor({ env: [], secret }, process.env)
  const result = (await callTool('mobile_study', Object.keys(secrets).length > 0 ? { ...args, secrets } : args)) as { structuredContent?: MobileStudyReport }
  const report = result?.structuredContent
  if (!report || typeof report.ok !== 'boolean') {
    fail(`Nawi returned an unexpected mobile_study result: ${JSON.stringify(result).slice(0, 500)}`, EXIT_APP_ERROR)
  }
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : renderStudyResult(report)}\n`)
  process.exit(report.ok ? EXIT_OK : EXIT_APP_ERROR)
}

/** `nawi mobile-explore`: exit 0 when the app was explored (a budget may have stopped it), 1 with the fix when not. */
async function mobileExploreCommand(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseMobileExploreArgs>
  try {
    parsed = parseMobileExploreArgs(argv)
  } catch (err) {
    if (err instanceof MobileUsageError) fail(`${err.message}\n\n${MOBILE_EXPLORE_USAGE}`, EXIT_USAGE)
    throw err
  }
  const { json, secret, never_press, ...args } = parsed
  // Only the named secrets, from this shell (like `nawi run`); a name the shell lacks is simply not scrubbed.
  const { secrets } = inputsFor({ env: [], secret }, process.env)
  const result = (await callTool('mobile_explore', {
    ...args,
    ...(never_press.length > 0 ? { never_press } : {}),
    ...(Object.keys(secrets).length > 0 ? { secrets } : {})
  })) as { structuredContent?: MobileExploreReport }
  const report = result?.structuredContent
  if (!report || typeof report.ok !== 'boolean') {
    fail(`Nawi returned an unexpected mobile_explore result: ${JSON.stringify(result).slice(0, 500)}`, EXIT_APP_ERROR)
  }
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : renderExploreResult(report)}\n`)
  process.exit(report.ok ? EXIT_OK : EXIT_APP_ERROR)
}

/** `nawi mobile-record`: exit 0 when a flow was recorded (it may have warnings), 1 with the fix when not. */
async function mobileRecordCommand(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseMobileRecordArgs>
  try {
    parsed = parseMobileRecordArgs(argv, process.cwd())
  } catch (err) {
    if (err instanceof MobileUsageError) fail(`${err.message}\n\n${MOBILE_RECORD_USAGE}`, EXIT_USAGE)
    throw err
  }
  const { json, ...args } = parsed
  process.stderr.write(
    'Recording: Nawi restarts the app and reads its screen first (a few seconds). Start once its first screen shows, wait\n' +
      'about 2 s after each tap that changes the screen, and stop by not touching the device for the idle time (Ctrl-C\n' +
      'cancels without a flow).\n'
  )
  const result = (await callTool('mobile_record', args)) as { structuredContent?: MobileRecordReport }
  const report = result?.structuredContent
  if (!report || typeof report.ok !== 'boolean') {
    fail(`Nawi returned an unexpected mobile_record result: ${JSON.stringify(result).slice(0, 500)}`, EXIT_APP_ERROR)
  }
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : renderRecordResult(report)}\n`)
  process.exit(report.ok ? EXIT_OK : EXIT_APP_ERROR)
}

/** `nawi tools [--json]`: what the running app offers, straight from `tools/list`. */
async function toolsCommand(argv: string[]): Promise<void> {
  if (argv.some((a) => a !== '--json')) fail(`nawi tools takes only --json.\n\n${USAGE}`, EXIT_USAGE)
  const tools = toolDescriptors(await callRpc('tools/list', {}))
  process.stdout.write(`${argv.includes('--json') ? JSON.stringify({ tools }, null, 2) : renderTools(tools)}\n`)
  process.exit(EXIT_OK)
}

/**
 * `nawi runs --follow`: polls list_runs and prints each run that appears after the command started as one JSON
 * line (NDJSON), oldest first. Runs that already exist are not replayed; use `nawi runs` for those. Ends on
 * Ctrl-C / SIGTERM (exit 0); a lost connection exits 3 like any other command.
 */
async function followRuns(filter: Record<string, unknown>, intervalMs: number): Promise<void> {
  const list = async (): Promise<RunSummary[]> => {
    const result = (await callTool('list_runs', filter)) as { structuredContent?: { runs?: RunSummary[] } }
    const runs = result?.structuredContent?.runs
    if (!Array.isArray(runs)) fail(`Nawi returned an unexpected list_runs result: ${JSON.stringify(result).slice(0, 500)}`, EXIT_APP_ERROR)
    return runs
  }
  const seen = new Set<string>()
  newRuns(seen, await list())
  // Exit at once: a handler that only sets a flag would replace the default and leave Ctrl-C waiting for the next poll.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(EXIT_OK))
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs))
    for (const run of newRuns(seen, await list())) process.stdout.write(`${JSON.stringify(run)}\n`)
  }
}

/**
 * `nawi serve`: runs the app with `--serve` in the foreground and exits with its code. Ctrl-C, SIGTERM and
 * SIGHUP are passed on so the app quits through its own shutdown (which removes mcp.json), never killed from here.
 */
async function serveCommandMain(argv: string[]): Promise<void> {
  let args: ReturnType<typeof parseServeArgs>
  try {
    args = parseServeArgs(argv, process.cwd())
  } catch (err) {
    if (err instanceof ServeUsageError) fail(`${err.message}\n\n${SERVE_USAGE}`, EXIT_USAGE)
    throw err
  }
  if (args.help) {
    process.stdout.write(`${SERVE_USAGE}\n`)
    process.exit(EXIT_OK)
  }
  // "Already running on this profile" is the app's single-instance lock to decide (exit 3 from there), not a guess from mcp.json.
  const app = findApp(fileURLToPath(import.meta.url), process.platform, existsSync)
  if (!app) fail('Cannot find the Nawi app next to this CLI (neither an installed app nor a checkout with Electron).', EXIT_NOT_RUNNING)

  const { command, args: appArgs } = serveCommand(app, args, process.platform, process.env)
  const child = spawn(command, appArgs, { stdio: 'inherit', env: serveEnv(process.env) })
  let forwarded = false
  // On Windows child.kill() is a hard TerminateProcess: the app cannot clean up there (see SERVE_USAGE).
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      forwarded = true
      child.kill(sig)
    })
  }
  child.once('error', (err) => fail(`Could not start Nawi (${command}): ${err.message}`, EXIT_NOT_RUNNING))
  child.once('exit', (code, signal) => {
    const note = serveExitNote(code, signal, forwarded)
    if (note) process.stderr.write(`${note}\n`)
    process.exit(serveExitCode(code, signal, forwarded))
  })
}

void main()
