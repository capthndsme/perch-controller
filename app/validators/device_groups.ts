import { DEVICE_GROUP_LIMITS } from '#services/device_group_settings'
import vine from '@vinejs/vine'

/**
 * Bodies and query strings of the device groups REST API
 * (docs/gateway/device-groups.md section 3). Shapes and ranges; what depends
 * on stored state (a network exists, a name or MAC is free) is refused by the
 * service.
 */

const id = () => vine.number().withoutDecimals().min(1)
const NETWORK_PERCH_ID_REGEX = /^[A-Za-z0-9._:-]{1,64}$/
const MAC_REGEX = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/
const kbit = () => vine.number().withoutDecimals().min(0).max(10_000_000).nullable()

const qos = () =>
  vine
    .object({
      policyId: id().nullable().optional(),
      rate: vine.object({ downloadKbit: kbit(), uploadKbit: kbit() }).nullable().optional(),
    })
    .nullable()

const fields = {
  name: vine.string().trim().minLength(1).maxLength(64),
  notes: vine.string().trim().maxLength(500).nullable().optional(),
  networkPerchId: vine.string().trim().regex(NETWORK_PERCH_ID_REGEX).nullable().optional(),
  internet: vine.boolean().optional(),
  portalBypass: vine.boolean().optional(),
  qos: qos().optional(),
}

export const deviceGroupsQueryValidator = vine.compile(vine.object({ gatewayId: id().optional() }))

export const createDeviceGroupValidator = vine.compile(
  vine.object({ gatewayId: id().optional(), collectorId: id().optional(), ...fields })
)

export const updateDeviceGroupValidator = vine.compile(
  vine.object({ ...fields, name: fields.name.optional() })
)

export const addMemberValidator = vine.compile(
  vine.object({ mac: vine.string().trim().regex(MAC_REGEX), move: vine.boolean().optional() })
)

export const createKeyValidator = vine.compile(
  vine.object({
    label: vine.string().trim().minLength(1).maxLength(64),
    passphrase: vine.string().minLength(8).maxLength(63).nullable().optional(),
  })
)

export const deviceGroupSettingsValidator = vine.compile(
  vine.object({
    ssids: vine
      .array(vine.string().minLength(1).maxLength(32))
      .maxLength(DEVICE_GROUP_LIMITS.ssids.max)
      .optional(),
    confirmSeconds: vine
      .number()
      .withoutDecimals()
      .min(DEVICE_GROUP_LIMITS.confirmSeconds.min)
      .max(DEVICE_GROUP_LIMITS.confirmSeconds.max)
      .optional(),
  })
)

/** A port name (`wan`, `lan1`, `eth0.2`), null = the AP detects it. */
export const apTrunkValidator = vine.compile(
  vine.object({
    trunk: vine
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._@-]{1,15}$/)
      .nullable(),
  })
)

export const deviceGroupOfQueryValidator = vine.compile(vine.object({ gatewayId: id().optional() }))
