import {
  createApiClient,
  listApiClients,
  revokeApiClient,
  rotateApiClient,
  updateApiClient,
} from '#services/portal_api_clients'
import { apiClientNotFound, idParam } from '#services/portal_errors'
import { createApiClientValidator, updateApiClientValidator } from '#validators/portal'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Integration tokens of the authorize API (docs/gateway/portal.md section
 * 11.6), admin-only. A token is in the answer of create and rotate only
 * (`Cache-Control: no-store`).
 */
export default class PortalApiClientsController {
  /** GET /api/v1/portal/api-clients */
  async index() {
    return { data: await listApiClients() }
  }

  /** POST /api/v1/portal/api-clients */
  async store({ auth, request, response }: HttpContext) {
    const payload = await request.validateUsing(createApiClientValidator)
    const result = await createApiClient(payload, auth.user?.id ?? null)
    response.header('Cache-Control', 'no-store')
    response.status(201)
    return { data: result }
  }

  /** PATCH /api/v1/portal/api-clients/:id */
  async update({ params, request }: HttpContext) {
    const id = idParam(params.id, apiClientNotFound)
    const payload = await request.validateUsing(updateApiClientValidator)
    return { data: await updateApiClient(id, payload) }
  }

  /** POST /api/v1/portal/api-clients/:id/rotate */
  async rotate({ params, response }: HttpContext) {
    const result = await rotateApiClient(idParam(params.id, apiClientNotFound))
    response.header('Cache-Control', 'no-store')
    return { data: result }
  }

  /** DELETE /api/v1/portal/api-clients/:id (revokes; the row stays for the audit) */
  async destroy({ params, response }: HttpContext) {
    await revokeApiClient(idParam(params.id, apiClientNotFound))
    return response.noContent()
  }
}
