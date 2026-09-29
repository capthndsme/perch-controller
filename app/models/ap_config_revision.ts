import { ApConfigRevisionSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type { RevisionSnapshotEntry } from '#models/gateway_revision'
import type { ConfigDiffEntry, RouterAuthor } from '#services/gateway_config/types'

export type { RevisionSnapshotEntry }

/**
 * One agreed state of an AP's synced Wi-Fi/network config (docs/design/wifi
 * controller.md section 2; the `GatewayRevision` shape with `apId` and
 * `rolloutId`). `confirmedAt` is set once the state is known to work on the
 * AP; a reset AP is offered the newest confirmed one.
 */
export default class ApConfigRevision extends ApConfigRevisionSchema {
  @jsonColumn('router_author')
  declare routerAuthor: RouterAuthor | null

  @jsonColumn('snapshot')
  declare snapshot: RevisionSnapshotEntry[]

  @jsonColumn('diff')
  declare diff: ConfigDiffEntry[]

  @jsonColumn('hashes')
  declare hashes: Record<string, string>
}
