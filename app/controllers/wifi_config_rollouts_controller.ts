import WifiRollout from '#models/wifi_rollout'
import { previewNetworkDraft } from '#services/wifi_config/fleet_service'
import {
  activeRollout,
  createRollout,
  findRollout,
  previewRollout,
  rolloutAction,
  type RolloutAction,
} from '#services/wifi_config/rollouts'
import { rolloutViewOf, rolloutViews } from '#transformers/wifi_config'
import {
  rolloutActionValidator,
  rolloutCreateValidator,
  rolloutPreviewValidator,
  wifiPagingValidator,
} from '#validators/wifi_config'
import type { HttpContext } from '@adonisjs/core/http'
import { wifiRefusal } from '#controllers/wifi_config_aps_controller'

/**
 * Rollouts over REST (docs/design/wifi controller.md sections 6 and 7.2):
 * the impact preview (also of unsaved network edits: `draft`), starting
 * one (one at a time fleet-wide), the history, the active one, and the
 * admin's actions on a running, paused or stopped rollout.
 */
export default class WifiConfigRolloutsController {
  /** POST /api/v1/wifi/rollouts/preview {networkIds?, apIds?, perchIds?, draft?} */
  async preview({ request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(rolloutPreviewValidator)
    try {
      if (payload.draft) {
        return serialize(
          await previewNetworkDraft(
            {
              network: payload.draft.network as never,
              aps: (payload.draft.aps ?? []) as never,
            },
            { adminAddress: request.ip() }
          )
        )
      }
      return serialize(
        await previewRollout({
          kind: 'change',
          actor: null,
          networkIds: payload.networkIds,
          apIds: payload.apIds,
          perchIds: payload.perchIds,
          adminAddress: request.ip(),
        })
      )
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST /api/v1/wifi/rollouts → 202 WifiRollout */
  async store({ request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(rolloutCreateValidator)
    try {
      const rollout = await createRollout({
        kind: 'change',
        actor: auth.getUserOrFail().id,
        networkIds: payload.networkIds,
        apIds: payload.apIds,
        perchIds: payload.perchIds,
        order: payload.order,
        confirmMode: payload.confirmMode,
        offlinePolicy: payload.offlinePolicy,
        note: payload.note ?? null,
        adminAddress: request.ip(),
      })
      response.status(202)
      return serialize(await rolloutViewOf(rollout))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** GET /api/v1/wifi/rollouts?limit=&before= */
  async index({ request, serialize }: HttpContext) {
    const input = await wifiPagingValidator.validate(request.qs())
    const limit = input.limit ?? 20
    const query = WifiRollout.query().orderBy('id', 'desc').limit(limit)
    if (input.before) query.where('id', '<', input.before)
    if (input.state) query.where('state', input.state)
    const rows = await query
    return serialize({
      items: await rolloutViews(rows),
      nextBefore: rows.length === limit ? Number(rows[rows.length - 1].id) : null,
    })
  }

  /**
   * GET /api/v1/wifi/rollouts/current: the active rollout (running, paused,
   * or stopped and waiting for Retry/Skip/Roll back/Cancel), or null.
   */
  async current() {
    const rollout = await activeRollout()
    // `serialize` does not take null: the envelope is built here.
    return { data: rollout ? await rolloutViewOf(rollout) : null }
  }

  /** GET /api/v1/wifi/rollouts/:rolloutId */
  async show({ params, response, serialize }: HttpContext) {
    try {
      return serialize(await rolloutViewOf(await findRollout(Number(params.rolloutId))))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST /api/v1/wifi/rollouts/:rolloutId/{pause,resume,cancel,retry,skip,rollback} */
  async action({ params, request, response, auth, serialize }: HttpContext) {
    const { apId } = await request.validateUsing(rolloutActionValidator)
    try {
      const rollout = await rolloutAction(
        Number(params.rolloutId),
        params.action as RolloutAction,
        {
          actor: auth.getUserOrFail().id,
          apId,
          adminAddress: request.ip(),
        }
      )
      return serialize(await rolloutViewOf(rollout))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }
}
