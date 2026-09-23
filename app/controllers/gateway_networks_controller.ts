import { planeRefusal } from '#controllers/gateways_controller'
import GatewayApply from '#models/gateway_apply'
import { normalizeMac } from '#services/device_labels'
import { findGateway } from '#services/gateway_config/gateway_config_service'
import {
  allNetworks,
  createGatewayNetwork,
  deleteGatewayNetwork,
  getGatewayNetwork,
  listGatewayNetworks,
  updateGatewayNetwork,
  type NetworkWriteResult,
} from '#services/gateway_config/networks_service'
import {
  deviceNetworkHistory,
  deviceNetworksFor,
  queryNetworkHistory,
  scopeChanges,
} from '#services/gateway_network_accounting'
import { pickRouterResolution } from '#services/router_metrics'
import { resolveTimeWindow } from '#services/time_window'
import { applyViewOf } from '#transformers/gateway_transformer'
import {
  networkCreateValidator,
  networkHistoryValidator,
  networkPatchValidator,
} from '#validators/gateways'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Networks of a managed gateway (docs/gateway/networks.md): list and detail
 * with live counters, create/edit/delete (a VLAN on an existing bridge, its
 * DHCP pool) through the config plane, the per-network capture toggle, the
 * traffic history of each network and the accounting scope changes. Reads
 * for any signed-in user, writes admin-only (routes).
 */

function applyFlag(request: HttpContext['request']): boolean {
  const value = request.input('apply')
  if (value === undefined || value === null) return true
  return !['0', 'false', false, 0].includes(value)
}

async function withApplyView(result: NetworkWriteResult) {
  return {
    ...result,
    apply:
      result.apply instanceof GatewayApply
        ? await applyViewOf(result.apply, { changes: true })
        : null,
  }
}

function networkId(params: Record<string, unknown>): number {
  return Number(params.networkId)
}

export default class GatewayNetworksController {
  /** GET /api/v1/gateways/:id/networks */
  async index({ params, response }: HttpContext) {
    try {
      // A plain array is not wrapped by `serialize`: wrap it here.
      return { data: await listGatewayNetworks(Number(params.id)) }
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** GET /api/v1/gateways/:id/networks/:networkId */
  async show({ params, response, serialize }: HttpContext) {
    try {
      return serialize(await getGatewayNetwork(Number(params.id), networkId(params)))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/networks[?apply=0] */
  async store({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(networkCreateValidator)
    try {
      const result = await createGatewayNetwork(Number(params.id), auth.getUserOrFail().id, {
        ...payload,
        apply: applyFlag(request),
      })
      response.status(201)
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** PATCH /api/v1/gateways/:id/networks/:networkId[?apply=0] */
  async update({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(networkPatchValidator)
    try {
      const result = await updateGatewayNetwork(
        Number(params.id),
        networkId(params),
        auth.getUserOrFail().id,
        { ...payload, apply: applyFlag(request) }
      )
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** DELETE /api/v1/gateways/:id/networks/:networkId[?apply=0] */
  async destroy({ params, request, response, auth, serialize }: HttpContext) {
    try {
      const result = await deleteGatewayNetwork(
        Number(params.id),
        networkId(params),
        auth.getUserOrFail().id,
        { apply: applyFlag(request) }
      )
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /**
   * GET /api/v1/gateways/:id/networks/history?range=24h|from&to&resolution=&network=
   *
   * Per-network rates from the 30 s samples (averages and peaks per
   * bucket), plus the scope rule changes inside the window.
   */
  async history({ params, request, response, serialize }: HttpContext) {
    const qs = await request.validateUsing(networkHistoryValidator, { data: request.qs() })
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)
    try {
      const gateway = await findGateway(Number(params.id))
      const resolutionSeconds = pickRouterResolution(qs.resolution, window.since, window.until)
      const [networks, changes, before] = await Promise.all([
        queryNetworkHistory({
          gatewayId: gateway.id,
          since: window.since,
          until: window.until,
          resolutionSeconds,
          network: qs.network,
        }),
        scopeChanges({ gatewayId: gateway.id, since: window.since, until: window.until }),
        scopeChanges({ gatewayId: gateway.id, until: window.since }),
      ])
      return serialize({
        gatewayId: gateway.id,
        range: window.range,
        from: window.since.toISO(),
        to: window.until.toISO(),
        resolution: `${resolutionSeconds / 60}m`,
        resolutionSeconds,
        /** The scope in force at `from` (null = never reported). */
        scopeAtStart: before.length > 0 ? before[before.length - 1].scope : null,
        scopeChanges: changes.map(({ scope, changedAt }) => ({ scope, changedAt })),
        networks,
      })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** GET /api/v1/networks: every gateway's networks (any signed-in user). */
  async all(_ctx: HttpContext) {
    return { data: await allNetworks() }
  }

  /** GET /api/v1/networks/scope-changes: when each gateway's accounting scope changed. */
  async scopeChanges(_ctx: HttpContext) {
    return { data: await scopeChanges() }
  }

  /** GET /api/v1/devices/:mac/networks: the device's network now and its intervals. */
  async device({ params, response, serialize }: HttpContext) {
    const mac = normalizeMac(String(params.mac))
    if (!mac) {
      return response.badRequest({
        error: 'invalid_mac',
        message: `"${params.mac}" is not a MAC address.`,
      })
    }
    const latestByMac = await deviceNetworksFor([mac])
    const latest = latestByMac.get(mac) ?? null
    return serialize({ mac, latest, history: await deviceNetworkHistory(mac) })
  }
}
