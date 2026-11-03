import { request } from 'node:http'

export interface PostResult {
  status: number
  /** `content-length` as sent by the app, or null when it streamed/chunked the body. */
  contentLength: string | null
  /** The `Mcp-Session-Id` the app issued (on `initialize`), or null. */
  sessionId: string | null
  /** True when the app answered with an event stream; its messages went to `onEvent` and `text` is empty. */
  streamed: boolean
  text: string
}

export interface PostOptions {
  /**
   * Receives each SSE message's data (one serialized JSON-RPC message) as it
   * arrives, when the app answers with `text/event-stream` (progress, then the
   * response). Without it a stream is buffered into `text` unparsed.
   */
  onEvent?: (data: string) => void
  /** Aborting closes the connection (the app stops the call) and rejects. */
  signal?: AbortSignal
}

/**
 * POST one JSON-RPC frame to the running app's loopback endpoint.
 *
 * Over `node:http`, not `fetch`: fetch (undici) gives up after 300 s without
 * response headers, and a `run_flow` call legitimately takes longer than that,
 * so the CLI and the stdio bridge would both report "not running" for a run
 * the app is still executing. node:http sets no headers timeout of its own. A
 * refused connection still fails at once.
 *
 * Shared by the CLI and the stdio bridge for the same reason `endpoint.ts` is:
 * one place for the transport to be right. Dependency-free and electron-free.
 */
export function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  options: PostOptions = {}
): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } },
      (res) => {
        const sessionHeader = res.headers['mcp-session-id']
        const sessionId = typeof sessionHeader === 'string' && sessionHeader.length > 0 ? sessionHeader : null
        const streamed =
          options.onEvent !== undefined && /^text\/event-stream\b/i.test(res.headers['content-type'] ?? '')
        const sse = streamed ? new SseParser(options.onEvent as (data: string) => void) : null
        let text = ''
        // A string decoder: a multi-byte character split across chunks stays whole.
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          if (sse) sse.push(c)
          else text += c
        })
        res.on('end', () => {
          sse?.end()
          resolve({
            status: res.statusCode ?? 0,
            contentLength: res.headers['content-length'] ?? null,
            sessionId,
            streamed,
            text
          })
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    const signal = options.signal
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'))
      else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    }
    req.end(body)
  })
}

/**
 * Incremental `text/event-stream` parser (WHATWG rules, the subset MCP uses):
 * events end at a blank line, `data:` lines join with "\n", one leading space
 * after the colon is dropped, comments (`:`) and other fields are ignored, and
 * CRLF/CR/LF all end a line. An event without data is not delivered.
 */
export class SseParser {
  private buffer = ''
  private data: string[] = []

  constructor(private readonly onEvent: (data: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk
    // A trailing "\r" may be the first half of "\r\n": keep it until the next chunk.
    const lines = this.buffer.split(/\r\n|\r(?!$)|\n/)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) this.line(line)
  }

  /** The stream closed: a final event without its blank line is still delivered. */
  end(): void {
    if (this.buffer.length > 0) this.line(this.buffer.replace(/\r$/, ''))
    this.buffer = ''
    this.dispatch()
  }

  private line(line: string): void {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
  }

  private dispatch(): void {
    if (this.data.length === 0) return
    const data = this.data.join('\n')
    this.data = []
    this.onEvent(data)
  }
}
