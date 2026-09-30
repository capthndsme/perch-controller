import { planeRefusal } from '#controllers/gateways_controller'
import {
  gatewaySyncSettingsView,
  getGatewaySyncSettings,
  updateGatewaySyncSettings,
} from '#services/gateway_config/gateway_sync_settings'
import { gatewaySyncSettingsPatchValidator } from '#validators/gateway_wan'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Settings → Gateway sync (docs/design/gateway-sync/rest.md 11, work package
 * B1). Admin-only (start/routes/gateway_sync.ts). Turning `multiWanWrites` on
 * needs the admin's current password.
 */
export default class GatewaySyncSettingsController {
  /** GET /api/v1/settings/gateway-sync */
  async show({ serialize }: HttpContext) {
    return serialize(gatewaySyncSettingsView(await getGatewaySyncSettings()))
  }

  /** PATCH /api/v1/settings/gateway-sync */
  async update({ request, response, auth, serialize }: HttpContext) {
    const { currentPassword, ...patch } = await request.validateUsing(
      gatewaySyncSettingsPatchValidator
    )
    try {
      const settings = await updateGatewaySyncSettings(patch, auth.getUserOrFail(), currentPassword)
      return serialize(gatewaySyncSettingsView(settings))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }
}
