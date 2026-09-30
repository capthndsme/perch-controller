/**
 * Agent updates (perch-apd and perch-collector from the dashboard). Mirrors the
 * controller's contract, docs/design/agent-updates/controller.md section 9.1,
 * exactly; the request bodies and the settings view follow sections 8 and 9.2.
 */

export type AgentProduct = 'perch-apd' | 'perch-collector'
export type DeviceKind = 'ap' | 'collector'
export type Channel = 'stable' | 'pre' | 'local'
export type AutoUpdate = 'off' | 'notify' | 'auto'
export type InstallKind = 'package' | 'swapped' | 'unowned' | 'manual' | 'docker' | 'other'
export type UpdateMethod = 'binary' | 'package'
export type JobState =
  | 'queued'
  | 'staging'
  | 'staged'
  | 'installing'
  | 'probation'
  | 'unknown'
  | 'confirmed'
  | 'failed'
  | 'rolled_back'
  | 'rollback_failed'
  | 'rollback_unavailable'
  | 'cancelled'
  | 'expired'
export type UnsupportedReason =
  | 'agent_too_old'
  | 'self_update_off'
  | 'no_trusted_keys'
  | 'install_kind_unsupported'
  | 'not_openwrt'
  | 'poll_transport'
  | 'never_reported'

export type DeviceRef = { key: string; kind: DeviceKind; id: number; name: string }

export type AgentUpdateJobSummary = {
  id: number
  updateId: string
  state: JobState
  fromVersion: string
  toVersion: string
  method: UpdateMethod
  source: 'release' | 'previous'
  rollbackStore: 'flash' | 'ram' | null
  reason: string | null
  detail: string | null
  progress: { bytes: number; totalBytes: number } | null
  /** ISO, while installing/probation. */
  deadline: string | null
  createdAt: string
  finishedAt: string | null
}

export type AgentUpdateDevice = {
  /** `ap:4` / `collector:1`. */
  key: string
  kind: DeviceKind
  id: number
  name: string
  role: 'ap' | 'gateway' | 'collector'
  product: AgentProduct
  online: boolean
  /** transport_security.ts, as on the wifi-sources / collectors pages. */
  secure: boolean | null
  version: string | null
  versionState: 'current' | 'update_available' | 'below_controller' | 'unknown'
  selfUpdate: {
    supported: boolean
    reason: UnsupportedReason | null
    installKind: InstallKind | null
    methods: UpdateMethod[]
    packageManager: 'opkg' | 'apk' | null
    packageVersion: string | null
    /** installKind 'swapped'. */
    packageRecordStale: boolean
    openwrtRelease: string | null
    arch: string | null
    pkgArch: string | null
    flash: { fsType: string; freeBytes: number; totalBytes: number } | null
    floor: string | null
    guard: 'installed' | 'missing' | 'outdated' | null
    previous: { version: string; store: 'flash' } | null
    reportedAt: string | null
  }
  /** Effective. */
  channel: Channel
  /** null = the default channel. */
  channelSetting: Channel | null
  /** Effective. */
  autoUpdate: AutoUpdate
  autoUpdateSetting: 'inherit' | AutoUpdate
  pinnedVersion: string | null
  available: {
    version: string
    releaseId: number
    channel: Channel
    method: UpdateMethod
    downloadBytes: number
    /** Above package.json perch.apdVersion / collectorVersion. */
    newerThanController: boolean
  } | null
  activeJob: AgentUpdateJobSummary | null
  lastJob: AgentUpdateJobSummary | null
  /** When !selfUpdate.supported and a command can be built. */
  manualCommand: ManualCommand | null
}

export type ManualCommand = {
  /** 'Update perch-apd to 1.1.0-pre.5 by hand'. */
  title: string
  targetVersion: string
  /** Copyable shell, run as root on the device. */
  command: string
  /** The signed URL inside it. */
  expiresAt: string | null
  /** E.g. the plain-HTTP notice, 'keeps the join credentials'. */
  notes: string[]
}

export type AgentFleet = {
  devices: AgentUpdateDevice[]
  summary: { total: number; current: number; updateAvailable: number; updating: number; unsupported: number }
  /** perch_version.ts. */
  controller: { version: string; apdVersion: string; collectorVersion: string }
  lastGithubCheckAt: string | null
  githubCheck: boolean
  window: { enabled: boolean; open: boolean; nextStart: string | null; timezone: string }
  openRollouts: { id: number; product: AgentProduct; version: string; state: string }[]
}

export type AgentArtefact = {
  id: number
  file: string
  kind: 'binary' | 'package' | 'files'
  arch: string | null
  variant: string | null
  manager: 'opkg' | 'apk' | null
  openwrtSeries: string | null
  pkgArch: string | null
  sizeBytes: number
  sha256: string
  stored: boolean
}

export type AgentRelease = {
  id: number
  product: AgentProduct
  version: string
  channel: Channel
  source: 'github' | 'upload'
  keyId: string
  keyLabel: string | null
  minVersion: string | null
  minFromVersion: string | null
  minControllerVersion: string | null
  releasedAt: string | null
  importedAt: string
  notesUrl: string | null
  withdrawnAt: string | null
  artefacts: AgentArtefact[]
  devicesOn: number
  devicesEligible: number
  offerable: boolean
  notOfferableReason: 'withdrawn' | 'controller_too_old' | null
}

/** `GET /releases/:id`: the release plus its manifest, parsed for display. */
export type AgentReleaseDetail = AgentRelease & { manifest: Record<string, unknown> }

export type AgentUpdateJob = AgentUpdateJobSummary & {
  device: DeviceRef | null
  product: AgentProduct
  releaseId: number | null
  rolloutId: number | null
  preflight: AgentPreflight | null
  requestedBy: { userId: number; name: string } | { system: 'rollout' | 'auto_update' } | null
  /** From the events. */
  timeline: { at: string; state: JobState; note: string | null }[]
  stagedAt: string | null
  installSentAt: string | null
  reconnectedAt: string | null
  confirmedAt: string | null
}

/** A row of `GET /jobs`. */
export type AgentUpdateJobListItem = AgentUpdateJobSummary & {
  device: DeviceRef | null
  product: AgentProduct
  rolloutId: number | null
}

export type AgentPreflight = {
  ok: boolean
  problems: { code: string; message: string; freeBytes?: number; needBytes?: number }[]
  method: UpdateMethod
  installKind: InstallKind
  rollbackStore: 'flash' | 'ram' | null
  staging: 'ram' | 'flash' | null
  downloadBytes: number
  flash: {
    path: string
    fsType: string
    freeBytes: number
    needBytes: number
    reserveBytes: number
    estimate: string
    hardlink: boolean
  }
  ram: { memAvailableBytes: number; tmpFreeBytes: number; needBytes: number; reserveBytes: number }
  busy: string | null
}

export type RolloutState = 'canary' | 'observing' | 'rolling' | 'paused' | 'completed' | 'cancelled'
export type RolloutDeviceState = 'pending' | 'running' | 'confirmed' | 'failed' | 'skipped'

export type AgentRolloutDevice = {
  device: DeviceRef
  position: number
  isCanary: boolean
  state: RolloutDeviceState
  skipReason: string | null
  job: AgentUpdateJobSummary | null
}

export type AgentRollout = {
  id: number
  product: AgentProduct
  version: string
  releaseId: number
  state: RolloutState
  method: 'auto' | UpdateMethod
  batchSize: number
  batchGapSeconds: number
  canaryObserveMinutes: number
  offlineWaitMinutes: number
  stopOnFailure: boolean
  respectWindow: boolean
  auto: boolean
  waitingFor: 'window' | 'gap' | 'observe' | 'online' | 'busy' | null
  pausedReason: string | null
  pausedDetail: string | null
  counts: { total: number; confirmed: number; failed: number; skipped: number; pending: number; running: number }
  /** Only in GET /rollouts/:id. */
  devices?: AgentRolloutDevice[]
  createdBy: { userId: number; name: string } | { system: 'auto_update' } | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  nextActionAt: string | null
}

export type EventSeverity = 'info' | 'warning' | 'critical'

export type AgentUpdateEvent = {
  id: number
  at: string
  event: string
  severity: EventSeverity
  device: DeviceRef | null
  jobId: number | null
  rolloutId: number | null
  releaseId: number | null
  actor: { userId: number; name: string } | { system: string } | null
  detail: Record<string, unknown> | null
}

// Settings (section 8): `system_settings` key `agent_updates`.

export type AgentUpdateSettings = {
  githubCheck: boolean
  githubCheckIntervalHours: number
  prefetch: boolean
  keepReleases: number
  defaultChannel: Channel
  autoUpdateAp: AutoUpdate
  autoUpdateCollector: AutoUpdate
  windowEnabled: boolean
  /** 0 = Sunday … 6. */
  windowDays: number[]
  /** HH:MM in the instance time zone. */
  windowStart: string
  windowEnd: string
  probationSeconds: number
  stableSeconds: number
  minPushes: number
  confirmGraceSeconds: number
  crashLoopRestarts: number
  downloadTimeoutSeconds: number
  /** 0 = unlimited. */
  downloadRateKbps: number
  flashReserveKiB: number
  ramReserveMiB: number
  keepPreviousMinFreeKiB: number
  allowRamRollbackOnAps: boolean
  batchSize: number
  batchGapSeconds: number
  canaryObserveMinutes: number
  offlineWaitMinutes: number
  stopOnFailure: boolean
  queueExpiryHours: number
  historyDays: number
  /** Signify public key lines (≤ 8); advisory on the controller, devices pin their own. */
  extraTrustedKeys: string[]
}

type NumericKeys<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T]
export type AgentUpdateNumericSetting = NumericKeys<AgentUpdateSettings>

/**
 * `GET` / `PATCH /api/v1/settings/agent-updates`. Only the numeric settings'
 * limits are read (`{min, max}`); whatever the server sends for the other keys
 * is ignored.
 */
export type AgentUpdateSettingsView = {
  settings: AgentUpdateSettings
  defaults: AgentUpdateSettings
  limits: Partial<Record<AgentUpdateNumericSetting, { min: number; max: number }>>
}

// Request bodies (section 9.2).

export type DeviceSettingsPatch = {
  channel?: Channel | null
  autoUpdate?: 'inherit' | AutoUpdate
  pinnedVersion?: string | null
}

export type PreflightRequest = { version: string; method?: UpdateMethod; source?: 'release' | 'previous' }
export type PreflightResponse = { preflight: AgentPreflight; release: { id: number; version: string } | null }

export type UpdateRequest = {
  version: string
  method?: UpdateMethod
  when?: 'now' | 'window'
  acceptUnrecoverable?: boolean
}

export type ReleaseCheckResult = {
  checkedAt: string
  found: {
    product: AgentProduct
    version: string
    status: 'new' | 'known' | 'unsigned' | 'rejected'
    reason: string | null
  }[]
}

export type CreateRolloutRequest = {
  product: AgentProduct
  version: string
  deviceKeys?: string[]
  canaryKey?: string
  method?: 'auto' | UpdateMethod
  batchSize?: number
  batchGapSeconds?: number
  canaryObserveMinutes?: number
  offlineWaitMinutes?: number
  stopOnFailure?: boolean
  respectWindow?: boolean
  acceptUnrecoverable?: boolean
}

export type JobsQuery = { deviceKey?: string; state?: 'open' | 'final' | 'all'; limit?: number; before?: number }
export type JobsPage = { jobs: AgentUpdateJobListItem[]; nextBefore: number | null }

export type EventsQuery = {
  deviceKey?: string
  rolloutId?: number
  jobId?: number
  severity?: EventSeverity
  limit?: number
}
export type EventsPage = { events: AgentUpdateEvent[]; nextBefore: number | null }
