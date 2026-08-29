import { createInterface } from 'node:readline'
import { NOT_RUNNING, readEndpoint } from './endpoint'

/**
 * stdio ↔ loopback-HTTP proxy. This is what an MCP client (Claude Code) spawns.
 *
 * **Why this process exists at all.** The tool bodies need `library`, `capture`
 * and the `BrowserWindow`, so they must run in Electron main — but a packaged
 * Electron app on Windows has no usable stdout, so main cannot itself be an MCP
 * stdio server. This is the half that has a real stdout: plain node, no
 * `electron` import, no dependencies.
 *
 * **It contains zero tool logic and holds no state.** Every frame is forwarded
 * verbatim to the running app and the reply is written back verbatim. Duplicating
 * any policy here — the kill switch especially — would create a second place for
 * it to be wrong, and this process is the one an attacker can most easily
 * restart. All authority stays in main.
 *
 * If Nawi is not running it fails fast with a JSON-RPC error. It never
 * launches the app: an agent handshake silently starting a GUI on someone's
 * desktop is a surprise, and one the user never consented to.
 *
 * Framing is newline-delimited JSON, which is what MCP stdio specifies — not
 * LSP-style `Content-Length` headers. Getting that wrong produces a silent hang
 * rather than an error, so it is called out here.
 */

const APP_ERROR = -32000

function write(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

async function forward(message: { id?: unknown; method?: unknown }): Promise<void> {
  const id = message.id ?? null
  // A notification expects no reply at all; answering one confuses strict clients.
  const isNotification = message.id === undefined || message.id === null

  const endpoint = readEndpoint()
  if (!endpoint) {
    if (!isNotification) {
      write({ jsonrpc: '2.0', id, error: { code: APP_ERROR, message: NOT_RUNNING } })
    }
    return
  }

  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${endpoint.token}`
        // No Origin header: main rejects any non-null Origin as a DNS-rebinding
        // defence, and this is not a browser.
      },
      body: JSON.stringify(message)
    })

    // 202 is main's answer to a notification — nothing to write back.
    if (res.status === 202 || res.headers.get('content-length') === '0') return

    const text = await res.text()
    if (isNotification) return
    if (text.length === 0) {
      write({
        jsonrpc: '2.0',
        id,
        error: { code: APP_ERROR, message: `Nawi returned an empty response (HTTP ${res.status}).` }
      })
      return
    }
    // Forwarded verbatim — the reply is already a complete JSON-RPC frame, and
    // re-encoding it is a chance to corrupt something this process should not
    // be interpreting in the first place.
    process.stdout.write(`${text}\n`)
  } catch (err) {
    if (isNotification) return
    const detail = err instanceof Error ? err.message : String(err)
    write({
      jsonrpc: '2.0',
      id,
      error: { code: APP_ERROR, message: `${NOT_RUNNING} (${detail})` }
    })
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

/**
 * Frames are processed strictly in order.
 *
 * Without the chain, two requests arriving in one tick would race and could be
 * written back out of order — legal for JSON-RPC ids, but it breaks clients that
 * assume ordering, and it makes an `initialize` handshake nondeterministic.
 */
let chain: Promise<void> = Promise.resolve()

lines.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return

  let message: { id?: unknown; method?: unknown }
  try {
    message = JSON.parse(trimmed) as { id?: unknown; method?: unknown }
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }

  // Chained on a *settled* tail: one failed forward must not stop every later
  // frame from being processed, which would wedge the session with no error.
  chain = chain.then(
    () => forward(message),
    () => forward(message)
  )
})

lines.on('close', () => {
  // The client closed stdin. Drain in-flight work, then exit cleanly.
  void chain.finally(() => process.exit(0))
})
