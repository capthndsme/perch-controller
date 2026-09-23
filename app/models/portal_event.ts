import { PortalEventSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type { PortalEventType } from '#services/portal/reconcile'

/** Portal audit log row (docs/gateway/portal.md section 7.4). */
export default class PortalEvent extends PortalEventSchema {
  declare type: PortalEventType

  @jsonColumn('detail')
  declare detail: Record<string, unknown> | null
}
