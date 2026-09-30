/**
 * Wi-Fi management over REST (docs/design/wifi/controller.md sections 5 and 7):
 * networks as fleet templates, radios per access point, each AP's config
 * plane, divergences, adoption and rollouts. The config-plane shapes shared
 * with the gateway (applies, sections, revisions, events, pairing, diffs,
 * issues) are imported from `gateway-config.ts`, not copied.
 */

import type {
  ConfigDiffEntry,
  ConfirmMode,
  GatewayApply,
  GatewayPairing,
  GatewaySection,
  Issue,
  ManagementPath,
  SectionStatus,
} from '@/types/gateway-config'

export type Band = '2g' | '5g' | '6g'

/** `wpa_wpa2` is only ever imported from a router, never offered. */
export type WifiSecurity = 'open' | 'owe' | 'wpa2' | 'wpa2_wpa3' | 'wpa3' | 'wpa_wpa2'

export type WifiBinding =
  | { kind: 'lan' }
  | { kind: 'vlan'; vlanId: number; gatewayId: number | null; networkPerchId: string | null }
  | { kind: 'ap_network' }

export type Roaming = { ft: boolean; mobilityDomain: string | null; rrm: boolean; btm: boolean }

export type PmfMode = 'default' | 'disabled' | 'optional' | 'required'

export type Advanced = {
  pmf: PmfMode
  multicastToUnicast: boolean | null
  maxClients: number | null
  dtimPeriod: number | null
}

export type NetworkOverrides = Partial<{
  enabled: boolean
  hidden: boolean
  isolate: boolean
  apNetwork: string
  keepKey: boolean
  maxClients: number
  dtimPeriod: number
}>

export type ApMode = 'off' | 'observe' | 'managed'
export type ApSyncState = 'unknown' | 'in_sync' | 'ahead' | 'conflict' | 'drift' | 'applying'
export type ApFleetState = 'unknown' | 'in_line' | 'diverged' | 'behind' | 'unassigned'

export type ApWriteBlockedReason =
  | 'offline'
  | 'no_capability'
  | 'router_access'
  | 'guard_missing'
  | 'insecure_transport'
  | 'not_paired'

export type WifiHealthRadio = {
  section: string
  up: boolean
  retrySetupFailed: boolean
  channel: number | null
  dfs: { cacActive: boolean; cacSecondsLeft: number } | null
}

export type WifiHealthBss = {
  section: string
  ifname: string | null
  ssid: string
  /** hostapd's: ENABLED, DFS, ACS, HT_SCAN, DISABLED, COUNTRY_UPDATE, UNINITIALIZED. */
  status: string
  expected: boolean
}

export type WifiHealth = {
  checkedAt: string
  ok: boolean
  pending: boolean
  radios: WifiHealthRadio[]
  bss: WifiHealthBss[]
  problems: Array<{ code: string; section: string | null; message: string }>
}

export type ApApply = GatewayApply & {
  health: WifiHealth | null
  cacAllowanceSeconds: number
  rolloutId: number | null
}

export type ApRejoinOffer = { revision: number | null; reason: string; detectedAt: string }

/** `wifi.capabilities` as stored (protocol.md 3.1); every field optional (older agents send less). */
export type WifiCapabilityChannel = {
  channel: number
  mhz?: number
  maxDbm?: number
  dfs: boolean
  noIr?: boolean
  disabled?: boolean
  cacSeconds?: number
}

export type WifiCapabilityRadio = {
  section: string
  phy?: string
  path?: string
  band: Band | null
  present: boolean
  up?: boolean
  retrySetupFailed?: boolean
  country?: string | null
  txpowerMaxDbm?: number | null
  maxBss?: number
  widths?: number[]
  modes?: string[]
  channels?: WifiCapabilityChannel[]
  current?: { channel: number | null; htmode: string | null; txpowerDbm: number | null }
}

export type HostapdFeature = '11r' | 'sae' | 'owe' | 'eap' | 'wps' | 'mesh' | '11ac' | '11ax' | '11be' | 'acs' | 'ocv'

export type WifiCapabilities = {
  protocol?: number
  access?: 'none' | 'read' | 'write'
  allowedConfigs?: string[]
  transportOk?: boolean
  allowInsecure?: boolean
  confirmMaxSeconds?: number
  backend?: string
  guard?: string
  openwrt?: { release?: string; revision?: string; target?: string; arch?: string; board?: string }
  packageManager?: 'opkg' | 'apk'
  packages?: Record<string, string>
  wifiScripts?: 'ucode' | 'shell'
  schema?: boolean
  hostapd?: {
    binary?: string
    variant?: string
    ubus?: boolean
    features?: Partial<Record<HostapdFeature, boolean>>
  }
  regulatory?: { global?: string | null; settable?: boolean; reason?: string | null; selfManaged?: string[] }
  radios?: WifiCapabilityRadio[]
  trunk?: { port?: string | null; bridge?: string | null; vlanFiltering?: boolean; source?: string } | null
  networks?: Array<{ name: string; device?: string; proto?: string; up?: boolean }>
  [key: string]: unknown
}

export type ApConfig = {
  apId: number
  name: string
  online: boolean
  secure: boolean | null
  agentVersion: string | null
  /** system.info lists `wifi_config`. */
  capable: boolean
  access: 'none' | 'read' | 'write' | null
  transportOk: boolean | null
  allowInsecure: boolean | null
  mode: ApMode
  authoritative: boolean
  authoritativeSince: string | null
  enforcement: 'active' | 'suspended'
  writable: boolean
  writeBlockedReason: ApWriteBlockedReason | null
  signedWrites: boolean
  pairing: GatewayPairing | null
  syncState: ApSyncState
  fleetState: ApFleetState
  counts: {
    synced: number
    excluded: number
    unmodeled: number
    ahead: number
    conflicts: number
    drift: number
    divergences: number
    orphans: number
  }
  country: { mode: 'fleet' | 'fixed' | 'router'; effective: string | null; settable: boolean; selfManaged: boolean }
  health: WifiHealth | null
  healthAt: string | null
  pendingApply: ApApply | null
  rejoinOffer: ApRejoinOffer | null
  groups: { engine: boolean; enabled: boolean; handedOver: boolean }
  headRevision: number
  observedAt: string | null
  luciPending: boolean
  uncommitted: string[]
  // GET /wifi/aps/:apId only:
  capabilities?: WifiCapabilities | null
  managementPath?: (ManagementPath & { radios?: string[] }) | null
}

export type WifiSlotState =
  | 'in_sync'
  | 'ahead'
  | 'pending'
  | 'conflict'
  | 'drift'
  | 'diverged'
  | 'missing'
  | 'unsupported'
  | 'offline'

export type WifiSlot = {
  radio: string
  band: Band | null
  perchId: string | null
  section: string | null
  state: WifiSlotState
  bssid: string | null
  clients: number | null
}

export type WifiNetworkAp = {
  apId: number
  apName: string
  online: boolean
  mode: ApMode
  /** null = follows the network's scope. */
  included: boolean | null
  carried: boolean
  bands: Band[] | null
  radios: string[] | null
  overrides: NetworkOverrides
  radioOverrides: Record<string, { enabled?: boolean }>
  slots: WifiSlot[]
  unsupported: Array<{ code: string; message: string }>
}

export type WifiNetworkStatus =
  | 'in_sync'
  | 'applying'
  | 'ahead'
  | 'diverged'
  | 'conflict'
  | 'drift'
  | 'partial'
  | 'unmanaged'

export type WifiNetwork = {
  id: number
  name: string
  ssid: string
  enabled: boolean
  security: WifiSecurity
  passphrase: { state: 'set' | 'unknown' | 'mixed' | 'none'; updatedAt: string | null }
  hidden: boolean
  isolate: boolean
  binding: WifiBinding & {
    label: string | null
    purpose: string | null
    portal: { id: number; name: string } | null
  }
  bands: Band[]
  apScope: 'all' | 'selected'
  roaming: Roaming
  advanced: Advanced
  groups: boolean
  origin: 'perch' | 'import' | 'router'
  revision: number
  status: WifiNetworkStatus
  counts: { aps: number; apsCarrying: number; slots: number; clients: number | null }
  aps: WifiNetworkAp[]
  issues: Issue[]
  createdAt: string
  updatedAt: string
}

export type WifiRadio = {
  apId: number
  perchId: string
  section: string
  band: Band | null
  present: boolean
  up: boolean | null
  channelMode: 'auto' | 'fixed'
  channel: number | null
  allowed: number[] | null
  width: number | null
  htmode: string | null
  txpower: { mode: 'auto' | 'fixed'; dbm: number | null }
  enabled: boolean
  country: string | null
  current: { channel: number | null; htmode: string | null; txpowerDbm: number | null; utilization: number | null }
  options: {
    channels: Array<{ channel: number; dfs: boolean; maxDbm: number; cacSeconds: number | null }>
    widths: number[]
    txpowerMaxDbm: number | null
  }
  status: SectionStatus
  protected: boolean
  networks: Array<{ id: number; name: string; ssid: string }>
}

export type DivergenceKind = 'option' | 'removed' | 'added' | 'unassigned' | 'country'
export type DivergenceResolution = 'fleet' | 'override' | 'revert' | 'split'

export type WifiDivergence = {
  id: number
  apId: number
  apName: string
  networkId: number | null
  networkName: string | null
  radio: string | null
  kind: DivergenceKind
  option: string | null
  /** Secrets arrive as `{ fingerprint }`. */
  fleetValue: unknown
  apValue: unknown
  routerAuthor: GatewaySection['routerAuthor']
  detectedAt: string
  resolutions: DivergenceResolution[]
}

export type RolloutState = 'running' | 'paused' | 'stopped' | 'completed' | 'cancelled'
export type RolloutStepState =
  | 'pending'
  | 'waiting_offline'
  | 'applying'
  | 'confirmed'
  | 'noop'
  | 'failed'
  | 'rolled_back'
  | 'skipped'
  | 'cancelled'
export type RolloutKind = 'change' | 'radios' | 'catch_up' | 'revert' | 'adopt' | 'rejoin'

export type WifiRolloutStep = {
  apId: number
  apName: string
  position: number
  state: RolloutStepState
  apply: ApApply | null
  startedAt: string | null
  finishedAt: string | null
  outcome: { reason?: string; error?: string; message?: string } | null
}

export type ImpactAp = {
  apId: number
  apName: string
  /** Position in the rollout, 0-based. */
  order: number
  online: boolean
  jobs: Array<{ kind: string; protected: boolean; changes: ConfigDiffEntry[] }>
  restartsRadio: string[]
  touchedBss: number
  clientsAffected: number
  dfs: { radio: string; cacSeconds: number } | null
  adminDeviceHere: boolean
  windowSeconds: number
}

export type ImpactPreview = {
  aps: ImpactAp[]
  adminDevice: { mac: string; apId: number; ssid: string } | null
  warnings: Issue[]
}

export type WifiRollout = {
  id: number
  kind: RolloutKind
  state: RolloutState
  requestedBy: { id: number | null; email: string | null; system?: true } | null
  note: string | null
  confirmMode: ConfirmMode
  offlinePolicy: 'skip' | 'wait'
  networkIds: number[]
  steps: WifiRolloutStep[]
  stop: { apId: number; reason: string; applyId: string | null; message: string } | null
  impact: ImpactPreview | null
  createdAt: string
  finishedAt: string | null
}

export type WriteResult<T> = {
  object: T | null
  issues: Issue[]
  rollout: WifiRollout | null
  /** Why no rollout started; the change is kept as a draft. */
  rolloutError: { error: string; message: string } | null
}

export type WifiConfigOverview = {
  aps: ApConfig[]
  networks: WifiNetwork[]
  divergences: number
  rollout: WifiRollout | null
  adoptionPending: number
}

// ── Requests ────────────────────────────────────────────────────────────────

export type NetworkCreate = {
  name: string
  ssid: string
  enabled?: boolean
  security: Exclude<WifiSecurity, 'wpa_wpa2'>
  /** Required unless open/OWE. */
  passphrase?: string
  hidden?: boolean
  isolate?: boolean
  binding?: WifiBinding
  bands?: Band[]
  apScope?: 'all' | 'selected'
  apIds?: number[]
  roaming?: Partial<Roaming>
  advanced?: Partial<Advanced>
  groups?: boolean
}

export type NetworkPatch = Partial<NetworkCreate>

export type NetworkApPut = {
  included?: boolean | null
  bands?: Band[] | null
  radios?: string[] | null
  overrides?: NetworkOverrides
  radioOverrides?: Record<string, { enabled?: boolean }>
}

export type RadioPatch = {
  channelMode?: 'auto' | 'fixed'
  channel?: number
  allowed?: number[] | null
  width?: number
  txpower?: { mode: 'auto' | 'fixed'; dbm?: number }
  enabled?: boolean
}

export type CountryPolicy = { mode: 'fleet' | 'fixed' | 'router'; code?: string | null }

export type ApPatch = {
  mode?: ApMode
  authoritative?: boolean
  expectRevision?: number
  currentPassword?: string
  country?: CountryPolicy
  trunk?: string | null
}

export type PassphraseMatch = { apId: number; radio: string; match: boolean }
export type PassphraseResult = { network: WifiNetwork; matches: PassphraseMatch[] }

export type ResolveDivergenceItem = { id: number; resolution: DivergenceResolution; passphrase?: string }
export type ResolveDivergencesResult = {
  resolved: number[]
  rollout: WifiRollout | null
  rolloutError: { error: string; message: string } | null
}

export type RolloutPreviewRequest = { networkIds?: number[]; apIds?: number[]; perchIds?: string[] }
export type RolloutRequest = {
  networkIds?: number[]
  apIds?: number[]
  order?: number[]
  confirmMode?: ConfirmMode
  offlinePolicy?: 'skip' | 'wait'
  note?: string
}
export type RolloutAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'skip' | 'rollback'

export type Paged<T> = { items: T[]; nextBefore: number | null }

// ── Adoption (controller.md 5.4) ────────────────────────────────────────────

export type AdoptionWarning = 'ssid_key_mismatch' | 'open_on_lan' | 'owe_unsupported_elsewhere' | 'orphans_skipped'

export type AdoptionMember = {
  apId: number
  perchId: string
  section: string
  radio: string
  band: Band | null
  overrides: NetworkOverrides
  radioEnabled: boolean
}

export type AdoptionProposal = {
  key: string
  name: string
  ssid: string
  security: WifiSecurity
  keyFingerprint: string | null
  binding: WifiBinding
  bands: Band[]
  apScope: 'all' | 'selected'
  template: { hidden: boolean; isolate: boolean; roaming: Roaming; advanced: Advanced; enabled: boolean }
  members: AdoptionMember[]
  /** Majority taken, minority listed. */
  choices: Array<{ field: string; values: Array<{ value: unknown; apIds: number[] }> }>
  warnings: AdoptionWarning[]
  /** The per-AP rows it would create (S4's `fleet/adoption.ts`). */
  memberships?: Array<{
    apId: number
    included: boolean | null
    bands: Band[] | null
    radios: string[] | null
    overrides: NetworkOverrides
    radioOverrides: Record<string, { enabled?: boolean }>
  }>
  /** Informational, e.g. "VLAN 30" when an AP network sits on `<bridge>.<vid>`. */
  hints?: string[]
  /** Suggested: leave it out (every member is disabled). */
  exclude?: boolean
}

export type AdoptionView = {
  proposals: AdoptionProposal[]
  countries: Array<{ apId: number; values: string[]; unset?: boolean; suggested: string | null }>
  /** The fleet default the time zone suggests (else the most common one). */
  suggestedCountry?: string | null
  skipped: Array<{ apId: number; section: string; reason: 'orphan' | 'unmodeled' | 'ambiguous' }>
}

export type AdoptionAccept = {
  proposals: Array<{
    key: string
    name?: string
    merge?: string[]
    choices?: Record<string, unknown>
    exclude?: boolean
  }>
  countryDefault?: string | null
  countries?: Record<number, CountryPolicy>
}

export type AdoptionResult = { networks: WifiNetwork[]; divergences: number }

// ── Settings → Wi-Fi management (controller.md 8) ───────────────────────────

export type WifiConfigSettings = {
  confirmTimeoutSeconds: number
  managementConfirmTimeoutSeconds: number
  confirmMode: ConfirmMode
  protectedConfirmMode: ConfirmMode
  healthWaitSeconds: number
  dfsAllowance: boolean
  watchSeconds: number
  importDebounceSeconds: number
  authoritativeRevertDelaySeconds: number
  enforcementMaxFailures: number
  enforcementWindowMinutes: number
  rolloutOrder: 'canary' | 'name'
  rolloutOfflinePolicy: 'skip' | 'wait'
  catchUpOnReconnect: 'auto' | 'ask'
  countryDefault: string | null
  newNetworkFastRoaming: boolean
  keepRevisions: number
  auditRetentionDays: number
  allowInsecureTransport: boolean
  sealSecrets: boolean
}

export type WifiConfigNumericKey = {
  [K in keyof WifiConfigSettings]: WifiConfigSettings[K] extends number ? K : never
}[keyof WifiConfigSettings]

export type WifiConfigSettingsView = {
  settings: WifiConfigSettings
  defaults: WifiConfigSettings
  limits: Record<WifiConfigNumericKey, { min: number; max: number }>
  choices: {
    confirmMode: ConfirmMode[]
    protectedConfirmMode?: ConfirmMode[]
    rolloutOrder?: Array<WifiConfigSettings['rolloutOrder']>
    rolloutOfflinePolicy?: Array<WifiConfigSettings['rolloutOfflinePolicy']>
    catchUpOnReconnect?: Array<WifiConfigSettings['catchUpOnReconnect']>
  }
}

