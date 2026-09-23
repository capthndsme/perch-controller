import { planeRefusal } from '#controllers/gateways_controller'
import GatewayApply from '#models/gateway_apply'
import {
  applyLabelNames,
  createDnsRecord,
  deleteDeviceReservation,
  deleteDnsRecord,
  dnsOverview,
  getDeviceReservation,
  pendingLabelNames,
  putDeviceReservation,
  setDnsLabelPolicy,
  updateDnsRecord,
} from '#services/gateway_config/device_names'
import { findGateway } from '#services/gateway_config/gateway_config_service'
import { applyViewOf } from '#transformers/gateway_transformer'
import {
  deviceGatewayValidator,
  deviceReservationValidator,
  dnsRecordPatchValidator,
  dnsRecordValidator,
  labelNamesApplyValidator,
} from '#validators/gateways'
import {
  dnsSettings,
  hasSettingsPatch,
  updateDnsSettings,
} from '#services/gateway_config/dns_service'
import { dnsSettingsPatchValidator } from '#validators/gateway_native'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * The first managed domains (README M3; plan 2 sections 4.1, 4.2, 5): a
 * device's DHCP reservation and DNS name from the device page, local DNS
 * records, and label names in DNS under review (README 7.10). Writes go into
 * the draft through `editSections` and, unless `?apply=0`, straight into an
 * apply of the touched sections; the response carries that apply (or why it
 * could not start: `applyError`).
 */

function applyFlag(request: HttpContext['request']): boolean {
  const value = request.input('apply')
  if (value === undefined || value === null) return true
  return !['0', 'false', false, 0].includes(value)
}

async function withApplyView<T extends { apply: unknown }>(result: T) {
  return {
    ...result,
    apply:
      result.apply instanceof GatewayApply
        ? await applyViewOf(result.apply, { changes: true })
        : null,
  }
}

export default class GatewayNamesController {
  /** GET /api/v1/devices/:mac/reservation?gatewayId= */
  async showReservation({ params, request, response, serialize }: HttpContext) {
    const { gatewayId } = await deviceGatewayValidator.validate(request.qs())
    try {
      return serialize(await getDeviceReservation(params.mac, gatewayId))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** PUT /api/v1/devices/:mac/reservation */
  async putReservation({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(deviceReservationValidator)
    try {
      const result = await putDeviceReservation(params.mac, auth.getUserOrFail().id, {
        ...payload,
        apply: applyFlag(request),
      })
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** DELETE /api/v1/devices/:mac/reservation */
  async deleteReservation({ params, request, response, auth, serialize }: HttpContext) {
    const { gatewayId } = await request.validateUsing(deviceGatewayValidator)
    try {
      const result = await deleteDeviceReservation(params.mac, auth.getUserOrFail().id, {
        gatewayId,
        apply: applyFlag(request),
      })
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /**
   * GET /api/v1/gateways/:id/dns: records, names and label names
   * (`dnsOverview`) plus the resolver settings (`settings`,
   * docs/gateway/native-sync.md section 3).
   */
  async dns({ params, response, serialize }: HttpContext) {
    try {
      const id = Number(params.id)
      return serialize({ ...(await dnsOverview(id)), settings: await dnsSettings(id) })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /**
   * PATCH /api/v1/gateways/:id/dns `{labelNames?, …settings}`: the label-name
   * policy and/or the resolver settings (one dnsmasq instance, Perch's items
   * only). Answers the GET shape plus `issues`, `apply`, `applyError`.
   */
  async updateDns({ params, request, response, auth, serialize }: HttpContext) {
    const { labelNames, ...patch } = await request.validateUsing(dnsSettingsPatchValidator)
    try {
      const id = Number(params.id)
      const userId = auth.getUserOrFail().id
      if (labelNames === undefined && !hasSettingsPatch(patch)) {
        return response.unprocessableEntity({
          error: 'nothing_to_change',
          message: 'Send labelNames or a DNS setting.',
        })
      }
      let write: { issues: unknown[]; apply: unknown; applyError: unknown } = {
        issues: [],
        apply: null,
        applyError: null,
      }
      if (hasSettingsPatch(patch)) {
        const result = await updateDnsSettings(id, userId, { ...patch, apply: applyFlag(request) })
        write = await withApplyView(result)
      }
      if (labelNames !== undefined) await setDnsLabelPolicy(id, userId, labelNames)
      return serialize({
        ...(await dnsOverview(id)),
        settings: await dnsSettings(id),
        issues: write.issues,
        apply: write.apply,
        applyError: write.applyError,
      })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/dns/records */
  async createRecord({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(dnsRecordValidator)
    try {
      const result = await createDnsRecord(Number(params.id), auth.getUserOrFail().id, {
        ...payload,
        apply: applyFlag(request),
      })
      response.status(201)
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** PATCH /api/v1/gateways/:id/dns/records/:perchId */
  async updateRecord({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(dnsRecordPatchValidator)
    try {
      const result = await updateDnsRecord(
        Number(params.id),
        auth.getUserOrFail().id,
        params.perchId,
        { ...payload, apply: applyFlag(request) }
      )
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** DELETE /api/v1/gateways/:id/dns/records/:perchId */
  async deleteRecord({ params, request, response, auth, serialize }: HttpContext) {
    try {
      const result = await deleteDnsRecord(
        Number(params.id),
        auth.getUserOrFail().id,
        params.perchId,
        { apply: applyFlag(request) }
      )
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** GET /api/v1/gateways/:id/dns/label-names */
  async labelNames({ params, response, serialize }: HttpContext) {
    try {
      const gateway = await findGateway(Number(params.id))
      return serialize({
        policy: gateway.dnsLabelNames === 'off' ? 'off' : 'review',
        pending: gateway.dnsLabelNames === 'off' ? [] : await pendingLabelNames(gateway),
      })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/dns/label-names/apply {macs?} */
  async applyLabelNames({ params, request, response, auth, serialize }: HttpContext) {
    const { macs } = await request.validateUsing(labelNamesApplyValidator)
    try {
      const result = await applyLabelNames(Number(params.id), auth.getUserOrFail().id, {
        macs,
        apply: applyFlag(request),
      })
      return serialize(await withApplyView(result))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }
}
