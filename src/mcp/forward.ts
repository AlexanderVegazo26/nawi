import { NOT_RUNNING, readEndpoint } from './endpoint'
import { postJson } from './post'

/**
 * Forwards one JSON-RPC frame from the stdio bridge to the running app and
 * writes the reply. Split out of `stdio-bridge.ts` (which only wires stdin and
 * stdout) so the transport can be tested without spawning a process; the
 * bridge's doc comment explains why this holds no tool logic.
 */

export const APP_ERROR = -32000

export type Writer = (line: string) => void

/** A parsed JSON-RPC frame; only `id` matters here, the rest is forwarded untouched. */
export type Frame = { id?: unknown; method?: unknown; [key: string]: unknown }

export async function forward(message: Frame, writeLine: Writer): Promise<void> {
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
    const res = await postJson(
      endpoint.url,
      {
        'content-type': 'application/json',
        authorization: `Bearer ${endpoint.token}`
        // No Origin header: main rejects any non-null Origin as a DNS-rebinding
        // defence, and this is not a browser.
      },
      JSON.stringify(message)
    )

    // 202 is main's answer to a notification — nothing to write back.
    if (res.status === 202 || res.contentLength === '0') return

    if (isNotification) return
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
    if (isNotification) return
    const detail = err instanceof Error ? err.message : String(err)
    write({
      jsonrpc: '2.0',
      id,
      error: { code: APP_ERROR, message: `${NOT_RUNNING} (${detail})` }
    })
  }
}
