import type { AgentConnection } from '#services/agent_hub'
import { agentAuthBudget } from '#services/ap_agent_rate_limit'
import { deriveClientAddress } from '#services/client_address'
import { transportSecurity } from '#services/transport_security'
import {
  DEFAULT_TRUST_PROXY,
  compileTrustProxy,
  type TrustProxyPredicate,
} from '#services/trust_proxy'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { STATUS_CODES, type IncomingMessage, type Server as HttpServer } from 'node:http'
import type { Server as HttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type PerMessageDeflateOptions, type WebSocket } from 'ws'

/**
 * The device-agent WebSocket endpoints: the AP daemon
 * (`/api/v1/ap-agent/ws`, docs/ap-controller.md section 2.2) and the
 * collector (`/api/v1/collector-agent/ws`, docs/collector-agent.md section 3).
 *
 * Upgrades never reach the Adonis router, so this hooks the Node server's
 * `upgrade` event directly, once, and routes by path. The parts every
 * endpoint shares live here: the failed-attempt budget, the subprotocol
 * check, refusing with a plain HTTP answer, the ping/pong heartbeat and the
 * graceful close. Each endpoint brings its own authentication and what to do
 * with an accepted socket.
 */

export const DEFAULT_HEARTBEAT_MS = 30_000

/** Time `close()` gives agents to answer the close frame before cutting them off. */
const CLOSE_GRACE_MS = 500

/** A refused upgrade: status, JSON body, extra headers. */
export type UpgradeRefusal = {
  status: number
  body: Record<string, unknown>
  headers?: Record<string, string>
}

export type UpgradeContext = {
  /** Client address after the trusted-proxy walk, or 'unknown'. */
  address: string
  /** Reached over TLS (see transport_security.ts); null when a proxy does not say. */
  secure: boolean | null
}

export type AuthenticateResult<P> =
  | { ok: true; principal: P }
  | { ok: false; refusal: UpgradeRefusal }

/**
 * One endpoint. `authenticate` runs before the upgrade (a refusal is an HTTP
 * answer, which the daemons read as a status code); `onConnection` gets the
 * socket once `ws` owns it. The gateway has already wired the heartbeat.
 */
export type AgentEndpoint<P = unknown> = {
  path: string
  subprotocol: string
  maxPayload: number
  perMessageDeflate?: boolean | PerMessageDeflateOptions
  authenticate(request: IncomingMessage, context: UpgradeContext): Promise<AuthenticateResult<P>>
  onConnection(ws: WebSocket, principal: P, context: UpgradeContext): void
  /** Once, when the gateway is attached (notification handlers and the like). */
  attach?(): void
  /** Close every live session (shutdown); returns the connections to cut off after the grace. */
  closeAll(code: number, reason: string): AgentConnection[]
}

export type AgentGatewayOptions = {
  heartbeatMs?: number
  trust?: TrustProxyPredicate
  /** Defaults to both endpoints: AP daemon and collector. */
  endpoints?: AgentEndpoint<any>[]
}

export type AgentGateway = {
  close(): Promise<void>
}

type Tracked = { socket: WebSocket; alive: boolean }

type Mounted = { endpoint: AgentEndpoint<any>; wss: WebSocketServer }

export async function defaultAgentEndpoints(): Promise<AgentEndpoint<any>[]> {
  const [{ apAgentEndpoint }, { collectorAgentEndpoint }] = await Promise.all([
    import('#services/ap_agent_gateway'),
    import('#services/collector_agent_gateway'),
  ])
  return [apAgentEndpoint(), collectorAgentEndpoint()]
}

export async function attachAgentGateway(
  server: HttpServer | HttpsServer,
  options: AgentGatewayOptions = {}
): Promise<AgentGateway> {
  const endpoints = options.endpoints ?? (await defaultAgentEndpoints())
  return mountAgentGateway(server, endpoints, options)
}

/** Synchronous core of `attachAgentGateway`, for callers that already hold the endpoints. */
export function mountAgentGateway(
  server: HttpServer | HttpsServer,
  endpoints: AgentEndpoint<any>[],
  options: Omit<AgentGatewayOptions, 'endpoints'> = {}
): AgentGateway {
  const trust = options.trust ?? resolveTrustPredicate()
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const tracked = new Set<Tracked>()
  let closed = false
  let closing: Promise<void> | null = null

  const mounted = new Map<string, Mounted>()
  for (const endpoint of endpoints) {
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: endpoint.maxPayload,
      clientTracking: false,
      perMessageDeflate: endpoint.perMessageDeflate ?? false,
      handleProtocols: (protocols) =>
        protocols.has(endpoint.subprotocol) ? endpoint.subprotocol : false,
    })
    mounted.set(endpoint.path, { endpoint, wss })
    endpoint.attach?.()
  }

  const heartbeat = setInterval(() => {
    for (const entry of tracked) {
      if (!entry.alive) {
        entry.socket.terminate()
        continue
      }
      entry.alive = false
      try {
        entry.socket.ping()
      } catch {
        entry.socket.terminate()
      }
    }
  }, heartbeatMs)
  heartbeat.unref()

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (request.url ?? '').split('?')[0]
    const target = mounted.get(path)
    if (!target) {
      // Leave it to another upgrade listener if there is one.
      if (server.listenerCount('upgrade') > 1) return
      abortHandshake(socket, 404, { error: 'not_found', message: 'No WebSocket endpoint here.' })
      return
    }
    if (closed) {
      abortHandshake(socket, 503, { error: 'shutting_down', message: 'Server is shutting down.' })
      return
    }
    authenticateAndUpgrade(target, request, socket, head).catch((error) => {
      logger.error({ err: error, path }, 'agent_gateway: upgrade failed')
      abortHandshake(socket, 500, { error: 'internal_error', message: 'Upgrade failed.' })
    })
  }

  async function authenticateAndUpgrade(
    { endpoint, wss }: Mounted,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) {
    // Until `ws` owns the socket, a reset must not crash the process.
    socket.on('error', () => {})

    const address =
      deriveClientAddress(
        request.socket.remoteAddress,
        request.headers['x-forwarded-for'],
        trust
      ) ?? 'unknown'

    const budget = agentAuthBudget(address)
    if (!budget.allowed) {
      abortHandshake(
        socket,
        429,
        {
          error: 'rate_limited',
          message: 'Too many failed attempts from this address. Try again later.',
          retryAfterSeconds: budget.retryAfterSeconds,
        },
        { 'Retry-After': String(budget.retryAfterSeconds) }
      )
      return
    }

    const offered = parseOfferedProtocols(request.headers['sec-websocket-protocol'])
    if (offered.length > 0 && !offered.includes(endpoint.subprotocol)) {
      abortHandshake(socket, 400, {
        error: 'unsupported_protocol',
        message: `This server speaks ${endpoint.subprotocol}.`,
      })
      return
    }

    const context: UpgradeContext = { address, secure: transportSecurity(request, trust) }
    const verdict = await endpoint.authenticate(request, context)
    if (!verdict.ok) {
      abortHandshake(socket, verdict.refusal.status, verdict.refusal.body, verdict.refusal.headers)
      return
    }

    if (socket.destroyed || closed) return
    wss.handleUpgrade(request, socket, head, (ws) => {
      const entry: Tracked = { socket: ws, alive: true }
      tracked.add(entry)
      ws.on('pong', () => {
        entry.alive = true
      })
      ws.on('close', () => {
        tracked.delete(entry)
      })
      endpoint.onConnection(ws, verdict.principal, context)
    })
  }

  server.on('upgrade', onUpgrade)

  return {
    close() {
      if (closing) return closing
      closed = true
      clearInterval(heartbeat)
      server.off('upgrade', onUpgrade)
      const connections = endpoints.flatMap((endpoint) =>
        endpoint.closeAll(1001, 'server shutting down')
      )
      closing = new Promise<void>((resolve) => {
        const done = () => {
          for (const connection of connections) connection.terminate()
          for (const entry of tracked) entry.socket.terminate()
          tracked.clear()
          let pending = mounted.size
          if (pending === 0) resolve()
          for (const { wss } of mounted.values()) {
            wss.close(() => {
              pending -= 1
              if (pending === 0) resolve()
            })
          }
        }
        if (connections.length === 0 && tracked.size === 0) done()
        else setTimeout(done, CLOSE_GRACE_MS)
      })
      return closing
    },
  }
}

/** The same predicate `request.ip()` uses (config/app.ts → http.trustProxy). */
function resolveTrustPredicate(): TrustProxyPredicate {
  const configured = app.config.get<unknown>('app.http.trustProxy', null)
  if (typeof configured === 'function') return configured as TrustProxyPredicate
  return compileTrustProxy(DEFAULT_TRUST_PROXY)
}

function parseOfferedProtocols(header: string | string[] | undefined): string[] {
  const value = Array.isArray(header) ? header.join(',') : header
  if (!value) return []
  return value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

/**
 * Answers a refused upgrade with a plain HTTP response and closes the
 * socket once it is flushed (the same dance `ws` does internally).
 */
function abortHandshake(
  socket: Duplex,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  if (socket.destroyed) return
  const payload = JSON.stringify(body)
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(payload)}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ]
  socket.once('finish', () => socket.destroy())
  socket.end(`${lines.join('\r\n')}\r\n\r\n${payload}`)
}
