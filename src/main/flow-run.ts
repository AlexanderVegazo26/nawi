import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative } from 'node:path'
import {
  FLOW_FILE_SUFFIX,
  FlowSchema,
  MissingFlowInputsError,
  createInterpolator,
  formatFlowErrors,
  parseFlow,
  type Flow
} from '@shared/flow'
import { CdpClient } from './cdp/client'
import { attachToEndpoint, launchDebugBrowser, parseEndpoint, type LaunchOptions } from './cdp/launcher'
import { ToolError } from './mcp/errors'
import { replayFlow, type FlowRun, type ReplayClient, type StepRun } from './replay/replay'

/**
 * Roadmap F3b: run a flow file from the app (MCP `run_flow`, CLI `nawi run`).
 *
 * Electron-free on purpose: the tool body in `mcp/tools.ts` only adds the kill
 * switch and the app's defaults, so everything that decides what a run may
 * read, which browser it drives and what it reports is tested here without an
 * app.
 *
 * What a caller can make the app do is kept narrow:
 * - **Files:** only an absolute path to a `*.nawi.yaml` file, resolved through
 *   symlinks, inside an allowed root (the user's home by default), at most
 *   1 MiB. Any other file is refused before it is read, so a run cannot be used
 *   to read arbitrary files through parse errors.
 * - **Browser:** a fresh, throwaway-profile browser the app launches, or an
 *   existing DevTools endpoint on this machine (FR-SEC.1: a run never drives a
 *   browser over the network). On an attached browser the run opens its own tab
 *   and closes it afterwards; it never takes over a tab the user has open.
 * - **Inputs:** `${env.*}` and `${secret.*}` come only from the call. The app
 *   never hands its own `process.env` to a flow; the CLI sends exactly the
 *   variables the flow names, from the shell that ran it.
 */

export const MAX_FLOW_FILE_BYTES = 1024 * 1024

export interface FlowRunRequest {
  /** Absolute path to the flow file. */
  file: string
  /** Values for declared `vars`, overriding the file's defaults. */
  vars?: Record<string, string>
  env?: Record<string, string>
  secrets?: Record<string, string>
  headless?: boolean
  /** Attach to this DevTools endpoint (`9222`, `127.0.0.1:9222`) instead of launching a browser. */
  cdpEndpoint?: string
  /** Fallback per-step timeout for steps without `timeout_ms`. */
  stepTimeoutMs?: number
}

/** A page the run may drive, and how to let go of it. */
export interface BrowserPage {
  client: ReplayClient
  sessionId: string
  /** Releases the page: closes the tab (attach) or the whole browser (launch). Never throws. */
  close(): Promise<void>
}

export type OpenPage = (options: { headless: boolean; cdpEndpoint?: string }) => Promise<BrowserPage>

export interface RunFlowDeps {
  /** Directories a flow file must live in. Default: the user's home directory. */
  roots?: string[]
  openPage?: OpenPage
  /** Stops the run between steps (the agent kill switch). */
  signal?: AbortSignal
  /** Extra launch options for the default `openPage` (tests pass `--no-sandbox` on Linux). */
  launch?: Pick<LaunchOptions, 'prefer' | 'extraArgs'>
}

/** `run_flow`'s answer. Screenshots are summarised: the bytes belong in the run record (F4), not in an RPC reply. */
export interface FlowRunReport {
  file: string
  flow: string
  status: FlowRun['status']
  duration_ms: number
  error?: string
  failed_step_id?: string
  steps: Array<Omit<StepRun, 'screenshotPng'> & { screenshot_bytes?: number }>
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  // `..flows/x` is a folder named "..flows" inside the root; only `..` as a whole segment leaves it.
  return rel !== '' && !/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel)
}

/**
 * The real path of a flow file the run may read, or a typed refusal.
 * The suffix is checked on both the given and the resolved path, so a
 * `x.nawi.yaml` symlink to `~/.ssh/id_ed25519` is refused too.
 */
export async function resolveFlowFile(file: string, roots: string[] = [homedir()]): Promise<string> {
  if (!isAbsolute(file)) {
    throw new ToolError('INVALID_ARGUMENTS', 'file must be an absolute path to a flow file.', { file })
  }
  if (!file.endsWith(FLOW_FILE_SUFFIX)) {
    throw new ToolError('INVALID_ARGUMENTS', `Only flow files (*${FLOW_FILE_SUFFIX}) can be run.`, { file })
  }
  let real: string
  try {
    real = await fs.realpath(file)
  } catch {
    throw new ToolError('NOT_FOUND', 'No flow file exists at that path.', { file })
  }
  const realRoots = await Promise.all(roots.map((r) => fs.realpath(r).catch(() => null)))
  if (!real.endsWith(FLOW_FILE_SUFFIX) || !realRoots.some((r) => r !== null && within(r, real))) {
    throw new ToolError(
      'INVALID_ARGUMENTS',
      `Flow files must live inside ${roots.length === 1 ? 'your home directory' : 'an allowed folder'} and resolve to a *${FLOW_FILE_SUFFIX} file.`,
      { file }
    )
  }
  const stat = await fs.stat(real)
  if (!stat.isFile()) throw new ToolError('INVALID_ARGUMENTS', 'That path is not a file.', { file })
  if (stat.size > MAX_FLOW_FILE_BYTES) {
    throw new ToolError('INVALID_ARGUMENTS', `Flow files are limited to ${MAX_FLOW_FILE_BYTES} bytes.`, {
      file,
      size_bytes: stat.size
    })
  }
  return real
}

/** The flow with `overrides` applied to its declared vars; undeclared names are refused, not silently ignored. */
export function withVars(flow: Flow, overrides: Record<string, string> = {}): Flow {
  const names = Object.keys(overrides)
  if (names.length === 0) return flow
  const declared = Object.keys(flow.vars ?? {})
  const unknown = names.filter((n) => !Object.hasOwn(flow.vars ?? {}, n))
  if (unknown.length > 0) {
    throw new ToolError(
      'INVALID_ARGUMENTS',
      `The flow does not declare ${unknown.map((n) => `"${n}"`).join(', ')} under vars` +
        (declared.length ? ` (declared: ${declared.join(', ')}).` : ' (it declares none).'),
      { unknown, declared }
    )
  }
  const parsed = FlowSchema.safeParse({ ...flow, vars: { ...flow.vars, ...overrides } })
  if (!parsed.success) {
    throw new ToolError(
      'INVALID_ARGUMENTS',
      `A var value is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    )
  }
  return parsed.data
}

const NOT_LOCAL =
  'Runs only attach to a browser on this machine (127.0.0.1, localhost or ::1); Nawi does not drive browsers over the network.'

/** Refuses a DevTools endpoint that is not on this machine, using the parser the launcher dials with. */
function loopbackEndpoint(endpoint: string): void {
  const parsed = parseEndpoint(endpoint)
  if (!parsed) {
    throw new ToolError('INVALID_ARGUMENTS', `Could not read "${endpoint}" as host:port.`, { cdp_endpoint: endpoint })
  }
  if (!LOOPBACK_HOSTS.has(parsed.host)) throw new ToolError('INVALID_ARGUMENTS', NOT_LOCAL, { cdp_endpoint: endpoint })
}

/** The endpoint's own answer names the socket to dial; it must be local too, or a local proxy could hand the run to another host. */
function loopbackSocket(url: string, endpoint: string): void {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    host = ''
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ToolError('INVALID_ARGUMENTS', `${NOT_LOCAL} The endpoint pointed at ${host || 'an unreadable address'}.`, {
      cdp_endpoint: endpoint
    })
  }
}

async function attachPage(client: CdpClient, targetId: string): Promise<string> {
  const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  await client.send('Runtime.enable', {}, sessionId)
  return sessionId
}

/** Launches (or attaches to) a browser and hands back one page session. */
export function defaultOpenPage(launch: RunFlowDeps['launch'] = {}): OpenPage {
  return async ({ headless, cdpEndpoint }) => {
    if (cdpEndpoint !== undefined) {
      loopbackEndpoint(cdpEndpoint)
      const endpoint = await attachToEndpoint(cdpEndpoint)
      const socket = await endpoint.browserWebSocketUrl()
      loopbackSocket(socket, cdpEndpoint)
      const client = await CdpClient.connect(socket, { commandTimeoutMs: 30_000 })
      try {
        const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
        const sessionId = await attachPage(client, targetId)
        return {
          client,
          sessionId,
          async close() {
            await client.send('Target.closeTarget', { targetId }).catch(() => undefined)
            client.close()
          }
        }
      } catch (error) {
        client.close()
        throw error
      }
    }

    const browser = await launchDebugBrowser({ headless, startUrl: 'about:blank', ...launch })
    let client: CdpClient | undefined
    try {
      const page = await browser.endpoint.firstPageTarget()
      client = await CdpClient.connect(await browser.endpoint.browserWebSocketUrl(), { commandTimeoutMs: 30_000 })
      const sessionId = await attachPage(client, page.id)
      const owned = client
      return {
        client: owned,
        sessionId,
        async close() {
          owned.close()
          await browser.close().catch(() => undefined)
        }
      }
    } catch (error) {
      client?.close()
      await browser.close().catch(() => undefined)
      throw error
    }
  }
}

function report(file: string, flow: Flow, run: FlowRun): FlowRunReport {
  return {
    file,
    flow: flow.name,
    status: run.status,
    duration_ms: run.durationMs,
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.failedStepId !== undefined ? { failed_step_id: run.failedStepId } : {}),
    steps: run.steps.map(({ screenshotPng, ...step }) =>
      screenshotPng === undefined ? step : { ...step, screenshot_bytes: Buffer.byteLength(screenshotPng, 'base64') }
    )
  }
}

/** Reads, checks and replays one flow file. Step failures are a `failed` report, not a throw. */
export async function runFlowFile(request: FlowRunRequest, deps: RunFlowDeps = {}): Promise<FlowRunReport> {
  const real = await resolveFlowFile(request.file, deps.roots)
  const parsed = parseFlow(await fs.readFile(real, 'utf8'))
  if (!parsed.ok) {
    throw new ToolError('INVALID_ARGUMENTS', `The flow file is not valid:\n${formatFlowErrors(parsed.errors, real)}`, {
      file: request.file
    })
  }
  const flow = withVars(parsed.flow, request.vars)
  if (flow.target.kind !== 'browser') {
    throw new ToolError(
      'NOT_IMPLEMENTED',
      'This flow targets a desktop app; replaying desktop flows needs computer-use replay, which this build does not have yet.',
      { file: request.file }
    )
  }

  // Null-prototype copies: `${env.constructor}` must be "not provided", not Object's constructor.
  const env: Record<string, string> = Object.assign(Object.create(null), request.env)
  const secrets: Record<string, string> = Object.assign(Object.create(null), request.secrets)
  const secret = (name: string): string | undefined => secrets[name]

  /** A run that ends before any browser is started: every step skipped or not run. */
  const before = (error: string): FlowRunReport => ({
    file: request.file,
    flow: flow.name,
    status: 'failed',
    duration_ms: 0,
    error,
    steps: flow.steps.map((s) => ({ id: s.id, action: s.action, status: s.disabled ? 'skipped' : 'not_run' }))
  })

  // Missing inputs fail the run before a browser is started for nothing.
  try {
    createInterpolator(flow, { env, secret }, { includeTarget: true })
  } catch (error) {
    if (!(error instanceof MissingFlowInputsError)) throw error
    return before(error.message)
  }
  // Paused (or the caller left) while the file was being read: don't open a browser at all.
  if (deps.signal?.aborted) {
    return before(typeof deps.signal.reason === 'string' ? deps.signal.reason : 'the run was stopped')
  }

  const openPage = deps.openPage ?? defaultOpenPage(deps.launch)
  let page: BrowserPage
  try {
    page = await openPage({ headless: request.headless ?? false, cdpEndpoint: request.cdpEndpoint })
  } catch (error) {
    if (error instanceof ToolError) throw error
    throw new ToolError('UNAVAILABLE', `Could not open a browser for the run: ${(error as Error).message ?? error}`, {
      file: request.file
    })
  }
  try {
    const run = await replayFlow(page.client, flow, {
      sessionId: page.sessionId,
      env,
      secret,
      defaultTimeoutMs: request.stepTimeoutMs,
      signal: deps.signal
    })
    return report(request.file, flow, run)
  } finally {
    await page.close()
  }
}
