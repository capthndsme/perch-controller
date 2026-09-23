import { QosScheduleSchema } from '#database/schema'

export const QOS_SCHEDULE_TARGETS = ['policy', 'assignment'] as const
export type QosScheduleTarget = (typeof QOS_SCHEDULE_TARGETS)[number]

export const QOS_SCHEDULE_ACTIONS = ['limit', 'unlimited', 'block', 'policy'] as const
export type QosScheduleAction = (typeof QOS_SCHEDULE_ACTIONS)[number]

/**
 * A weekly window in which a policy or an assignment behaves differently
 * (owner decision 16; docs/gateway/qos.md section 4.6). Evaluated by
 * `app/services/qos_plan.ts`.
 */
export default class QosSchedule extends QosScheduleSchema {}
