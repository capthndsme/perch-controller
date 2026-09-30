import ApConfig from '#models/ap_config'
import { pushApConfigure } from '#services/wifi_config/ap_service'
import {
  getWifiConfigSettings,
  updateWifiConfigSettings,
  wifiConfigSettingsErrors,
  wifiConfigSettingsView,
  type WifiConfigSettings,
} from '#services/wifi_config/settings'
import { apSession } from '#services/wifi_config/registry'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Settings → Wi-Fi management (docs/design/wifi controller.md section 8):
 * `{ settings, defaults, limits, choices }`; a PATCH takes any subset (422
 * outside the limits). The watch, debounce and health-wait values ride in
 * `agent.configure`, so every online AP with the plane gets them again.
 */
export default class WifiConfigSettingsController {
  /** GET /api/v1/settings/wifi-config */
  async show({ serialize }: HttpContext) {
    return serialize(wifiConfigSettingsView(await getWifiConfigSettings()))
  }

  /** PATCH /api/v1/settings/wifi-config */
  async update({ request, response, serialize }: HttpContext) {
    const body = request.body() as Record<string, unknown>
    const errors = wifiConfigSettingsErrors(body)
    if (errors.length > 0) {
      return response.unprocessableEntity({
        errors: errors.map((e) => ({ field: e.field, rule: 'range', message: e.message })),
      })
    }
    const settings = await updateWifiConfigSettings(body as Partial<WifiConfigSettings>)
    for (const ap of await ApConfig.query()) {
      if (apSession(ap.apId)) await pushApConfigure(ap)
    }
    return serialize(wifiConfigSettingsView(settings))
  }
}
