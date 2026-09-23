import { QosAssignmentSchema } from '#database/schema'

export const QOS_TARGET_TYPES = ['device', 'group', 'network'] as const
export type QosTargetType = (typeof QOS_TARGET_TYPES)[number]

export const QOS_QUOTA_ACTIONS = ['block', 'throttle'] as const
export type QosQuotaAction = (typeof QOS_QUOTA_ACTIONS)[number]

/**
 * Who gets which cap (docs/gateway/qos.md section 4): a device (`mac`), a
 * group (`groupId`) or a network default (`network`), with a policy and/or
 * a plain rate, an optional quota and expiry.
 */
export default class QosAssignment extends QosAssignmentSchema {}
