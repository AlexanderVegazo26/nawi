/**
 * Typed MCP tool errors.
 *
 * Every failure an agent can provoke gets a machine-readable `code`. The rule
 * this file exists to enforce: **a capability that does not exist yet returns an
 * explainable error, never a stub that reports success.** An agent that receives
 * `ok` for a redaction it did not get is worse off than one that receives
 * `NOT_IMPLEMENTED` — it will act on the belief that the data is safe.
 */

export type ToolErrorCode =
  /** UX-AGT.3 — the kill switch is on. */
  | 'AGENT_ACCESS_PAUSED'
  /** No bearer token, or the wrong one. */
  | 'UNAUTHORIZED'
  /** A cross-origin request reached the loopback listener (DNS-rebinding defence). */
  | 'FORBIDDEN_ORIGIN'
  /** Arguments failed schema validation. */
  | 'INVALID_ARGUMENTS'
  | 'UNKNOWN_TOOL'
  | 'NOT_FOUND'
  /** FR-CAP.5 — element capture was asked for with no browser attached. */
  | 'NO_BROWSER_ATTACHED'
  /** The capability is real but this build cannot perform it yet. */
  | 'NOT_IMPLEMENTED'
  /** The request was well-formed but the app cannot satisfy it right now. */
  | 'UNAVAILABLE'
  | 'INTERNAL'

/**
 * What each code means, in the words docs/MCP-ERRORS.md uses. A `Record` over
 * the union, so adding a code without explaining it does not compile.
 */
export const TOOL_ERROR_MEANINGS: Record<ToolErrorCode, string> = {
  AGENT_ACCESS_PAUSED: 'Agent access is paused in Nawi (the kill switch). Nothing was read, run or created.',
  UNAUTHORIZED: 'No bearer token, or not the one in userData/mcp.json.',
  FORBIDDEN_ORIGIN: 'The request carried an Origin header (a web page); only local, non-browser clients are served.',
  INVALID_ARGUMENTS:
    'The arguments failed the tool\'s input schema (`data.issues`: `path` + `message` each), or a value the schema ' +
    'cannot judge was refused (an empty region, a path outside your home, a flow that does not parse).',
  UNKNOWN_TOOL: 'No tool by that name (`data.tool`).',
  NOT_FOUND: 'The capture, run, flow file or display named in the arguments does not exist.',
  NO_BROWSER_ATTACHED: 'The tool needs a browser attached over CDP and none is.',
  NOT_IMPLEMENTED:
    'This build cannot do that yet (a listed tool such as `redact`, with `data.tool`; or a desktop-target flow). Nothing was changed.',
  UNAVAILABLE: 'The target exists but cannot serve this call (no state layer, no input events, a browser that cannot be used).',
  INTERNAL: 'An unexpected failure inside Nawi. The message says what failed; retrying may help.'
}

/**
 * Codes any call to an existing tool can end with, because `dispatch` raises
 * them before (or around) the tool body. A tool declares only the codes its own
 * body adds. (UNKNOWN_TOOL is dispatch's too, but only for a name that is no tool.)
 */
export const DISPATCH_ERROR_CODES: readonly ToolErrorCode[] = [
  'UNAUTHORIZED',
  'FORBIDDEN_ORIGIN',
  'AGENT_ACCESS_PAUSED',
  'INVALID_ARGUMENTS',
  'INTERNAL'
]

export class ToolError extends Error {
  readonly code: ToolErrorCode
  /** Extra machine-readable context. Never contains secrets. */
  readonly detail: Record<string, unknown>

  constructor(code: ToolErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ToolError'
    this.code = code
    this.detail = detail
  }
}

/**
 * The paused error, in one place.
 *
 * UX-AGT.3's acceptance names both the code and "a human-readable message", so
 * the message is part of the contract and not incidental logging.
 */
export function agentAccessPaused(): ToolError {
  return new ToolError(
    'AGENT_ACCESS_PAUSED',
    'Agent access is paused in Nawi. No capture was created. Resume it from the app to allow agent tool calls again.'
  )
}

export function notImplemented(tool: string, why: string): ToolError {
  return new ToolError('NOT_IMPLEMENTED', `${tool} is not available yet: ${why}`, { tool })
}

/** Narrows an unknown throw into a ToolError, without leaking internals to the client. */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new ToolError('INTERNAL', message)
}
