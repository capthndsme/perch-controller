import { applyFlag, runSync } from '#services/gateway_config/gateway_sync_http'
import {
  createAlias,
  createWan,
  deleteAlias,
  deleteWan,
  orderWans,
  updateAlias,
  updateWan,
  wanHistory,
  wanOverview,
  wanView,
} from '#services/gateway_config/wan_service'
import {
  wanAliasCreateValidator,
  wanAliasPatchValidator,
  wanCreateValidator,
  wanDeleteValidator,
  wanHistoryValidator,
  wanOrderValidator,
  wanPatchValidator,
} from '#validators/gateway_wan'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: WAN uplinks, aliases and failover order (docs/design/
 * gateway-sync/rest.md 3, work package B1). Admin-only
 * (start/routes/gateway_sync.ts). Every UCI write is a checked job: the
 * router verifies the internet after the commit.
 */
export default class GatewayWanController {
  /** GET /api/v1/gateways/:id/wan */
  async index(ctx: HttpContext) {
    return runSync(ctx, (c, _u, gatewayId) => wanOverview(gatewayId, c.request.ip()))
  }

  /** GET /api/v1/gateways/:id/wan/history?range=24h|7d|30d&network= */
  async history(ctx: HttpContext) {
    const range = ctx.request.input('range')
    if (range !== undefined && !['24h', '7d', '30d'].includes(range)) {
      return ctx.response.status(400).send({
        error: 'invalid_range',
        message: 'range is 24h, 7d or 30d.',
      })
    }
    const query = await wanHistoryValidator.validate(ctx.request.qs())
    return runSync(ctx, (_c, _u, gatewayId) =>
      wanHistory(gatewayId, query.range ?? '24h', query.network ?? null)
    )
  }

  /** PUT /api/v1/gateways/:id/wan/order[?apply=0] */
  async order(ctx: HttpContext) {
    const { ids } = await ctx.request.validateUsing(wanOrderValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      orderWans(gatewayId, userId, ids, { apply: applyFlag(c.request), requestIp: c.request.ip() })
    )
  }

  /** POST /api/v1/gateways/:id/wan[?apply=0] */
  async create(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(wanCreateValidator)
    return runSync(
      ctx,
      (c, userId, gatewayId) =>
        createWan(gatewayId, userId, body, {
          apply: applyFlag(c.request),
          requestIp: c.request.ip(),
        }),
      201
    )
  }

  /** GET /api/v1/gateways/:id/wan/:perchId */
  async show(ctx: HttpContext) {
    return runSync(ctx, (c, _u, gatewayId) => wanView(gatewayId, String(c.params.perchId)))
  }

  /** PATCH /api/v1/gateways/:id/wan/:perchId[?apply=0] */
  async update(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(wanPatchValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      updateWan(gatewayId, userId, String(c.params.perchId), body, {
        apply: applyFlag(c.request),
        requestIp: c.request.ip(),
      })
    )
  }

  /** DELETE /api/v1/gateways/:id/wan/:perchId[?apply=0] {confirm} */
  async destroy(ctx: HttpContext) {
    const { confirm } = await ctx.request.validateUsing(wanDeleteValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      deleteWan(gatewayId, userId, String(c.params.perchId), confirm, {
        apply: applyFlag(c.request),
        requestIp: c.request.ip(),
      })
    )
  }

  /** POST /api/v1/gateways/:id/wan/:perchId/aliases[?apply=0] */
  async createAlias(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(wanAliasCreateValidator)
    return runSync(
      ctx,
      (c, userId, gatewayId) =>
        createAlias(gatewayId, userId, String(c.params.perchId), body, {
          apply: applyFlag(c.request),
          requestIp: c.request.ip(),
        }),
      201
    )
  }

  /** PATCH /api/v1/gateways/:id/wan/aliases/:perchId[?apply=0] */
  async updateAlias(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(wanAliasPatchValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      updateAlias(gatewayId, userId, String(c.params.perchId), body, {
        apply: applyFlag(c.request),
        requestIp: c.request.ip(),
      })
    )
  }

  /** DELETE /api/v1/gateways/:id/wan/aliases/:perchId[?apply=0] */
  async deleteAlias(ctx: HttpContext) {
    return runSync(ctx, (c, userId, gatewayId) =>
      deleteAlias(gatewayId, userId, String(c.params.perchId), {
        apply: applyFlag(c.request),
        requestIp: c.request.ip(),
      })
    )
  }
}
