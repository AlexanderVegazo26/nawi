import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Discovery of the running app's loopback JSON-RPC endpoint.
 *
 * Extracted from `stdio-bridge.ts` when the CLI became a second consumer. That
 * file's own doc comment is the reason this is shared rather than copied:
 * duplicating policy "would create a second place for it to be wrong". The
 * config path convention and the not-running refusal are both policy.
 *
 * Everything here must stay dependency-free and electron-free — both consumers
 * are plain-node processes spawned outside the app.
 */

export interface EndpointInfo {
  url: string
  token: string
  pid: number
}

/**
 * Resolves `userData/mcp.json`.
 *
 * `app.getPath('userData')` is not available here (no electron), so the platform
 * convention is reproduced. `NAWI_MCP_CONFIG` overrides it — which is how
 * the E2E suite points the bridge at its throwaway `--user-data-dir` instead of
 * the developer's real profile.
 */
export function configPath(): string {
  const override = process.env['NAWI_MCP_CONFIG']
  if (override) return override

  const appName = 'nawi'
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, appName, 'mcp.json')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', appName, 'mcp.json')
  }
  const xdg = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
  return join(xdg, appName, 'mcp.json')
}

/** Hostnames as WHATWG `URL` reports them; IPv6 keeps its brackets. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * True only for a plain `http:` URL on a loopback host, with no credentials.
 *
 * The app always publishes `http://127.0.0.1:<port>/mcp`. Anything else in
 * `mcp.json` was written by someone else: a same-user process that rewrites the
 * file could otherwise point the bridge (and the CLI) at a remote host and turn
 * it into an exfiltration channel for the agent's traffic and the bearer token
 * (docs/SECURITY-REVIEW-M1A.md). Parsing with `URL` rather than matching the
 * string is what defeats `http://127.0.0.1@evil.example` and
 * `http://127.0.0.1.evil.example`.
 */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return (
    url.protocol === 'http:' &&
    url.username === '' &&
    url.password === '' &&
    LOOPBACK_HOSTS.has(url.hostname)
  )
}

/**
 * Re-read per request, not cached: the app can restart on a new ephemeral port.
 * A non-loopback `url` is treated like a missing file (see `isLoopbackUrl`).
 */
export function readEndpoint(): EndpointInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<EndpointInfo>
    if (typeof parsed.url !== 'string' || typeof parsed.token !== 'string') return null
    if (!isLoopbackUrl(parsed.url)) return null
    return { url: parsed.url, token: parsed.token, pid: Number(parsed.pid) || 0 }
  } catch {
    return null
  }
}

/**
 * The single wording for "the app isn't up".
 *
 * Neither consumer launches the app. That is a deliberate product decision
 * carried over from the bridge: an agent handshake — or a shell command —
 * silently starting a GUI on someone's desktop is a surprise they never
 * consented to.
 */
export const NOT_RUNNING =
  'Nawi is not running, so its agent interface is unavailable. Start Nawi and try again. ' +
  '(This bridge deliberately does not launch the app for you.)'
