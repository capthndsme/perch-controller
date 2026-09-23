import { GatewayApplySchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type {
  ApplyOp,
  ConfigDiffEntry,
  LedgerChange,
  SectionContent,
} from '#services/gateway_config/types'

/**
 * What an apply ended with (section 10 `GatewayApply.outcome`), plus the
 * agent's `discarded` router edits of a rollback (section 5.5).
 */
export type GatewayApplyOutcome = {
  reason?: string
  error?: string
  message?: string
  discardedConfigs?: string[]
  hashes?: Record<string, string>
  [key: string]: unknown
}

/**
 * One apply job (docs/gateway/config-plane.md sections 3.4, 5.6 and 9). The
 * wire `applyId` is `applyKey`. `protected` marks the management-path job
 * (README 3.8), which runs alone with the longer confirm window.
 */
export default class GatewayApply extends GatewayApplySchema {
  @jsonColumn('ops')
  declare ops: ApplyOp[]

  @jsonColumn('base_hashes')
  declare baseHashes: Record<string, string>

  @jsonColumn('perch_ids')
  declare perchIds: string[]

  @jsonColumn('outcome')
  declare outcome: GatewayApplyOutcome | null

  /** Revert only: the router's content that the revert replaced, by perchId. */
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

  /** What the job changes on the router (section 10 `changes`). */
  @jsonColumn('changes')
  declare changes: ConfigDiffEntry[] | null

  /** The request's section filter for the next job of the chain (null = all). */
  @jsonColumn('chain_perch_ids')
  declare chainPerchIds: string[] | null
}
