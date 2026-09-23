import {
  gatewayConfigSettingsView,
  getGatewayConfigSettings,
  isValidLocalStatePath,
  updateGatewayConfigSettings,
} from '#services/gateway_config/gateway_config_settings'
import { updateGatewayConfigSettingsValidator } from '#validators/gateway_config_settings'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Settings → Gateway (docs/gateway/config-plane.md section 11): the managed
 * gateway's tunables. Admin-only, like every route under /settings.
 */
export default class GatewaySettingsController {
  /**
   * GET /api/v1/settings/gateway
   *
   * `{ settings, defaults, limits, choices }`.
   */
  async show({ serialize }: HttpContext) {
    return serialize(gatewayConfigSettingsView(await getGatewayConfigSettings()))
  }

  /**
   * PATCH /api/v1/settings/gateway
   *
   * Any subset of the settings; the others keep their value.
   */
  async update({ request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(updateGatewayConfigSettingsValidator)
    if (payload.localStatePath !== undefined && !isValidLocalStatePath(payload.localStatePath)) {
      return response.unprocessableEntity({
        errors: [
          {
            field: 'localStatePath',
            rule: 'localStatePath',
            message: 'An absolute path of plain segments, without "." or ".." segments',
          },
        ],
      })
    }
    return serialize(gatewayConfigSettingsView(await updateGatewayConfigSettings(payload)))
  }
}
