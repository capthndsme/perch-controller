import { grantNotFound, idParam } from '#services/portal_errors'
import { extendGrant, listGrants, listSessions, revokeGrant } from '#services/portal_grant_admin'
import { page, parseIsoTime } from '#services/portal_params'
import {
  extendGrantValidator,
  grantListQueryValidator,
  sessionListQueryValidator,
} from '#validators/portal'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Grants and sessions (docs/gateway/portal.md section 11.4). Lists: any
 * signed-in user. Extend and revoke: admins.
 */
export default class PortalGrantsController {
  /** GET /api/v1/portal/grants */
  async index({ request }: HttpContext) {
    const qs = await grantListQueryValidator.validate(request.qs())
    return { data: await listGrants({ ...qs, ...page(qs) }) }
  }

  /** POST /api/v1/portal/grants/:id/extend {minutes?, bytes?} */
  async extend({ params, request }: HttpContext) {
    const id = idParam(params.id, grantNotFound)
    const payload = await request.validateUsing(extendGrantValidator)
    return { data: await extendGrant(id, payload) }
  }

  /** POST /api/v1/portal/grants/:id/revoke */
  async revoke({ params }: HttpContext) {
    return { data: await revokeGrant(idParam(params.id, grantNotFound)) }
  }

  /** GET /api/v1/portal/sessions */
  async sessions({ request }: HttpContext) {
    const qs = await sessionListQueryValidator.validate(request.qs())
    return {
      data: await listSessions({
        ...qs,
        from: parseIsoTime(qs.from, 'from'),
        to: parseIsoTime(qs.to, 'to'),
        ...page(qs),
      }),
    }
  }
}
