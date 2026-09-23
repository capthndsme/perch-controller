import { planeRefusal } from '#controllers/gateways_controller'
import GatewayApply from '#models/gateway_apply'
import { validateStates } from '#services/gateway_config/apply_lifecycle'
import {
  createPortForward,
  createRule,
  deletePortForward,
  deleteRule,
  firewallOverview,
  getDeviceWanAccess,
  reorder,
  resolveFirewallOrder,
  setDeviceWanAccess,
  updatePortForward,
  updateRule,
} from '#services/gateway_config/firewall_service'
import { applyViewOf } from '#transformers/gateway_transformer'
import {
  firewallOrderResolveValidator,
  firewallOrderValidator,
  firewallRulePatchValidator,
  firewallRuleValidator,
  portForwardPatchValidator,
  portForwardValidator,
  wanAccessValidator,
} from '#validators/gateway_firewall'
import { deviceGatewayValidator } from '#validators/gateways'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * The firewall on the managed gateway (docs/gateway/firewall.md section 6;
 * plan 2 sections 4.3 and 5): the overview, port forwards, Perch rules and
 * their order, and the device page's WAN block. Writes go into the draft
 * and, unless `?apply=0`, straight into an apply of the touched sections;
 * the response carries it (`apply`) or why it did not start (`applyError`).
 */

function applyFlag(request: HttpContext['request']): boolean {
  const value = request.input('apply')
  if (value === undefined || value === null) return true
  return !['0', 'false', false, 0].includes(value)
}

async function withApplyView<T extends { apply: unknown }>(result: T) {
  return {
    ...result,
    apply:
      result.apply instanceof GatewayApply
        ? await applyViewOf(result.apply, { changes: true })
        : null,
  }
}

export default class GatewayFirewallController {
  /** GET /api/v1/gateways/:id/firewall */
  async show({ params, response, serialize }: HttpContext) {
    try {
      return serialize(await firewallOverview(Number(params.id), { validate: validateStates }))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/firewall/port-forwards */
  async createPortForward({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(portForwardValidator)
    try {
      const result = await createPortForward(Number(params.id), auth.getUserOrFail().id, {
        ...payload,
        apply: applyFlag(request),
      })
      response.status(201)
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** PATCH /api/v1/gateways/:id/firewall/port-forwards/:perchId */
  async updatePortForward({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(portForwardPatchValidator)
    try {
      const result = await updatePortForward(
        Number(params.id),
        auth.getUserOrFail().id,
        params.perchId,
        { ...payload, apply: applyFlag(request) }
      )
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** DELETE /api/v1/gateways/:id/firewall/port-forwards/:perchId */
  async deletePortForward({ params, request, response, auth, serialize }: HttpContext) {
    try {
      const result = await deletePortForward(
        Number(params.id),
        auth.getUserOrFail().id,
        params.perchId,
        { apply: applyFlag(request) }
      )
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/firewall/rules */
  async createRule({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(firewallRuleValidator)
    try {
      const result = await createRule(Number(params.id), auth.getUserOrFail().id, {
        ...payload,
        clientIp: request.ip(),
        apply: applyFlag(request),
      })
      response.status(201)
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** PATCH /api/v1/gateways/:id/firewall/rules/:perchId */
  async updateRule({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(firewallRulePatchValidator)
    try {
      const result = await updateRule(Number(params.id), auth.getUserOrFail().id, params.perchId, {
        ...payload,
        clientIp: request.ip(),
        apply: applyFlag(request),
      })
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** DELETE /api/v1/gateways/:id/firewall/rules/:perchId */
  async deleteRule({ params, request, response, auth, serialize }: HttpContext) {
    try {
      const result = await deleteRule(Number(params.id), auth.getUserOrFail().id, params.perchId, {
        apply: applyFlag(request),
      })
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** PUT /api/v1/gateways/:id/firewall/rules/order {ids} */
  async orderRules(ctx: HttpContext) {
    return this.#order(ctx, 'rule')
  }

  /** PUT /api/v1/gateways/:id/firewall/port-forwards/order {ids} */
  async orderPortForwards(ctx: HttpContext) {
    return this.#order(ctx, 'redirect')
  }

  async #order(
    { params, request, response, auth, serialize }: HttpContext,
    type: 'rule' | 'redirect'
  ) {
    const { ids } = await request.validateUsing(firewallOrderValidator)
    try {
      const result = await reorder(Number(params.id), auth.getUserOrFail().id, type, ids, {
        apply: applyFlag(request),
      })
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/firewall/order/resolve {type, take} */
  async resolveOrder({ params, request, response, auth, serialize }: HttpContext) {
    const { type, take } = await request.validateUsing(firewallOrderResolveValidator)
    try {
      const result = await resolveFirewallOrder(
        Number(params.id),
        auth.getUserOrFail().id,
        type,
        take,
        { apply: applyFlag(request) }
      )
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** GET /api/v1/devices/:mac/wan-access?gatewayId= */
  async showWanAccess({ params, request, response, serialize }: HttpContext) {
    const { gatewayId } = await deviceGatewayValidator.validate(request.qs())
    try {
      return serialize(await getDeviceWanAccess(params.mac, gatewayId))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** PUT /api/v1/devices/:mac/wan-access {gatewayId?, blocked, note?} */
  async putWanAccess({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(wanAccessValidator)
    try {
      const result = await setDeviceWanAccess(params.mac, auth.getUserOrFail().id, {
        ...payload,
        clientIp: request.ip(),
        apply: applyFlag(request),
      })
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }
}
