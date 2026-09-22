import logger from '@adonisjs/core/services/logger'
import { type DateTime } from 'luxon'

/**
 * Live device-agent sessions, one per row id, and JSON-RPC 2.0 over them:
 * the AP daemon (`ap_agent_hub.ts`, keyed by `wifi_access_points.id`,
 * PROTOCOL.md section 2 of perch-apd) and the collector
 * (`collector_agent_hub.ts`, keyed by `collectors.id`, docs/collector-agent.md
 * section 3). One class, one instance per kind: the ids of the two tables
 * overlap.
 *
 * In-process by design, like the scheduler and the poller's counter
 * snapshots: the API runs as a single instance. The hub does not know about
 * WebSockets — `agent_gateway.ts` hands it an `AgentConnection` per session —
 * so it can be driven by a fake connection in unit tests.
 */

/** JSON-RPC error codes of both protocols (PROTOCOL.md section 2.1). */
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  COMMAND_FAILED: -32000,
  UNSUPPORTED: -32001,
  NOT_FOUND: -32002,
} as const

/** Close codes the server uses (PROTOCOL.md section 2, docs/collector-agent.md 3.2). */
export const CLOSE_CODES = {
  GOING_AWAY: 1001,
  POLICY_VIOLATION: 1008,
  REVOKED: 4001,
  REPLACED: 4002,
  DISMISSED: 4003,
} as const

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

export class AgentOfflineError extends Error {
  readonly id: number
  constructor(id: number) {
    super('agent offline')
    this.name = 'AgentOfflineError'
    this.id = id
  }
}

export class AgentTimeoutError extends Error {
  readonly method: string
  readonly timeoutMs: number
  constructor(method: string, timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`)
    this.name = 'AgentTimeoutError'
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

export class AgentRpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'AgentRpcError'
    this.code = code
    this.data = data
  }
}

/** The transport the gateway wraps around one WebSocket. */
export interface AgentConnection {
  send(data: string): void
  close(code: number, reason: string): void
  terminate(): void
}

export type AgentSessionInfo = {
  connectedAt: DateTime
  address: string | null
  protocol: string
  /** Whether the session came in over TLS; null when the gateway cannot tell. */
  secure: boolean | null
}

export type AgentSessionInit = Omit<AgentSessionInfo, 'secure'> & {
  secure?: boolean | null
  /** Row id the session belongs to (`wifi_access_points.id` or `collectors.id`). */
  id: number
  connection: AgentConnection
}

type Pending = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * One registered session. Returned by `register` so the gateway can later
 * say "this socket closed" without risking unregistering a newer session
 * that replaced it.
 */
export class AgentSession {
  readonly id: number
  readonly connection: AgentConnection
  readonly info: AgentSessionInfo
  nextId = 1
  readonly pending = new Map<number, Pending>()
  closed = false
  /** Set when a newer session for the same row took over. */
  replaced = false

  constructor(init: AgentSessionInit) {
    this.id = init.id
    this.connection = init.connection
    this.info = {
      connectedAt: init.connectedAt,
      address: init.address,
      protocol: init.protocol,
      secure: init.secure ?? null,
    }
  }

  rejectAll(error: () => Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error())
    }
    this.pending.clear()
  }
}

type RpcMessage = {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
}

/**
 * Handles one notification the agent sent (`metrics.push`, `locate.ended`,
 * `collector.push`). Called in frame order; must not throw (errors are logged).
 */
export type NotificationHandler = (id: number, params: unknown) => void | Promise<void>

export class AgentHub {
  #sessions = new Map<number, AgentSession>()
  #notificationHandlers = new Map<string, NotificationHandler>()
  /** Log prefix: `ap_agent_hub`, `collector_agent_hub`. */
  readonly #logName: string

  constructor(kind = 'ap') {
    this.#logName = `${kind}_agent_hub`
  }

  /** Routes notifications named `method` to `handler` (one handler per method). */
  onNotification(method: string, handler: NotificationHandler): void {
    this.#notificationHandlers.set(method, handler)
  }

  /**
   * Registers a new session for its row. An existing session for the same row
   * is closed with 4002 (a second agent — or a reconnect the server has not
   * noticed yet — with the same credentials) and its pending requests fail.
   */
  register(init: AgentSessionInit): AgentSession {
    const session = new AgentSession(init)
    const previous = this.#sessions.get(init.id)
    this.#sessions.set(init.id, session)
    if (previous) {
      previous.closed = true
      previous.replaced = true
      previous.rejectAll(() => new AgentOfflineError(init.id))
      try {
        previous.connection.close(CLOSE_CODES.REPLACED, 'replaced by a newer session')
      } catch {
        previous.connection.terminate()
      }
    }
    return session
  }

  /**
   * The socket behind `session` is gone. Returns true when that leaves its
   * row offline: it was the registered session, or `disconnect` removed it
   * and nothing replaced it since. False when a newer session took over.
   */
  unregister(session: AgentSession): boolean {
    session.closed = true
    session.rejectAll(() => new AgentOfflineError(session.id))
    const current = this.#sessions.get(session.id)
    if (current === session) {
      this.#sessions.delete(session.id)
      return true
    }
    return current === undefined && !session.replaced
  }

  isOnline(id: number): boolean {
    return this.#sessions.has(id)
  }

  session(id: number): AgentSessionInfo | null {
    return this.#sessions.get(id)?.info ?? null
  }

  /** The live session object itself (for the gateway's per-session bookkeeping). */
  liveSession(id: number): AgentSession | null {
    const session = this.#sessions.get(id)
    return session && !session.closed ? session : null
  }

  onlineIds(): number[] {
    return [...this.#sessions.keys()]
  }

  /**
   * Calls `method` on the row's agent. Rejects with `AgentOfflineError` when
   * there is no session (or it drops before answering), `AgentTimeoutError`
   * after `timeoutMs`, `AgentRpcError` when the agent answers with an error.
   */
  request<T = unknown>(
    id: number,
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {}
  ): Promise<T> {
    const session = this.#sessions.get(id)
    if (!session || session.closed) return Promise.reject(new AgentOfflineError(id))

    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const requestId = session.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(requestId)
        reject(new AgentTimeoutError(method, timeoutMs))
      }, timeoutMs)
      session.pending.set(requestId, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
      try {
        session.connection.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }))
      } catch {
        clearTimeout(timer)
        session.pending.delete(requestId)
        reject(new AgentOfflineError(id))
      }
    })
  }

  /** Fire-and-forget JSON-RPC notification. False when the row is offline. */
  notify(id: number, method: string, params: Record<string, unknown> = {}): boolean {
    const session = this.#sessions.get(id)
    if (!session || session.closed) return false
    try {
      session.connection.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
      return true
    } catch {
      return false
    }
  }

  /**
   * Closes the row's session (4001 when its credentials were revoked, 4003
   * when a collector was dismissed, 1001 on shutdown). The gateway's close
   * handler unregisters it; the session is marked closed right away so no new
   * request is sent on it.
   */
  disconnect(id: number, code: number, reason: string): boolean {
    const session = this.#sessions.get(id)
    if (!session) return false
    this.#sessions.delete(id)
    session.closed = true
    session.rejectAll(() => new AgentOfflineError(id))
    try {
      session.connection.close(code, reason)
    } catch {
      session.connection.terminate()
    }
    return true
  }

  /** Closes every session; returns the connections so the caller can terminate stragglers. */
  closeAll(code: number, reason: string): AgentConnection[] {
    const connections: AgentConnection[] = []
    for (const id of [...this.#sessions.keys()]) {
      const session = this.#sessions.get(id)
      if (session) connections.push(session.connection)
      this.disconnect(id, code, reason)
    }
    return connections
  }

  /**
   * One text frame from the agent. Responses settle pending requests;
   * notifications go to their `onNotification` handler; requests are
   * answered with -32601 (the server exposes no methods to agents yet);
   * anything else is logged and dropped.
   */
  handleFrame(session: AgentSession, raw: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(raw)
    } catch {
      logger.debug({ id: session.id }, `${this.#logName}: dropped non-JSON frame`)
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      logger.debug({ id: session.id }, `${this.#logName}: dropped non-object frame`)
      return
    }

    if (typeof message.method === 'string') {
      const hasId = message.id !== undefined && message.id !== null
      if (hasId) {
        this.#send(session, {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: RPC_ERRORS.METHOD_NOT_FOUND,
            message: `method not found: ${message.method}`,
          },
        })
        return
      }
      const handler = this.#notificationHandlers.get(message.method)
      if (!handler) {
        logger.debug(
          { id: session.id, method: message.method },
          `${this.#logName}: unhandled agent notification`
        )
        return
      }
      try {
        const result = handler(session.id, message.params)
        if (result instanceof Promise) {
          result.catch((error) =>
            logger.error(
              { id: session.id, method: message.method, err: error },
              `${this.#logName}: notification handler failed`
            )
          )
        }
      } catch (error) {
        logger.error(
          { id: session.id, method: message.method, err: error },
          `${this.#logName}: notification handler failed`
        )
      }
      return
    }

    const id = typeof message.id === 'number' ? message.id : Number(message.id)
    const pending = Number.isFinite(id) ? session.pending.get(id) : undefined
    if (!pending) {
      logger.debug(
        { id: session.id, responseId: message.id },
        `${this.#logName}: response to no request`
      )
      return
    }
    session.pending.delete(id)
    clearTimeout(pending.timer)

    if (message.error !== undefined && message.error !== null) {
      const error = message.error as { code?: unknown; message?: unknown; data?: unknown }
      const code = typeof error.code === 'number' ? error.code : RPC_ERRORS.INTERNAL_ERROR
      const text =
        typeof error.message === 'string' && error.message.length > 0
          ? error.message
          : `${pending.method} failed`
      pending.reject(new AgentRpcError(code, text, error.data))
      return
    }
    pending.resolve(message.result ?? null)
  }

  #send(session: AgentSession, payload: object) {
    try {
      session.connection.send(JSON.stringify(payload))
    } catch {
      // The close handler cleans up.
    }
  }
}
