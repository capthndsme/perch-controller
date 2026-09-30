import AgentUpdateRollout, { OPEN_ROLLOUT_STATES } from '#models/agent_update_rollout'
import {
  RolloutError,
  cancelRollout,
  createRollout,
  pauseByAdmin,
  resumeRollout,
  rolloutView,
  rolloutViews,
} from '#services/agent_updates/rollouts'
import { getAgentUpdateSettings } from '#services/agent_updates/settings'
import {
  rolloutCreateValidator,
  rolloutResumeValidator,
  rolloutsQueryValidator,
} from '#validators/agent_updates'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Rollouts (docs/design/agent-updates/controller.md section 9.2, endpoints 7,
 * 8, 20, 21): list and read for any signed-in user; create, pause, resume and
 * cancel for admins, each recorded with its user.
 */
export default class AgentRolloutsController {
  /** GET /api/v1/agent-updates/rollouts */
  async index({ request, serialize }: HttpContext) {
    const query = await rolloutsQueryValidator.validate(request.qs())
    const builder = AgentUpdateRollout.query().orderBy('id', 'desc').limit(200)
    if ((query.state ?? 'all') === 'open') builder.whereIn('state', [...OPEN_ROLLOUT_STATES])
    if (query.product) builder.where('product', query.product)
    return serialize({ rollouts: await rolloutViews(await builder) })
  }

  /** GET /api/v1/agent-updates/rollouts/:id */
  async show({ params, response, serialize }: HttpContext) {
    const rollout = await AgentUpdateRollout.find(Number(params.id))
    if (!rollout) return notFound(response, params.id)
    return serialize(await rolloutView(rollout))
  }

  /** POST /api/v1/agent-updates/rollouts */
  async store({ request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(rolloutCreateValidator)
    const settings = await getAgentUpdateSettings()
    try {
      const rollout = await createRollout({ ...payload, userId: auth.user?.id ?? null }, settings)
      response.status(201)
      return serialize(await rolloutView(rollout))
    } catch (error) {
      if (error instanceof RolloutError) return refused(response, error)
      throw error
    }
  }

  /** POST /api/v1/agent-updates/rollouts/:id/pause */
  async pause({ params, response, auth, serialize }: HttpContext) {
    return this.act(params, response, serialize, (rollout) =>
      pauseByAdmin(rollout, auth.user?.id ?? null)
    )
  }

  /** POST /api/v1/agent-updates/rollouts/:id/resume */
  async resume({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(rolloutResumeValidator)
    return this.act(params, response, serialize, (rollout) =>
      resumeRollout(rollout, {
        skipFailed: payload.skipFailed ?? false,
        userId: auth.user?.id ?? null,
      })
    )
  }

  /** POST /api/v1/agent-updates/rollouts/:id/cancel */
  async cancel({ params, response, auth, serialize }: HttpContext) {
    return this.act(params, response, serialize, (rollout) =>
      cancelRollout(rollout, auth.user?.id ?? null)
    )
  }

  private async act(
    params: Record<string, unknown>,
    response: HttpContext['response'],
    serialize: HttpContext['serialize'],
    action: (rollout: AgentUpdateRollout) => Promise<AgentUpdateRollout>
  ) {
    const rollout = await AgentUpdateRollout.find(Number(params.id))
    if (!rollout) return notFound(response, params.id)
    try {
      return serialize(await rolloutView(await action(rollout)))
    } catch (error) {
      if (error instanceof RolloutError) return refused(response, error)
      throw error
    }
  }
}

function notFound(response: HttpContext['response'], id: unknown) {
  return response.notFound({ error: 'rollout_not_found', message: `Rollout ${id} does not exist.` })
}

function refused(response: HttpContext['response'], error: RolloutError) {
  return response
    .status(error.status)
    .send({ error: error.code, message: error.message, ...error.extra })
}
