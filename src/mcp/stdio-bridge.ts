import { createInterface } from 'node:readline'
import { Bridge, type Frame } from './forward'

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
 * The transport (and its reason for being node:http, not fetch) lives in
 * `forward.ts` / `post.ts`, shared with the CLI.
 *
 * Framing is newline-delimited JSON, which is what MCP stdio specifies — not
 * LSP-style `Content-Length` headers. Getting that wrong produces a silent hang
 * rather than an error, so it is called out here.
 */

function write(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

const writeLine = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

/**
 * Frames are processed strictly in order (Bridge; cancellations excepted).
 *
 * Without ordering, two requests arriving in one tick would race and could be
 * written back out of order — legal for JSON-RPC ids, but it breaks clients that
 * assume ordering, and it makes an `initialize` handshake nondeterministic.
 */
const bridge = new Bridge(writeLine)

lines.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return

  let message: Frame
  try {
    message = JSON.parse(trimmed) as Frame
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }

  bridge.frame(message)
})

lines.on('close', () => {
  // The client closed stdin. Drain in-flight work, then exit cleanly.
  void bridge.drain().finally(() => process.exit(0))
})
