/**
 * The managed gateway's config plane over REST (metrics-be
 * docs/gateway/config-plane.md section 10). Kept apart from `api.ts` so the
 * gateway branches merge without touching the same lines.
 */

export type GatewayMode = 'off' | 'observe' | 'managed'
export type GatewaySyncState = 'unknown' | 'in_sync' | 'ahead' | 'conflict' | 'drift' | 'applying'
export type AgentAccess = 'none' | 'read' | 'write'
export type WriteBlockedReason =
  | 'offline'
  | 'no_capability'
  | 'router_access'
  | 'insecure_transport'
  | 'not_paired'
  | 'sign_key_unknown'

export type UciValue = string | string[]
export type UserRef = { id: number; email: string } | null

export type GatewayPairingState =
  | 'awaiting_confirmation'
  | 'awaiting_router'
  | 'paired'
  | 'lost'
  | 'expired'
  | 'failed'

export type GatewayPairing = {
  state: GatewayPairingState
  pairingId: string
  keyId: string
  /** The 6-digit code, while awaiting a confirmation. */
  sas: string | null
  startedAt: string
  expiresAt: string
  adminConfirmedAt: string | null
  routerConfirmedAt: string | null
  pairedAt: string | null
  attemptsLeft: number
  reason: string | null
}

export type ApplyKind = 'apply' | 'revert' | 'adopt' | 'package'
export type ApplyState =
  | 'queued'
  | 'sending'
  | 'pending_confirm'
  | 'confirmed'
  | 'rolled_back'
  | 'failed'
  | 'expired'
  | 'cancelled'
export type ConfirmMode = 'agent' | 'admin_and_agent'

export type ConfigDiffOption = {
  name: string
  before: UciValue | null
  after: UciValue | null
  secret?: true
}

export type ConfigDiffEntry = {
  perchId: string | null
  config: string
  section: string
  type: string
  domain: string | null
  action: 'create' | 'update' | 'delete' | 'adopt' | 'order'
  options: ConfigDiffOption[]
}

export type GatewayApply = {
  /** The wire applyId. */
  id: string
  kind: ApplyKind
  state: ApplyState
  confirmMode: ConfirmMode
  confirmTimeoutSeconds: number
  protected: boolean
  signed: boolean
  deadlineAt: string | null
  confirmations: { agent: string | null; admin: string | null }
  agentReconnectedAt: string | null
  requestedBy: UserRef
  requestedAt: string
  sentAt: string | null
  finishedAt: string | null
  queueExpiresAt: string | null
  note: string | null
  outcome: {
    reason?: string
    error?: string
    message?: string
    discardedConfigs?: string[]
    assumed?: true
  } | null
  revision: number | null
  perchIds: string[]
  configs: string[]
  changes?: ConfigDiffEntry[]
}

export type RejoinOffer = {
  revision: number
  reason: 'ledger_reset' | 'rebound'
  detectedAt: string
}

export type SectionCounts = {
  synced: number
  excluded: number
  unmodeled: number
  ahead: number
  conflicts: number
  drift: number
}

export type ManagementPath = {
  network: string | null
  device: string
  controllerAddress?: string
  reportedAt?: string
}

/** `gateway.capabilities` as stored; every field optional (older agents send less). */
export type GatewayCapabilities = {
  access?: AgentAccess
  allowedConfigs?: string[]
  transportOk?: boolean
  allowInsecure?: boolean
  openwrt?: { release?: string; revision?: string; target?: string; arch?: string; board?: string }
  firewall?: 'fw4' | 'fw3' | null
  packageManager?: 'opkg' | 'apk'
  packages?: Record<string, string>
  installAllowlist?: string[]
  flash?: { path?: string; totalBytes?: number; freeBytes?: number } | null
  storage?: { path?: string; kind?: string; medium?: string; freeBytes?: number } | null
  [key: string]: unknown
}

export type Gateway = {
  id: number
  collectorId: number | null
  name: string
  detached: boolean
  online: boolean
  /** The live session's TLS flag. */
  secure: boolean | null
  mode: GatewayMode
  authoritative: boolean
  authoritativeSince: string | null
  enforcement: 'active' | 'suspended'
  agentAccess: AgentAccess | null
  agentAccessConfigured: AgentAccess | null
  transportOk: boolean | null
  allowInsecure: boolean | null
  writable: boolean
  signedWrites: boolean
  writeBlockedReason: WriteBlockedReason | null
  signingKey: 'paired' | 'config_sign_key' | 'api_key' | null
  hasSignKey: boolean
  pairing: GatewayPairing | null
  syncState: GatewaySyncState
  counts: SectionCounts
  headRevision: number
  observedAt: string | null
  luciPending: boolean
  uncommitted: string[]
  pendingApply: GatewayApply | null
  rejoinOffer: RejoinOffer | null
  dnsLabelNames: 'off' | 'review'
  domains: Array<{ key: string; configs: string[] }>
  // GET /gateways/:id only:
  capabilities?: GatewayCapabilities | null
  capabilitiesAt?: string | null
  managementPath?: ManagementPath | null
  observedHashes?: Record<string, string>
}

export type SectionScope = 'synced' | 'excluded' | 'unmodeled'
export type SectionStatus = 'in_sync' | 'ahead' | 'pending' | 'conflict' | 'drift' | 'reverting'

export type SectionContent = {
  type: string
  options: Record<string, UciValue>
  secrets: Record<string, { fingerprint: string; setByController: boolean }>
}

export type RouterAuthor = {
  kind: 'luci' | 'cli' | 'perch' | 'unknown'
  user?: string
  via?: 'trigger' | 'poll'
  applyId?: string
}

export type ConflictOption = { name: string; base: unknown; router: unknown; controller: unknown }

export type SectionConflict = {
  kind: 'options' | 'delete_vs_edit' | 'type' | 'order'
  options: ConflictOption[]
  detectedAt: string
  origin?: 'merge' | 'rollback_discarded'
  discarded?: SectionContent | null
}

export type GatewaySection = {
  perchId: string
  config: string
  section: string
  type: string
  anonymous: boolean
  scope: SectionScope
  domain: string | null
  issue: 'ambiguous' | 'no_round_trip' | 'duplicate' | null
  /** null = the whole section is Perch's. */
  ownership: { kind: 'options'; options: string[]; items?: Record<string, string[]> } | null
  status: SectionStatus
  router: SectionContent | null
  desired: SectionContent | null
  base: SectionContent | null
  baseRevision: number | null
  routerAuthor: RouterAuthor | null
  routerChangedAt: string | null
  conflict: SectionConflict | null
  driftSince: string | null
  /** Authoritative Mode: when the revert is due. */
  revertAt: string | null
  position: number | null
  updatedByUserId: number | null
  updatedAt: string | null
}

export type RevisionSource = 'import' | 'router' | 'controller' | 'merge' | 'revert' | 'rollback'

export type GatewayRevision = {
  number: number
  source: RevisionSource
  author: UserRef
  routerAuthor: RouterAuthor | null
  summary: string
  note: string | null
  createdAt: string
  confirmedAt: string | null
  applyId: string | null
  diff?: ConfigDiffEntry[]
  snapshot?: Array<{
    perchId: string
    config: string
    section: string
    domain: string | null
    content: SectionContent | null
  }>
}

export type GatewayEvent = {
  id: number
  event: string
  user: UserRef
  applyId: string | null
  revision: number | null
  detail: Record<string, unknown> | null
  createdAt: string
}

export type Paged<T> = { items: T[]; nextBefore: number | null }

export type SectionDetail = {
  section: GatewaySection
  history: Paged<GatewayRevision & { change: ConfigDiffEntry }>
}

export type Issue = {
  severity: 'error' | 'warning'
  code: string
  message: string
  perchId?: string | null
  config?: string
  section?: string
  option?: string
}

export type GatewayDraft = {
  changes: ConfigDiffEntry[]
  jobs: Array<{ kind: ApplyKind; protected: boolean; configs: string[]; perchIds: string[] }>
  issues: Issue[]
  blockedByConflicts: string[]
}

export type DryRunResult = {
  changes: ConfigDiffEntry[]
  agentChanges: unknown
  issues: Issue[]
}

export type SyncBlocker =
  | { kind: 'offline' | 'mode_not_managed' | 'apply_in_flight' | 'enforcement_suspended' }
  | {
      kind: 'conflict' | 'controller_ahead' | 'router_ahead' | 'unimported_section'
      perchId: string | null
      config: string
      section: string
      diff: ConfigDiffEntry
    }

export type SyncStatus = {
  inSync: boolean
  headRevision: number
  observedAt: string | null
  luciPending: boolean
  uncommitted: string[]
  blockers: SyncBlocker[]
}

export type PackageDryRun = {
  install?: string[]
  alreadyInstalled?: string[]
  needBytes?: number
  freeBytes?: number
  manager?: string
  [key: string]: unknown
}

// ── Device page and DNS (section 10.3) ────────────────────────────────────

export type DhcpReservation = {
  perchId: string
  section: string
  macs: string[]
  ip: string | null
  hostname: string | null
  publishDns: boolean
  leaseTime: string | null
  deny: boolean
  owner: 'perch' | 'router'
  status: SectionStatus
  scope: SectionScope
  applied: boolean
  conflict: boolean
  driftSince: string | null
}

export type DeviceReservationView = {
  gatewayId: number
  reservation: DhcpReservation | null
  dnsName: string | null
  lease: { ipv4: string | null; hostname: string | null } | null
}

export type ApplyError = { error: string; message: string } | null

export type DomainWriteResult<T> = {
  gatewayId?: number
  object: T
  issues: Issue[]
  apply: GatewayApply | null
  applyError: ApplyError
}

export type DnsRecord = {
  perchId: string
  section: string
  type: 'a' | 'cname'
  name: string
  value: string
  owner: 'perch' | 'router'
  status: string
  applied: boolean
}

export type PendingLabelName = {
  mac: string
  label: string
  slug: string
  current: string | null
  perchId: string | null
  blocked: 'reserved' | 'router_owned' | null
}

export type GatewayDns = {
  labelNames: 'off' | 'review'
  records: DnsRecord[]
  names: Array<{ perchId: string; hostname: string; ip: string | null; macs: string[]; owner: 'perch' | 'router' }>
  reserved: string[]
  pendingLabelNames: PendingLabelName[]
}

// ── Settings → Gateway config (section 11) ─────────────────────────────────

export type GatewayConfigSettings = {
  confirmTimeoutSeconds: number
  managementConfirmTimeoutSeconds: number
  confirmMode: ConfirmMode
  queueExpiryHours: number
  watchSeconds: number
  importDebounceSeconds: number
  authoritativeRevertDelaySeconds: number
  enforcementMaxFailures: number
  enforcementWindowMinutes: number
  keepRevisions: number
  auditRetentionDays: number
  allowInsecureTransport: boolean
  localStatePath: string
  localStateFlushSecondsFlash: number
  localStateFlushSecondsDisk: number
}

export type GatewayConfigNumericKey = {
  [K in keyof GatewayConfigSettings]: GatewayConfigSettings[K] extends number ? K : never
}[keyof GatewayConfigSettings]

export type GatewayConfigSettingsView = {
  settings: GatewayConfigSettings
  defaults: GatewayConfigSettings
  limits: Record<GatewayConfigNumericKey, { min: number; max: number }>
  choices: { confirmMode: ConfirmMode[] }
}
