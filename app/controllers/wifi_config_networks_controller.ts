import {
  createNetwork,
  deleteNetwork,
  findNetwork,
  putNetworkAp,
  revealPassphrase,
  setPassphrase,
  updateNetwork,
} from '#services/wifi_config/fleet_service'
import { getWifiConfigSettings } from '#services/wifi_config/settings'
import { networkViews, rolloutViewOf } from '#transformers/wifi_config'
import {
  networkApValidator,
  networkCreateValidator,
  networkPatchValidator,
  passphraseValidator,
} from '#validators/wifi_config'
import type { WifiBinding } from '#services/wifi_config/types'
import type { HttpContext } from '@adonisjs/core/http'
import { applyFlag, wifiRefusal, writeResult } from '#controllers/wifi_config_aps_controller'

/**
 * Fleet Wi-Fi networks over REST (docs/design/wifi controller.md section
 * 7.2 "Networks"). Writes return a `WriteResult<WifiNetwork>`: the change is
 * stored, and unless `?apply=0` a rollout takes it to the APs one at a time
 * (`rolloutError` says why none started; the change is kept).
 */

type BindingInput = {
  kind: 'lan' | 'vlan' | 'ap_network'
  vlanId?: number
  gatewayId?: number | null
  networkPerchId?: string | null
}

/** The validated binding as the fleet's union. */
function bindingOf(input: BindingInput | undefined): WifiBinding | undefined {
  if (!input) return undefined
  if (input.kind === 'vlan') {
    return {
      kind: 'vlan',
      vlanId: input.vlanId ?? 0,
      gatewayId: input.gatewayId ?? null,
      networkPerchId: input.networkPerchId ?? null,
    }
  }
  return { kind: input.kind }
}

async function networkView(id: number) {
  const [view] = await networkViews(await getWifiConfigSettings(), { ids: [id] })
  return view ?? null
}

export default class WifiConfigNetworksController {
  /** GET /api/v1/wifi/networks */
  async index(_ctx: HttpContext) {
    return { data: await networkViews(await getWifiConfigSettings()) }
  }

  /** GET /api/v1/wifi/networks/:id */
  async show({ params, response, serialize }: HttpContext) {
    try {
      await findNetwork(Number(params.id))
      return serialize(await networkView(Number(params.id)))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST /api/v1/wifi/networks[?apply=0] → 201 WriteResult<WifiNetwork> */
  async store(ctx: HttpContext) {
    const { request, response, auth, serialize } = ctx
    const payload = await request.validateUsing(networkCreateValidator)
    try {
      const outcome = await createNetwork(
        { ...payload, binding: bindingOf(payload.binding) },
        auth.getUserOrFail(),
        {
          apply: applyFlag(ctx),
          adminAddress: request.ip(),
        }
      )
      response.status(201)
      return serialize(await writeResult(await networkView(outcome.object.id), outcome))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** PATCH /api/v1/wifi/networks/:id[?apply=0] → WriteResult<WifiNetwork> */
  async update(ctx: HttpContext) {
    const { params, request, response, auth, serialize } = ctx
    const payload = await request.validateUsing(networkPatchValidator)
    try {
      const outcome = await updateNetwork(
        Number(params.id),
        { ...payload, binding: bindingOf(payload.binding) },
        auth.getUserOrFail(),
        {
          apply: applyFlag(ctx),
          adminAddress: request.ip(),
        }
      )
      return serialize(await writeResult(await networkView(outcome.object.id), outcome))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** DELETE /api/v1/wifi/networks/:id[?apply=0] → WriteResult<null> */
  async destroy(ctx: HttpContext) {
    const { params, request, response, auth, serialize } = ctx
    try {
      const outcome = await deleteNetwork(Number(params.id), auth.getUserOrFail(), {
        apply: applyFlag(ctx),
        adminAddress: request.ip(),
      })
      return serialize(await writeResult(null, outcome))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST /api/v1/wifi/networks/:id/passphrase {passphrase, force?} */
  async setPassphrase(ctx: HttpContext) {
    const { params, request, response, auth, serialize } = ctx
    const payload = await request.validateUsing(passphraseValidator)
    try {
      const outcome = await setPassphrase(
        Number(params.id),
        payload.passphrase,
        auth.getUserOrFail(),
        {
          force: payload.force,
          apply: applyFlag(ctx),
          adminAddress: request.ip(),
        }
      )
      return serialize({
        network: await networkView(outcome.network.id),
        matches: outcome.matches,
        rollout: outcome.rollout ? await rolloutViewOf(outcome.rollout) : null,
        rolloutError: outcome.rolloutError,
      })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** GET /api/v1/wifi/networks/:id/passphrase (admin, audited as `passphrase_revealed`) */
  async revealPassphrase({ params, response, auth, serialize }: HttpContext) {
    try {
      const passphrase = await revealPassphrase(Number(params.id), auth.getUserOrFail())
      response.header('Cache-Control', 'no-store')
      return serialize({ passphrase })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** PUT /api/v1/wifi/networks/:id/aps/:apId[?apply=0] → WriteResult<WifiNetwork> */
  async putAp(ctx: HttpContext) {
    const { params, request, response, auth, serialize } = ctx
    const payload = await request.validateUsing(networkApValidator)
    try {
      const outcome = await putNetworkAp(
        Number(params.id),
        Number(params.apId),
        payload,
        auth.getUserOrFail(),
        {
          apply: applyFlag(ctx),
          adminAddress: request.ip(),
        }
      )
      return serialize(await writeResult(await networkView(outcome.object.id), outcome))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** DELETE /api/v1/wifi/networks/:id/aps/:apId/overrides[?apply=0] → WriteResult<WifiNetwork> */
  async resetAp(ctx: HttpContext) {
    const { params, request, response, auth, serialize } = ctx
    try {
      const outcome = await putNetworkAp(
        Number(params.id),
        Number(params.apId),
        {},
        auth.getUserOrFail(),
        {
          apply: applyFlag(ctx),
          reset: true,
          adminAddress: request.ip(),
        }
      )
      return serialize(await writeResult(await networkView(outcome.object.id), outcome))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }
}
