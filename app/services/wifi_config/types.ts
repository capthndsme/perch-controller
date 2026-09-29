/**
 * Types of the Wi-Fi plane: the per-AP config plane (the gateway's model on
 * each perch-apd access point) and the fleet layer above it (networks,
 * divergences, rollouts). Pure data, no Lucid, no I/O: domains, the fleet
 * layer and their tests import them without booting the app.
 *
 * Design: docs/design/wifi (controller.md sections 2–8, protocol.md for the
 * agent's shapes). The per-AP half reuses the gateway core's types
 * (`app/services/gateway_config/types.ts`), re-exported here.
 */
import type {
  AgentAccess,
  ConfigDiffEntry,
  ConfirmMode,
  GatewayEnforcement,
  GatewayMode,
  GatewaySyncState,
  Issue,
  LedgerEntry,
  ManagementPath,
  RouterAuthor,
  SectionContent,
  SectionStatus,
  UciOptions,
  UciValue,
} from '#services/gateway_config/types'

export type {
  AgentAccess,
  ConfigDiffEntry,
  ConfirmMode,
  Issue,
  LedgerEntry,
  ManagementPath,
  RouterAuthor,
  SectionContent,
  SectionStatus,
  UciOptions,
  UciValue,
}

// ── per AP ───────────────────────────────────────────────────────────────

/** An AP's plane mode (the gateway's modes). */
export type ApMode = GatewayMode
export type ApEnforcement = GatewayEnforcement
/** `ap_configs.sync_state`: the gateway rollup. */
export type ApSyncState = GatewaySyncState

/** `ap_configs.fleet_state`: how the AP stands against the fleet render. */
export const AP_FLEET_STATES = ['unknown', 'in_line', 'diverged', 'behind', 'unassigned'] as const
export type ApFleetState = (typeof AP_FLEET_STATES)[number]

/** `ap_configs.country_mode` (decision D10). */
export const COUNTRY_MODES = ['fleet', 'fixed', 'router'] as const
export type CountryMode = (typeof COUNTRY_MODES)[number]

/** Why an AP cannot be written to (REST `writeBlockedReason`). */
export const AP_WRITE_BLOCKS = [
  'offline',
  'no_capability',
  'router_access',
  'guard_missing',
  'insecure_transport',
  'not_paired',
] as const
export type ApWriteBlock = (typeof AP_WRITE_BLOCKS)[number]

/** Kinds of an AP job (`ap_config_applies.kind`): no `package` on APs. */
export const AP_APPLY_KINDS = ['apply', 'revert', 'adopt'] as const
export type ApApplyKind = (typeof AP_APPLY_KINDS)[number]

/** The boot guard's state on the AP (protocol.md 3.4). */
export const AP_GUARD_STATES = ['installed', 'self_installed', 'missing'] as const
export type ApGuardState = (typeof AP_GUARD_STATES)[number]

/** The pairing subject of an AP's Wi-Fi plane (W0): never equal to a gateway's. */
export function apPairingSubject(apId: number): string {
  return `ap:${apId}`
}

/**
 * How the AP reaches the controller (protocol.md 3.8): the gateway's path
 * plus the UCI radios that carry the uplink (a `sta`, mesh or WDS member of
 * the management bridge); `[]` for a wired AP.
 */
export interface ApManagementPath extends ManagementPath {
  radios: string[]
}

/** The device-groups engine as the AP reports it (protocol.md 2.1, 3.1). */
export interface ApGroupsState {
  engine: boolean
  enabled: boolean
  state?: string
  handedOver: boolean
  appliedRevision?: number
  owned?: string[]
}

/** The open job the AP reports (`system.info.wifiConfig.apply`). */
export interface ApReportedApply {
  state: 'idle' | 'applying' | 'pending_confirm' | 'rolling_back'
  applyId?: string
  kind?: ApApplyKind
  deadline?: string
  protected?: boolean
  health?: 'pending' | 'ok' | 'failed'
}

/** One outcome the AP has not had acked (`system.info.wifiConfig.results`). */
export interface ApReportedResult {
  applyId: string
  kind: ApApplyKind
  outcome: 'rolled_back' | 'failed'
  reason:
    | 'confirm_timeout'
    | 'admin'
    | 'reboot'
    | 'commit_failed'
    | 'reload_failed'
    | 'health_failed'
    | string
  at: string
  hashes?: Record<string, string>
  discarded?: unknown
  health?: WifiHealth
  detail?: unknown
}

/** `system.info.wifiConfig` (protocol.md 2.1): the plane's hello. */
export interface ApWifiConfigBlock {
  protocol: number
  access: AgentAccess
  transportOk: boolean
  allowInsecure: boolean
  allowedConfigs: string[]
  hashes: Record<string, string>
  apply: ApReportedApply
  results: ApReportedResult[]
  signing: {
    required: boolean
    challenge?: string
    key: string
    keyId?: string | null
    windowSeconds?: number
  }
  management: ApManagementPath | null
  groups: ApGroupsState | null
}

/** One channel a radio offers (nl80211 wiphy dump, protocol.md 3.1). */
export interface ApChannel {
  channel: number
  mhz: number
  maxDbm: number
  dfs: boolean
  noIr: boolean
  disabled: boolean
  /** Radar check time (60 s, 600 s for weather channels under ETSI); DFS channels only. */
  cacSeconds?: number | null
}

export type Band = '2g' | '5g' | '6g' | '60g'

/** One radio as `wifi.capabilities` reports it (protocol.md 3.1). */
export interface ApRadioCaps {
  /** UCI `wifi-device` section name. */
  section: string
  phy: string | null
  path: string | null
  band: Band | null
  /** The hardware exists (a stale section of a moved path is `false`). */
  present: boolean
  up: boolean
  retrySetupFailed: boolean
  country: string | null
  txpowerMaxDbm: number | null
  /** Most AP interfaces the radio runs at once. */
  maxBss: number | null
  widths: number[]
  /** htmode families: `HT`, `VHT`, `HE`, `EHT`. */
  modes: string[]
  channels: ApChannel[]
  current: { channel: number | null; htmode: string | null; txpowerDbm: number | null } | null
}

/** hostapd build features (`hostapd -v<feature>`). */
export interface HostapdFeatures {
  '11r'?: boolean
  'sae'?: boolean
  'owe'?: boolean
  'eap'?: boolean
  'wps'?: boolean
  'mesh'?: boolean
  '11ac'?: boolean
  '11ax'?: boolean
  '11be'?: boolean
  'acs'?: boolean
  'ocv'?: boolean
}

/** The AP's trunk port towards the gateway (device groups' detection). */
export interface ApTrunk {
  port: string | null
  bridge: string | null
  vlanFiltering: boolean
  source: 'auto' | 'override' | 'none'
}

/**
 * `wifi.capabilities` (protocol.md 3.1), as stored on `ap_configs.capabilities`.
 * Every field optional where older or smaller agents may omit it: the
 * controller degrades instead of failing.
 */
export interface ApCapabilities {
  protocol?: number
  access?: AgentAccess
  allowedConfigs?: string[]
  transportOk?: boolean
  allowInsecure?: boolean
  confirmMaxSeconds?: number
  backend?: 'ubus' | 'file' | null
  guard?: ApGuardState
  openwrt?: { release?: string; revision?: string; target?: string; arch?: string; board?: string }
  packageManager?: 'opkg' | 'apk'
  packages?: Record<string, string>
  wifiScripts?: 'ucode' | 'shell'
  schema?: boolean
  hostapd?: {
    binary?: string
    variant?: string | null
    ubus?: boolean
    features?: HostapdFeatures
  }
  regulatory?: {
    global: string | null
    settable: boolean
    reason?: string | null
    /** phys whose regdomain the firmware owns (ath11k). */
    selfManaged?: string[]
  }
  radios?: ApRadioCaps[]
  trunk?: ApTrunk | null
  networks?: Array<{ name: string; device: string | null; proto: string | null; up: boolean }>
  management?: ApManagementPath | null
  hashes?: Record<string, string>
  uncommitted?: string[]
  luciPending?: boolean
  apply?: ApReportedApply
  groups?: ApGroupsState | null
  [key: string]: unknown
}

/** `wifi.health` (protocol.md 3.7). */
export interface WifiHealth {
  checkedAt: string
  ok: boolean
  pending: boolean
  radios: Array<{
    section: string
    up: boolean
    retrySetupFailed: boolean
    channel: number | null
    dfs: { cacActive: boolean; cacSecondsLeft: number } | null
  }>
  bss: Array<{
    section: string
    ifname: string | null
    ssid: string
    status: string
    expected: boolean
    bssid?: string | null
    nr?: string | null
  }>
  pskGuard?: string
  problems: Array<{ code: string; section: string | null; message: string }>
}

/** `ap_configs.observed_state`: the last read's context. */
export interface ApObservedState {
  luciPending: boolean
  uncommitted: string[]
  readAt: string | null
}

/** `ap_configs.rejoin_offer` (controller.md 4.6). */
export interface ApRejoinOffer {
  /** The newest confirmed revision; null when none was ever confirmed. */
  revision: number | null
  reason: 'ledger_reset' | 'rejoined'
  detectedAt: string
  /** The current fleet render can be offered instead. */
  fleet: boolean
}

/** The AP's ledger as last read. */
export type ApLedger = LedgerEntry[]

// ── fleet ────────────────────────────────────────────────────────────────

/** Security of a network (controller.md 5.1). `wpa_wpa2` is imported only. */
export const WIFI_SECURITIES = ['open', 'owe', 'wpa2', 'wpa2_wpa3', 'wpa3', 'wpa_wpa2'] as const
export type WifiSecurity = (typeof WIFI_SECURITIES)[number]

/** The securities a new network may have (NetworkCreate). */
export const OFFERED_SECURITIES = ['open', 'owe', 'wpa2', 'wpa2_wpa3', 'wpa3'] as const
export type OfferedSecurity = (typeof OFFERED_SECURITIES)[number]

/** Bands a network can carry. */
export const WIFI_BANDS = ['2g', '5g', '6g'] as const
export type WifiBand = (typeof WIFI_BANDS)[number]

/** Where a network's clients land (controller.md 5.1). */
export type WifiBinding =
  /** Each AP's management network. */
  | { kind: 'lan' }
  /** A VLAN, usually one of the gateway's networks (phase 3). */
  | { kind: 'vlan'; vlanId: number; gatewayId: number | null; networkPerchId: string | null }
  /** Per AP: `overrides.apNetwork`. */
  | { kind: 'ap_network' }

export interface Roaming {
  /** 802.11r fast transition. */
  ft: boolean
  /** 4 hex digits; null = derived from the network id. */
  mobilityDomain: string | null
  /** 802.11k. */
  rrm: boolean
  /** 802.11v BSS transition. */
  btm: boolean
}

export const PMF_MODES = ['default', 'disabled', 'optional', 'required'] as const
export type PmfMode = (typeof PMF_MODES)[number]

export interface Advanced {
  pmf: PmfMode
  multicastToUnicast: boolean | null
  maxClients: number | null
  dtimPeriod: number | null
}

/** Per-AP overrides of a network (controller.md 5.1). */
export type NetworkOverrides = Partial<{
  enabled: boolean
  hidden: boolean
  isolate: boolean
  apNetwork: string
  /** Keep the AP's own passphrase (a `key` divergence resolved as "override"). */
  keepKey: boolean
  maxClients: number
  dtimPeriod: number
}>

/** Per-radio overrides of a network on one AP. */
export type RadioOverrides = Record<string, { enabled?: boolean }>

export const NETWORK_ORIGINS = ['perch', 'import', 'router'] as const
export type NetworkOrigin = (typeof NETWORK_ORIGINS)[number]

export const AP_SCOPES = ['all', 'selected'] as const
export type ApScope = (typeof AP_SCOPES)[number]

/** A network as the fleet layer sees it (a `wifi_networks` row, parsed). */
export interface WifiNetworkSpec {
  id: number
  name: string
  ssid: string
  enabled: boolean
  security: WifiSecurity
  /** `wifi_secrets.ref` of a known passphrase; null = unknown (adopted) or none (open/OWE). */
  passphraseRef: string | null
  hidden: boolean
  isolate: boolean
  binding: WifiBinding
  bands: WifiBand[]
  apScope: ApScope
  roaming: Roaming
  advanced: Advanced
  groups: boolean
  origin: NetworkOrigin
  revision: number
}

/** A network's membership of one AP (a `wifi_network_aps` row). */
export interface WifiNetworkApSpec {
  networkId: number
  apId: number
  /** null = follow the network's scope. */
  included: boolean | null
  bands: WifiBand[] | null
  radios: string[] | null
  overrides: NetworkOverrides
  radioOverrides: RadioOverrides
}

export const IFACE_LINK_ORIGINS = ['adopted', 'created', 'router'] as const
export type IfaceLinkOrigin = (typeof IFACE_LINK_ORIGINS)[number]

/** An AP interface section linked to a network (a `wifi_iface_links` row). */
export interface IfaceLink {
  apId: number
  perchId: string
  networkId: number | null
  radio: string
  origin: IfaceLinkOrigin
}

export const DIVERGENCE_KINDS = ['option', 'removed', 'added', 'unassigned', 'country'] as const
export type DivergenceKind = (typeof DIVERGENCE_KINDS)[number]

export const DIVERGENCE_RESOLUTIONS = ['fleet', 'override', 'revert', 'split', 'auto'] as const
export type DivergenceResolution = (typeof DIVERGENCE_RESOLUTIONS)[number]

/** An open divergence (a `wifi_divergences` row without `resolved_at`). */
export interface OpenDivergence {
  id: number | null
  apId: number
  networkId: number | null
  perchId: string | null
  radio: string | null
  kind: DivergenceKind
  option: string | null
  fleetValue: unknown
  apValue: unknown
  routerAuthor: RouterAuthor | null
}

export const ROLLOUT_KINDS = ['change', 'radios', 'catch_up', 'revert', 'adopt', 'rejoin'] as const
export type RolloutKind = (typeof ROLLOUT_KINDS)[number]

export const ROLLOUT_STATES = ['running', 'paused', 'stopped', 'completed', 'cancelled'] as const
export type RolloutState = (typeof ROLLOUT_STATES)[number]

export const ROLLOUT_STEP_STATES = [
  'pending',
  'waiting_offline',
  'applying',
  'confirmed',
  'noop',
  'failed',
  'rolled_back',
  'skipped',
  'cancelled',
] as const
export type RolloutStepState = (typeof ROLLOUT_STEP_STATES)[number]

export const OFFLINE_POLICIES = ['skip', 'wait'] as const
export type OfflinePolicy = (typeof OFFLINE_POLICIES)[number]

export const ROLLOUT_ORDERS = ['canary', 'name'] as const
export type RolloutOrder = (typeof ROLLOUT_ORDERS)[number]

export const CATCH_UP_POLICIES = ['auto', 'ask'] as const
export type CatchUpPolicy = (typeof CATCH_UP_POLICIES)[number]

/** Where a rollout stopped (`wifi_rollouts.stop`). */
export interface RolloutStop {
  apId: number
  reason: string
  applyId: string | null
  message: string
}

/** One AP's part of an impact preview (controller.md 6.3). */
export interface ImpactAp {
  apId: number
  apName: string
  order: number
  online: boolean
  jobs: Array<{ kind: string; protected: boolean; changes: ConfigDiffEntry[] }>
  /** Radio sections whose radio-level options change (the radio restarts). */
  restartsRadio: string[]
  touchedBss: number
  clientsAffected: number
  dfs: { radio: string; cacSeconds: number } | null
  adminDeviceHere: boolean
  windowSeconds: number
}

export interface ImpactPreview {
  aps: ImpactAp[]
  adminDevice: { mac: string; apId: number; ssid: string } | null
  warnings: Issue[]
}

/** Confirm mode of Wi-Fi jobs (decision D4: `agent` + the AP's health check). */
export type WifiConfirmMode = ConfirmMode
