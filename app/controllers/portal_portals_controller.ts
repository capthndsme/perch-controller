import Portal from '#models/portal'
import { sendPortalPushes } from '#services/portal_agent_sender'
import { idParam, portalNotFound } from '#services/portal_errors'
import {
  createPortal,
  deletePortal,
  listPortals,
  showPortal,
  updatePortal,
} from '#services/portal_portals'
import { runInPortalQueue } from '#services/portal_queue'
import { getPortalSettings, updatePortalSettings } from '#services/portal_settings'
import { portalSettingsView } from '#services/portal/settings'
import {
  createPortalValidator,
  deletePortalQueryValidator,
  portalListQueryValidator,
  updatePortalSettingsValidator,
  updatePortalValidator,
} from '#validators/portal'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Guest portals and their settings (docs/gateway/portal.md section 11.4).
 * Reads: any signed-in user. Writes: admins (the routes add `requireAdmin`).
 */
export default class PortalPortalsController {
  /** GET /api/v1/portal/portals?gatewayId= */
  async index({ request }: HttpContext) {
    const qs = await portalListQueryValidator.validate(request.qs())
    return { data: await listPortals(qs) }
  }

  /** GET /api/v1/portal/portals/:id */
  async show({ params }: HttpContext) {
    return { data: await showPortal(idParam(params.id, portalNotFound)) }
  }

  /** POST /api/v1/portal/portals */
  async store({ request, response }: HttpContext) {
    const payload = await request.validateUsing(createPortalValidator)
    const result = await createPortal(payload)
    response.status(201)
    return { data: result }
  }

  /** PATCH /api/v1/portal/portals/:id */
  async update({ params, request }: HttpContext) {
    const id = idParam(params.id, portalNotFound)
    const payload = await request.validateUsing(updatePortalValidator)
    return { data: await updatePortal(id, payload) }
  }

  /** DELETE /api/v1/portal/portals/:id?force=1 */
  async destroy({ params, request, response }: HttpContext) {
    const id = idParam(params.id, portalNotFound)
    const qs = await deletePortalQueryValidator.validate(request.qs())
    await deletePortal(id, Boolean(qs.force))
    return response.noContent()
  }

  /** GET /api/v1/settings/portal */
  async settings() {
    return { data: portalSettingsView(await getPortalSettings()) }
  }

  /**
   * PATCH /api/v1/settings/portal. The router side of several settings
   * (intervals, rate limits, the offline list) changes with them: every
   * gateway with a portal gets a full `sync`.
   */
  async updateSettings({ request }: HttpContext) {
    const payload = await request.validateUsing(updatePortalSettingsValidator)
    const settings = await updatePortalSettings(payload)
    const gatewayIds = await Portal.query().whereNull('deleted_at').distinct('gateway_id')
    for (const { gatewayId } of gatewayIds) {
      await runInPortalQueue(gatewayId, () => sendPortalPushes(gatewayId, [{ kind: 'sync' }]))
    }
    return { data: portalSettingsView(settings) }
  }
}
