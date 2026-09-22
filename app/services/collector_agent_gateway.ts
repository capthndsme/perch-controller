import Collector from '#models/collector'
import type { AgentEndpoint } from '#services/agent_gateway'
import {
  forgetSessionKey,
  handleCollectorPush,
  rememberSessionKey,
  sendCollectorConfigure,
  syncCollectorProtocols,
} from '#services/collector_agent'
import collectorHub, {
  type AgentConnection,
  type AgentSession,
  CLOSE_CODES,
  RPC_ERRORS,
} from '#services/collector_agent_hub'
import {
  PENDING_LIMIT,
  consumeAnnounceBudget,
  isAnnounceEnabled,
  keysMatch,
  recordAnnounce,
} from '#services/collector_announce'
import { recordAgentAuthFailure } from '#services/ap_agent_rate_limit'
import { INSTANCE_ID_REGEX, collectorHelloValidator } from '#validators/collectors'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { errors as vineErrors } from '@vinejs/vine'
import type { IncomingMessage } from 'node:http'
import { DateTime } from 'luxon'
import type { WebSocket } from 'ws'

/**
 * The collector endpoint (docs/collector-agent.md section 3), mounted by
 * `agent_gateway.ts`.
 *
 * The upgrade is checked against the instance id and bearer the collector
 * sends (section 3.1). After it, the first frame must be a `collector.hello`
 * request, which runs the announce match table with the upgrade's source
 * address — so discovery, pending rows and adoption work exactly as over
 * HTTP — and marks the row `transport = 'agent'`. Only then is the session
 * registered with the hub under the row id, told its push schedule
 * (`agent.configure`) and, when adopted, asked for its protocol table.
 */

export const COLLECTOR_AGENT_WS_PATH = '/api/v1/collector-agent/ws'
export const COLLECTOR_AGENT_SUBPROTOCOL = 'perch-collector.v1'
/** After inflation: a push is the whole device table, 1–2 MB on a busy home LAN. */
export const COLLECTOR_AGENT_MAX_PAYLOAD = 64 * 1024 * 1024
export const INSTANCE_ID_HEADER = 'x-perch-instance-id'
/** How long a new socket may take to say `collector.hello`. */
export const HELLO_TIMEOUT_MS = 10_000

export type CollectorPrincipal = {
  instanceId: string
  /** The bearer the collector presented: its own api_key. */
  bearer: string
}

type HelloResult = { collectorId: number; lifecycle: string; name: string }

type RpcFrame = {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

function refusal(status: number, error: string, message: string, headers?: Record<string, string>) {
  return { ok: false as const, refusal: { status, body: { error, message }, headers } }
}

function parseBearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const token = match ? match[1].trim() : ''
  return token.length > 0 && token.length <= 512 ? token : null
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name]
  const single = Array.isArray(value) ? value[0] : value
  return typeof single === 'string' ? single.trim() : null
}

export function collectorAgentEndpoint(): AgentEndpoint<CollectorPrincipal> {
  return {
    path: COLLECTOR_AGENT_WS_PATH,
    subprotocol: COLLECTOR_AGENT_SUBPROTOCOL,
    maxPayload: COLLECTOR_AGENT_MAX_PAYLOAD,
    // A push is ~1 MB of repetitive JSON; deflate makes it ~10× smaller. No
    // context takeover: a 32 KB window buys little on megabyte messages and
    // keeps per-session memory flat.
    perMessageDeflate: {
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      threshold: 1024,
    },

    attach() {
      collectorHub.onNotification('collector.push', async (collectorId, params) => {
        await handleCollectorPush(collectorId, params)
      })
    },

    async authenticate(request, { address }) {
      const bearer = parseBearer(headerValue(request, 'authorization') ?? undefined)
      const instanceId = headerValue(request, INSTANCE_ID_HEADER)
      if (!bearer || !instanceId || !INSTANCE_ID_REGEX.test(instanceId)) {
        return refusal(
          400,
          'invalid_request',
          'Send Authorization: Bearer <api_key> and X-Perch-Instance-Id.'
        )
      }

      const row = await Collector.query().where('instance_id', instanceId).first()
      if (row && row.apiKey !== null && !keysMatch(row.apiKey, bearer)) {
        recordAgentAuthFailure(address)
        logger.warn(
          { collectorId: row.id, address },
          'collector_agent_gateway: rejected collector key'
        )
        return refusal(
          401,
          'invalid_collector_key',
          'This controller has a different API key for this collector.'
        )
      }

      const adopted = row?.lifecycle === 'adopted'
      if (!adopted && !(await isAnnounceEnabled())) {
        return refusal(
          403,
          'announce_disabled',
          'Collector discovery is switched off on this controller.'
        )
      }

      if (!adopted) {
        // Unadopted sockets are announces: same per-address budget as
        // POST /api/v1/collectors/announce. Adopted collectors are the data
        // path and are never throttled here.
        const budget = consumeAnnounceBudget(address)
        if (!budget.allowed) {
          return refusal(
            429,
            'announce_rate_limited',
            'Too many announces. Slow down and try again later.',
            { 'Retry-After': String(budget.retryAfterSeconds) }
          )
        }
      }

      if (!row) {
        const pending = await db
          .from('collectors')
          .where('lifecycle', 'pending')
          .count('* as total')
        if (Number(pending[0]?.total ?? 0) >= PENDING_LIMIT) {
          return refusal(
            409,
            'announce_pending_limit',
            'Too many collectors are already waiting for adoption.'
          )
        }
      }

      return { ok: true, principal: { instanceId, bearer } }
    },

    onConnection(ws, principal, { address, secure }) {
      let session: AgentSession | null = null
      let helloSeen = false

      const helloTimer = setTimeout(() => {
        if (!helloSeen) ws.close(CLOSE_CODES.POLICY_VIOLATION, 'collector.hello expected')
      }, HELLO_TIMEOUT_MS)
      helloTimer.unref()

      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        const raw = data.toString()
        if (session) {
          collectorHub.handleFrame(session, raw)
          return
        }
        if (helloSeen) {
          logger.debug(
            { instanceId: principal.instanceId },
            'collector_agent_gateway: frame before the hello was answered; dropped'
          )
          return
        }
        helloSeen = true
        clearTimeout(helloTimer)
        // The session is bound the moment it is registered, so a close that
        // races the end of the hello still unregisters it.
        handleHello(ws, principal, address, secure, raw, (registered) => {
          session = registered
        }).catch((error) => {
          logger.error(
            { instanceId: principal.instanceId, err: error },
            'collector_agent_gateway: hello failed'
          )
          ws.close(1011, 'internal error')
        })
      })
      ws.on('error', (error) => {
        logger.debug(
          { instanceId: principal.instanceId, err: error },
          'collector_agent_gateway: socket error'
        )
      })
      ws.on('close', (code) => {
        clearTimeout(helloTimer)
        if (!session) return
        const wasCurrent = collectorHub.unregister(session)
        if (wasCurrent) forgetSessionKey(session.id)
        logger.info(
          { collectorId: session.id, code },
          'collector_agent_gateway: collector disconnected'
        )
      })
    },

    closeAll(code, reason) {
      return collectorHub.closeAll(code, reason)
    },
  }
}

function send(ws: WebSocket, payload: Record<string, unknown>) {
  try {
    ws.send(JSON.stringify({ jsonrpc: '2.0', ...payload }))
  } catch {
    // The close handler cleans up.
  }
}

function rpcError(ws: WebSocket, id: unknown, code: number, message: string, data?: unknown) {
  send(ws, {
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  })
}

/**
 * Answers the first frame. Calls `bind` with the hub session once it is
 * registered; returns without registering when the socket was refused (and
 * is being closed).
 */
async function handleHello(
  ws: WebSocket,
  principal: CollectorPrincipal,
  address: string,
  secure: boolean | null,
  raw: string,
  bind: (session: AgentSession) => void
): Promise<void> {
  let frame: RpcFrame
  try {
    frame = JSON.parse(raw)
  } catch {
    rpcError(ws, null, RPC_ERRORS.PARSE_ERROR, 'parse error')
    ws.close(CLOSE_CODES.POLICY_VIOLATION, 'collector.hello expected')
    return
  }
  const hasId = frame && typeof frame === 'object' && frame.id !== undefined && frame.id !== null
  if (!hasId || frame.jsonrpc !== '2.0' || frame.method !== 'collector.hello') {
    if (hasId) rpcError(ws, frame.id, RPC_ERRORS.INVALID_REQUEST, 'collector.hello expected')
    ws.close(CLOSE_CODES.POLICY_VIOLATION, 'collector.hello expected')
    return
  }
  const id = frame.id

  let hello: Awaited<ReturnType<typeof collectorHelloValidator.validate>>
  try {
    hello = await collectorHelloValidator.validate(frame.params ?? {})
  } catch (error) {
    const detail =
      error instanceof vineErrors.E_VALIDATION_ERROR
        ? (error.messages as Array<{ field: string; message: string }>)
            .map((entry) => `${entry.field}: ${entry.message}`)
            .join('; ')
        : String(error)
    rpcError(ws, id, RPC_ERRORS.INVALID_PARAMS, `invalid params: ${detail}`)
    ws.close(CLOSE_CODES.POLICY_VIOLATION, 'invalid collector.hello')
    return
  }
  if (hello.instanceId !== principal.instanceId) {
    rpcError(ws, id, RPC_ERRORS.INVALID_PARAMS, 'instanceId does not match X-Perch-Instance-Id')
    ws.close(CLOSE_CODES.POLICY_VIOLATION, 'invalid collector.hello')
    return
  }

  const known = address !== 'unknown'
  const outcome = await recordAnnounce(
    {
      instanceId: hello.instanceId,
      hostname: hello.hostname,
      version: hello.version,
      captureInterface: hello.captureInterface,
      // No pollable address can be derived without a source address.
      port: known ? hello.port : undefined,
      tls: hello.tls,
      baseUrl: hello.baseUrl,
      apiKey: hello.apiKey,
      apiKeyFingerprint: hello.apiKeyFingerprint,
    },
    { sourceAddress: address, bearerToken: principal.bearer, transport: 'agent' }
  )

  if (outcome.status === 'rejected') {
    if (outcome.error === 'announce_key_mismatch') {
      rpcError(
        ws,
        id,
        RPC_ERRORS.COMMAND_FAILED,
        'This instance id is already registered with a different API key.',
        { error: 'announce_key_mismatch' }
      )
      ws.close(CLOSE_CODES.REVOKED, 'collector key mismatch')
    } else {
      rpcError(
        ws,
        id,
        RPC_ERRORS.COMMAND_FAILED,
        'Too many collectors are already waiting for adoption.',
        { error: 'announce_pending_limit' }
      )
      ws.close(CLOSE_CODES.POLICY_VIOLATION, 'pending limit')
    }
    return
  }

  const row = await Collector.find(outcome.collectorId)
  if (!row) {
    ws.close(CLOSE_CODES.REVOKED, 'collector deleted')
    return
  }
  const result: HelloResult = { collectorId: row.id, lifecycle: outcome.lifecycle, name: row.name }
  send(ws, { id, result })

  if (outcome.lifecycle === 'dismissed') {
    logger.info(
      { collectorId: row.id, address },
      'collector_agent_gateway: dismissed collector turned away'
    )
    ws.close(CLOSE_CODES.DISMISSED, 'dismissed')
    return
  }
  if (ws.readyState !== ws.OPEN) return

  const connection: AgentConnection = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
  }
  const session = collectorHub.register({
    id: row.id,
    connection,
    connectedAt: DateTime.utc(),
    address: address === 'unknown' ? null : address,
    protocol: ws.protocol || COLLECTOR_AGENT_SUBPROTOCOL,
    secure,
  })
  bind(session)
  rememberSessionKey(row.id, principal.bearer)
  sendCollectorConfigure(row)
  logger.info(
    { collectorId: row.id, lifecycle: outcome.lifecycle, address },
    'collector_agent_gateway: collector connected'
  )
  if (outcome.lifecycle === 'adopted') void syncCollectorProtocols(row.id)
}
