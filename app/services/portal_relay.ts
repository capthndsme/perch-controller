import { authenticatePortalApiToken, isPortalApiToken } from '#services/portal_api_clients'
import {
  consumePortalApiRequest,
  portalApiAuthBudget,
  recordPortalApiAuthFailure,
} from '#services/portal_api_rate_limit'
import {
  type AuthorizeCallContext,
  authorizeDevice,
  clientPrincipal,
  deauthorizeDevice,
  deviceAuthorization,
} from '#services/portal_authorize'
import { PortalError } from '#services/portal_errors'
import { getPortalSettings } from '#services/portal_settings'
import { authorizeValidator } from '#validators/portal'
import logger from '@adonisjs/core/services/logger'
import { errors as vineErrors } from '@vinejs/vine'

/**
 * `portal.relay` (decision 22, docs/gateway/portal.md section 13.6): the
 * Paid Hotspot API through the router. A paid-hotspot integration such as a
 * coin-operated vending box on the guest network calls the router's
 * `/portal/v1/authorizations[/:mac]` with its `perch_pa_` token; the router
 * passes the request through untouched (it never stores or checks a token)
 * and answers the guest side with `{status, body}` exactly as the HTTP API
 * would.
 *
 * Extra scrutiny over the HTTP path:
 * - only `perch_pa_` tokens: a controller access token must never be typed
 *   on a guest network, so one is refused like a wrong token;
 * - the portal is the router's own (the portal the request came in on, not
 *   one the body names), and it must belong to the relaying gateway;
 * - failed tokens are charged to `relay:<gatewayId>` (20 in 15 minutes and the
 *   gateway's relay answers 429 before any lookup), accepted calls count
 *   against the client's `apiRequestsPerClientPerMinute` like HTTP calls;
 * - the router rate-limits per guest address and portal before it asks.
 */

export type RelayOp = 'authorize' | 'status' | 'deauthorize'
export type RelayAnswer = { status: number; body: Record<string, unknown> }

function answer(status: number, error: string, message: string, extra = {}): RelayAnswer {
  return { status, body: { error, message, ...extra } }
}

function relayParams(params: unknown) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  const p = params as Record<string, unknown>
  const portalId = p.portalId
  if (typeof portalId !== 'number' || !Number.isSafeInteger(portalId) || portalId < 1) return null
  if (p.op !== 'authorize' && p.op !== 'status' && p.op !== 'deauthorize') return null
  const token = typeof p.token === 'string' ? p.token.trim() : ''
  const mac = typeof p.mac === 'string' ? p.mac.slice(0, 32) : ''
  const clientIp = typeof p.clientIp === 'string' ? p.clientIp.slice(0, 45) : null
  return { portalId, op: p.op as RelayOp, token, mac, body: p.body, clientIp }
}

export async function handlePortalRelay(gatewayId: number, params: unknown): Promise<RelayAnswer> {
  const p = relayParams(params)
  if (!p) return answer(400, 'bad_request', 'The relay request was malformed.')

  const failureKey = `relay:${gatewayId}`
  const budget = portalApiAuthBudget(failureKey)
  if (!budget.allowed) {
    return answer(429, 'rate_limited', 'Too many failed tokens through this gateway.', {
      retryAfterSeconds: budget.retryAfterSeconds,
    })
  }
  const client =
    p.token && isPortalApiToken(p.token) ? await authenticatePortalApiToken(p.token) : null
  if (!client) {
    recordPortalApiAuthFailure(failureKey)
    return answer(
      401,
      'invalid_api_token',
      'A valid portal API token (Bearer perch_pa_…) is required.'
    )
  }
  const principal = clientPrincipal(client)
  const settings = await getPortalSettings()
  const allowed = consumePortalApiRequest(principal.key, settings.apiRequestsPerClientPerMinute)
  if (!allowed.allowed) {
    return answer(429, 'rate_limited', 'Too many requests for this API client.', {
      retryAfterSeconds: allowed.retryAfterSeconds,
    })
  }

  const context: AuthorizeCallContext = { via: 'relay', address: p.clientIp, gatewayId }
  try {
    if (p.op === 'authorize') {
      const body =
        p.body && typeof p.body === 'object' && !Array.isArray(p.body)
          ? (p.body as Record<string, unknown>)
          : {}
      // The portal is the one the request came in on.
      const payload = await authorizeValidator.validate({ ...body, portalId: p.portalId })
      const result = await authorizeDevice(principal, payload, context)
      return {
        status: result.status,
        body: { data: { grant: result.grant, delivery: result.delivery, outcome: result.outcome } },
      }
    }
    if (p.op === 'status') {
      return {
        status: 200,
        body: { data: await deviceAuthorization(principal, p.portalId, p.mac, context) },
      }
    }
    return {
      status: 200,
      body: { data: await deauthorizeDevice(principal, p.portalId, p.mac, context) },
    }
  } catch (error) {
    if (error instanceof PortalError) {
      return {
        status: error.httpStatus,
        body: { error: error.code, message: error.message, ...error.extra },
      }
    }
    if (error instanceof vineErrors.E_VALIDATION_ERROR) {
      return { status: 422, body: { errors: error.messages } }
    }
    logger.error({ gatewayId, op: p.op, err: error }, 'portal_relay: relay failed')
    return answer(500, 'internal_error', 'The controller could not answer.')
  }
}
