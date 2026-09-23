import {
  deleteDeviceLabel,
  deviceTypeCatalog,
  getDeviceLabel,
  listDeviceLabels,
  listDeviceTags,
  normalizeMac,
  saveDeviceLabel,
} from '#services/device_labels'
import { deviceLabelUpdateValidator } from '#validators/device_labels'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Operator-supplied device identity: personal name, device type, how it
 * attaches (Ethernet, when marked), tags and notes. Writes are open to every
 * signed-in user (same audience as the read API) — naming a device is an
 * annotation, not a configuration change, and an operator looking at the
 * dashboard is exactly who knows which laptop is whose.
 */
export default class DeviceLabelsController {
  /**
   * GET /api/v1/devices/labels
   *
   * The whole labelling state in one request: stored labels, the tags in use
   * (filter options + input autocomplete) and the device-type catalog. Small
   * enough to fetch once and keep in the client cache.
   */
  async index({ serialize }: HttpContext) {
    const [labels, tags] = await Promise.all([listDeviceLabels(), listDeviceTags()])

    return serialize({
      types: deviceTypeCatalog(),
      tags,
      labels,
    })
  }

  /**
   * GET /api/v1/devices/:mac/label
   */
  async show({ params, response, serialize }: HttpContext) {
    const mac = normalizeMac(params.mac)
    if (!mac) return response.badRequest(invalidMac(params.mac))

    return serialize({ mac, label: await getDeviceLabel(mac) })
  }

  /**
   * PATCH /api/v1/devices/:mac/label
   *
   * Merge semantics: omitted fields keep their stored value, `null` clears
   * one. A label with nothing left in it is deleted, so `label` comes back
   * `null` — the same shape a never-labelled device returns.
   */
  async update({ auth, params, request, response, serialize }: HttpContext) {
    const mac = normalizeMac(params.mac)
    if (!mac) return response.badRequest(invalidMac(params.mac))

    const payload = await request.validateUsing(deviceLabelUpdateValidator)
    const label = await saveDeviceLabel(mac, payload, auth.user?.id ?? null)

    return serialize({ mac, label })
  }

  /**
   * DELETE /api/v1/devices/:mac/label
   */
  async destroy({ params, response }: HttpContext) {
    const mac = normalizeMac(params.mac)
    if (!mac) return response.badRequest(invalidMac(params.mac))

    await deleteDeviceLabel(mac)
    return response.status(204)
  }
}

function invalidMac(raw: unknown) {
  return {
    error: 'invalid_mac',
    message: `${String(raw)} is not a MAC address.`,
  }
}
