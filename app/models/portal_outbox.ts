import { PortalOutboxSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type { PortalPushKind } from '#services/portal_agent_sender'

/**
 * A message waiting for a gateway's router (docs/gateway/portal.md section
 * 11.2). Written by `OutboxPortalAgentSender`, drained by the collector
 * socket (WP3) inside the gateway's portal queue.
 */
export default class PortalOutbox extends PortalOutboxSchema {
  static table = 'portal_outbox'

  declare kind: PortalPushKind

  @jsonColumn('grant_ids')
  declare grantIds: number[] | null
}
