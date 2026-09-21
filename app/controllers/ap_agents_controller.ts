import WifiAccessPoint from '#models/wifi_access_point'
import env from '#start/env'
import hub, { AgentOfflineError, AgentTimeoutError } from '#services/ap_agent_hub'
import { agentAuthBudget, recordAgentAuthFailure } from '#services/ap_agent_rate_limit'
import { forgetAgent, joinAgent, type JoinResult } from '#services/ap_agent_registry'
import { announceSourceAddress } from '#services/collector_announce'
import WifiAccessPointTransformer from '#transformers/wifi_access_point_transformer'
import { apAgentJoinValidator } from '#validators/ap_agents'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * ap-controller agents (docs/ap-controller.md).
 *
 * `join` is the one action outside `auth` and the setup gate (like the
 * collector announce): an access point with a join token must be able to
 * register itself. Everything else is mounted under `/api/v1/settings` and
 * is therefore `auth + requirePasswordChange + requireAdmin`.
 */

const DEFAULT_RELEASE_URL = 'https://github.com/capthndsme/perch-apd/releases/latest/download'

/** Fixed list, in this order (docs/ap-controller.md section 4.2). */
const AGENT_ASSETS = [
  {
    arch: 'mipsle',
    file: 'perch-apd-linux-mipsle',
    label: 'MIPS little-endian',
    hint: 'MT7621, MT7628 (mipsel_24kc)',
  },
  {
    arch: 'mips',
    file: 'perch-apd-linux-mips',
    label: 'MIPS big-endian',
    hint: 'Atheros/QCA ath79 (mips_24kc)',
  },
  {
    arch: 'armv7',
    file: 'perch-apd-linux-armv7',
    label: 'ARMv7',
    hint: 'IPQ40xx, IPQ806x, mvebu (arm_cortex-a7/a9/a15 with VFP)',
  },
  {
    arch: 'armv5',
    file: 'perch-apd-linux-armv5',
    label: 'ARM without VFP',
    hint: 'kirkwood, bcm53xx, ARMv5/v6 (software floats)',
  },
  {
    arch: 'arm64',
    file: 'perch-apd-linux-arm64',
    label: 'ARM64',
    hint: 'Filogic MT798x, IPQ807x, BCM2711 (aarch64)',
  },
  {
    arch: 'amd64',
    file: 'perch-apd-linux-amd64',
    label: 'x86-64',
    hint: 'x86_64 PCs and VMs',
  },
] as const

const INVALID_TOKEN_MESSAGES: Record<
  Extract<JoinResult, { status: 'invalid_token' }>['reason'],
  string
> = {
  unknown: 'Unknown join token.',
  revoked: 'This join token has been revoked.',
  expired: 'This join token has expired.',
  exhausted: 'This join token has been used up.',
}

export default class ApAgentsController {
  /**
   * POST /api/v1/ap-agent/join  (unauthenticated — the token is the auth)
   */
  async join({ request, response, serialize }: HttpContext) {
    // Budget first, before a schema run or a database read.
    const address = announceSourceAddress(request.ip())
    const budget = agentAuthBudget(address)
    if (!budget.allowed) {
      response.header('Retry-After', String(budget.retryAfterSeconds))
      return response.tooManyRequests({
        error: 'rate_limited',
        message: 'Too many failed join attempts from this address. Try again later.',
        retryAfterSeconds: budget.retryAfterSeconds,
      })
    }

    let payload
    try {
      payload = await request.validateUsing(apAgentJoinValidator)
    } catch (error) {
      recordAgentAuthFailure(address)
      throw error
    }

    const result = await joinAgent(payload)
    if (result.status === 'invalid_token') {
      recordAgentAuthFailure(address)
      return response.unauthorized({
        error: 'invalid_join_token',
        message: INVALID_TOKEN_MESSAGES[result.reason],
      })
    }

    response.status(201)
    return serialize({
      agentId: result.agentId,
      agentSecret: result.agentSecret,
      apId: result.ap.id,
      apName: result.ap.friendlyName ?? result.ap.name,
      outcome: result.outcome,
    })
  }

  /**
   * GET /api/v1/settings/ap-agent/install
   */
  async installInfo({ request, serialize }: HttpContext) {
    const releaseBaseUrl = stripTrailingSlash(
      env.get('AP_AGENT_RELEASE_URL') || DEFAULT_RELEASE_URL
    )
    const controllerUrl = stripTrailingSlash(
      env.get('AP_AGENT_CONTROLLER_URL') || `${request.protocol()}://${request.host()}`
    )
    return serialize({
      controllerUrl,
      releaseBaseUrl,
      installScriptUrl: `${releaseBaseUrl}/install.sh`,
      assets: AGENT_ASSETS.map((asset) => ({ ...asset })),
    })
  }

  /**
   * POST /api/v1/settings/wifi-sources/:id/agent/ping
   */
  async ping({ params, response, serialize }: HttpContext) {
    const ap = await findSource(params.id)
    if (!ap) return sourceNotFound(response, params.id)
    if (!ap.agentId) return agentNotFound(response, ap.id)

    const start = performance.now()
    try {
      await hub.request(ap.id, 'ping', {}, { timeoutMs: 5000 })
    } catch (error) {
      if (error instanceof AgentOfflineError) {
        return response.conflict({
          error: 'agent_offline',
          message: 'The Perch AP Daemon on this AP is not connected.',
        })
      }
      if (error instanceof AgentTimeoutError) {
        return response.status(504).send({
          error: 'agent_timeout',
          message: `The Perch AP Daemon did not answer within ${error.timeoutMs} ms.`,
        })
      }
      return response.badRequest({
        error: 'agent_error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return serialize({ online: true, latencyMs: Math.round(performance.now() - start) })
  }

  /**
   * DELETE /api/v1/settings/wifi-sources/:id/agent  ("Forget agent")
   */
  async forget({ params, response, serialize }: HttpContext) {
    const ap = await findSource(params.id)
    if (!ap) return sourceNotFound(response, params.id)
    if (!ap.agentId) return agentNotFound(response, ap.id)

    const updated = await forgetAgent(ap)
    return serialize(WifiAccessPointTransformer.transform(updated))
  }
}

async function findSource(rawId: unknown): Promise<WifiAccessPoint | null> {
  const id = Number(rawId)
  if (!Number.isSafeInteger(id) || id <= 0) return null
  return WifiAccessPoint.find(id)
}

function sourceNotFound(response: HttpContext['response'], id: unknown) {
  return response.notFound({
    error: 'wifi_source_not_found',
    message: `WiFi source ${id} does not exist.`,
  })
}

function agentNotFound(response: HttpContext['response'], id: number) {
  return response.notFound({
    error: 'agent_not_found',
    message: `WiFi source ${id} has no Perch AP Daemon.`,
  })
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
