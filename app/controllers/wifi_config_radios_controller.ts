import { patchRadio } from '#services/wifi_config/ap_service'
import { radioViews } from '#transformers/wifi_config'
import { radioPatchValidator } from '#validators/wifi_config'
import type { HttpContext } from '@adonisjs/core/http'
import { applyFlag, wifiRefusal, writeResult } from '#controllers/wifi_config_aps_controller'

/**
 * Radios over REST (docs/design/wifi controller.md section 7.2 "Radios"):
 * every radio of the observed and managed APs with the clients on it; an
 * edit goes into the AP's draft and, unless `?apply=0`, out by a one-AP
 * `radios` rollout.
 */
export default class WifiConfigRadiosController {
  /** GET /api/v1/wifi/radios?apId= */
  async index({ request }: HttpContext) {
    const apId = Number(request.input('apId'))
    return { data: await radioViews(Number.isInteger(apId) && apId > 0 ? { apId } : {}) }
  }

  /** PATCH /api/v1/wifi/config/aps/:apId/radios/:section[?apply=0] → WriteResult<WifiRadio> */
  async update(ctx: HttpContext) {
    const { params, request, response, auth, serialize } = ctx
    const payload = await request.validateUsing(radioPatchValidator)
    try {
      const apId = Number(params.apId)
      const outcome = await patchRadio(apId, params.section, payload, auth.getUserOrFail(), {
        apply: applyFlag(ctx),
        adminAddress: request.ip(),
      })
      const radios = await radioViews({ apId })
      const radio = radios.find((r) => r.section === params.section) ?? null
      return serialize(await writeResult(radio, outcome))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }
}
