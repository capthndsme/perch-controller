import { QosError, resolveGateway } from '#services/qos_gateway'
import { listAssignments, listGroups, listPolicies, listSchedules } from '#services/qos_reads'
import {
  createWanQueue,
  deleteWanQueue,
  listWanQueues,
  updateWanQueue,
} from '#services/qos_wan_queues'
import QosViewTransformer from '#transformers/qos_view_transformer'
import QosWanQueueTransformer from '#transformers/qos_wan_queue_transformer'
import {
  createAssignmentValidator,
  createGroupValidator,
  createPolicyValidator,
  createScheduleValidator,
  createWanQueueValidator,
  qosAssignmentsQueryValidator,
  qosDevicesQueryValidator,
  qosGatewayQueryValidator,
  qosPauseValidator,
  updateAssignmentValidator,
  updateGroupValidator,
  updatePolicyValidator,
  updateScheduleValidator,
  updateWanQueueValidator,
} from '#validators/qos'
import { listDeviceShaping, qosOverview } from '#services/qos_views'
import {
  createAssignment,
  createGroup,
  createPolicy,
  createSchedule,
  deleteAssignment,
  deleteGroup,
  deletePolicy,
  deleteSchedule,
  resetAssignmentQuota,
  setQosPaused,
  updateAssignment,
  updateGroup,
  updatePolicy,
  updateSchedule,
} from '#services/qos_writes'
import QosGatewayState from '#models/qos_gateway_state'
import { qosLive, routerPaused } from '#services/qos_live'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Traffic shaping (docs/gateway/qos.md section 5). Reads are open to every
 * signed-in user (owner decision 16: operators see every cap, bucket and
 * schedule); writes are admin-only (the routes add `requireAdmin`). Router
 * writes go through the config plane (`sqm_plane.ts`); until its apply path
 * exists they answer 409 `plane_unavailable` with the intended change.
 */
export default class QosController {
  /** GET /api/v1/qos/wan-queues?gatewayId=|collectorId= */
  async wanQueues({ request, response, serialize }: HttpContext) {
    const query = await qosGatewayQueryValidator.validate(request.qs())
    try {
      return serialize(QosWanQueueTransformer.transform(await listWanQueues(query)))
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** POST /api/v1/qos/wan-queues → 201 `{ queue, warnings }`. */
  async createWanQueue({ auth, request, response, serialize }: HttpContext) {
    const { gatewayId, collectorId, ...input } =
      await request.validateUsing(createWanQueueValidator)
    try {
      const { record, warnings } = await createWanQueue(
        { gatewayId, collectorId },
        input,
        auth.user?.id ?? null
      )
      response.status(201)
      return serialize({ queue: QosWanQueueTransformer.transform(record), warnings })
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** PATCH /api/v1/qos/wan-queues/:id → `{ queue, warnings }`. */
  async updateWanQueue({ auth, params, request, response, serialize }: HttpContext) {
    const body = request.body()
    for (const field of ['gatewayId', 'collectorId'] as const) {
      if (body[field] !== undefined) {
        return response.unprocessableEntity({
          error: 'qos_field_not_applicable',
          message: 'A queue stays on its gateway; delete it and create one on the other.',
          field,
        })
      }
    }
    const patch = await request.validateUsing(updateWanQueueValidator)
    try {
      const { record, warnings } = await updateWanQueue(
        Number(params.id),
        patch,
        auth.user?.id ?? null
      )
      return serialize({ queue: QosWanQueueTransformer.transform(record), warnings })
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** DELETE /api/v1/qos/wan-queues/:id → 204. */
  async destroyWanQueue({ auth, params, response }: HttpContext) {
    try {
      await deleteWanQueue(Number(params.id), auth.user?.id ?? null)
      return response.noContent()
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** GET /api/v1/qos/policies?gatewayId=|collectorId= */
  async policies({ request, response, serialize }: HttpContext) {
    const query = await qosGatewayQueryValidator.validate(request.qs())
    try {
      return serialize(QosViewTransformer.transform(await listPolicies(query)))
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** GET /api/v1/qos/groups?gatewayId=|collectorId= */
  async groups({ request, response, serialize }: HttpContext) {
    const query = await qosGatewayQueryValidator.validate(request.qs())
    try {
      return serialize(QosViewTransformer.transform(await listGroups(query)))
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** GET /api/v1/qos/assignments?gatewayId=|collectorId=&policyId=&mac=&source= */
  async assignments({ request, response, serialize }: HttpContext) {
    const query = await qosAssignmentsQueryValidator.validate(request.qs())
    try {
      return serialize(QosViewTransformer.transform(await listAssignments(query)))
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** GET /api/v1/qos/schedules?gatewayId=|collectorId= */
  async schedules({ request, response, serialize }: HttpContext) {
    const query = await qosGatewayQueryValidator.validate(request.qs())
    try {
      return serialize(QosViewTransformer.transform(await listSchedules(query)))
    } catch (error) {
      return refusal(response, error)
    }
  }
  // -------------------------------------------------------------------------
  // Live (WP-D)

  /** GET /api/v1/qos?gatewayId=|collectorId= → `QosOverview`. */
  async overview({ request, response, serialize }: HttpContext) {
    const query = await qosGatewayQueryValidator.validate(request.qs())
    try {
      const { wan, ...overview } = await qosOverview(query)
      return serialize({ ...overview, wan: QosWanQueueTransformer.transform(wan) })
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** GET /api/v1/qos/devices?gatewayId=|collectorId=&mac= → `DeviceShaping[]`. */
  async devices({ request, response, serialize }: HttpContext) {
    const { mac, ...query } = await qosDevicesQueryValidator.validate(request.qs())
    try {
      const rows = await listDeviceShaping(query)
      return serialize(QosViewTransformer.transform(mac ? rows.filter((r) => r.mac === mac) : rows))
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** POST /api/v1/qos/pause → `QosOverview`. */
  async pause(ctx: HttpContext) {
    return this.#setPaused(ctx, true)
  }

  /** POST /api/v1/qos/resume (`overrideRouter` resumes over a router-side pause) → `QosOverview`. */
  async resume(ctx: HttpContext) {
    return this.#setPaused(ctx, false)
  }

  async #setPaused({ auth, request, response, serialize }: HttpContext, paused: boolean) {
    const { overrideRouter, ...ref } = await request.validateUsing(qosPauseValidator)
    try {
      const { gateway } = await resolveGateway(ref)
      const report = qosLive(gateway.collectorId)?.report ?? null
      const state = await QosGatewayState.findBy('gatewayId', gateway.id)
      const byRouter = routerPaused(report, Boolean(state?.pausedAt))
      await setQosPaused(ref, paused, {
        userId: auth.user?.id ?? null,
        overrideRouter,
        routerPausedAt: byRouter ? new Date().toISOString() : null,
      })
      const { wan, ...overview } = await qosOverview(ref)
      return serialize({ ...overview, wan: QosWanQueueTransformer.transform(wan) })
    } catch (error) {
      return refusal(response, error)
    }
  }

  // -------------------------------------------------------------------------
  // Writes (WP-C): admin-only (the routes add requireAdmin)

  /** POST /api/v1/qos/policies → 201 `QosPolicy`. */
  async createPolicy({ auth, request, response, serialize }: HttpContext) {
    const { gatewayId, collectorId, ...input } = await request.validateUsing(createPolicyValidator)
    return this.#write(response, serialize, 201, () =>
      createPolicy({ gatewayId, collectorId }, input, { userId: auth.user?.id ?? null })
    )
  }

  /** PATCH /api/v1/qos/policies/:id → `QosPolicy`. */
  async updatePolicy({ auth, params, request, response, serialize }: HttpContext) {
    const fixed = fixedFields(request.body(), ['gatewayId', 'collectorId'])
    if (fixed) return response.unprocessableEntity(fixed)
    const input = await request.validateUsing(updatePolicyValidator)
    return this.#write(response, serialize, 200, () =>
      updatePolicy(Number(params.id), input, { userId: auth.user?.id ?? null })
    )
  }

  /** DELETE /api/v1/qos/policies/:id → 204 (409 `qos_policy_in_use`). */
  async destroyPolicy({ auth, params, response }: HttpContext) {
    return this.#destroy(response, () =>
      deletePolicy(Number(params.id), { userId: auth.user?.id ?? null })
    )
  }

  /** POST /api/v1/qos/groups → 201 `QosGroup`. */
  async createGroup({ auth, request, response, serialize }: HttpContext) {
    const { gatewayId, collectorId, ...input } = await request.validateUsing(createGroupValidator)
    return this.#write(response, serialize, 201, () =>
      createGroup({ gatewayId, collectorId }, input, { userId: auth.user?.id ?? null })
    )
  }

  /** PATCH /api/v1/qos/groups/:id `{name?, notes?, addMacs?, removeMacs?}` → `QosGroup`. */
  async updateGroup({ auth, params, request, response, serialize }: HttpContext) {
    const fixed = fixedFields(request.body(), ['gatewayId', 'collectorId', 'members'])
    if (fixed) return response.unprocessableEntity(fixed)
    const input = await request.validateUsing(updateGroupValidator)
    return this.#write(response, serialize, 200, () =>
      updateGroup(Number(params.id), input, { userId: auth.user?.id ?? null })
    )
  }

  /** DELETE /api/v1/qos/groups/:id → 204 (its assignment cascades). */
  async destroyGroup({ auth, params, response }: HttpContext) {
    return this.#destroy(response, () =>
      deleteGroup(Number(params.id), { userId: auth.user?.id ?? null })
    )
  }

  /** POST /api/v1/qos/assignments → 201 `QosAssignment`. */
  async createAssignment({ auth, request, response, serialize }: HttpContext) {
    const { gatewayId, collectorId, ...input } =
      await request.validateUsing(createAssignmentValidator)
    return this.#write(response, serialize, 201, () =>
      createAssignment({ gatewayId, collectorId }, input, { userId: auth.user?.id ?? null })
    )
  }

  /** PATCH /api/v1/qos/assignments/:id → `QosAssignment` (the target stays). */
  async updateAssignment({ auth, params, request, response, serialize }: HttpContext) {
    const fixed = fixedFields(request.body(), ['gatewayId', 'collectorId', 'target'])
    if (fixed) return response.unprocessableEntity(fixed)
    const input = await request.validateUsing(updateAssignmentValidator)
    return this.#write(response, serialize, 200, () =>
      updateAssignment(Number(params.id), input, { userId: auth.user?.id ?? null })
    )
  }

  /** DELETE /api/v1/qos/assignments/:id → 204. */
  async destroyAssignment({ auth, params, response }: HttpContext) {
    return this.#destroy(response, () =>
      deleteAssignment(Number(params.id), { userId: auth.user?.id ?? null })
    )
  }

  /** POST /api/v1/qos/assignments/:id/quota/reset → `QosAssignment`. */
  async resetQuota({ auth, params, response, serialize }: HttpContext) {
    return this.#write(response, serialize, 200, () =>
      resetAssignmentQuota(Number(params.id), { userId: auth.user?.id ?? null })
    )
  }

  /** POST /api/v1/qos/schedules → 201 `QosSchedule`. */
  async createSchedule({ auth, request, response, serialize }: HttpContext) {
    const { gatewayId, collectorId, ...input } =
      await request.validateUsing(createScheduleValidator)
    return this.#write(response, serialize, 201, () =>
      createSchedule({ gatewayId, collectorId }, input, { userId: auth.user?.id ?? null })
    )
  }

  /** PATCH /api/v1/qos/schedules/:id → `QosSchedule` (the target stays). */
  async updateSchedule({ auth, params, request, response, serialize }: HttpContext) {
    const fixed = fixedFields(request.body(), ['gatewayId', 'collectorId', 'target'])
    if (fixed) return response.unprocessableEntity(fixed)
    const input = await request.validateUsing(updateScheduleValidator)
    return this.#write(response, serialize, 200, () =>
      updateSchedule(Number(params.id), input, { userId: auth.user?.id ?? null })
    )
  }

  /** DELETE /api/v1/qos/schedules/:id → 204. */
  async destroySchedule({ auth, params, response }: HttpContext) {
    return this.#destroy(response, () =>
      deleteSchedule(Number(params.id), { userId: auth.user?.id ?? null })
    )
  }

  async #write(
    response: HttpContext['response'],
    serialize: HttpContext['serialize'],
    status: 200 | 201,
    run: () => Promise<Record<string, unknown>>
  ) {
    try {
      const view = await run()
      response.status(status)
      return serialize(QosViewTransformer.transform(view))
    } catch (error) {
      return refusal(response, error)
    }
  }

  async #destroy(response: HttpContext['response'], run: () => Promise<void>) {
    try {
      await run()
      return response.noContent()
    } catch (error) {
      return refusal(response, error)
    }
  }
}

/** 422 `qos_field_not_applicable` body when a PATCH names a field that cannot change. */
function fixedFields(body: Record<string, unknown>, fields: string[]) {
  const field = fields.find((name) => body[name] !== undefined)
  if (!field) return null
  return {
    error: 'qos_field_not_applicable',
    message: `${field} cannot change here; delete and create instead.`,
    field,
  }
}

function refusal(response: HttpContext['response'], error: unknown) {
  if (error instanceof QosError) return response.status(error.status).send(error.body)
  throw error
}
