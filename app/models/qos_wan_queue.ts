import { QosWanQueueSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type { UciOptions } from '#services/gateway_config/types'

export const QOS_QUEUE_ORIGINS = ['controller', 'router'] as const
export type QosQueueOrigin = (typeof QOS_QUEUE_ORIGINS)[number]

/**
 * A WAN SQM queue of a managed gateway (docs/gateway/qos.md section 2): the
 * controller's mirror of one `sqm` `queue` section. `options` is the
 * section's full UCI option map, verbatim; `app/services/sqm_mapping.ts`
 * turns it into the API fields and back. `routerPausedAt` marks a router-side
 * `enabled=0` (owner decision 15: a safety pause, never reverted).
 */
export default class QosWanQueue extends QosWanQueueSchema {
  @jsonColumn('options')
  declare options: UciOptions
}
