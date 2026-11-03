import type { ProgressUpdate } from './dispatch'
import type { StepProgress } from '../replay/replay'

/**
 * Roadmap AI12: progress and cancellation for long tool calls, over the
 * loopback endpoint's Streamable-HTTP framing. Electron-free so it is tested
 * without an app; `server.ts` wires it in.
 *
 * - **Progress.** A caller that sends `_meta.progressToken` on `tools/call` and
 *   accepts `text/event-stream` gets the answer as a short SSE stream: one
 *   `notifications/progress` message per update, then the JSON-RPC response,
 *   then the stream ends. Everyone else gets the plain JSON answer as before.
 * - **Cancellation.** `notifications/cancelled` names the request id it
 *   cancels. Ids are only unique per client, so in-flight calls are keyed by
 *   the `Mcp-Session-Id` the client got from `initialize` plus the id, and a
 *   call made without a session (the CLI, curl) cannot be cancelled by id at
 *   all: such callers cancel by closing their request. So one client can never
 *   stop another's call by reusing a number.
 */

export type JsonRpcId = string | number | null

/** The token to report progress against, or null when the caller cannot or did not ask for progress. */
export function progressTokenOf(params: unknown, accept: string | null): string | number | null {
  if (accept === null || !/(^|,)\s*text\/event-stream\s*(;|,|$)/i.test(accept)) return null
  const meta = (params as { _meta?: { progressToken?: unknown } } | null | undefined)?._meta
  const token = meta?.progressToken
  if (typeof token === 'string' && token.length > 0 && token.length <= 200) return token
  if (typeof token === 'number' && Number.isFinite(token)) return token
  return null
}

/**
 * One SSE event carrying one serialized JSON-RPC message. JSON.stringify never
 * emits a raw newline, so the message fits on one `data:` line.
 */
export function sseEvent(json: string): string {
  return `event: message\ndata: ${json}\n\n`
}

export function progressNotification(token: string | number, update: ProgressUpdate): unknown {
  return {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: {
      progressToken: token,
      progress: update.progress,
      ...(update.total !== undefined ? { total: update.total } : {}),
      ...(update.message !== undefined ? { message: update.message } : {})
    }
  }
}

/**
 * One settled flow step as a progress update. Ids and actions only: never the
 * step's error, values or URL, which may hold text that is scrubbed of secrets
 * only in the final report.
 */
export function stepProgress(step: StepProgress): ProgressUpdate {
  const n = step.index + 1
  return { progress: n, total: step.total, message: `step ${n}/${step.total} ${step.id} (${step.action}): ${step.status}` }
}

/** The reason a cancelled run reports. The client's own `reason` is not echoed: it is untrusted text. */
export const CANCELLED_REASON = 'the client cancelled the call, so the remaining steps were not run'

/** In-flight `tools/call` requests that a `notifications/cancelled` can stop. */
export class InFlightCalls {
  private readonly calls = new Map<string, AbortController>()

  private static key(session: string, id: string | number): string {
    return JSON.stringify([session, id])
  }

  get size(): number {
    return this.calls.size
  }

  /**
   * Registers a call and returns the function that unregisters it. Calls
   * without a session or an id are not registered. A second call reusing a
   * live (session, id) pair is not registered either: cancelling must never
   * stop a call other than the one the client meant, so the reuse simply
   * cannot be cancelled by id.
   */
  add(session: string | null, id: JsonRpcId, controller: AbortController): () => void {
    if (!session || id === null) return () => undefined
    const key = InFlightCalls.key(session, id)
    if (this.calls.has(key)) return () => undefined
    this.calls.set(key, controller)
    return () => {
      if (this.calls.get(key) === controller) this.calls.delete(key)
    }
  }

  /** Aborts the named call; false when there is none (finished already, or never seen). */
  cancel(session: string | null, id: unknown): boolean {
    if (!session || (typeof id !== 'string' && typeof id !== 'number')) return false
    const controller = this.calls.get(InFlightCalls.key(session, id))
    if (!controller) return false
    controller.abort(CANCELLED_REASON)
    return true
  }
}
