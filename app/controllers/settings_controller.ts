import {
  getHostnameEnrichmentSettings,
  normalizeHostnameEnrichmentSettings,
  setHostnameEnrichmentSettings,
} from '#services/hostname_enrichment_settings'
import WifiAccessPoint from '#models/wifi_access_point'
import {
  createWifiAccessPoint,
  deleteWifiAccessPoint,
  listWifiAccessPoints,
  probeWifiAccessPointById,
  updateWifiAccessPoint,
} from '#services/wifi_source_registry'
import { probeWifiAccessPoint } from '#services/wifi_access_point_probe'
import WifiAccessPointTransformer from '#transformers/wifi_access_point_transformer'
import { updateHostnameEnrichmentSettingsValidator } from '#validators/hostname_enrichment_settings'
import {
  wifiSourceCreateValidator,
  wifiSourceProbeValidator,
  wifiSourceUpdateValidator,
} from '#validators/wifi'
import type { HttpContext } from '@adonisjs/core/http'

export default class SettingsController {
  /**
   * GET /api/v1/settings/hostname-enrichment
   */
  async hostnameEnrichment({ serialize }: HttpContext) {
    const settings = await getHostnameEnrichmentSettings()
    return serialize(settings)
  }

  /**
   * PATCH /api/v1/settings/hostname-enrichment
   */
  async updateHostnameEnrichment({ request, serialize }: HttpContext) {
    const payload = await request.validateUsing(updateHostnameEnrichmentSettingsValidator)
    const settings = normalizeHostnameEnrichmentSettings(payload)
    await setHostnameEnrichmentSettings(settings)
    return serialize(settings)
  }

  /**
   * GET /api/v1/settings/wifi-sources
   */
  async wifiSources({ request, serialize }: HttpContext) {
    const includeDisabled = request.input('includeDisabled') === 'true'
    const rows = await listWifiAccessPoints({ includeDisabled })
    return serialize(WifiAccessPointTransformer.transform(rows))
  }

  /**
   * POST /api/v1/settings/wifi-sources
   */
  async createWifiSource({ request, serialize }: HttpContext) {
    const payload = await request.validateUsing(wifiSourceCreateValidator)
    const { source, probe } = await createWifiAccessPoint(payload)
    return serialize({
      source: WifiAccessPointTransformer.transform(source),
      probe,
    })
  }

  /**
   * POST /api/v1/settings/wifi-sources/probe
   */
  async probeWifiSourceDraft({ request, serialize }: HttpContext) {
    const payload = await request.validateUsing(wifiSourceProbeValidator)
    const probe = await probeWifiAccessPoint(payload.metricsUrl)
    return serialize({
      probe,
      suggestedName: probe.nodename ?? null,
    })
  }

  /**
   * PUT /api/v1/settings/wifi-sources/:id
   */
  async updateWifiSource({ params, request, response, serialize }: HttpContext) {
    const source = await WifiAccessPoint.find(Number(params.id))
    if (!source) {
      return response.notFound({
        error: 'wifi_source_not_found',
        message: `WiFi source ${params.id} does not exist.`,
      })
    }

    const payload = await request.validateUsing(wifiSourceUpdateValidator)
    const shouldProbe = request.input('probe') !== 'false'
    const { source: updated, probe } = await updateWifiAccessPoint(source, payload, {
      probeAfterUpdate: shouldProbe,
    })

    return serialize({
      source: WifiAccessPointTransformer.transform(updated),
      probe,
    })
  }

  /**
   * DELETE /api/v1/settings/wifi-sources/:id
   */
  async deleteWifiSource({ params, response }: HttpContext) {
    const source = await WifiAccessPoint.find(Number(params.id))
    if (!source) {
      return response.notFound({
        error: 'wifi_source_not_found',
        message: `WiFi source ${params.id} does not exist.`,
      })
    }
    await deleteWifiAccessPoint(source)
    return response.status(204)
  }

  /**
   * POST /api/v1/settings/wifi-sources/:id/probe
   */
  async probeWifiSource({ params, response, serialize }: HttpContext) {
    const source = await WifiAccessPoint.find(Number(params.id))
    if (!source) {
      return response.notFound({
        error: 'wifi_source_not_found',
        message: `WiFi source ${params.id} does not exist.`,
      })
    }
    const probe = await probeWifiAccessPointById(source)
    return serialize({
      source: WifiAccessPointTransformer.transform(source),
      probe,
    })
  }
}
