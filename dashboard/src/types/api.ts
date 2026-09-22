export type User = {
  id: number
  fullName: string | null
  email: string
  role: string
  mustChangePassword?: boolean
  createdAt?: string
  updatedAt?: string
  initials?: string
}

export type AuthResponse = {
  user: User
  token: string
}

export type CollectorStatus = {
  ok: boolean
  checkedAt: string
  latencyMs?: number
  error?: string
  totalDevices?: number
  captureInterface?: string
  /** Reported by the collector's `meta.version`, when it exposes one. */
  version?: string
  /** Consecutive failed polls. Absent/0 when the last poll succeeded. */
  failures?: number
  /** Set while the collector reports gateway stats (it runs on the router). */
  gateway?: CollectorGatewayReport
}

/**
 * How the controller gets a collector's counters: `poll` = it polls the
 * collector's HTTP API, `agent` = the collector dials in over a WebSocket and
 * pushes them (docs/collector-agent.md).
 */
export type CollectorTransport = 'poll' | 'agent'

/** The live WebSocket session of a socket collector. */
export type CollectorConnection = {
  online: boolean
  connectedAt: string | null
  /** The address the socket came from. */
  address: string | null
  /**
   * true: the live session reached the controller over TLS; false: plain,
   * unencrypted HTTP/WebSocket; null (or absent, older servers): offline, or
   * behind a proxy that does not say (X-Forwarded-Proto).
   */
  secure?: boolean | null
}

/** The last gateway report of a collector that runs on the router. */
export type CollectorGatewayReport = {
  reportedAt: string
  wanInterfaces: string[]
  /** `configured` or `default-route`. */
  wanSource: string
}

/**
 * Who put a collector row in the table: an admin (`manual`), the
 * `COLLECTOR_URL` env of the server process (`env`), or the collector itself
 * through `POST /api/v1/collectors/announce` (`announced`).
 */
export type CollectorSource = 'manual' | 'env' | 'announced'

/**
 * What the poller is allowed to do with a row. `pending` and `dismissed` are
 * never polled; "disabled" is not a lifecycle, it is `enabled === false` on an
 * `adopted` row.
 */
export type CollectorLifecycle = 'pending' | 'adopted' | 'dismissed'

/** A collector as the admin-only settings API describes it. Never carries the key. */
export type Collector = {
  id: number
  name: string
  /**
   * The address the controller polls. `null` for a socket collector whose API
   * only answers on its own loopback: there is nothing to poll.
   */
  baseUrl: string | null
  transport: CollectorTransport
  /** Socket rows only (`null` for polled rows). */
  connection: CollectorConnection | null
  /** Present while this collector reports gateway stats. */
  gateway: CollectorGatewayReport | null
  hasApiKey: boolean
  /** First 8 hex chars of sha256(api key) — safe to display, comparable by hand. */
  apiKeyFingerprint: string | null
  pollIntervalSeconds: number
  enabled: boolean
  source: CollectorSource
  lifecycle: CollectorLifecycle
  instanceId: string | null
  hostname: string | null
  version: string | null
  captureInterface: string | null
  /** The address the collector claimed; `baseUrl` is what the controller polls. */
  announcedBaseUrl: string | null
  lastAnnounceAt: string | null
  lastSeenAt: string | null
  lastStatus: CollectorStatus | null
  createdAt: string
  updatedAt: string | null
}

/**
 * `GET /api/v1/collectors` — what a non-admin may see. Deliberately carries no
 * address and no key material.
 */
export type CollectorSummary = {
  id: number
  name: string
  hostname: string | null
  captureInterface: string | null
  enabled: boolean
  lastSeenAt: string | null
  ok: boolean | null
}

export type WifiSignalQuality =
  | 'excellent'
  | 'very_good'
  | 'good'
  | 'fair'
  | 'weak'
  | 'very_weak'

export type DeviceWifiSummary =
  | {
      connected: false
    }
  | {
      connected: true
      apId: number
      ap: string
      ssid: string | null
      band: string | null
      signalDbm: number | null
      signalQuality: WifiSignalQuality | null
      snrDb: number | null
      txRateKbps: number | null
      rxRateKbps: number | null
      inactiveMs: number | null
      lastSeenAt: string | null
    }

/**
 * Fixed device taxonomy (`device_labels.device_type`). Mirrors
 * `DEVICE_TYPES` in the API; `deviceTypeMeta()` maps each to an icon.
 */
export type DeviceType =
  | 'phone'
  | 'tablet'
  | 'laptop'
  | 'desktop'
  | 'tv'
  | 'console'
  | 'speaker'
  | 'wearable'
  | 'camera'
  | 'iot'
  | 'printer'
  | 'nas'
  | 'server'
  | 'router'
  | 'access_point'
  | 'vehicle'
  | 'other'

/** What an operator called a device, as opposed to what DHCP calls it. */
export type DeviceLabel = {
  mac: string
  name: string | null
  deviceType: DeviceType | null
  tags: string[]
  notes: string | null
  updatedAt: string | null
  updatedByUserId: number | null
}

export type DeviceLabelResponse = {
  mac: string
  label: DeviceLabel | null
}

/** `GET /api/v1/devices/labels`: everything the labelling UI needs at once. */
export type DeviceLabelsResponse = {
  types: Array<{ id: DeviceType; label: string }>
  tags: string[]
  labels: DeviceLabel[]
}

export type DeviceLabelPayload = {
  name?: string | null
  deviceType?: DeviceType | null
  tags?: string[] | null
  notes?: string | null
}

export type DeviceSummary = {
  mac: string
  hostname?: string | null
  hostnameSource?: string | null
  /** From `device_labels`; the UI prefers `customName` over `hostname`. */
  customName?: string | null
  deviceType?: DeviceType | null
  tags?: string[]
  notes?: string | null
  primaryIp: string | null
  ips: string[]
  bytesIn: number
  bytesOut: number
  bytesInWan: number
  bytesOutWan: number
  bytesInLan: number
  bytesOutLan: number
  packetsIn: number
  packetsOut: number
  mbpsIn: number
  mbpsOut: number
  mbpsInWan: number
  mbpsOutWan: number
  mbpsInLan: number
  mbpsOutLan: number
  resolutionSeconds: number
  lastBucketStart: string
  lastSeenAt: string
  collector: {
    id: number
    name: string
    lastStatus: CollectorStatus | null
  }
  wifi: DeviceWifiSummary
}

export type WifiSignalDistribution = {
  excellent: number
  veryGood: number
  good: number
  fair: number
  weak: number
  veryWeak: number
  unknown: number
}

export type WifiSsidSummary = {
  ssid: string
  clientCount: number
  averageSignalDbm: number | null
  signalQuality: WifiSignalQuality | null
  /**
   * AP-side interface counters: `bytesIn` is what the AP *received* from
   * its stations (client upload), `bytesOut` what it *transmitted* (client
   * download). Swap them when labelling as down/up.
   */
  bytesIn: number
  bytesOut: number
  quality: number | null
  noiseDbm: number | null
  channel: number | null
  frequencyMhz: number | null
  radios: string[]
  bands: string[]
  accessPoints: string[]
}

/**
 * Where an AP's metrics come from: `scrape` = its Prometheus `/metrics`
 * endpoint over HTTP (node_exporter), `agent` = Perch AP Daemon (`perch-apd`)
 * over the WebSocket (docs/ap-controller.md).
 */
export type WifiTransport = 'scrape' | 'agent'

/** Which AP commands the dashboard may offer right now, and over what. */
export type WifiApControls = {
  /** `null` = no command channel (no agent, SSH commands off). */
  via: 'agent' | 'ssh' | null
  /** Agent connected; always `true` for SSH. */
  online: boolean
  kick: boolean
  steer: boolean
  locate: boolean
  reboot: boolean
}

export type WifiAccessPointOverview = {
  id: number
  name: string
  friendlyName: string | null
  enabled: boolean
  model: string | null
  openwrtRelease: string | null
  nodename: string | null
  pollIntervalSeconds: number
  lastSeenAt: string | null
  lastStatus: {
    ok: boolean
    checkedAt: string
    error?: string
  } | null
  transport: WifiTransport
  /** `null` for scrape APs. */
  agentOnline: boolean | null
  controls: WifiApControls
  clientCount: number
  system: {
    load1: number | null
    load5: number | null
    load15: number | null
    memTotal: number | null
    memAvailable: number | null
    memUsagePct: number | null
    conntrackEntries: number | null
    conntrackLimit: number | null
    conntrackUsagePct: number | null
    uptimeSeconds: number | null
    recordedAt: string | null
  } | null
}

export type WifiOverviewResponse = {
  range: string | null
  from: string
  to: string
  totalClients: number
  ssidCount: number
  accessPointCount: number
  signalDistribution: WifiSignalDistribution
  ssids: WifiSsidSummary[]
  accessPoints: WifiAccessPointOverview[]
  peakClientsToday?: number
  peakClients7d?: number
  peakClientsAllTime?: number
}

export type WifiClientHistoryBucket = {
  bucketStart: string
  ts: number
  bands: Record<string, number>
  aps: Record<string, number>
  total: number
}

export type WifiClientsHistoryResponse = {
  range: string | null
  from: string
  to: string
  resolution: TrafficResolution
  resolutionSeconds: number
  buckets: WifiClientHistoryBucket[]
  allBands: string[]
  allAps: string[]
}

export type WifiSsidsResponse = {
  range: string | null
  from: string
  to: string
  ssids: WifiSsidSummary[]
}

export type WifiClientSummary = {
  mac: string
  hostname?: string | null
  hostnameSource?: string | null
  customName?: string | null
  deviceType?: DeviceType | null
  tags?: string[]
  apId: number
  ap: string
  ifname: string
  ssid: string | null
  band: string | null
  signalDbm: number | null
  signalQuality: WifiSignalQuality | null
  snrDb: number | null
  txRateKbps: number | null
  rxRateKbps: number | null
  inactiveMs: number | null
  active: boolean
  lastSeenAt: string | null
}

export type WifiSsidClientsResponse = {
  ssid: string
  clientCount: number
  clients: Array<
    Omit<WifiClientSummary, 'active'> & {
      active?: boolean
    }
  >
}

export type WifiSsidThroughputResponse = {
  ssid: string
  range: string | null
  from: string
  to: string
  resolution: TrafficResolution
  resolutionSeconds: number
  /** AP-side direction, like `WifiSsidSummary`: `*In` = client upload, `*Out` = client download. */
  buckets: Array<{
    bucketStart: string
    bytesIn: number
    bytesOut: number
    mbpsIn: number
    mbpsOut: number
  }>
}

export type WifiApThroughputPoint = {
  downloadBytes: number
  uploadBytes: number
  downloadMbps: number
  uploadMbps: number
}

/**
 * `GET /api/v1/wifi/aps/throughput`. Already in client terms: `download`
 * is what the AP transmitted to its stations, `upload` what it received.
 * `aps` is busiest-first and includes enabled APs with no traffic (zeros);
 * a bucket omits an AP that had no row in that slot.
 */
export type WifiApThroughputResponse = {
  range: string | null
  from: string
  to: string
  resolution: TrafficResolution
  resolutionSeconds: number
  aps: Array<{
    id: number
    name: string
    friendlyName: string | null
    downloadBytes: number
    uploadBytes: number
  }>
  buckets: Array<{
    bucketStart: string
    aps: Record<string, WifiApThroughputPoint>
  }>
}

export type WifiClientDetailResponse = {
  mac: string
  label: DeviceLabel | null
  latest: WifiClientSummary
  roamingEvents: Array<{
    id: number
    eventType: string
    from: {
      apId: number | null
      apName: string | null
      ifname: string | null
      ssid: string | null
      band: string | null
    }
    to: {
      apId: number | null
      apName: string | null
      ifname: string | null
      ssid: string | null
      band: string | null
    }
    detectedAt: string | null
  }>
}

export type WifiClientSignalBucket = {
  bucketStart: string
  signalDbm: number | null
  signalQuality: WifiSignalQuality | null
  snrDb: number | null
  txRateKbps: number | null
  rxRateKbps: number | null
}

export type WifiClientSignalResponse = {
  mac: string
  range: string | null
  from: string
  to: string
  resolution: TrafficResolution
  resolutionSeconds: number
  buckets: WifiClientSignalBucket[]
}

export type WifiRfEntry = {
  apId: number
  ap: string
  ifname: string
  ssid: string
  radio: string
  channel: number | null
  frequencyMhz: number | null
  band: string | null
  quality: number | null
  signalDbm: number | null
  noiseDbm: number | null
  bitrateKbps: number | null
  clientCount: number
  recordedAt: string | null
}

export type WifiRfHistoryResponse = {
  range: string | null
  from: string
  to: string
  buckets: Array<{
    bucketStart: string
    ssid: string
    avgNoiseDbm: number | null
    avgSignalDbm: number | null
    avgQuality: number | null
  }>
}

export type WifiApHealthResponse = {
  ap: {
    id: number
    name: string
    friendlyName: string | null
  }
  range: string | null
  from: string
  to: string
  resolution: TrafficResolution
  resolutionSeconds: number
  buckets: Array<{
    bucketStart: string
    load1: number | null
    load5: number | null
    load15: number | null
    memTotal: number | null
    memAvailable: number | null
    conntrackEntries: number | null
    conntrackLimit: number | null
    uptimeSeconds: number | null
  }>
}

export type WifiSourceStatus = {
  ok: boolean
  checkedAt: string
  latencyMs?: number
  error?: string
  metricFamilies?: number
  model?: string
  nodename?: string
  openwrtRelease?: string
}

/** The Perch AP Daemon linked to a wifi source (Settings → WiFi sources). */
export type WifiSourceAgent = {
  online: boolean
  /** First 8 chars of the agent id. */
  idPrefix: string
  version: string | null
  arch: string | null
  hostname: string | null
  boardName: string | null
  target: string | null
  kernel: string | null
  /** `metrics`, `clients`, `kick`, `locate`, `reboot` — what the device can do now. */
  capabilities: string[]
  joinedAt: string | null
  connectedAt: string | null
  disconnectedAt: string | null
  lastAddress: string | null
  /**
   * true: the live session reached the controller over TLS; false: plain,
   * unencrypted HTTP/WebSocket; null (or absent, older servers): offline, or
   * behind a proxy that does not say (X-Forwarded-Proto).
   */
  secure?: boolean | null
}

export type WifiSource = {
  id: number
  name: string
  friendlyName: string | null
  /** `null` for APs that joined through perch-apd and were never scraped. */
  metricsUrl: string | null
  pollIntervalSeconds: number
  enabled: boolean
  enableTwoWayCommands: boolean
  sshHost: string | null
  sshPort: number
  sshUsername: string | null
  hasSshPrivateKey: boolean
  model: string | null
  openwrtRelease: string | null
  nodename: string | null
  lastSeenAt: string | null
  lastStatus: WifiSourceStatus | null
  transport: WifiTransport
  /** `null` when no agent is linked. */
  agent: WifiSourceAgent | null
  createdAt: string
  updatedAt: string | null
}

export type ApJoinTokenStatus = 'active' | 'expired' | 'revoked' | 'exhausted'

/** `GET /api/v1/settings/ap-join-tokens` row; never carries the token itself. */
export type ApJoinToken = {
  id: number
  label: string | null
  /** `mlap_` + 4 chars, for recognising a token without revealing it. */
  prefix: string
  status: ApJoinTokenStatus
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  useCount: number
  maxUses: number | null
  createdBy: { id: number; email: string } | null
}

export type CreateApJoinTokenResponse = {
  token: string
  joinToken: ApJoinToken
}

export type ApAgentArch = 'mipsle' | 'mips' | 'armv7' | 'armv5' | 'arm64' | 'amd64'

export type ApAgentAsset = {
  arch: ApAgentArch
  file: string
  label: string
  hint: string
}

/** `GET /api/v1/settings/ap-agent/install`: what the install commands point at. */
export type ApAgentInstallInfo = {
  controllerUrl: string
  releaseBaseUrl: string
  installScriptUrl: string
  assets: ApAgentAsset[]
}

export type ApAgentPingResponse = {
  online: true
  latencyMs: number
}

/** Which channel carried an AP command. */
export type WifiCommandVia = 'agent' | 'ssh'

export type WifiKickResponse = {
  ok: boolean
  mac: string
  apId: number
  ifname: string
  via?: WifiCommandVia
  latencyMs?: number
}

export type WifiSteerResponse = WifiKickResponse & {
  banTimeMs: number
}

export type WifiRebootResponse = {
  ok: boolean
  apId: number
  via?: WifiCommandVia
  latencyMs?: number
}

/**
 * SSH: `blinkTimes` / `blinkDurationMs`. Agent: `active` / `durationSeconds`
 * (`active: false` after a stop).
 */
export type WifiLocateResponse = {
  ok: boolean
  apId: number
  via?: WifiCommandVia
  active?: boolean
  durationSeconds?: number
  blinkTimes?: number
  blinkDurationMs?: number
  latencyMs?: number
}

export type TrafficBucket = {
  collectorId: number | null
  bucketStart: string
  bucketEnd: string
  bytesIn: number
  bytesOut: number
  packetsIn: number
  packetsOut: number
  mbpsIn: number
  mbpsOut: number
}

export type DeviceTrafficResponse = {
  mac: string
  range: string
  resolution: string
  resolutionSeconds: number
  scope: TrafficScope
  buckets: TrafficBucket[]
}

export type AggregateTrafficResponse = {
  range: string
  resolution: TrafficResolution
  resolutionSeconds: number
  scope: TrafficScope
  summary: {
    bytesIn: number
    bytesOut: number
    latestMbpsIn: number
    latestMbpsOut: number
  }
  buckets: TrafficBucket[]
}

export type TopTrafficRank = 'total' | 'download' | 'upload'

export type TopTrafficPoint = {
  bytesIn: number
  bytesOut: number
  mbpsIn: number
  mbpsOut: number
}

export type TopTrafficDevice = {
  mac: string
  hostname: string | null
  customName?: string | null
  deviceType?: DeviceType | null
  primaryIp: string | null
  bytesIn: number
  bytesOut: number
}

/**
 * `GET /api/v1/traffic/top`: the busiest N devices as separate series plus
 * everyone else folded into `rest`. Device-perspective like `/traffic`
 * (`bytesIn` = download). A bucket omits a top device with no traffic in
 * that slot; `rest` is always present.
 */
export type TopTrafficResponse = {
  range: string | null
  from: string
  to: string
  resolution: TrafficResolution
  resolutionSeconds: number
  scope: TrafficScope
  limit: number
  by: TopTrafficRank
  devices: TopTrafficDevice[]
  rest: { deviceCount: number; bytesIn: number; bytesOut: number }
  buckets: Array<{
    bucketStart: string
    devices: Record<string, TopTrafficPoint>
    rest: TopTrafficPoint
  }>
}

export type DevicePeer = {
  collectorId: number
  peerIp: string
  scope: PeerScope
  bytesIn: number
  bytesOut: number
  /** ASN-derived service label when known (e.g. "Netflix", "Google"). */
  service?: string | null
  updatedAt: string | null
}

export type ProtocolBreakdown = {
  protocol: string
  /**
   * nDPI application category slug ("web", "media", "vpn", …; 'other' when
   * unknown). Optional so an older API build without it still type-checks.
   */
  category?: string
  bytesIn: number
  bytesOut: number
  packetsIn?: number
  packetsOut?: number
  percentage: number
}

export type ProtocolTimeSeriesPoint = {
  bucketStart: string
  bucketEnd?: string
  protocols: Record<string, { bytesIn: number; bytesOut: number }>
}

export type ProtocolsResponse = {
  mac?: string
  range: string
  resolution: string
  resolutionSeconds: number
  protocols: ProtocolBreakdown[]
  timeSeries: ProtocolTimeSeriesPoint[]
}

export type ProtocolTopDevice = {
  collectorId: number
  mac: string
  hostname?: string | null
  hostnameSource?: string | null
  customName?: string | null
  deviceType?: DeviceType | null
  primaryIp: string | null
  ips: string[]
  bytesIn: number
  bytesOut: number
  packetsIn: number
  packetsOut: number
  totalBytes: number
  percentage: number
}

export type ProtocolTopDevicesResponse = {
  protocol: string
  range: string | null
  from: string
  to: string
  limit: number
  totalBytes: number
  devices: ProtocolTopDevice[]
  other: {
    deviceCount: number
    bytesIn: number
    bytesOut: number
    totalBytes: number
    percentage: number
  } | null
}

export type DevicePeersResponse = {
  mac: string
  scope: 'wan' | 'lan'
  peers: DevicePeer[]
}

export type DeviceIdentity = {
  collectorId: number
  mac: string
  hostname?: string | null
  hostnameSource?: string | null
  customName?: string | null
  deviceType?: DeviceType | null
  tags?: string[]
  notes?: string | null
  primaryIp: string | null
  ips: string[]
  firstSeenAt: string | null
  lastSeenAt: string | null
}

export type TopAsn = {
  asn: number | null
  org: string
  prefix: string | null
  bytesIn: number
  bytesOut: number
  totalBytes: number
  peers: Array<{ ip: string; bytesIn: number; bytesOut: number }>
}

export type DeviceOverviewResponse = {
  mac: string
  scope: TrafficScope
  identity: DeviceIdentity[]
  traffic: DeviceTrafficResponse
  peers: {
    wan: DevicePeer[]
    lan: DevicePeer[]
  }
  topAsns: TopAsn[]
  protocols: ProtocolBreakdown[]
}

/**
 * Quick-range presets. Months/years are expressed in days because the
 * backend's range grammar only understands `s|m|h|d` (e.g. `180d`, not
 * `6mo`); `formatRangeLabel` maps them back to friendly labels. The long
 * tail (`30d`–`730d`) is what the rollup/retention work made fast — the
 * 5-minute rollup covers up to 7d and the hourly rollup carries 2 years.
 */
export type TrafficRange =
  | '1m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '6h'
  | '24h'
  | '7d'
  | '30d'
  | '90d'
  | '180d'
  | '365d'
  | '730d'

export type TrafficResolution = '5s' | '15s' | '1m' | '5m' | '15m' | '1h' | '1d'

/**
 * Scope filter for traffic queries. `all` returns the totals (WAN + LAN
 * combined, the default), `wan` and `lan` return the per-scope splits.
 * Distinct from `PeerScope` which only ever takes `'wan'` or `'lan'`
 * because peer queries don't have a sensible "both" answer.
 */
export type TrafficScope = 'all' | 'wan' | 'lan'

export type PeerScope = 'wan' | 'lan'

/**
 * Frontend-only scope picker. Adds an `'overlay'` option that is rendered
 * as "WAN primary + LAN overlaid", which lets the dashboard show both
 * scopes simultaneously without a separate switch. The backend never sees
 * `'overlay'` — `apiScopeForDashboard` translates it to `'wan'` for the
 * primary query, and the LAN overlay fires a second `?scope=lan` query.
 */
export type DashboardScope = 'all' | 'overlay' | 'wan' | 'lan'

/**
 * Translates the frontend-only `DashboardScope` to the API's
 * `TrafficScope`. Overlay maps to `'wan'` because the primary chart
 * series in overlay mode is WAN — the LAN series is fetched separately
 * and rendered on top.
 */
export function apiScopeForDashboard(scope: DashboardScope): TrafficScope {
  if (scope === 'overlay') return 'wan'
  return scope
}

// ── Peer history (hourly `device_peer_buckets_hourly`) ───────────────────

export type PeerHistoryEntry = {
  peerIp: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
  percentage: number
  deviceCount: number
  firstHour: string | null
  lastHour: string | null
  asn: number | null
  org: string | null
  prefix: string | null
}

export type TopPeersResponse = {
  scope: PeerScope
  range: string | null
  from: string
  to: string
  limit: number
  totalBytes: number
  peers: PeerHistoryEntry[]
  asns: TopAsn[]
}

export type DevicePeerHistoryResponse = TopPeersResponse & { mac: string }

// ── Services (TLS SNI / server names) ───────────────────────────────────

export type ServiceServer = {
  mac: string
  hostname: string | null
  customName?: string | null
  primaryIp: string | null
  bytesServed: number
  bytesReceived: number
}

export type ServiceSummary = {
  serverName: string
  protocol: string
  bytesServed: number
  bytesReceived: number
  totalBytes: number
  percentage: number
  servers: ServiceServer[]
}

export type ServerSummary = {
  mac: string
  hostname: string | null
  customName?: string | null
  primaryIp: string | null
  bytesServed: number
  bytesReceived: number
  totalBytes: number
  serviceCount: number
}

export type ServicesResponse = {
  range: string | null
  from: string
  to: string
  limit: number
  totalBytesServed: number
  totalBytesReceived: number
  services: ServiceSummary[]
  servers: ServerSummary[]
}

export type DeviceServicesResponse = {
  mac: string
  range: string | null
  from: string
  to: string
  totalBytesServed: number
  services: Array<{
    serverName: string
    protocol: string
    bytesServed: number
    bytesReceived: number
    totalBytes: number
    percentage: number
  }>
}

export type ServiceTrafficBucket = {
  bucketStart: string
  bucketEnd: string
  bytesServed: number
  bytesReceived: number
}

export type ServiceTrafficResponse = {
  serverName: string
  range: string | null
  from: string
  to: string
  resolution: TrafficResolution
  resolutionSeconds: number
  buckets: ServiceTrafficBucket[]
}

// ── Destinations (where a device's WAN bytes went, by name) ──────────────

/**
 * One (server name, protocol) row from the hourly destination history.
 * Bytes are from the device's point of view: `bytesIn` was downloaded from
 * the destination, `bytesOut` uploaded to it.
 */
export type DestinationEntry = {
  /** null = flows nDPI labelled (e.g. "netflix") but never saw a name. */
  serverName: string | null
  /** Registered domain of serverName, the IP for IP-literal names, null when unnamed. */
  domain: string | null
  /**
   * Peer address of an unnamed TLS/HTTP/QUIC row (the hello was never
   * captured); null for named rows and for the per-protocol pool.
   */
  peerIp: string | null
  /** ASN / organisation of `peerIp` when known. */
  asn: number | null
  org: string | null
  protocol: string
  /** nDPI category slug; 'other' when unknown. */
  category: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
  /** Of totalBytes across the whole window, one decimal. */
  percentage: number
  deviceCount: number
}

export type DestinationName = {
  serverName: string | null
  /** Address of an unnamed-by-address member (see DestinationEntry.peerIp). */
  peerIp: string | null
  protocol: string
  category: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
}

export type DestinationDomainGroup = {
  /**
   * "d:<domain>" (named), "a:<asn|org|ip>" (unnamed flows grouped by
   * network: domain and protocol null, org/asn set, names are addresses)
   * or "p:<protocol>" for the pool of families that never carry a name.
   */
  key: string
  /** null for network groups and the unnamed pool. */
  domain: string | null
  /** Set only for the unnamed pool (its protocol label). */
  protocol: string | null
  /** Network of an address group: ASN + organisation ("Google LLC"). */
  asn: number | null
  org: string | null
  /** Dominant category of the group. */
  category: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
  percentage: number
  nameCount: number
  deviceCount: number
  /** Top 10 members, sorted desc. */
  names: DestinationName[]
}

export type DestinationCategoryEntry = {
  category: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
  percentage: number
}

export type DestinationsResponse = {
  range: string | null
  from: string
  to: string
  limit: number
  totalBytes: number
  totalBytesIn: number
  totalBytesOut: number
  /** Top `limit` names by totalBytes. */
  destinations: DestinationEntry[]
  /** Top `limit` domain groups by totalBytes. */
  domains: DestinationDomainGroup[]
  /** Every category in the window, sorted desc. */
  categories: DestinationCategoryEntry[]
}

export type DeviceDestinationsResponse = DestinationsResponse & { mac: string }

export type DestinationTrafficBucket = {
  bucketStart: string | null
  bucketEnd: string | null
  bytesIn: number
  bytesOut: number
}

export type DestinationTrafficResponse = {
  serverName: string
  range: string | null
  from: string
  to: string
  resolution: '1h' | '1d'
  resolutionSeconds: number
  buckets: DestinationTrafficBucket[]
}

// ── Usage (vnstat-style buckets per local day / week / month) ───────────

export type UsagePeriod = 'day' | 'week' | 'month'

/** Same semantics as `TrafficScope`; protocols are always totals regardless. */
export type UsageScope = TrafficScope

export type UsageProtocol = {
  protocol: string
  category: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
  /** Of the bucket's protocol total. */
  percentage: number
}

export type UsageOtherProtocols = {
  count: number
  bytesIn: number
  bytesOut: number
  totalBytes: number
  percentage: number
} | null

/** Bytes per application category inside a bucket — complete, not top-N. */
export type UsageCategory = {
  category: string
  bytesIn: number
  bytesOut: number
  totalBytes: number
  /** Of the bucket's protocol total. */
  percentage: number
}

/** `null` fields when the bucket has no Wi-Fi client totals. */
export type UsageWifiClients = {
  avg: number | null
  max: number | null
  peakAt: string | null
}

export type UsageBucket = {
  /** UTC ISO; aligned to the instance timezone (local midnight / Monday / 1st). */
  bucketStart: string
  bucketEnd: string
  /** `2026-09-18`, `2026-W38` or `2026-09`. */
  label: string
  /** Still running (today / this week / this month) or cut short by `to`. */
  partial: boolean
  /** Covered seconds (elapsed for a partial bucket). */
  seconds: number
  bytesIn: number
  bytesOut: number
  totalBytes: number
  /** totalBytes × 8 / seconds / 1e6, rounded to 2 dp. */
  avgMbps: number
  /** Distinct MACs with traffic in the bucket. */
  activeDevices: number
  wifiClients: UsageWifiClients
  /** Top N, sorted desc. */
  protocols: UsageProtocol[]
  otherProtocols: UsageOtherProtocols
  /** Every category in the bucket, sorted desc. */
  categories: UsageCategory[]
}

export type UsageInterval = '1h' | '4h' | '8h' | '12h'
export type UsageIntervalRequest = 'auto' | UsageInterval

/** One sub-day slot of the hourly breakdown, aligned to local midnight. */
export type UsageIntervalBucket = {
  bucketStart: string
  bucketEnd: string
  partial: boolean
  seconds: number
  bytesIn: number
  bytesOut: number
  totalBytes: number
  avgMbps: number
  activeDevices: number
}

export type UsageIntervalsResponse = {
  range: string | null
  interval: UsageInterval
  intervalSeconds: 3600 | 14400 | 28800 | 43200
  from: string
  to: string
  scope: UsageScope
  timezone: string
  offsetMinutes: number
  buckets: UsageIntervalBucket[]
}

/** `activeDevices` is distinct over the window; `wifiClients` avg/max over the window. */
export type UsageTotals = Omit<UsageBucket, 'bucketStart' | 'bucketEnd' | 'label' | 'partial'>

export type UsageResponse = {
  period: UsagePeriod
  range: string | null
  from: string
  to: string
  scope: UsageScope
  timezone: string
  offsetMinutes: number
  source: 'hourly' | 'daily'
  protocolsLimit: number
  /** Every bucket in the window, oldest first, empty ones included with zeros. */
  buckets: UsageBucket[]
  totals: UsageTotals
}

// ── Gateway (reported by the collector on the router) ────────────────────

export type RouterResolutionRequest = 'auto' | '1m' | '5m' | '15m' | '1h'

export type RouterLatest = {
  recordedAt: string
  ageSeconds: number
  conntrackEntries: number | null
  conntrackLimit: number | null
  /** Table fill, one decimal. */
  conntrackPct: number | null
  tcpEstablished: number | null
  load1: number | null
  memTotal: number | null
  memAvailable: number | null
  wanIfaces: string[]
  wanRxBytes: number | null
  wanTxBytes: number | null
  wanRxBps: number | null
  wanTxBps: number | null
  /** WAN receive = the house's download. */
  wanRxMbps: number | null
  /** WAN transmit = the house's upload. */
  wanTxMbps: number | null
}

export type RouterSeriesBucket = {
  bucketStart: string
  ts: number
  /** Average over the bucket. */
  conntrackEntries: number | null
  conntrackMax: number | null
  tcpEstablished: number | null
  load1: number | null
  wanRxMbps: number | null
  wanTxMbps: number | null
}

/** The collector whose gateway reports fill the Gateway panel. */
export type RouterSource = {
  collectorId: number
  name: string
  transport: CollectorTransport
  /** Socket rows: the socket is open. Polled rows: the last poll succeeded. */
  online: boolean
  wanInterfaces: string[]
  wanSource: 'configured' | 'default-route'
  /** Last gateway report. */
  reportedAt: string
}

export type RouterResponse = {
  /**
   * The most recent reporter among the adopted collectors; `null` when no
   * collector reports gateway stats (history may still be in `series`).
   */
  source: RouterSource | null
  /** `source.wanInterfaces`, or `[]`. */
  wanIfaces: string[]
  range: string | null
  from: string
  to: string
  resolution: '1m' | '5m' | '15m' | '1h'
  resolutionSeconds: number
  /** null until the first gateway report. */
  latest: RouterLatest | null
  series: RouterSeriesBucket[]
}
