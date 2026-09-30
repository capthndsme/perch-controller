import { acceptAdoption, adoptionProposals } from '#services/wifi_config/fleet_service'
import { getWifiConfigSettings } from '#services/wifi_config/settings'
import { networkViews } from '#transformers/wifi_config'
import { adoptionValidator } from '#validators/wifi_config'
import type { HttpContext } from '@adonisjs/core/http'
import { wifiRefusal } from '#controllers/wifi_config_aps_controller'

/**
 * Adoption over REST (docs/design/wifi controller.md sections 5.4 and 7.2):
 * the proposals from what the observed APs run (with S4's `memberships`,
 * `hints`, `exclude`, `unset` and `suggestedCountry`), and their
 * acceptance, which writes nothing to any AP.
 */
export default class WifiConfigAdoptionController {
  /** GET /api/v1/wifi/adoption */
  async show({ serialize }: HttpContext) {
    return serialize(await adoptionProposals())
  }

  /** POST /api/v1/wifi/adoption → { networks, divergences, passphrases } */
  async accept({ request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(adoptionValidator)
    try {
      const outcome = await acceptAdoption(payload, auth.getUserOrFail())
      const ids = outcome.networks.map((n) => n.id)
      return serialize({
        networks: ids.length > 0 ? await networkViews(await getWifiConfigSettings(), { ids }) : [],
        divergences: outcome.divergences,
        passphrases: outcome.passphrases,
      })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }
}
