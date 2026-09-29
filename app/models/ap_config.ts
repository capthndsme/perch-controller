import { ApConfigSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import encryption from '@adonisjs/core/services/encryption'
import { column } from '@adonisjs/lucid/orm'
import type { GatewayPairing } from '#models/gateway'
import type {
  AgentAccess,
  ApCapabilities,
  ApEnforcement,
  ApFleetState,
  ApGuardState,
  ApLedger,
  ApManagementPath,
  ApMode,
  ApObservedState,
  ApRejoinOffer,
  ApSyncState,
  CountryMode,
  WifiHealth,
} from '#services/wifi_config/types'

export type { ApEnforcement, ApFleetState, ApMode, ApSyncState, CountryMode }

/**
 * The Wi-Fi plane's row of one perch-apd access point (docs/design/wifi
 * controller.md sections 2 and 4): the AP's counterpart of `Gateway`. The
 * primary key is the AP's id (`wifi_access_points.id`), assigned by the
 * caller.
 *
 * Unions (`mode`, `enforcement`, `syncState`, `fleetState`, `countryMode`,
 * `agentAccess`, `guard`) are plain strings enforced in the app layer; the
 * JSON columns are parsed here. The pairing key is APP_KEY-encrypted and
 * never serialised.
 */
export default class ApConfig extends ApConfigSchema {
  static selfAssignPrimaryKey = true

  declare mode: ApMode
  declare enforcement: ApEnforcement
  declare syncState: ApSyncState
  declare fleetState: ApFleetState
  declare countryMode: CountryMode
  declare agentAccess: AgentAccess | null
  declare guard: ApGuardState | null

  /** `wifi.capabilities` as last fetched. */
  @jsonColumn('capabilities')
  declare capabilities: ApCapabilities | null

  @jsonColumn('observed_hashes')
  declare observedHashes: Record<string, string> | null

  /** The AP's ledger at the last read. */
  @jsonColumn('observed_ledger')
  declare observedLedger: ApLedger | null

  /** The last read's context besides configs and ledger. */
  @jsonColumn('observed_state')
  declare observedState: ApObservedState | null

  /** File hashes pinned when Authoritative Mode was enabled. */
  @jsonColumn('pinned_hashes')
  declare pinnedHashes: Record<string, string> | null

  /** How the AP reaches the controller, with the uplink radios. */
  @jsonColumn('management_path')
  declare managementPath: ApManagementPath | null

  /** A reset or re-joined AP is offered the fleet render or its last confirmed revision. */
  @jsonColumn('rejoin_offer')
  declare rejoinOffer: ApRejoinOffer | null

  /** The plain-HTTP signing pairing (subject `ap:<apId>`, the gateway shape). */
  @jsonColumn('pairing')
  declare pairing: GatewayPairing | null

  /** The paired key (64 hex), APP_KEY-encrypted, never serialised. */
  @column({
    columnName: 'pairing_key',
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
  declare pairingKey: string | null

  /** The last `wifi.health` the AP reported. */
  @jsonColumn('health')
  declare health: WifiHealth | null
}
