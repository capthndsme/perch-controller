import { idParam, portalUserNotFound } from '#services/portal_errors'
import {
  createPortalUser,
  deletePortalUser,
  listPortalUsers,
  setPortalUserPassword,
  updatePortalUser,
} from '#services/portal_users_admin'
import {
  createPortalUserValidator,
  portalUserPasswordValidator,
  updatePortalUserValidator,
} from '#validators/portal'
import type { HttpContext } from '@adonisjs/core/http'

/** Portal users (docs/gateway/portal.md section 11.4), admin-only. */
export default class PortalUsersController {
  /** GET /api/v1/portal/users */
  async index() {
    return { data: await listPortalUsers() }
  }

  /** POST /api/v1/portal/users */
  async store({ request, response }: HttpContext) {
    const payload = await request.validateUsing(createPortalUserValidator)
    response.status(201)
    return { data: await createPortalUser(payload) }
  }

  /** PATCH /api/v1/portal/users/:id */
  async update({ params, request }: HttpContext) {
    const id = idParam(params.id, portalUserNotFound)
    const payload = await request.validateUsing(updatePortalUserValidator)
    return { data: await updatePortalUser(id, payload) }
  }

  /** PUT /api/v1/portal/users/:id/password */
  async password({ params, request, response }: HttpContext) {
    const id = idParam(params.id, portalUserNotFound)
    const { password } = await request.validateUsing(portalUserPasswordValidator)
    await setPortalUserPassword(id, password)
    return response.noContent()
  }

  /** DELETE /api/v1/portal/users/:id */
  async destroy({ params, response }: HttpContext) {
    await deletePortalUser(idParam(params.id, portalUserNotFound))
    return response.noContent()
  }
}
