/**
 * Raw Chrome DevTools Protocol over the WebSocket that Electron 44's main
 * process already exposes globally.
 *
 * Deliberately no `ws` dependency and no Playwright at runtime: a spike
 * confirmed `globalThis.WebSocket` exists in main, and electron-builder ships
 * `dependencies` only, so anything with a browser binary is unshippable.
 * Playwright stays a devDependency that launches browsers *for tests* — this
 * client is the code under test, never a wrapper around Playwright's own
 * protocol.
 *
 * Pure transport: correlation, event dispatch, session bookkeeping, error
 * surfacing. It knows no CDP domain semantics.
 */

/** A CDP `{id, error}` reply. Distinct from a transport failure. */
export class CdpProtocolError extends Error {
  readonly code: number
  readonly cdpMethod: string
  readonly sessionId: string | undefined
  readonly data: string | undefined

  constructor(method: string, sessionId: string | undefined, code: number, message: string, data?: string) {
    super(`${method} failed (${code}): ${message}${data ? ` — ${data}` : ''}`)
    this.name = 'CdpProtocolError'
    this.code = code
    this.cdpMethod = method
    this.sessionId = sessionId
    this.data = data
  }
}

/** The socket went away, or never came up. Every in-flight call rejects with this. */
export class CdpConnectionError extends Error {
  readonly reason: 'closed' | 'socket-error' | 'connect-timeout' | 'disposed'

  constructor(reason: CdpConnectionError['reason'], message: string) {
    super(message)
    this.name = 'CdpConnectionError'
    this.reason = reason
  }
}

export interface CdpEvent {
  method: string
  params: Record<string, unknown>
  /** Absent for browser-level events; set for anything arriving on a flattened session. */
  sessionId?: string
}

export type CdpEventListener = (event: CdpEvent) => void

/** Removes the listener it came from. Idempotent. */
export type Unsubscribe = () => void

export interface CdpClientOptions {
  /** Milliseconds to wait for the initial socket open. */
  connectTimeoutMs?: number
  /** Milliseconds after which an unanswered command rejects. 0 disables. */
  commandTimeoutMs?: number
  /** Reconnect attempts after an unexpected close. 0 (default) means none. */
  maxReconnectAttempts?: number
  /** Base backoff; attempt N waits `backoffMs * 2 ** (N - 1)`. */
  reconnectBackoffMs?: number
}

interface Pending {
  method: string
  sessionId: string | undefined
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface IncomingMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: Record<string, unknown>
  error?: { code?: number; message?: string; data?: string }
}

const DEFAULTS = {
  connectTimeoutMs: 15_000,
  commandTimeoutMs: 30_000,
  maxReconnectAttempts: 0,
  reconnectBackoffMs: 250
} as const

/** Listener key for "every event, on every session". */
export const ALL_EVENTS = '*'

export class CdpClient {
  private socket: WebSocket | null = null
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<CdpEventListener>>()
  private readonly attached = new Map<string, Record<string, unknown>>()
  private readonly options: Required<CdpClientOptions>
  /**
   * One counter across every session. CDP ids are scoped per connection, not
   * per session, and reusing an id across two flattened sessions silently
   * cross-wires two replies.
   */
  private nextId = 0
  private disposed = false
  private reconnectAttempts = 0
  private autoAttachConfig: { autoRun: boolean } | null = null

  private constructor(
    readonly url: string,
    options: CdpClientOptions
  ) {
    this.options = { ...DEFAULTS, ...options }
  }

  static async connect(url: string, options: CdpClientOptions = {}): Promise<CdpClient> {
    const client = new CdpClient(url, options)
    await client.open()
    return client
  }

  /** sessionIds currently attached via `Target.setAutoAttach`. */
  sessions(): string[] {
    return [...this.attached.keys()]
  }

  /** The `Target.attachedToTarget` payload for a session, for callers that need target type/url. */
  sessionTarget(sessionId: string): Record<string, unknown> | undefined {
    return this.attached.get(sessionId)
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = new WebSocket(this.url)
      } catch (error) {
        reject(new CdpConnectionError('socket-error', `could not open ${this.url}: ${String(error)}`))
        return
      }
      this.socket = socket

      const timer = setTimeout(() => {
        socket.close()
        reject(new CdpConnectionError('connect-timeout', `timed out opening ${this.url}`))
      }, this.options.connectTimeoutMs)

      let settled = false
      socket.onopen = (): void => {
        settled = true
        clearTimeout(timer)
        this.reconnectAttempts = 0
        resolve()
      }
      socket.onerror = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new CdpConnectionError('socket-error', `websocket error opening ${this.url}`))
      }
      socket.onmessage = (event: MessageEvent): void => {
        this.handleMessage(typeof event.data === 'string' ? event.data : String(event.data))
      }
      socket.onclose = (): void => {
        clearTimeout(timer)
        this.handleClose()
        if (!settled) {
          settled = true
          reject(new CdpConnectionError('closed', `websocket closed before opening ${this.url}`))
        }
      }
    })
  }

  private handleMessage(raw: string): void {
    let message: IncomingMessage
    try {
      message = JSON.parse(raw) as IncomingMessage
    } catch {
      // A frame we cannot parse is a protocol-level surprise, not a silent
      // no-op: surface it to '*' subscribers so it lands in a log somewhere.
      this.dispatch({ method: 'Nawi.malformedMessage', params: { raw } })
      return
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(
          new CdpProtocolError(
            pending.method,
            pending.sessionId,
            message.error.code ?? -1,
            message.error.message ?? 'unknown CDP error',
            message.error.data
          )
        )
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }

    if (typeof message.method !== 'string') return
    const event: CdpEvent = {
      method: message.method,
      params: message.params ?? {},
      ...(message.sessionId ? { sessionId: message.sessionId } : {})
    }
    this.trackSessions(event)
    this.dispatch(event)
  }

  /**
   * Session bookkeeping, and the release of targets frozen by
   * `waitForDebuggerOnStart`. Without the `Runtime.runIfWaitingForDebugger`
   * below an OOPIF or a cross-document navigation stays paused forever and the
   * harvest just... never arrives. No error is raised anywhere, which is why
   * this is done in the transport rather than left to each caller.
   */
  private trackSessions(event: CdpEvent): void {
    if (event.method === 'Target.attachedToTarget') {
      const sessionId = event.params.sessionId
      if (typeof sessionId !== 'string') return
      const info = event.params.targetInfo
      this.attached.set(sessionId, (info as Record<string, unknown> | undefined) ?? {})
      if (this.autoAttachConfig?.autoRun) {
        void this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch((error: unknown) => {
          this.dispatch({
            method: 'Nawi.autoAttachResumeFailed',
            params: { sessionId, error: String(error) }
          })
        })
      }
    } else if (event.method === 'Target.detachedFromTarget') {
      const sessionId = event.params.sessionId
      if (typeof sessionId === 'string') this.attached.delete(sessionId)
    }
  }

  private dispatch(event: CdpEvent): void {
    for (const key of [event.method, ALL_EVENTS]) {
      const set = this.listeners.get(key)
      if (!set) continue
      for (const listener of [...set]) {
        try {
          listener(event)
        } catch (error) {
          // A throwing subscriber must not take down the dispatch loop for
          // every other subscriber, but it must not vanish either.
          console.error('[cdp] event listener threw', event.method, error)
        }
      }
    }
  }

  private handleClose(): void {
    const inFlight = [...this.pending.values()]
    this.pending.clear()
    this.attached.clear()
    for (const pending of inFlight) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(
        new CdpConnectionError('closed', `connection closed while awaiting ${pending.method}`)
      )
    }
    if (this.disposed) return
    this.dispatch({ method: 'Nawi.disconnected', params: {} })
    if (this.options.maxReconnectAttempts > 0) void this.reconnect()
  }

  private async reconnect(): Promise<void> {
    while (!this.disposed && this.reconnectAttempts < this.options.maxReconnectAttempts) {
      this.reconnectAttempts += 1
      const delay = this.options.reconnectBackoffMs * 2 ** (this.reconnectAttempts - 1)
      await new Promise((r) => setTimeout(r, delay))
      if (this.disposed) return
      try {
        await this.open()
      } catch {
        continue
      }
      // A reconnect gives a fresh browser-level connection with no sessions, so
      // auto-attach has to be re-armed or every child target is lost silently.
      if (this.autoAttachConfig) {
        try {
          await this.setAutoAttach(this.autoAttachConfig)
        } catch (error) {
          this.dispatch({ method: 'Nawi.reconnectFailed', params: { error: String(error) } })
          return
        }
      }
      this.dispatch({ method: 'Nawi.reconnected', params: { attempts: this.reconnectAttempts } })
      return
    }
    if (!this.disposed) {
      this.dispatch({
        method: 'Nawi.reconnectExhausted',
        params: { attempts: this.reconnectAttempts }
      })
    }
  }

  /**
   * Issue a command. `sessionId` targets a flattened session; omit it for the
   * browser-level connection.
   */
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new CdpConnectionError('disposed', `client disposed; ${method} not sent`))
    }
    const socket = this.socket
    if (!socket || socket.readyState !== 1 /* OPEN */) {
      return Promise.reject(
        new CdpConnectionError('closed', `socket not open; ${method} not sent`)
      )
    }

    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer =
        this.options.commandTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(
                new CdpConnectionError(
                  'connect-timeout',
                  `${method} timed out after ${this.options.commandTimeoutMs}ms`
                )
              )
            }, this.options.commandTimeoutMs)
          : null

      this.pending.set(id, {
        method,
        sessionId,
        resolve: resolve as (value: Record<string, unknown>) => void,
        reject,
        timer
      })

      try {
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      } catch (error) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(new CdpConnectionError('socket-error', `send failed for ${method}: ${String(error)}`))
      }
    })
  }

  /** Subscribe to one CDP method, or to `ALL_EVENTS`. */
  on(method: string, listener: CdpEventListener): Unsubscribe {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(method)
    }
  }

  /** Resolve on the first matching event, or reject on timeout. */
  once(method: string, timeoutMs = this.options.commandTimeoutMs): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              off()
              reject(new CdpConnectionError('connect-timeout', `timed out waiting for ${method}`))
            }, timeoutMs)
          : null
      const off = this.on(method, (event) => {
        if (timer) clearTimeout(timer)
        off()
        resolve(event)
      })
    })
  }

  /**
   * `flatten: true` routes child-target traffic over this same socket with a
   * `sessionId`, which is the only shape that keeps OOPIFs and cross-document
   * navigations in the harvest.
   *
   * `waitForDebuggerOnStart` defaults true so a target cannot run before we
   * have installed anything on it — and this client then resumes it
   * automatically (see `trackSessions`), because a frozen target that nobody
   * resumes is a hang, not an error.
   */
  async setAutoAttach(options: { autoRun?: boolean; waitForDebuggerOnStart?: boolean } = {}): Promise<void> {
    const waitForDebuggerOnStart = options.waitForDebuggerOnStart ?? true
    const autoRun = options.autoRun ?? true
    this.autoAttachConfig = { autoRun }
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart,
      flatten: true
    })
  }

  /** Same call, addressed to an existing session so its own children attach too. */
  async setAutoAttachForSession(sessionId: string, waitForDebuggerOnStart = true): Promise<void> {
    await this.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart, flatten: true },
      sessionId
    )
  }

  close(): void {
    this.disposed = true
    this.autoAttachConfig = null
    const socket = this.socket
    this.socket = null
    const inFlight = [...this.pending.values()]
    this.pending.clear()
    for (const pending of inFlight) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new CdpConnectionError('disposed', `client closed while awaiting ${pending.method}`))
    }
    this.listeners.clear()
    this.attached.clear()
    if (socket && socket.readyState <= 1) socket.close()
  }
}
