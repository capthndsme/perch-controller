import { QosPolicySchema } from '#database/schema'

export const QOS_FAIRNESS = ['per_host', 'per_flow'] as const
export type QosFairness = (typeof QOS_FAIRNESS)[number]

export const QOS_SOURCES = ['admin', 'portal'] as const
export type QosSource = (typeof QOS_SOURCES)[number]

/**
 * A QoS policy (docs/gateway/qos.md section 4): an optional shared bucket
 * (`shared*`), an optional per-member cap (`each*`), fairness, the LAN
 * toggle (owner decision 13) and an optional parent bucket (decision 16).
 * Rates are kbit/s; a NULL pair = no such part, 0 = unlimited that way.
 */
export default class QosPolicy extends QosPolicySchema {}
