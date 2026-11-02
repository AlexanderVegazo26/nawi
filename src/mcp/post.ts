import { request } from 'node:http'

export interface PostResult {
  status: number
  /** `content-length` as sent by the app, or null when it streamed/chunked the body. */
  contentLength: string | null
  text: string
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
export function postJson(url: string, headers: Record<string, string>, body: string): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            contentLength: res.headers['content-length'] ?? null,
            text: Buffer.concat(chunks).toString('utf8')
          })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}
