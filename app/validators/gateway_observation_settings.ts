import { GATEWAY_OBSERVATION_LIMITS } from '#services/gateway_observation_settings'
import vine from '@vinejs/vine'

function days(key: keyof typeof GATEWAY_OBSERVATION_LIMITS) {
  const { min, max } = GATEWAY_OBSERVATION_LIMITS[key]
  return vine.number().withoutDecimals().min(min).max(max).optional()
}

/** PATCH /api/v1/settings/gateway-observations: any subset; the rest keep their value. */
export const updateGatewayObservationSettingsValidator = vine.compile(
  vine.object({
    hostRetentionDays: days('hostRetentionDays'),
    upnpEventRetentionDays: days('upnpEventRetentionDays'),
    backupsKept: days('backupsKept'),
  })
)

/** POST /api/v1/gateways/:gatewayId/observe. */
export const observeRequestValidator = vine.compile(
  vine.object({
    parts: vine
      .array(
        vine.enum([
          'interfaces',
          'neighbors',
          'dhcp',
          'upnp',
          'mwan3',
          'resolver',
          'system',
          'wireguard',
          'packages',
        ] as const)
      )
      .maxLength(16)
      .distinct()
      .optional(),
  })
)

/** POST /api/v1/gateways/:gatewayId/backups. */
export const createBackupValidator = vine.compile(
  vine.object({
    note: vine.string().trim().maxLength(200).optional(),
    // false asks for the router's secrets too; the router must allow it (`gateway_backup full`).
    redact: vine.boolean().optional(),
  })
)
