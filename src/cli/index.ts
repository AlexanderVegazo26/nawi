#!/usr/bin/env node
import { NOT_RUNNING, readEndpoint } from '../mcp/endpoint'

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
 * not running and exits non-zero.
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

/** Commands are a thin naming layer over the MCP tools; see `src/main/mcp/tools.ts`. */
const COMMANDS: Record<string, { tool: string; summary: string }> = {
  capture: { tool: 'capture_screen', summary: 'Capture the whole screen.' },
  'capture-region': { tool: 'capture_region', summary: 'Capture a region: --x --y --width --height.' },
  'capture-element': { tool: 'capture_element', summary: 'Capture a page element: --selector.' },
  record: { tool: 'start_recording', summary: 'Start a screen recording.' },
  'record-stop': { tool: 'stop_recording', summary: 'Stop the active recording.' },
  get: { tool: 'get_capture', summary: 'Fetch one capture: --id.' },
  list: { tool: 'list_captures', summary: 'List captures in the library.' },
  search: { tool: 'search_captures', summary: 'Search captures: --query.' },
  annotate: { tool: 'annotate', summary: 'Add an annotation to a capture.' },
  redact: { tool: 'redact', summary: 'Redact a region of a capture.' },
  export: { tool: 'export_guide', summary: 'Export captures as a guide.' }
}

const USAGE = `nawi — command-line access to a running Nawi.

Usage:
  nawi <command> [--flag value ...] [--json]

Commands:
${Object.entries(COMMANDS)
  .map(([name, c]) => `  ${name.padEnd(16)}${c.summary}`)
  .join('\n')}

Global flags:
  --json            Print the raw JSON-RPC result instead of formatted text.
  --help, -h        Show this help.
  --version, -v     Show the CLI version.

Values are parsed as JSON when they look like JSON (numbers, true/false, arrays,
objects) and kept as strings otherwise, so --width 800 sends a number and
--name "My shot" sends a string. A flag with no value is the boolean true.

Nawi must already be running; this command will not start it for you.`

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

  const entry = COMMANDS[command]
  if (!entry) {
    fail(`Unknown command "${command}".\n\n${USAGE}`, EXIT_USAGE)
  }

  let parsed: { args: Record<string, unknown>; json: boolean }
  try {
    parsed = parseArgs(argv.slice(1))
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`, EXIT_USAGE)
  }

  const endpoint = readEndpoint()
  if (!endpoint) fail(NOT_RUNNING, EXIT_NOT_RUNNING)

  let res: Response
  try {
    res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${endpoint.token}`
        // No Origin header: main rejects any non-null Origin as a DNS-rebinding
        // defence, and this is not a browser.
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: entry.tool, arguments: parsed.args }
      })
    })
  } catch (err) {
    fail(`${NOT_RUNNING} (${err instanceof Error ? err.message : String(err)})`, EXIT_NOT_RUNNING)
  }

  const text = await res.text()
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

  process.stdout.write(
    `${parsed.json ? JSON.stringify(frame.result, null, 2) : render(frame.result)}\n`
  )
  process.exit(EXIT_OK)
}

void main()
