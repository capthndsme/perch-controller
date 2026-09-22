import WifiAccessPoint from '#models/wifi_access_point'
import type { AgentEndpoint } from '#services/agent_gateway'
import hub, { type AgentConnection, AgentOfflineError } from '#services/ap_agent_hub'
import { agentSecretMatches, parseAgentBearer } from '#services/ap_agent_credentials'
import { agentConfigureParams, handleMetricsPush } from '#services/ap_agent_metrics'
import { recordAgentAuthFailure } from '#services/ap_agent_rate_limit'
import {
  markAgentConnected,
  markAgentDisconnected,
  recordSystemInfo,
  type SystemInfoResult,
} from '#services/ap_agent_registry'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * The Perch AP Daemon endpoint (docs/ap-controller.md section 2.2, PROTOCOL.md
 * section 2 of perch-apd), mounted by `agent_gateway.ts`.
 *
 * Authenticate the bearer against `wifi_access_points.agent_id` +
 * `agent_secret_hash`, register the session with the hub, tell the agent its
 * push schedule (`agent.configure`), ask it who it is (`system.info`) and
 * route its `metrics.push` notifications to ingestion.
 */

export const AP_AGENT_WS_PATH = '/api/v1/ap-agent/ws'
export const AP_AGENT_SUBPROTOCOL = 'perch-ap.v1'
export const AP_AGENT_MAX_PAYLOAD = 4 * 1024 * 1024

export function apAgentEndpoint(): AgentEndpoint<WifiAccessPoint> {
  return {
    path: AP_AGENT_WS_PATH,
    subprotocol: AP_AGENT_SUBPROTOCOL,
    maxPayload: AP_AGENT_MAX_PAYLOAD,
    // A push is 20–40 KB of Prometheus text that deflates about 7×; perch-apd
    // offers permessage-deflate since 0.1.1 (older agents do not, and stay
    // uncompressed). Same settings as the collector endpoint: no context
    // takeover keeps per-session memory flat.
    perMessageDeflate: {
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      threshold: 1024,
    },

    attach() {
      // Pushed metrics (docs/ap-controller.md section 3.1).
      hub.onNotification('metrics.push', async (apId, params) => {
        await handleMetricsPush(apId, params)
      })
    },

    async authenticate(request, { address }) {
      const credentials = parseAgentBearer(request.headers.authorization)
      const ap = credentials
        ? await WifiAccessPoint.query().where('agent_id', credentials.agentId).first()
        : null
      if (!credentials || !ap || !agentSecretMatches(ap.agentSecretHash, credentials.agentSecret)) {
        recordAgentAuthFailure(address)
        logger.warn({ address }, 'ap_agent_gateway: rejected agent credentials')
        return {
          ok: false,
          refusal: {
            status: 401,
            body: {
              error: 'invalid_agent_credentials',
              message: 'Unknown or revoked agent credentials.',
            },
          },
        }
      }
      return { ok: true, principal: ap }
    },

    onConnection(ws, ap, { address, secure }) {
      // The credentials this session proved; every write it causes is scoped to them.
      const agentId = ap.agentId!

      const connection: AgentConnection = {
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
        terminate: () => ws.terminate(),
      }
      const session = hub.register({
        id: ap.id,
        connection,
        connectedAt: DateTime.utc(),
        address: address === 'unknown' ? null : address,
        protocol: ws.protocol || AP_AGENT_SUBPROTOCOL,
        secure,
      })
      // First frame of every session: the push schedule. Then system.info.
      hub.notify(ap.id, 'agent.configure', agentConfigureParams(ap))

      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        hub.handleFrame(session, data.toString())
      })
      ws.on('error', (error) => {
        logger.debug({ apId: ap.id, err: error }, 'ap_agent_gateway: socket error')
      })
      ws.on('close', (code) => {
        const wasCurrent = hub.unregister(session)
        logger.info({ apId: ap.id, code }, 'ap_agent_gateway: agent disconnected')
        if (wasCurrent) {
          markAgentDisconnected(ap.id, agentId).catch((error) =>
            logger.warn(
              { apId: ap.id, err: error },
              'ap_agent_gateway: could not record disconnect'
            )
          )
        }
      })

      logger.info({ apId: ap.id, address }, 'ap_agent_gateway: agent connected')
      markAgentConnected(ap.id, agentId, session.info.address)
        .then(() => refreshSystemInfo(ap.id, agentId))
        .catch((error) =>
          logger.warn({ apId: ap.id, err: error }, 'ap_agent_gateway: could not record connect')
        )
    },

    closeAll(code, reason) {
      return hub.closeAll(code, reason)
    },
  }
}

/**
 * `system.info` right after connect: identity, version and capabilities
 * (what the command buttons are enabled from).
 */
async function refreshSystemInfo(apId: number, agentId: string): Promise<void> {
  try {
    const info = await hub.request<SystemInfoResult>(apId, 'system.info')
    if (info && typeof info === 'object' && !Array.isArray(info)) {
      await recordSystemInfo(apId, info, agentId)
    }
  } catch (error) {
    if (error instanceof AgentOfflineError) {
      logger.debug({ apId }, 'ap_agent_gateway: agent left before answering system.info')
      return
    }
    logger.warn({ apId, err: error }, 'ap_agent_gateway: system.info failed')
  }
}
