import {
  addDeviceGroupMember,
  createDeviceGroup,
  createDeviceGroupKey,
  deleteDeviceGroup,
  deleteDeviceGroupKey,
  deviceGroupOf,
  getDeviceGroup,
  isGroupRefusal,
  listDeviceGroups,
  removeDeviceGroupMember,
  revealDeviceGroupKey,
  updateDeviceGroup,
} from '#services/device_groups'
import {
  deviceGroupSettingsView,
  getDeviceGroupSettings,
  isValidSsid,
  updateDeviceGroupSettings,
} from '#services/device_group_settings'
import { planeRefusal } from '#controllers/gateways_controller'
import { GatewayPlaneError } from '#services/gateway_config/errors'
import {
  addMemberValidator,
  createDeviceGroupValidator,
  createKeyValidator,
  deviceGroupOfQueryValidator,
  deviceGroupSettingsValidator,
  deviceGroupsQueryValidator,
  updateDeviceGroupValidator,
} from '#validators/device_groups'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Device groups (docs/gateway/device-groups.md section 3). Reads for every
 * signed-in user, writes admin-only (routes).
 */

function refusal(response: HttpContext['response'], error: unknown) {
  if (isGroupRefusal(error)) return response.status(error.status).send(error.body)
  if (error instanceof GatewayPlaneError) return planeRefusal(response, error)
  throw error
}

function groupId(params: Record<string, unknown>): number {
  const n = Number(params.id)
  return Number.isInteger(n) && n > 0 ? n : 0
}

export default class DeviceGroupsController {
  /** GET /api/v1/device-groups?gatewayId= */
  async index({ request, response }: HttpContext) {
    const { gatewayId } = await deviceGroupsQueryValidator.validate(request.qs())
    try {
      return { data: await listDeviceGroups({ gatewayId }) }
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** GET /api/v1/device-groups/:id */
  async show({ params, response }: HttpContext) {
    try {
      return { data: await getDeviceGroup(groupId(params)) }
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** POST /api/v1/device-groups */
  async store({ auth, request, response }: HttpContext) {
    const { gatewayId, collectorId, ...input } = await request.validateUsing(
      createDeviceGroupValidator
    )
    try {
      const group = await createDeviceGroup({ gatewayId, collectorId }, input, {
        userId: auth.user?.id ?? null,
      })
      response.status(201)
      return { data: group }
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** PATCH /api/v1/device-groups/:id */
  async update({ auth, params, request, response }: HttpContext) {
    const input = await request.validateUsing(updateDeviceGroupValidator)
    try {
      return {
        data: await updateDeviceGroup(groupId(params), input, { userId: auth.user?.id ?? null }),
      }
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** DELETE /api/v1/device-groups/:id */
  async destroy({ auth, params, response }: HttpContext) {
    try {
      await deleteDeviceGroup(groupId(params), { userId: auth.user?.id ?? null })
      return response.noContent()
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** POST /api/v1/device-groups/:id/members `{mac, move?}` */
  async addMember({ auth, params, request, response }: HttpContext) {
    const { mac, move } = await request.validateUsing(addMemberValidator)
    try {
      const result = await addDeviceGroupMember(
        groupId(params),
        mac,
        { move },
        { userId: auth.user?.id ?? null }
      )
      response.status(201)
      return { data: { ...result, group: await getDeviceGroup(groupId(params)) } }
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** DELETE /api/v1/device-groups/:id/members/:mac */
  async removeMember({ auth, params, response }: HttpContext) {
    try {
      await removeDeviceGroupMember(groupId(params), String(params.mac), {
        userId: auth.user?.id ?? null,
      })
      return response.noContent()
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** POST /api/v1/device-groups/:id/keys `{label, passphrase?}` */
  async createKey({ auth, params, request, response }: HttpContext) {
    const input = await request.validateUsing(createKeyValidator)
    try {
      const created = await createDeviceGroupKey(groupId(params), input, {
        userId: auth.user?.id ?? null,
      })
      response.status(201)
      return { data: created }
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** GET /api/v1/device-groups/:id/keys/:keyId/passphrase */
  async revealKey({ params, response }: HttpContext) {
    try {
      return { data: await revealDeviceGroupKey(groupId(params), Number(params.keyId)) }
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** DELETE /api/v1/device-groups/:id/keys/:keyId */
  async destroyKey({ auth, params, response }: HttpContext) {
    try {
      await deleteDeviceGroupKey(groupId(params), Number(params.keyId), {
        userId: auth.user?.id ?? null,
      })
      return response.noContent()
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** GET /api/v1/devices/:mac/group?gatewayId= */
  async deviceGroup({ params, request, response }: HttpContext) {
    const { gatewayId } = await deviceGroupOfQueryValidator.validate(request.qs())
    try {
      return { data: await deviceGroupOf(String(params.mac), gatewayId) }
    } catch (error) {
      return refusal(response, error)
    }
  }

  /** GET /api/v1/settings/device-groups */
  async settings() {
    return { data: deviceGroupSettingsView(await getDeviceGroupSettings()) }
  }

  /** PATCH /api/v1/settings/device-groups */
  async updateSettings({ request, response }: HttpContext) {
    const input = await request.validateUsing(deviceGroupSettingsValidator)
    const bad = (input.ssids ?? []).find((s) => !isValidSsid(s))
    if (bad !== undefined) {
      return response.unprocessableEntity({
        error: 'ssid_invalid',
        message: `"${bad}" is not a usable SSID (1-32 bytes, no control characters).`,
        field: 'ssids',
      })
    }
    return { data: deviceGroupSettingsView(await updateDeviceGroupSettings(input)) }
  }
}
