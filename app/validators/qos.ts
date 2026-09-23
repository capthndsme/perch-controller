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
