/**
 * Getting a CDP endpoint to talk to, by either of the two routes that actually
 * work:
 *
 *  1. **Launch** a Chromium-family browser we control, with
 *     `--remote-debugging-port=0` and a dedicated profile directory, then read
 *     the port Chrome chose back out of `DevToolsActivePort`.
 *  2. **Attach** to an endpoint the user already started themselves.
 *
 * There is no third route, and in particular there is no attaching to the
 * user's *normal* Chrome: Chrome refuses `--remote-debugging-port` when the
 * profile is already in use by a running instance, and the second process just
 * hands its command line to the first and exits. That is the single most
 * likely thing to go wrong here, so it surfaces as a typed
 * `BrowserLaunchError`/`AttachError` with an explanation, never as a hang.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export type BrowserKind = 'chrome' | 'edge' | 'playwright-chromium'

export interface BrowserExecutable {
  kind: BrowserKind
  path: string
}

export type LaunchFailureReason =
  | 'no-browser-found'
  | 'port-file-timeout'
  | 'process-exited'
  | 'no-page-target'
  | 'profile-in-use'

export class BrowserLaunchError extends Error {
  readonly reason: LaunchFailureReason
  readonly detail: string | undefined

  constructor(reason: LaunchFailureReason, message: string, detail?: string) {
    super(message)
    this.name = 'BrowserLaunchError'
    this.reason = reason
    this.detail = detail
  }
}

export type AttachFailureReason = 'unreachable' | 'bad-response' | 'no-page-target' | 'timeout'

export class AttachError extends Error {
  readonly reason: AttachFailureReason
  readonly endpoint: string

  constructor(reason: AttachFailureReason, endpoint: string, message: string) {
    super(message)
    this.name = 'AttachError'
    this.reason = reason
    this.endpoint = endpoint
  }
}

export interface CdpTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

export interface LaunchOptions {
  /** Preference order; the first that exists on disk wins. */
  prefer?: BrowserKind[]
  /** Skip discovery entirely. */
  executablePath?: string
  /** Debug profile directory. A fresh temp dir is created (and removed on close) if omitted. */
  userDataDir?: string
  headless?: boolean
  /** Initial URL. */
  startUrl?: string
  /** How long to wait for `DevToolsActivePort` to appear. */
  timeoutMs?: number
  extraArgs?: string[]
}

/** Flags every launch needs so the debug profile behaves predictably. */
const BASE_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=Translate,MediaRouter'
]

const WINDOWS_CANDIDATES: ReadonlyArray<{ kind: BrowserKind; path: string }> = [
  { kind: 'chrome', path: 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
  { kind: 'chrome', path: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' },
  { kind: 'edge', path: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' },
  { kind: 'edge', path: 'C:/Program Files/Microsoft/Edge/Application/msedge.exe' }
]

const MAC_CANDIDATES: ReadonlyArray<{ kind: BrowserKind; path: string }> = [
  { kind: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  { kind: 'edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' }
]

const LINUX_CANDIDATES: ReadonlyArray<{ kind: BrowserKind; path: string }> = [
  { kind: 'chrome', path: '/usr/bin/google-chrome' },
  { kind: 'chrome', path: '/usr/bin/chromium' },
  { kind: 'chrome', path: '/usr/bin/chromium-browser' },
  { kind: 'edge', path: '/usr/bin/microsoft-edge' }
]

/**
 * Playwright's downloaded Chromium, used as a fallback so a dev machine or CI
 * box with no system Chrome still has something to drive. Playwright itself is
 * never imported at runtime — only this path on disk is read — which is what
 * keeps it a devDependency.
 */
function playwrightChromium(): BrowserExecutable | null {
  const roots =
    process.platform === 'win32'
      ? [join(homedir(), 'AppData/Local/ms-playwright')]
      : process.platform === 'darwin'
        ? [join(homedir(), 'Library/Caches/ms-playwright')]
        : [join(homedir(), '.cache/ms-playwright')]
  const relative =
    process.platform === 'win32'
      ? 'chrome-win/chrome.exe'
      : process.platform === 'darwin'
        ? 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'
        : 'chrome-linux/chrome'

  for (const root of roots) {
    if (!existsSync(root)) continue
    const builds = readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      // Numeric, not lexicographic: "chromium-99" must not beat "chromium-1234".
      .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    for (const build of builds) {
      const candidate = join(root, build, relative)
      if (existsSync(candidate)) return { kind: 'playwright-chromium', path: candidate }
    }
  }
  return null
}

const DEFAULT_PREFERENCE: BrowserKind[] = ['chrome', 'edge', 'playwright-chromium']

/** First existing executable in preference order, or null. */
export function findBrowserExecutable(prefer: BrowserKind[] = DEFAULT_PREFERENCE): BrowserExecutable | null {
  const installed =
    process.platform === 'win32'
      ? WINDOWS_CANDIDATES
      : process.platform === 'darwin'
        ? MAC_CANDIDATES
        : LINUX_CANDIDATES

  for (const kind of prefer) {
    if (kind === 'playwright-chromium') {
      const found = playwrightChromium()
      if (found) return found
      continue
    }
    const found = installed.find((c) => c.kind === kind && existsSync(c.path))
    if (found) return { kind: found.kind, path: found.path }
  }
  return null
}

/** `GET url` as JSON, with a hard timeout so an unreachable endpoint fails instead of hanging. */
function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Deliberately no Host header override. DevTools echoes the request's Host
    // straight back into `webSocketDebuggerUrl`, so forcing `Host: localhost`
    // yields a port-less `ws://localhost/devtools/...` that cannot connect.
    // Node's default (`127.0.0.1:<port>`) is both correct and accepted by
    // DevTools' DNS-rebinding check.
    const request = httpGet(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (body += chunk))
      response.on('end', () => {
        try {
          resolve(JSON.parse(body) as T)
        } catch (error) {
          reject(new Error(`non-JSON response from ${url}: ${String(error)}`))
        }
      })
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`timed out after ${timeoutMs}ms`))
    })
    request.on('error', reject)
  })
}

/** A live DevTools HTTP endpoint, however it was obtained. */
export class DebugEndpoint {
  constructor(
    readonly host: string,
    readonly port: number,
    private readonly requestTimeoutMs = 5_000
  ) {}

  get httpBase(): string {
    return `http://${this.host}:${this.port}`
  }

  async listTargets(): Promise<CdpTarget[]> {
    try {
      return await getJson<CdpTarget[]>(`${this.httpBase}/json/list`, this.requestTimeoutMs)
    } catch (error) {
      throw new AttachError('unreachable', this.httpBase, `could not list targets: ${String(error)}`)
    }
  }

  /** The browser-level endpoint, which is what `Target.setAutoAttach` needs. */
  async browserWebSocketUrl(): Promise<string> {
    let version: { webSocketDebuggerUrl?: string }
    try {
      version = await getJson(`${this.httpBase}/json/version`, this.requestTimeoutMs)
    } catch (error) {
      throw new AttachError('unreachable', this.httpBase, `could not read /json/version: ${String(error)}`)
    }
    if (!version.webSocketDebuggerUrl) {
      throw new AttachError('bad-response', this.httpBase, '/json/version carried no webSocketDebuggerUrl')
    }
    return version.webSocketDebuggerUrl
  }

  /** First `page` target with a debugger URL, waiting up to `timeoutMs` for one to exist. */
  async firstPageTarget(timeoutMs = 10_000): Promise<CdpTarget> {
    const deadline = Date.now() + timeoutMs
    let lastSeen: CdpTarget[] = []
    for (;;) {
      lastSeen = await this.listTargets()
      const page = lastSeen.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
      if (Date.now() >= deadline) break
      await delay(100)
    }
    throw new AttachError(
      'no-page-target',
      this.httpBase,
      `no page target appeared within ${timeoutMs}ms (saw: ${lastSeen.map((t) => t.type).join(', ') || 'nothing'})`
    )
  }
}

/**
 * Attach to a DevTools endpoint the user started themselves.
 *
 * `endpoint` accepts `9222`, `127.0.0.1:9222`, or `http://127.0.0.1:9222`.
 * Failure is always a typed `AttachError` carrying the remediation, because the
 * overwhelmingly common cause is "Chrome was already running, so the flag was
 * ignored" and a bare ECONNREFUSED does not tell the user that.
 */
export async function attachToEndpoint(endpoint: string, requestTimeoutMs = 5_000): Promise<DebugEndpoint> {
  const parsed = parseEndpoint(endpoint)
  if (!parsed) {
    throw new AttachError('bad-response', endpoint, `could not parse "${endpoint}" as host:port`)
  }
  const target = new DebugEndpoint(parsed.host, parsed.port, requestTimeoutMs)
  try {
    await target.listTargets()
  } catch {
    throw new AttachError(
      'unreachable',
      target.httpBase,
      `nothing is listening for DevTools on ${target.httpBase}. ` +
        'Chrome ignores --remote-debugging-port when the profile is already open in a running ' +
        'instance, so start it fully quit and with a dedicated profile, e.g. ' +
        `chrome --remote-debugging-port=${parsed.port} --user-data-dir=<a fresh directory>`
    )
  }
  return target
}

function parseEndpoint(endpoint: string): { host: string; port: number } | null {
  const trimmed = endpoint.trim()
  if (/^\d+$/.test(trimmed)) return { host: '127.0.0.1', port: Number(trimmed) }
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withScheme)
    const port = Number(url.port)
    if (!url.hostname || !Number.isInteger(port) || port <= 0) return null
    return { host: url.hostname, port }
  } catch {
    return null
  }
}

/** A browser process we started and are responsible for killing. */
export interface LaunchedBrowser {
  endpoint: DebugEndpoint
  executable: BrowserExecutable
  userDataDir: string
  pid: number | undefined
  /** Resolves when the process has exited and any temp profile has been removed. */
  close(): Promise<void>
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function launchDebugBrowser(options: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const executable: BrowserExecutable | null = options.executablePath
    ? { kind: 'chrome', path: options.executablePath }
    : findBrowserExecutable(options.prefer)

  if (!executable || !existsSync(executable.path)) {
    throw new BrowserLaunchError(
      'no-browser-found',
      'no Chrome, Edge, or Chromium executable was found to launch for structured capture',
      options.executablePath ?? (options.prefer ?? DEFAULT_PREFERENCE).join(', ')
    )
  }

  const ownsProfile = !options.userDataDir
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'nawi-cdp-'))
  const timeoutMs = options.timeoutMs ?? 20_000

  const args = [
    // Port 0 asks Chrome to pick a free port; the real one comes back through
    // DevToolsActivePort. Hardcoding a port races any other tool on the box.
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    ...BASE_ARGS,
    ...(options.headless ? ['--headless=new'] : []),
    ...(options.extraArgs ?? []),
    ...(options.startUrl ? [options.startUrl] : [])
  ]

  const child: ChildProcess = spawn(executable.path, args, { stdio: 'ignore' })

  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
  let spawnError: Error | null = null
  child.on('error', (error) => (spawnError = error))
  child.on('exit', (code, signal) => (exitInfo = { code, signal }))

  const portFile = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  let port: number | null = null

  while (port === null && Date.now() < deadline) {
    if (spawnError) {
      await cleanup()
      throw new BrowserLaunchError(
        'process-exited',
        `could not start ${executable.path}`,
        String((spawnError as Error).message)
      )
    }
    if (exitInfo) {
      await cleanup()
      // Chrome exiting immediately with a clean code is the "profile already in
      // use" signature: it handed the command line to the running instance.
      const info = exitInfo as { code: number | null; signal: NodeJS.Signals | null }
      throw new BrowserLaunchError(
        info.code === 0 ? 'profile-in-use' : 'process-exited',
        info.code === 0
          ? 'the browser exited immediately without opening a DevTools port — this normally means ' +
            'the profile is already open in a running instance, which makes the second process ' +
            'forward its command line and quit. Quit that browser, or use a dedicated profile ' +
            'directory, or attach to an endpoint you started yourself.'
          : `the browser exited before opening a DevTools port (code ${String(info.code)}, signal ${String(info.signal)})`,
        `${executable.path} ${args.join(' ')}`
      )
    }
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, 'utf8').split('\n')[0]?.trim()
      const parsedPort = Number(first)
      if (first && Number.isInteger(parsedPort) && parsedPort > 0) port = parsedPort
    }
    if (port === null) await delay(50)
  }

  if (port === null) {
    await cleanup()
    throw new BrowserLaunchError(
      'port-file-timeout',
      `${executable.path} never wrote DevToolsActivePort within ${timeoutMs}ms`,
      portFile
    )
  }

  return {
    endpoint: new DebugEndpoint('127.0.0.1', port),
    executable,
    userDataDir,
    pid: child.pid,
    close: cleanup
  }

  async function cleanup(): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill()
      // Escalate rather than leaving an orphan holding the profile directory.
      const escalate = setTimeout(() => child.kill('SIGKILL'), 3_000)
      await Promise.race([exited, delay(5_000)])
      clearTimeout(escalate)
    }
    if (ownsProfile) {
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 })
      } catch (error) {
        // A locked profile dir on Windows is untidy, not a failure of the
        // capture — but it must not disappear silently.
        console.warn('[cdp] could not remove debug profile', userDataDir, error)
      }
    }
  }
}
