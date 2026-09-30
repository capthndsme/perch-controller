import { ApConfigApplySchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type { GatewayApplyOutcome } from '#models/gateway_apply'
import type {
  ApplyOp,
  ApplyState,
  ConfigDiffEntry,
  ConfirmMode,
  LedgerChange,
  SectionContent,
} from '#services/gateway_config/types'
import type { ApApplyKind, WifiHealth } from '#services/wifi_config/types'

/** What an AP job ended with: the gateway's outcome, plus the AP's health report. */
export type ApApplyOutcome = GatewayApplyOutcome & { health?: WifiHealth }

/**
 * One AP job (docs/design/wifi controller.md sections 2 and 4.3; the
 * `GatewayApply` shape with `apId`). The wire `applyId` is `applyKey`
 * (`a<apId>-<12 hex>`); `protected` marks a job on the AP's management
 * path. `health` is the AP's health check as last reported;
 * `cacAllowanceSeconds` the radar-check time added to the window;
 * `rolloutId` the fleet rollout the job belongs to.
 */
export default class ApConfigApply extends ApConfigApplySchema {
  declare kind: ApApplyKind
  declare state: ApplyState
  declare confirmMode: ConfirmMode

  @jsonColumn('ops')
  declare ops: ApplyOp[]

  @jsonColumn('base_hashes')
  declare baseHashes: Record<string, string>

  @jsonColumn('perch_ids')
  declare perchIds: string[]

  @jsonColumn('outcome')
  declare outcome: ApApplyOutcome | null

  /** The AP's content each section had before the job, by perchId. */
  @jsonColumn('replaced_router_content')
  declare replacedRouterContent: Record<string, SectionContent | null> | null

  /** The content each section has once confirmed, by perchId (`markConfirmed`). */
  @jsonColumn('written')
  declare written: Record<string, SectionContent | null> | null

  @jsonColumn('ledger')
  declare ledger: LedgerChange | null

  @jsonColumn('secret_refs')
  declare secretRefs: string[] | null

  @jsonColumn('configs')
  declare configs: string[] | null

  @jsonColumn('changes')
  declare changes: ConfigDiffEntry[] | null

  /** The request's section filter for the next job of the chain (null = all). */
  @jsonColumn('chain_perch_ids')
  declare chainPerchIds: string[] | null

  @jsonColumn('health')
  declare health: WifiHealth | null
}
