import { resolveDivergences } from '#services/wifi_config/fleet_service'
import { divergenceViews, rolloutViewOf } from '#transformers/wifi_config'
import { divergenceFilterValidator, divergenceResolveValidator } from '#validators/wifi_config'
import type { HttpContext } from '@adonisjs/core/http'
import { applyFlag, wifiRefusal } from '#controllers/wifi_config_aps_controller'

/**
 * Divergences over REST (docs/design/wifi controller.md sections 5.3 and
 * 7.2): where an AP differs from what the fleet renders for it, and the
 * admin's choice per item.
 */
export default class WifiConfigDivergencesController {
  /** GET /api/v1/wifi/divergences?apId=&networkId=&open=1 */
  async index({ request }: HttpContext) {
    const filter = await divergenceFilterValidator.validate(request.qs())
    return {
      data: await divergenceViews({
        apId: filter.apId,
        networkId: filter.networkId,
        open: filter.open === undefined ? true : filter.open === '1' || filter.open === 'true',
      }),
    }
  }

  /** POST /api/v1/wifi/divergences/resolve[?apply=0] {items, currentPassword?} */
  async resolve(ctx: HttpContext) {
    const { request, response, auth, serialize } = ctx
    const payload = await request.validateUsing(divergenceResolveValidator)
    try {
      const outcome = await resolveDivergences(payload.items, auth.getUserOrFail(), {
        apply: applyFlag(ctx),
        currentPassword: payload.currentPassword,
        adminAddress: request.ip(),
      })
      return serialize({
        resolved: outcome.resolved,
        rollout: outcome.rollout ? await rolloutViewOf(outcome.rollout) : null,
        rolloutError: outcome.rolloutError,
      })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }
}
