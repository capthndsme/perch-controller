import {
  SQM_DIFFSERV,
  SQM_FAIRNESS,
  SQM_LINK_LAYERS,
  SQM_WRITABLE_QDISCS,
} from '#services/sqm_mapping'
import vine from '@vinejs/vine'

/** 100 Gbit/s in kbit/s: a sanity bound, not a policy. */
export const MAX_KBIT = 100_000_000

const kbit = () => vine.number().withoutDecimals().min(0).max(MAX_KBIT)
const device = () =>
  vine
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{0,14}$/)

/** Query of the QoS reads: which gateway (both optional with one gateway). */
export const qosGatewayQueryValidator = vine.compile(
  vine.object({
    gatewayId: vine.number().withoutDecimals().min(1).optional(),
    collectorId: vine.number().withoutDecimals().min(1).optional(),
  })
)

/**
 * Raw UCI options a queue carries that have no field (`tcMTU`, `ilimit`, …):
 * keys merge, `null` removes. Names and values are checked by the mapping
 * (a key with a typed field is refused there).
 */
const advanced = () => vine.record(vine.string().maxLength(255).nullable()).optional()

const queueFields = {
  enabled: vine.boolean().optional(),
  qdisc: vine.enum(SQM_WRITABLE_QDISCS).optional(),
  diffserv: vine.enum(SQM_DIFFSERV).optional(),
  fairness: vine.enum(SQM_FAIRNESS).optional(),
  nat: vine.boolean().optional(),
  linkLayer: vine.enum(SQM_LINK_LAYERS).optional(),
  overhead: vine.number().withoutDecimals().min(-64).max(256).nullable().optional(),
  mpu: vine.number().withoutDecimals().min(0).max(256).nullable().optional(),
  ingressEcn: vine.boolean().optional(),
  egressEcn: vine.boolean().optional(),
  squashDscp: vine.boolean().optional(),
  squashIngress: vine.boolean().optional(),
  advanced: advanced(),
}

/** POST /api/v1/qos/wan-queues. */
export const createWanQueueValidator = vine.compile(
  vine.object({
    gatewayId: vine.number().withoutDecimals().min(1).optional(),
    collectorId: vine.number().withoutDecimals().min(1).optional(),
    device: device(),
    downloadKbit: kbit(),
    uploadKbit: kbit(),
    ...queueFields,
  })
)

/** PATCH /api/v1/qos/wan-queues/:id: any subset. */
export const updateWanQueueValidator = vine.compile(
  vine.object({
    device: device().optional(),
    downloadKbit: kbit().optional(),
    uploadKbit: kbit().optional(),
    ...queueFields,
  })
)

/** Query of GET /api/v1/qos/assignments. */
export const qosAssignmentsQueryValidator = vine.compile(
  vine.object({
    gatewayId: vine.number().withoutDecimals().min(1).optional(),
    collectorId: vine.number().withoutDecimals().min(1).optional(),
    policyId: vine.number().withoutDecimals().min(1).optional(),
    mac: vine
      .string()
      .trim()
      .regex(/^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/)
      .transform((value) => value.toLowerCase().replace(/-/g, ':'))
      .optional(),
    source: vine.enum(['admin', 'portal'] as const).optional(),
  })
)

// ---------------------------------------------------------------------------
// Policies, groups, assignments, schedules (WP-C writes, docs/gateway/qos.md 5.2)

const MAC_PATTERN = /^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/
const macField = () =>
  vine
    .string()
    .trim()
    .regex(MAC_PATTERN)
    .transform((value) => value.toLowerCase().replace(/-/g, ':'))

/** A UCI interface name (`guest`, `lan`, `iot`). */
const networkField = () =>
  vine
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{1,32}$/)

const gatewayRef = {
  gatewayId: vine.number().withoutDecimals().min(1).optional(),
  collectorId: vine.number().withoutDecimals().min(1).optional(),
}

/** `QosRate`: kbit/s per direction, null (or 0) = unlimited that way. */
const qosRate = () =>
  vine.object({
    downloadKbit: kbit().nullable(),
    uploadKbit: kbit().nullable(),
  })

/** A schedule's override: null = keep the target's own value that way, 0 = unlimited. */
const qosOverride = () =>
  vine.object({
    downloadKbit: kbit().nullable().optional(),
    uploadKbit: kbit().nullable().optional(),
  })

const policyName = () => vine.string().trim().minLength(1).maxLength(64)
const notes = () => vine.string().trim().maxLength(500).nullable().optional()
const id = () => vine.number().withoutDecimals().min(1)

const policyFields = {
  notes: notes(),
  shared: qosRate().nullable().optional(),
  each: qosRate().nullable().optional(),
  fairness: vine.enum(['per_host', 'per_flow'] as const).optional(),
  includeLan: vine.boolean().optional(),
  parentPolicyId: id().nullable().optional(),
  enabled: vine.boolean().optional(),
}

/** POST /api/v1/qos/policies. */
export const createPolicyValidator = vine.compile(
  vine.object({ ...gatewayRef, name: policyName(), ...policyFields })
)

/** PATCH /api/v1/qos/policies/:id: any subset. */
export const updatePolicyValidator = vine.compile(
  vine.object({ name: policyName().optional(), ...policyFields })
)

/** At most this many MACs per group request (the router takes 4096 entries). */
export const MAX_GROUP_MACS = 4096

/** POST /api/v1/qos/groups. */
export const createGroupValidator = vine.compile(
  vine.object({
    ...gatewayRef,
    name: policyName(),
    notes: notes(),
    members: vine.array(macField()).maxLength(MAX_GROUP_MACS).optional(),
  })
)

/** PATCH /api/v1/qos/groups/:id. */
export const updateGroupValidator = vine.compile(
  vine.object({
    name: policyName().optional(),
    notes: notes(),
    addMacs: vine.array(macField()).maxLength(MAX_GROUP_MACS).optional(),
    removeMacs: vine.array(macField()).maxLength(MAX_GROUP_MACS).optional(),
  })
)

/** 1 TiB × 1024: a sanity bound on quotas, not a policy. */
export const MAX_QUOTA_BYTES = 2 ** 50

const quotaField = () =>
  vine
    .object({
      limitBytes: vine.number().withoutDecimals().min(1).max(MAX_QUOTA_BYTES),
      onExhausted: vine.enum(['block', 'throttle'] as const),
      throttle: qosRate().nullable().optional(),
    })
    .nullable()
    .optional()

const assignmentFields = {
  policyId: id().nullable().optional(),
  rate: qosRate().nullable().optional(),
  quota: quotaField(),
  /** ISO 8601 with an offset (`2026-09-24T18:00:00Z`); parsed by the service. */
  expiresAt: vine.string().trim().maxLength(40).nullable().optional(),
}

/** POST /api/v1/qos/assignments. `target` members are checked against `type` by the service. */
export const createAssignmentValidator = vine.compile(
  vine.object({
    ...gatewayRef,
    target: vine.object({
      type: vine.enum(['device', 'group', 'network'] as const),
      mac: macField().optional(),
      groupId: id().optional(),
      network: networkField().optional(),
    }),
    ...assignmentFields,
  })
)

/** PATCH /api/v1/qos/assignments/:id (the target stays). */
export const updateAssignmentValidator = vine.compile(vine.object({ ...assignmentFields }))

export const QOS_DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const minute = () => vine.number().withoutDecimals().min(0).max(1439)

const scheduleFields = {
  enabled: vine.boolean().optional(),
  usePolicyId: id().nullable().optional(),
  shared: qosOverride().nullable().optional(),
  each: qosOverride().nullable().optional(),
  rate: qosOverride().nullable().optional(),
  days: vine.array(vine.enum(QOS_DAY_NAMES)).minLength(1).maxLength(7).optional(),
  startMinute: minute().optional(),
  endMinute: minute().optional(),
}

/** POST /api/v1/qos/schedules. */
export const createScheduleValidator = vine.compile(
  vine.object({
    ...gatewayRef,
    name: policyName(),
    target: vine.object({
      type: vine.enum(['policy', 'assignment'] as const),
      policyId: id().optional(),
      assignmentId: id().optional(),
    }),
    action: vine.enum(['limit', 'unlimited', 'block', 'policy'] as const),
    ...scheduleFields,
    days: vine.array(vine.enum(QOS_DAY_NAMES)).minLength(1).maxLength(7),
    startMinute: minute(),
    endMinute: minute(),
  })
)

/** PATCH /api/v1/qos/schedules/:id (the target stays). */
export const updateScheduleValidator = vine.compile(
  vine.object({
    name: policyName().optional(),
    action: vine.enum(['limit', 'unlimited', 'block', 'policy'] as const).optional(),
    ...scheduleFields,
  })
)

/** POST /api/v1/qos/pause and /resume. */
export const qosPauseValidator = vine.compile(
  vine.object({ ...gatewayRef, overrideRouter: vine.boolean().optional() })
)

/** Query of GET /api/v1/qos/devices. */
export const qosDevicesQueryValidator = vine.compile(
  vine.object({ ...gatewayRef, mac: macField().optional() })
)
