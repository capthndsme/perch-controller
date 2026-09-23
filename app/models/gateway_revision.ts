import { GatewayRevisionSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type { ConfigDiffEntry, RouterAuthor, SectionContent } from '#services/gateway_config/types'

/** A revision's snapshot entry: one synced section as it stood. */
export type RevisionSnapshotEntry = {
  perchId: string
  config: string
  section: string
  domain: string | null
  content: SectionContent
}

/**
 * One agreed state of a gateway's synced config (docs/gateway/config-plane.md
 * sections 2 and 9). `confirmedAt` is set once the state is known to work on
 * the router; a re-joined gateway is offered the newest confirmed revision,
 * never the newest one (README 3.7).
 */
export default class GatewayRevision extends GatewayRevisionSchema {
  @jsonColumn('router_author')
  declare routerAuthor: RouterAuthor | null

  @jsonColumn('snapshot')
  declare snapshot: RevisionSnapshotEntry[]

  @jsonColumn('diff')
  declare diff: ConfigDiffEntry[]

  @jsonColumn('hashes')
  declare hashes: Record<string, string>
}
