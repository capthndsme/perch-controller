import { GatewayApplySchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import { emitApplySaved } from '#services/gateway_config/hooks'
import { afterSave } from '@adonisjs/lucid/orm'
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
 * Work that runs once the job is live on the router (docs/gateway/firewall.md
 * section 5): the WAN block's conntrack flush.
 */
export type GatewayApplyPostActions = {
  conntrackFlush?: {
    mac: string
    ips: string[]
    /** The sections whose change must be live first (the block set and rules). */
    perchIds: string[]
    done?: boolean
    result?: Record<string, unknown> | null
  }
}

/** One check item as sent (gateway sync protocol.md 1.1). */
export type GatewayApplyCheckItem = {
  id: string
  kind: string
  network?: string
  family?: 4 | 6
  mustPass?: boolean
  targets?: string[]
  tcpPort?: number
  via?: string
  name?: string
  publicKey?: string
  withinSeconds?: number
}

/** The checks an apply carries (`gateway_applies.checks`, migration 140). */
export type GatewayApplyChecks = {
  v: 1
  timeoutSeconds: number
  items: GatewayApplyCheckItem[]
  /** The agent added its own default-route check (the job carried none). */
  agentAdded?: boolean
}

/** One item's state as the agent last reported it. */
export type CheckItemResult = {
  id: string
  state: string
  detail: string | null
  at: string | null
}

/** The agent's last report on an apply's checks (`check_results`). */
export type GatewayApplyCheckResults = {
  state: string
  startedAt: string | null
  timeoutSeconds: number | null
  allSkipped: boolean
  items: CheckItemResult[]
  /** The reply's baseline (each item once, before the job). */
  baseline?: CheckItemResult[]
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

  /** A `package` job's packages (README 7.7). */
  @jsonColumn('packages')
  declare packages: string[] | null

  /** The request's section filter for the next job of the chain (null = all). */
  @jsonColumn('chain_perch_ids')
  declare chainPerchIds: string[] | null

  /** Runs once the job is live (`post_actions`); carried along a chain until done. */
  @jsonColumn('post_actions')
  declare postActions: GatewayApplyPostActions | null

  /** Gateway sync: the checks sent (`items: []` = explicitly none). */
  @jsonColumn('checks')
  declare checks: GatewayApplyChecks | null

  /** Gateway sync: the agent's last report on them. */
  @jsonColumn('check_results')
  declare checkResults: GatewayApplyCheckResults | null

  /** Features follow their applies (`onApplySaved`, section 6.8). */
  @afterSave()
  static async notifyListeners(apply: GatewayApply) {
    await emitApplySaved(apply)
  }
}
