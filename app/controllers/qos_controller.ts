import { QosError } from '#services/qos_gateway'
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
  createWanQueueValidator,
  qosAssignmentsQueryValidator,
  qosGatewayQueryValidator,
  updateWanQueueValidator,
} from '#validators/qos'
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
}

function refusal(response: HttpContext['response'], error: unknown) {
  if (error instanceof QosError) return response.status(error.status).send(error.body)
  throw error
}
