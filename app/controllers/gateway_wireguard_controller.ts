import { applyFlag, runSync } from '#services/gateway_config/gateway_sync_http'
import {
  createWgInterface,
  createWgPeer,
  deleteWgInterface,
  deleteWgPeer,
  rotateWgKey,
  updateWgInterface,
  updateWgPeer,
  wireguardOverview,
} from '#services/gateway_config/wireguard_service'
import {
  wgConfirmValidator,
  wgInterfaceCreateValidator,
  wgInterfacePatchValidator,
  wgPeerCreateValidator,
  wgPeerPatchValidator,
  wgRotateValidator,
} from '#validators/gateway_sync_services'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: WireGuard interfaces and peers (docs/design/gateway-sync/
 * rest.md 4, work package B2). Admin-only (start/routes/gateway_sync.ts).
 * A new interface or peer is remote access into the LAN: the password
 * step-up (Settings → Gateway sync `wgStepUp`). A generated client config is
 * in the create answer only, sent with `Cache-Control: no-store`.
 */
export default class GatewayWireguardController {
  /** GET /api/v1/gateways/:id/wireguard/config */
  async index(ctx: HttpContext) {
    return runSync(ctx, (_c, _u, gatewayId) => wireguardOverview(gatewayId))
  }

  /** POST /api/v1/gateways/:id/wireguard/interfaces[?apply=0] */
  async createInterface(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(wgInterfaceCreateValidator)
    return runSync(
      ctx,
      (c, _u, gatewayId) =>
        createWgInterface(gatewayId, c.auth.getUserOrFail(), payload, {
          apply: applyFlag(c.request),
        }),
      201
    )
  }

  /** PATCH /api/v1/gateways/:id/wireguard/interfaces/:perchId[?apply=0] */
  async updateInterface(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(wgInterfacePatchValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      updateWgInterface(gatewayId, userId, String(c.params.perchId), payload, {
        apply: applyFlag(c.request),
      })
    )
  }

  /** DELETE /api/v1/gateways/:id/wireguard/interfaces/:perchId[?apply=0] */
  async deleteInterface(ctx: HttpContext) {
    const { confirm } = await ctx.request.validateUsing(wgConfirmValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      deleteWgInterface(gatewayId, userId, String(c.params.perchId), confirm, {
        apply: applyFlag(c.request),
      })
    )
  }

  /** POST /api/v1/gateways/:id/wireguard/interfaces/:perchId/rotate-key[?apply=0] */
  async rotateKey(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(wgRotateValidator)
    return runSync(ctx, (c, _u, gatewayId) =>
      rotateWgKey(gatewayId, c.auth.getUserOrFail(), String(c.params.perchId), payload, {
        apply: applyFlag(c.request),
      })
    )
  }

  /** POST /api/v1/gateways/:id/wireguard/interfaces/:perchId/peers[?apply=0] */
  async createPeer(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(wgPeerCreateValidator)
    // The answer may carry a client's private key: never cached anywhere.
    ctx.response.header('Cache-Control', 'no-store')
    return runSync(
      ctx,
      (c, _u, gatewayId) =>
        createWgPeer(gatewayId, c.auth.getUserOrFail(), String(c.params.perchId), payload, {
          apply: applyFlag(c.request),
        }),
      201
    )
  }

  /** PATCH /api/v1/gateways/:id/wireguard/peers/:perchId[?apply=0] */
  async updatePeer(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(wgPeerPatchValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      updateWgPeer(gatewayId, userId, String(c.params.perchId), payload, {
        apply: applyFlag(c.request),
      })
    )
  }

  /** DELETE /api/v1/gateways/:id/wireguard/peers/:perchId[?apply=0] */
  async deletePeer(ctx: HttpContext) {
    return runSync(ctx, (c, userId, gatewayId) =>
      deleteWgPeer(gatewayId, userId, String(c.params.perchId), { apply: applyFlag(c.request) })
    )
  }
}
