import { NOT_RUNNING, readEndpoint } from './endpoint'
import { postJson } from './post'

/**
 * Forwards JSON-RPC frames from the stdio bridge to the running app and writes
 * the replies. Split out of `stdio-bridge.ts` (which only wires stdin and
 * stdout) so the transport can be tested without spawning a process; the
 * bridge's doc comment explains why this holds no tool logic.
 */

export const APP_ERROR = -32000

export type Writer = (line: string) => void

/** A parsed JSON-RPC frame; only `id` matters here, the rest is forwarded untouched. */
export type Frame = { id?: unknown; method?: unknown; [key: string]: unknown }

/** True for a JSON-RPC response frame (it carries `result` or `error`), as opposed to a notification. */
function isResponse(data: string): boolean {
  try {
    const frame = JSON.parse(data) as Record<string, unknown> | null
    return typeof frame === 'object' && frame !== null && ('result' in frame || 'error' in frame)
  } catch {
    return false
  }
}

/**
 * Forwards one frame. `signal` cancels it: the POST's connection is closed,
 * which the app treats as the caller leaving (a run stops after the step in
 * progress), and nothing is written back — a cancelled request needs no reply.
 */
export async function forward(message: Frame, writeLine: Writer, signal?: AbortSignal): Promise<void> {
  const write = (payload: unknown): void => writeLine(JSON.stringify(payload))
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
    let answered = false
    const res = await postJson(
      endpoint.url,
      {
        'content-type': 'application/json',
        // Both, as the Streamable-HTTP transport asks: the app streams progress
        // (then the answer) only for a call that sent a progressToken.
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${endpoint.token}`
        // No Origin header: main rejects any non-null Origin as a DNS-rebinding
        // defence, and this is not a browser.
      },
      JSON.stringify(message),
      {
        // Each event is already one complete JSON-RPC frame (a progress
        // notification or the response): written through verbatim, in order.
        onEvent: (data) => {
          if (isResponse(data)) answered = true
          writeLine(data)
        },
        signal
      }
    )

    // 202 is main's answer to a notification — nothing to write back.
    if (res.status === 202 || res.contentLength === '0') return

    if (isNotification) return
    if (res.streamed) {
      // Progress alone is not an answer: without the response the client would wait forever.
      if (!answered) {
        write({ jsonrpc: '2.0', id, error: { code: APP_ERROR, message: 'Nawi ended the event stream without an answer.' } })
      }
      return
    }
    if (res.text.length === 0) {
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
    writeLine(res.text)
  } catch (err) {
    if (isNotification || signal?.aborted) return
    const detail = err instanceof Error ? err.message : String(err)
    write({
      jsonrpc: '2.0',
      id,
      error: { code: APP_ERROR, message: `${NOT_RUNNING} (${detail})` }
    })
  }
}

/** JSON-RPC ids compare by type and value: 1 and "1" are different requests. */
function idKey(id: unknown): string | null {
  return typeof id === 'string' || typeof id === 'number' ? JSON.stringify(id) : null
}

/**
 * The bridge's frame scheduler.
 *
 * Frames are forwarded strictly in order (see stdio-bridge.ts), except
 * `notifications/cancelled`, which the bridge handles itself, at once:
 * queued behind the call it cancels it would only arrive after that call had
 * finished. A cancelled request still waiting in the queue is dropped; one
 * already sent has its connection closed, which the app treats as the caller
 * leaving (a run stops after the step in progress). Closing our own request
 * cannot miss the call or hit another client's, unlike relaying the cancel by
 * id. Either way nothing is written back: a cancelled request needs no reply.
 */
export class Bridge {
  private chain: Promise<void> = Promise.resolve()
  private readonly queued = new Map<string, number>()
  private readonly dropped = new Set<string>()
  private readonly sent = new Map<string, AbortController>()

  constructor(
    private readonly writeLine: Writer,
    private readonly send: typeof forward = forward
  ) {}

  frame(message: Frame): void {
    if (message.method === 'notifications/cancelled') {
      const target = idKey((message.params as { requestId?: unknown } | undefined)?.requestId)
      if (target === null) return
      const inFlight = this.sent.get(target)
      if (inFlight) inFlight.abort()
      else if (this.queued.has(target)) this.dropped.add(target)
      return
    }

    const key = message.id === undefined || message.id === null ? null : idKey(message.id)
    if (key !== null) this.queued.set(key, (this.queued.get(key) ?? 0) + 1)
    const run = async (): Promise<void> => {
      if (key === null) return this.send(message, this.writeLine)
      const left = (this.queued.get(key) ?? 1) - 1
      if (left > 0) this.queued.set(key, left)
      else this.queued.delete(key)
      if (this.dropped.delete(key)) return
      const controller = new AbortController()
      this.sent.set(key, controller)
      try {
        await this.send(message, this.writeLine, controller.signal)
      } finally {
        if (this.sent.get(key) === controller) this.sent.delete(key)
      }
    }
    // Chained on a *settled* tail: one failed forward must not stop every later
    // frame from being processed, which would wedge the session with no error.
    this.chain = this.chain.then(run, run)
  }

  /** Resolves when every frame received so far has been handled. */
  drain(): Promise<void> {
    return this.chain
  }
}
