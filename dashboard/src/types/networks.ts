/**
 * Networks of a managed gateway: multi-LAN and VLANs (metrics-be
 * docs/gateway/networks.md section 3; the write envelope and the apply are
 * config-plane.md section 10.1). Kept apart from `types/api.ts` and the config
 * plane's own types so parallel branches merge cleanly: the few config plane
 * shapes used here (`SectionStatus`, `Issue`, `GatewayApply`, the gateway
 * row) are the subsets this page reads.
 */

export type SectionStatus = 'in_sync' | 'ahead' | 'pending' | 'conflict' | 'drift' | 'reverting'

export type NetworkPurpose = 'lan' | 'guest' | 'iot' | 'management' | 'custom'

export type NetworkL2Mode = 'bridge' | 'bridge_vlan' | '8021q' | 'device'

/** `'lan1:t'` = tagged, not the PVID; `'lan3:u*'` = untagged PVID port. */
export type NetworkPort = { port: string; tagged: boolean; pvid: boolean }

export type DhcpPoolView = {
  perchId: string
  section: string
  enabled: boolean
  start: number | null
  limit: number | null
  leaseTime: string | null
  owner: 'perch' | 'router'
  status: SectionStatus
}

/** The collector's capture counters for the network (cumulative). */
export type CaptureCounters = {
  bytesInWan: number
  bytesOutWan: number
  bytesInLan: number
  bytesOutLan: number
  packetsInWan: number
  packetsOutWan: number
  packetsInLan: number
  packetsOutLan: number
  /** Which rule splits WAN from LAN (owner decision 8: `routed` counts routed LAN↔LAN as LAN). */
  scope: 'routed' | 'legacy' | null
  kernelDrops: number | null
}

export type NetworkLive = {
  reportedAt: string
  up: boolean | null
  device: string | null
  proto: string | null
  ipv4: string[]
  ipv6: string[]
  /** Router side: rx = received from the network. */
  rxBytes: number | null
  txBytes: number | null
  /** Bits/s, router side. */
  rxBps: number | null
  txBps: number | null
  /** Client terms: download = txBps, upload = rxBps. */
  downloadBps: number | null
  uploadBps: number | null
  captured: boolean | null
  devices: number | null
  activeDevices: number | null
  capture: CaptureCounters | null
}

export type GatewayNetwork = {
  /** `gateway_networks.id`, the `:networkId` of the routes. */
  id: number
  gatewayId: number
  key: string
  label: string
  purpose: NetworkPurpose
  capture: boolean
  captureChangedAt: string | null
  /** The interface section; null = known from the collector's report only. */
  perchId: string | null
  /** `perch` = synced, `router` = mirrored (excluded / unmodeled), null = report only. */
  owner: 'perch' | 'router' | null
  l2Mode: NetworkL2Mode | null
  bridge: string | null
  vlanId: number | null
  parentDevice: string | null
  device: string | null
  proto: string | null
  ports: NetworkPort[]
  /** `192.168.1.1/24` */
  ipv4: string | null
  ipv4All: string[]
  status: SectionStatus | null
  /** The draft removes it (until the apply). */
  deleting: boolean
  /** The network the agent reaches the controller through (README 3.8). */
  management: boolean
  sections: string[]
  dhcp: DhcpPoolView | null
  firewallZone: string | null
  live: NetworkLive | null
}

export type NetworkIssue = {
  severity: 'error' | 'warning'
  code: string
  message: string
  perchId?: string | null
  config?: string
  section?: string
  option?: string
}

export type ApplyState =
  | 'queued'
  | 'sending'
  | 'pending_confirm'
  | 'confirmed'
  | 'rolled_back'
  | 'failed'
  | 'expired'
  | 'cancelled'

/** The subset of the config plane's `GatewayApply` this page shows. */
export type NetworkApply = {
  id: string
  kind: 'apply' | 'revert' | 'adopt' | 'package'
  state: ApplyState
  confirmMode: 'agent' | 'admin_and_agent'
  confirmTimeoutSeconds: number
  protected: boolean
  deadlineAt: string | null
  requestedAt: string
  perchIds: string[]
  configs: string[]
  changes?: Array<{ perchId: string | null; config: string; section: string; type: string; action: string }>
}

export type NetworkConversion = { bridge: string; untaggedVlan: number; moved: string[] }

export type NetworkWrite = {
  object: GatewayNetwork | null
  issues: NetworkIssue[]
  converted: NetworkConversion | null
  /** The first job of the apply request; null with `?apply=0` or when none started. */
  apply: NetworkApply | null
  /** Why no apply started; the draft keeps the change. */
  applyError: { error: string; message: string } | null
}

export type NetworkDhcpInput = { enabled?: boolean; start: number; limit: number; leaseTime: string }

export type NetworkCreate = {
  key: string
  l2Mode: NetworkL2Mode
  bridge?: string | null
  vlanId?: number | null
  parentDevice?: string | null
  ports?: NetworkPort[]
  ipv4?: string | null
  dhcp?: NetworkDhcpInput | null
  untaggedVlan?: number
  label?: string
  purpose?: NetworkPurpose
  capture?: boolean
  firewallZone?: string | null
}

export type NetworkPatch = {
  ipv4?: string | null
  ports?: NetworkPort[]
  vlanId?: number
  /** null removes the pool. */
  dhcp?: NetworkDhcpInput | null
  label?: string
  purpose?: NetworkPurpose
  capture?: boolean
  firewallZone?: string | null
}

export type NetworkHistoryPoint = {
  bucketStart: string
  ts: number
  /** Bucket averages of the 30 s rates, router side. */
  rxBps: number | null
  txBps: number | null
  rxPeakBps: number | null
  txPeakBps: number | null
}

export type NetworkScopeMark = { scope: 'routed' | 'legacy'; changedAt: string }

export type NetworkHistory = {
  gatewayId: number
  range: string | null
  from: string
  to: string
  resolution: string
  resolutionSeconds: 60 | 300 | 900 | 3600
  /** The scope rule in force at `from`; null = never reported. */
  scopeAtStart: 'routed' | 'legacy' | null
  /** Inside the window. */
  scopeChanges: NetworkScopeMark[]
  networks: Array<{ network: string; points: NetworkHistoryPoint[] }>
}

export type NetworkHistoryResolution = 'auto' | '1m' | '5m' | '15m' | '1h'

/** `GET /networks`: one row per network over every gateway. */
export type NetworkSummary = {
  gatewayId: number
  id: number
  key: string
  label: string
  purpose: string
  vlanId: number | null
  ipv4: string | null
  capture: boolean
  captured: boolean | null
  up: boolean | null
  rxBps: number | null
  txBps: number | null
  downloadBps: number | null
  uploadBps: number | null
  devices: number | null
  activeDevices: number | null
  management: boolean
}

export type ScopeChange = { gatewayId: number; scope: 'routed' | 'legacy'; changedAt: string }

/** Newest first, at most 200. */
export type DeviceNetworkInterval = {
  gatewayId: number
  network: string
  startedAt: string
  endedAt: string | null
}

export type DeviceNetworks = {
  mac: string
  latest: { gatewayId: number; network: string; seenAt: string } | null
  history: DeviceNetworkInterval[]
}

/** `/devices` rows and `/devices/:mac/presence` carry this (the newest over all gateways). */
export type DeviceNetworkRef = { gatewayId: number; name: string; since: string }

export type GatewayMode = 'off' | 'observe' | 'managed'

/**
 * The fields of the config plane's `Gateway` (`GET /gateways`) this page
 * reads. Same request and cache entry as the config plane pages.
 */
export type GatewayBrief = {
  id: number
  collectorId: number | null
  name: string
  detached: boolean
  online: boolean
  mode: GatewayMode
  writable: boolean
  writeBlockedReason:
    | 'offline'
    | 'no_capability'
    | 'router_access'
    | 'insecure_transport'
    | 'not_paired'
    | 'sign_key_unknown'
    | null
  pendingApply: NetworkApply | null
}
