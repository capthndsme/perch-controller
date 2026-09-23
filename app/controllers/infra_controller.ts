import {
  InfraError,
  addPorts,
  bindNode,
  createLink,
  createNode,
  deleteLink,
  deleteNode,
  deletePort,
  loadLayout,
  loadState,
  savePositions,
  updateLink,
  updateNode,
  updatePort,
} from '#services/infra_topology'
import {
  addInfraPortsValidator,
  bindInfraNodeValidator,
  createInfraLinkValidator,
  createInfraNodeValidator,
  saveInfraPositionsValidator,
  updateInfraLinkValidator,
  updateInfraNodeValidator,
  updateInfraPortValidator,
} from '#validators/infra'
import type { HttpContext } from '@adonisjs/core/http'

/** Keys `PATCH /infra/nodes/:id` refuses: kind is fixed, binding has its own endpoint. */
const FIXED_NODE_FIELDS = ['kind', 'collectorId', 'apId'] as const

/**
 * The infrastructure view (docs/infrastructure-view.md section 7): the
 * network map's devices, ports and cables. Reads are open to every signed-in
 * user; writes are admin-only (the routes add `requireAdmin`), because the
 * layout is shared work and binding touches agent rows. Refusals carry the
 * codes of the design's Appendix B.
 */
export default class InfraController {
  /**
   * GET /api/v1/infra/layout
   *
   * Every node (agent nodes are created on the way), port and cable, the
   * kinds catalog and the limits. Read from the database per request.
   */
  async layout({ serialize }: HttpContext) {
    return serialize(await loadLayout())
  }

  /**
   * GET /api/v1/infra/state
   *
   * The live part the page polls every 5 s: node status, port LEDs and cable
   * state, derived per request from the agents' reports and sessions.
   */
  async state({ serialize }: HttpContext) {
    return serialize(await loadState())
  }

  /**
   * POST /api/v1/infra/nodes — `{ node, link }`: with `linkTo` the new node
   * is cabled in the same transaction (`link`, else null), and a refused
   * cable leaves nothing behind.
   */
  async createNode({ request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createInfraNodeValidator)
    try {
      const { node, link } = await createNode(payload)
      response.status(201)
      return serialize({ node, link })
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** PATCH /api/v1/infra/nodes/:id — omitted keys keep their value, `null` clears. */
  async updateNode({ params, request, response, serialize }: HttpContext) {
    const body = request.body()
    const fixed = FIXED_NODE_FIELDS.find((field) => body[field] !== undefined)
    if (fixed) {
      return response.unprocessableEntity({
        error: 'infra_field_not_applicable',
        message:
          fixed === 'kind'
            ? 'The kind of a node is fixed when it is created.'
            : 'Bind a node with POST /api/v1/infra/nodes/:id/bind.',
        field: fixed,
      })
    }
    const payload = await request.validateUsing(updateInfraNodeValidator)
    try {
      return serialize({ node: await updateNode(Number(params.id), payload) })
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** DELETE /api/v1/infra/nodes/:id — a bound node refuses (hide it instead). */
  async destroyNode({ params, response }: HttpContext) {
    try {
      await deleteNode(Number(params.id))
      return response.noContent()
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** POST /api/v1/infra/nodes/:id/bind — `{ apId }` or `{ collectorId }`. */
  async bindNode({ params, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(bindInfraNodeValidator)
    if (payload.apId !== undefined && payload.collectorId !== undefined) {
      return response.unprocessableEntity({
        errors: [
          {
            field: 'collectorId',
            message: 'Give either apId or collectorId, not both.',
            rule: 'prohibited',
          },
        ],
      })
    }
    const target =
      payload.apId !== undefined
        ? { type: 'ap' as const, id: payload.apId }
        : { type: 'collector' as const, id: payload.collectorId! }
    try {
      return serialize(await bindNode(Number(params.id), target))
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** POST /api/v1/infra/nodes/:id/ports — ports pinned by hand. */
  async addPorts({ params, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(addInfraPortsValidator)
    try {
      const ports = await addPorts(Number(params.id), payload.ports)
      response.status(201)
      return serialize({ ports })
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** PATCH /api/v1/infra/ports/:id */
  async updatePort({ params, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(updateInfraPortValidator)
    try {
      return serialize({ port: await updatePort(Number(params.id), payload) })
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** DELETE /api/v1/infra/ports/:id — its cable goes with it. */
  async destroyPort({ params, response }: HttpContext) {
    try {
      await deletePort(Number(params.id))
      return response.noContent()
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** POST /api/v1/infra/links */
  async createLink({ request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createInfraLinkValidator)
    try {
      const link = await createLink(payload)
      response.status(201)
      return serialize({ link })
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** PATCH /api/v1/infra/links/:id — moves an end, edits medium, label, notes. */
  async updateLink({ params, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(updateInfraLinkValidator)
    try {
      return serialize({ link: await updateLink(Number(params.id), payload) })
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** DELETE /api/v1/infra/links/:id */
  async destroyLink({ params, response }: HttpContext) {
    try {
      await deleteLink(Number(params.id))
      return response.noContent()
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** PUT /api/v1/infra/positions — many nodes in one transaction. */
  async savePositions({ request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(saveInfraPositionsValidator)
    try {
      return serialize({ updated: await savePositions(payload.positions) })
    } catch (error) {
      return refusal(response, error)
    }
  }
}

/** Sends a service refusal as is; anything else is a real error. */
function refusal(response: HttpContext['response'], error: unknown) {
  if (error instanceof InfraError) return response.status(error.status).send(error.body)
  throw error
}
