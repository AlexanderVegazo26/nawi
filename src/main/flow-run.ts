import { createHash } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { arch, homedir, platform, release } from 'node:os'
import { insideRoots, within } from './confine'
import { dirname, isAbsolute, resolve } from 'node:path'
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
import { MAX_ANCHOR_BYTES, replayFlow, withIntent, type FlowRun, type ReplayClient, type ReplayOptions, type StepRun, type StepScreenshots } from './replay/replay'
import type { StepEvidence } from './replay/evidence'
import {
  buildRunRecord,
  newRunId,
  pruneRuns,
  writeRunRecord,
  DEFAULT_KEEP_RUNS,
  type RecordedStep,
  type RunEnvironment,
  type ShotFiles
} from './run-record'
import { toHtmlReport } from './run-report'

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
/** Longest flow file path a caller may pass (run_flow, the run_and_triage prompt). */
export const MAX_FLOW_PATH = 4096

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
  /**
   * Page screenshots around each step for the run record (F4b2). Default
   * `all` when a record is kept; never taken without one.
   */
  screenshots?: StepScreenshots
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
  /**
   * Where to keep the run record (roadmap F4a): `<dir>/<run-id>/run.json`,
   * `junit.xml` and step screenshots. Without it nothing is written.
   */
  record?: { dir: string; appVersion?: string; keep?: number }
  /** Injected for tests; defaults to Date.now. */
  now?: () => number
  /** Told about each step as it settles (MCP progress notifications). */
  onStep?: ReplayOptions['onStep']
}

/** Console errors and failed requests per step in `run_flow`'s answer; the run record keeps up to 20 of each. */
export const REPORTED_EVIDENCE_PER_STEP = 3

/**
 * `run_flow`'s answer. Screenshots are summarised: the bytes belong in the run record (F4), not in an RPC reply.
 * Likewise only the first few console errors and failed requests of each step are included (the rest are
 * counted in `*Dropped`), so a noisy page cannot flood the calling agent's context.
 */
export interface FlowRunReport {
  file: string
  flow: string
  status: FlowRun['status']
  duration_ms: number
  error?: string
  failed_step_id?: string
  steps: Array<Omit<StepRun, 'screenshotPng' | 'shots'> & { screenshot_bytes?: number; shots?: ShotFiles }>
  /** Console errors and failed requests while the target was opening (F4b). */
  opening?: FlowRun['opening']
  /** The page's URL when the run ended, scrubbed. */
  final_url?: string
  /** Set when the run record was saved. */
  run_id?: string
  /** The run record's folder (run.json, junit.xml, steps/). */
  run_dir?: string
  /** Why the run record could not be saved; the run's own result is unaffected. */
  record_error?: string
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export { within }

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
  if (!real.endsWith(FLOW_FILE_SUFFIX) || !(await insideRoots(real, roots))) {
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

/**
 * Bytes of an asset a flow points at (`target.image`), read only from inside
 * the flow's own folder: the schema already refuses absolute paths and `..`,
 * and this also refuses a symlink that resolves outside it, a non-file and
 * anything over MAX_ANCHOR_BYTES. The resolved file is checked, opened
 * without blocking (a FIFO swapped in would otherwise hang the run) and
 * checked again through that handle.
 */
export async function readFlowAsset(flowFile: string, path: string): Promise<Uint8Array> {
  const folder = await fs.realpath(dirname(flowFile))
  let real: string
  try {
    real = await fs.realpath(resolve(folder, path))
  } catch {
    throw new Error(`${path} does not exist next to the flow`)
  }
  if (!within(folder, real)) throw new Error(`${path} resolves outside the flow's folder`)
  // A named pipe would block open() itself: refuse non-files before opening, and open without blocking.
  if (!(await fs.stat(real)).isFile()) throw new Error(`${path} is not a file`)
  const handle = await fs.open(real, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`${path} is not a file`)
    if (stat.size > MAX_ANCHOR_BYTES) throw new Error(`${path} is larger than ${MAX_ANCHOR_BYTES} bytes`)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
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

/** At most `REPORTED_EVIDENCE_PER_STEP` of each kind; the rest move into the dropped counts. */
export function trimEvidence<T extends Omit<StepEvidence, 'url'>>(e: T): T {
  const out = { ...e }
  const n = REPORTED_EVIDENCE_PER_STEP
  if (out.consoleErrors && out.consoleErrors.length > n) {
    out.consoleErrorsDropped = (out.consoleErrorsDropped ?? 0) + out.consoleErrors.length - n
    out.consoleErrors = out.consoleErrors.slice(0, n)
  }
  if (out.failedRequests && out.failedRequests.length > n) {
    out.failedRequestsDropped = (out.failedRequestsDropped ?? 0) + out.failedRequests.length - n
    out.failedRequests = out.failedRequests.slice(0, n)
  }
  return out
}

/**
 * `recorded`: the saved record's steps, whose `shots` are file paths inside
 * run_dir; the reply carries those paths, never the image bytes.
 */
function report(
  file: string,
  flow: Flow,
  run: FlowRun,
  saved: Pick<FlowRunReport, 'run_id' | 'run_dir' | 'record_error'> = {},
  recorded?: RecordedStep[]
): FlowRunReport {
  return {
    file,
    flow: flow.name,
    status: run.status,
    duration_ms: run.durationMs,
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.failedStepId !== undefined ? { failed_step_id: run.failedStepId } : {}),
    ...(run.opening ? { opening: trimEvidence(run.opening) } : {}),
    ...(run.finalUrl !== undefined ? { final_url: run.finalUrl } : {}),
    // buildRunRecord maps run.steps one to one, so the same index is the same step.
    steps: run.steps.map(({ screenshotPng, shots: _shotData, ...step }, index) => {
      const shots = recorded?.[index]?.shots
      return {
        ...trimEvidence(step),
        ...(screenshotPng !== undefined ? { screenshot_bytes: Buffer.byteLength(screenshotPng, 'base64') } : {}),
        ...(shots ? { shots } : {})
      }
    }),
    ...saved
  }
}

/** Resolves to undefined instead of waiting on a page that stopped answering. */
function settleWithin<T>(ms: number, p: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  return Promise.race([p.catch(() => undefined), timeout]).finally(() => clearTimeout(timer))
}

/** Browser and viewport facts for the run record; best effort, never fails the run. */
async function browserFacts(page: BrowserPage): Promise<Pick<RunEnvironment, 'browser' | 'viewport'>> {
  const out: Pick<RunEnvironment, 'browser' | 'viewport'> = {}
  const [version, viewport] = await Promise.all([
    settleWithin(2_000, page.client.send<{ product?: unknown; protocolVersion?: unknown }>('Browser.getVersion')),
    settleWithin(
      2_000,
      page.client.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: '[innerWidth, innerHeight, devicePixelRatio]', returnByValue: true },
        page.sessionId
      )
    )
  ])
  if (typeof version?.product === 'string') {
    out.browser = {
      product: version.product,
      ...(typeof version.protocolVersion === 'string' ? { protocol_version: version.protocolVersion } : {})
    }
  }
  const v = viewport?.result?.value
  if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    out.viewport = { width: v[0], height: v[1], device_scale_factor: v[2] }
  }
  return out
}

/** Reads, checks and replays one flow file. Step failures are a `failed` report, not a throw. */
export async function runFlowFile(request: FlowRunRequest, deps: RunFlowDeps = {}): Promise<FlowRunReport> {
  const real = await resolveFlowFile(request.file, deps.roots)
  const bytes = await fs.readFile(real)
  const parsed = parseFlow(bytes.toString('utf8'))
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

  const now = deps.now ?? Date.now

  /** Saves the run record when the app asked for one, and builds the reply. A failed save is reported, not thrown. */
  const finish = async (run: FlowRun, facts: Pick<RunEnvironment, 'browser' | 'viewport'> = {}): Promise<FlowRunReport> => {
    if (!deps.record) return report(request.file, flow, run)
    try {
      const runId = newRunId(run.startedAt)
      const { record, assets } = buildRunRecord({
        runId,
        flow: { name: flow.name, file: real, sha256: createHash('sha256').update(bytes).digest('hex') },
        run,
        environment: {
          ...(deps.record.appVersion !== undefined ? { app_version: deps.record.appVersion } : {}),
          os: { platform: platform(), release: release(), arch: arch() },
          ...facts
        }
      })
      // The report is a convenience: if it cannot be rendered, the record (run.json, junit.xml) is still saved.
      let html: string | undefined
      try {
        html = toHtmlReport(record, assets)
      } catch {
        html = undefined
      }
      const dir = await writeRunRecord(deps.record.dir, record, assets, html)
      await pruneRuns(deps.record.dir, deps.record.keep ?? DEFAULT_KEEP_RUNS).catch(() => undefined)
      return report(request.file, flow, run, { run_id: runId, run_dir: dir }, record.steps)
    } catch (error) {
      return report(request.file, flow, run, { record_error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** A run that ends before any browser is started: every step skipped or not run. */
  const before = (error: string): Promise<FlowRunReport> =>
    finish({
      status: 'failed',
      startedAt: now(),
      durationMs: 0,
      error,
      steps: flow.steps.map((s) => ({ ...withIntent(s), status: s.disabled ? 'skipped' : 'not_run' }))
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
  let run: FlowRun
  let facts: Pick<RunEnvironment, 'browser' | 'viewport'> = {}
  try {
    run = await replayFlow(page.client, flow, {
      sessionId: page.sessionId,
      env,
      secret,
      defaultTimeoutMs: request.stepTimeoutMs,
      // Shots live only in the record: none without one.
      stepScreenshots: deps.record ? (request.screenshots ?? 'all') : 'off',
      signal: deps.signal,
      onStep: deps.onStep,
      loadAsset: (path) => readFlowAsset(real, path),
      now
    })
    if (deps.record) facts = await browserFacts(page)
  } finally {
    await page.close()
  }
  // The browser is closed before the record is written: disk work never keeps a window open.
  return finish(run, facts)
}
