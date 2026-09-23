import { GatewaySchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import encryption from '@adonisjs/core/services/encryption'
import { column } from '@adonisjs/lucid/orm'
import type {
  GatewayCapabilities,
  LedgerEntry,
  GatewayEnforcement,
  GatewayMode,
  GatewaySyncState,
  ManagementPath,
} from '#services/gateway_config/types'

export type { GatewayEnforcement, GatewayMode, GatewaySyncState }

/**
 * A managed gateway (docs/gateway/config-plane.md sections 2 and 9): the
 * controller-side row of a collector that runs on an OpenWrt router and
 * carries the `gateway_config` capability. `collectorId` null = detached
 * (its collector was deleted; history stays, it can be re-bound).
 *
 * Unions (`mode`, `enforcement`, `syncState`, `agentAccess`) are plain
 * strings enforced in the app layer; the JSON columns are parsed here.
 */
export default class Gateway extends GatewaySchema {
  @jsonColumn('pinned_hashes')
  declare pinnedHashes: Record<string, string> | null

  @jsonColumn('capabilities')
  declare capabilities: GatewayCapabilities | null

  @jsonColumn('observed_hashes')
  declare observedHashes: Record<string, string> | null

  @jsonColumn('management_path')
  declare managementPath: ManagementPath | null

  /** The router's sync ledger at the last read. */
  @jsonColumn('observed_ledger')
  declare observedLedger: LedgerEntry[] | null

  /** The last read's context besides configs and ledger. */
  @jsonColumn('observed_state')
  declare observedState: GatewayObservedState | null

  /**
   * The router's `config_sign_key` (signed RPCs over plain HTTP when the
   * router does not use the api_key): APP_KEY-encrypted, never serialised.
   */
  @column({
    columnName: 'config_sign_key',
    serializeAs: null,
    prepare: (value: string | null) => (value ? encryption.encrypt(value) : null),
    consume: (value: string | null) => {
      if (!value) return null
      try {
        return encryption.decrypt<string>(value) ?? null
      } catch {
        return null
      }
    },
  })
  declare configSignKey: string | null

  /** README 3.7: a reset or re-bound gateway is offered its last confirmed revision. */
  @jsonColumn('rejoin_offer')
  declare rejoinOffer: GatewayRejoinOffer | null
}

export type GatewayObservedState = {
  luciPending: boolean
  uncommitted: string[]
  readAt: string | null
}

export type GatewayRejoinOffer = {
  /** The newest confirmed revision; null when none was ever confirmed. */
  revision: number | null
  reason: 'ledger_reset' | 'rebound'
  detectedAt: string
}
