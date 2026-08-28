import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  IdempotencyCache,
  assertLoopbackTrust,
  describeTools,
  dispatch,
  type CallRecord,
  type ToolDefinition
} from './dispatch'
import { ToolError, toToolError } from './errors'
import { TOOLS } from './tools'
import * as settings from '../settings'

/**
 * The MCP endpoint, hosted in Electron main.
 *
 * **Why main hosts HTTP and not stdio** (PRD Q5): the tool bodies need
 * `library`, `capture` and the `BrowserWindow`, all of which only exist here —
 * but a packaged Electron app on Windows has no usable stdout, so an MCP client
 * cannot speak stdio to this process. Splitting on that line gives main a
 * loopback HTTP listener and puts the stdio half in `src/mcp/stdio-bridge.ts`,
 * a plain-node process that does have a real stdout and holds zero tool logic.
 *
 * **Loopback is not a trust boundary.** Any local process — including a
 * malicious web page's `fetch` — can reach `127.0.0.1`. So every request carries
 * a random bearer token, a non-null `Origin` is rejected outright (DNS
 * rebinding), and the socket is bound explicitly to `127.0.0.1` rather than
 * `0.0.0.0`, which would expose it to the LAN.
 *
 * **FR-SEC.1:** a *listening* loopback socket is not network egress. Nothing
 * leaves this machine because this server exists, so it must never be counted as
 * outbound traffic by a local-only indicator. There is no such indicator in the
 * build yet; `describe()` reports `egress: false` so the one that gets built has
 * the fact available rather than having to infer it.
 *
 * JSON-RPC framing is hand-rolled over `node:http`. The `@modelcontextprotocol/sdk`
 * package was installed and inspected first: its Streamable-HTTP transport pulls
 * express 5, hono, ajv, jose, cors, eventsource and pkce-challenge into runtime
 * `dependencies`, and `externalizeDepsPlugin()` would ship all of it in the asar
 * — a large surface for the three methods actually needed (`initialize`,
 * `tools/list`, `tools/call`). The milestone plan pre-authorized this fallback.
 */

const PROTOCOL_VERSION = '2025-06-18'
const MCP_PATH = '/mcp'
/** An MCP request is a small JSON envelope; anything larger is not one. */
const MAX_BODY_BYTES = 1024 * 1024

export interface McpEndpointInfo {
  port: number
  token: string
  url: string
  pid: number
  protocolVersion: string
  /** FR-SEC.1: a listening loopback socket is not egress. */
  egress: false
}

export interface McpServerHandle {
  info: McpEndpointInfo
  close(): Promise<void>
}

/** Where the bridge (and the user) find the port and token. */
export function mcpConfigPath(): string {
  return join(app.getPath('userData'), 'mcp.json')
}

/* ------------------------------------------------------------------ *
 * JSON-RPC
 * ------------------------------------------------------------------ */

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

type JsonRpcId = string | number | null

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })
}

function rpcResult(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

/**
 * JSON-RPC code for a tool-level failure.
 *
 * -32000 is the reserved implementation-defined range. The *typed* code
 * (AGENT_ACCESS_PAUSED, NO_BROWSER_ATTACHED, …) travels in `error.data.code`,
 * which is what UX-AGT.3's acceptance is asserted against — a numeric JSON-RPC
 * code alone could not distinguish "paused" from "not implemented".
 */
const APP_ERROR = -32000

function errorPayload(err: ToolError): { code: number; message: string; data: unknown } {
  return {
    code: APP_ERROR,
    message: err.message,
    data: { code: err.code, ...err.detail }
  }
}

/* ------------------------------------------------------------------ *
 * Request plumbing
 * ------------------------------------------------------------------ */

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    // Bounded before buffering, not after: an unbounded read from an untrusted
    // local peer is a trivial memory-exhaustion vector.
    if (total > MAX_BODY_BYTES) throw new ToolError('INVALID_ARGUMENTS', 'Request body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name]
  if (Array.isArray(v)) return v[0] ?? null
  return typeof v === 'string' ? v : null
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
    // This endpoint is never for browsers. No CORS headers are emitted, so a page
    // cannot read a response even if it somehow got one.
    'cache-control': 'no-store'
  })
  res.end(body)
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

export interface StartOptions {
  tools?: ToolDefinition[]
  /** Overridable so a test can drive the switch without touching real settings. */
  isPaused?(): Promise<boolean>
  onCall?(record: CallRecord): void
}

/**
 * Starts the endpoint and publishes `userData/mcp.json`.
 *
 * Never throws for an operational failure — a port problem must degrade the
 * agent interface, not prevent the app from launching. The caller logs and
 * carries on with `null`.
 */
export async function startMcpServer(options: StartOptions = {}): Promise<McpServerHandle | null> {
  const tools = options.tools ?? TOOLS
  const token = randomBytes(32).toString('base64url')
  const idempotency = new IdempotencyCache()
  const isPaused =
    options.isPaused ?? (async (): Promise<boolean> => (await settings.getSettings()).agentAccessPaused)

  const deps = { isPaused, token, tools, idempotency, onCall: options.onCall }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      // Terminal safety net. Every path above answers the request; this exists so
      // a bug here can never leave a client hanging with no response and no log.
      console.error('[mcp] unhandled request failure', err)
      if (!res.headersSent) send(res, 500, rpcError(null, -32603, 'Internal error'))
      else res.end()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = header(req, 'origin')
    const authorization = header(req, 'authorization')

    // Applied to *every* method, not just tools/call: `tools/list` leaks the
    // shape of the local install, and `initialize` confirms the app is running.
    try {
      assertLoopbackTrust(token, authorization, origin)
    } catch (err) {
      const te = toToolError(err)
      const status = te.code === 'FORBIDDEN_ORIGIN' ? 403 : 401
      send(res, status, rpcError(null, APP_ERROR, te.message, { code: te.code }))
      return
    }

    if ((req.url ?? '').split('?')[0] !== MCP_PATH) {
      send(res, 404, rpcError(null, -32601, 'Not found'))
      return
    }
    if (req.method !== 'POST') {
      // No SSE stream is offered: nothing here pushes server-initiated messages,
      // and advertising a stream we never write to just makes clients wait.
      send(res, 405, rpcError(null, -32601, 'Only POST is supported on this endpoint'))
      return
    }

    let raw: string
    try {
      raw = await readBody(req)
    } catch (err) {
      send(res, 413, rpcError(null, -32600, toToolError(err).message))
      return
    }

    let message: JsonRpcRequest
    try {
      message = JSON.parse(raw) as JsonRpcRequest
    } catch {
      send(res, 400, rpcError(null, -32700, 'Parse error'))
      return
    }
    if (typeof message?.method !== 'string') {
      send(res, 400, rpcError(message?.id ?? null, -32600, 'Invalid request'))
      return
    }

    const id: JsonRpcId = message.id ?? null

    // A notification (no id) gets no body — answering one confuses a strict client.
    const isNotification = message.id === undefined || message.id === null

    switch (message.method) {
      case 'initialize':
        send(
          res,
          200,
          rpcResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'nawi', version: app.getVersion?.() ?? '0.1.0' }
          })
        )
        return

      case 'notifications/initialized':
      case 'notifications/cancelled':
        res.writeHead(202).end()
        return

      case 'ping':
        send(res, 200, rpcResult(id, {}))
        return

      case 'tools/list':
        send(res, 200, rpcResult(id, { tools: describeTools(tools) }))
        return

      case 'tools/call': {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown }
        if (typeof params.name !== 'string') {
          send(res, 200, rpcError(id, -32602, 'tools/call requires a string "name"'))
          return
        }
        try {
          const value = await dispatch(deps, {
            name: params.name,
            args: params.arguments,
            authorization,
            origin,
            callId: randomUUID()
          })
          send(
            res,
            200,
            rpcResult(id, {
              // Both shapes: `content` for clients that render text, and
              // `structuredContent` for clients that want the object.
              content: [{ type: 'text', text: JSON.stringify(value) }],
              structuredContent: value,
              isError: false
            })
          )
        } catch (err) {
          const te = toToolError(err)
          const payload = errorPayload(te)
          if (isNotification) {
            res.writeHead(202).end()
            return
          }
          // 200 with a JSON-RPC error: the HTTP request succeeded, the call did
          // not. A 4xx here would make transports retry a deterministic refusal.
          send(res, 200, rpcError(id, payload.code, payload.message, payload.data))
        }
        return
      }

      default:
        if (isNotification) {
          res.writeHead(202).end()
          return
        }
        send(res, 200, rpcError(id, -32601, `Unknown method: ${message.method}`))
    }
  }

  const port = await new Promise<number | null>((resolve) => {
    server.once('error', (err) => {
      console.error('[mcp] could not start the agent endpoint', err)
      resolve(null)
    })
    // Explicitly 127.0.0.1. The default binds every interface, which would put
    // this on the LAN.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : null)
    })
  })

  if (port === null) {
    server.close()
    return null
  }

  const info: McpEndpointInfo = {
    port,
    token,
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    pid: process.pid,
    protocolVersion: PROTOCOL_VERSION,
    egress: false
  }

  try {
    const target = mcpConfigPath()
    await fs.mkdir(join(target, '..'), { recursive: true })
    // `mode` is honoured on POSIX. On Windows only the read-only bit is honoured,
    // so this does NOT restrict other local users there — the bearer token, not
    // the file mode, is what actually protects the endpoint.
    await fs.writeFile(target, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 })
    await fs.chmod(target, 0o600).catch(() => undefined)
  } catch (err) {
    // Without the file no bridge can connect, so this is a real failure — but it
    // still must not take the app down.
    console.error('[mcp] could not publish mcp.json', err)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return null
  }

  return {
    info,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      // The file names a port nothing is listening on once we stop; leaving it
      // would make the bridge report a confusing connection refusal instead of
      // "Nawi is not running".
      await fs.rm(mcpConfigPath(), { force: true }).catch(() => undefined)
    }
  }
}
