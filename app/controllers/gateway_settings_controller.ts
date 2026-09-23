import {
  gatewayConfigSettingsView,
  getGatewayConfigSettings,
  isValidLocalStatePath,
  updateGatewayConfigSettings,
} from '#services/gateway_config/gateway_config_settings'
import { updateGatewayConfigSettingsValidator } from '#validators/gateway_config_settings'
import Collector from '#models/collector'
import Gateway from '#models/gateway'
import { sendCollectorConfigure } from '#services/collector_agent'
import collectorHub from '#services/collector_agent_hub'
import type { GatewayConfigSettings } from '#services/gateway_config/gateway_config_settings'
import { setConfigureBlock } from '#services/gateway_config/gateway_registry'
import type { HttpContext } from '@adonisjs/core/http'

/** Online gateways learn new watch/debounce seconds right away (`agent.configure`). */
async function pushGatewayConfigure(settings: GatewayConfigSettings) {
  const online = collectorHub.onlineIds()
  if (online.length === 0) return
  const gateways = await Gateway.query().whereIn('collector_id', online)
  for (const gateway of gateways) {
    setConfigureBlock(gateway, settings)
    const collector = await Collector.find(gateway.collectorId!)
    if (collector) sendCollectorConfigure(collector)
  }
}

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
    const settings = await updateGatewayConfigSettings(payload)
    await pushGatewayConfigure(settings)
    return serialize(gatewayConfigSettingsView(settings))
  }
}
