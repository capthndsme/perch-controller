import { planeRefusal } from '#controllers/gateways_controller'
import GatewayApply from '#models/gateway_apply'
import {
  createTag,
  deleteTag,
  dhcpOverview,
  updatePool,
  updateReservation,
  updateTag,
} from '#services/gateway_config/dhcp_service'
import {
  createRoute,
  deleteRoute,
  routingOverview,
  updateRoute,
} from '#services/gateway_config/routing_service'
import { updateSystem } from '#services/gateway_config/system_service'
import { applyViewOf } from '#transformers/gateway_transformer'
import {
  dhcpPoolPatchValidator,
  dhcpReservationPatchValidator,
  dhcpTagPatchValidator,
  dhcpTagValidator,
  routePatchValidator,
  routeValidator,
  systemPatchValidator,
} from '#validators/gateway_native'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * The rest of native OpenWrt sync (docs/gateway/native-sync.md; plan 2
 * phase 4): DHCP pools with their options, DHCP tags and reservation tags,
 * static routes (policy rules, mwan3 and pbr read-only), and the system
 * section. DNS settings share `GatewayNamesController` (`/dns`). Every route
 * is admin-only (plan 2 section 5). Writes go into the draft and, unless
 * `?apply=0`, straight into an apply of the touched sections; the response
 * carries it (`apply`) or why it did not start (`applyError`).
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

type Handler = (ctx: HttpContext, userId: number, gatewayId: number) => Promise<unknown>

/** Runs a handler with the plane's refusals mapped to their statuses. */
async function run(ctx: HttpContext, handler: Handler, status = 200) {
  try {
    const result = await handler(ctx, ctx.auth.getUserOrFail().id, Number(ctx.params.id))
    ctx.response.status(status)
    const shaped =
      result && typeof result === 'object' && 'apply' in result
        ? await withApplyView(result as { apply: unknown })
        : result
    return ctx.serialize(shaped)
  } catch (error) {
    return planeRefusal(ctx.response, error)
  }
}

export default class GatewayNativeController {
  /** GET /api/v1/gateways/:id/dhcp */
  async dhcp(ctx: HttpContext) {
    return run(ctx, (_c, _u, id) => dhcpOverview(id))
  }

  /** PATCH /api/v1/gateways/:id/dhcp/pools/:network */
  async updatePool(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(dhcpPoolPatchValidator)
    return run(ctx, (c, userId, id) =>
      updatePool(id, userId, String(c.params.network), {
        ...payload,
        clientIp: c.request.ip(),
        apply: applyFlag(c.request),
      })
    )
  }

  /** POST /api/v1/gateways/:id/dhcp/tags */
  async createTag(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(dhcpTagValidator)
    return run(
      ctx,
      (c, userId, id) => createTag(id, userId, { ...payload, apply: applyFlag(c.request) }),
      201
    )
  }

  /** PATCH /api/v1/gateways/:id/dhcp/tags/:perchId */
  async updateTag(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(dhcpTagPatchValidator)
    return run(ctx, (c, userId, id) =>
      updateTag(id, userId, String(c.params.perchId), { ...payload, apply: applyFlag(c.request) })
    )
  }

  /** DELETE /api/v1/gateways/:id/dhcp/tags/:perchId */
  async deleteTag(ctx: HttpContext) {
    return run(ctx, (c, userId, id) =>
      deleteTag(id, userId, String(c.params.perchId), { apply: applyFlag(c.request) })
    )
  }

  /** PATCH /api/v1/gateways/:id/dhcp/reservations/:perchId */
  async updateReservation(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(dhcpReservationPatchValidator)
    return run(ctx, (c, userId, id) =>
      updateReservation(id, userId, String(c.params.perchId), {
        ...payload,
        apply: applyFlag(c.request),
      })
    )
  }

  /** GET /api/v1/gateways/:id/routing */
  async routing(ctx: HttpContext) {
    return run(ctx, (_c, _u, id) => routingOverview(id))
  }

  /** POST /api/v1/gateways/:id/routing/routes */
  async createRoute(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(routeValidator)
    return run(
      ctx,
      (c, userId, id) => createRoute(id, userId, { ...payload, apply: applyFlag(c.request) }),
      201
    )
  }

  /** PATCH /api/v1/gateways/:id/routing/routes/:perchId */
  async updateRoute(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(routePatchValidator)
    return run(ctx, (c, userId, id) =>
      updateRoute(id, userId, String(c.params.perchId), { ...payload, apply: applyFlag(c.request) })
    )
  }

  /** DELETE /api/v1/gateways/:id/routing/routes/:perchId */
  async deleteRoute(ctx: HttpContext) {
    return run(ctx, (c, userId, id) =>
      deleteRoute(id, userId, String(c.params.perchId), { apply: applyFlag(c.request) })
    )
  }

  /** PATCH /api/v1/gateways/:id/system */
  async updateSystem(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(systemPatchValidator)
    return run(ctx, (c, userId, id) =>
      updateSystem(id, userId, { ...payload, apply: applyFlag(c.request) })
    )
  }
}
