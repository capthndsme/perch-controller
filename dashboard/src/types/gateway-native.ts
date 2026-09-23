import type { Mwan3Observation } from '@/types/api'
import type { GatewayDns, SectionScope, SectionStatus } from '@/types/gateway-config'
import type { NetworkApply, NetworkIssue } from '@/types/networks'

/**
 * The rest of native OpenWrt sync (metrics-be docs/gateway/native-sync.md;
 * plan 2 phase 4): DHCP pools with their options, DHCP tags, reservation
 * tags, DNS settings, static routes and the system section. Shapes mirror
 * the services in `app/services/gateway_config/{dhcp,dns,routing,system}_service.ts`.
 */

/** Per-object sync info (`native_common.ts` `SyncInfo`). */
export type SyncInfo = {
  perchId: string
  section: string
  owner: 'perch' | 'router'
  scope: SectionScope
  issue: string | null
  status: SectionStatus
  applied: boolean
  conflict: boolean
  driftSince: string | null
}

/** Every native write answers this. */
export type NativeWrite<T> = {
  gatewayId: number
  object: T
  issues: NetworkIssue[]
  apply: NetworkApply | null
  applyError: { error: string; message: string } | null
}

// ── DHCP ────────────────────────────────────────────────────────────────────

export type DhcpOptionsView = {
  gateway: string | null
  dnsServers: string[]
  ntpServers: string[]
  domain: string | null
  other: Array<{ code: number | null; name: string | null; value: string; raw: string }>
}

export type DhcpOptionsInput = {
  gateway?: string | null
  dnsServers?: string[] | null
  ntpServers?: string[] | null
  domain?: string | null
  other?: Array<{ code: number; value: string }> | null
}

export type DhcpPool = {
  network: string
  perchId: string
  section: string
  subnet: string | null
  routerAddress: string | null
  enabled: boolean
  start: number | null
  limit: number | null
  leaseTime: string | null
  force: boolean
  options: DhcpOptionsView
  ipv6: { ra: string | null; dhcpv6: string | null; ndp: string | null; raFlags: string[] }
  management: boolean
  sync: SyncInfo
}

export type DhcpTag = {
  perchId: string
  name: string
  options: DhcpOptionsView
  force: boolean
  reservations: string[]
  sync: SyncInfo
}

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
  status: string
  scope: SectionScope
  applied: boolean
  conflict: boolean
  driftSince: string | null
  tags: string[]
  network: string | null
}

export type GatewayDhcp = {
  gatewayId: number
  pools: DhcpPool[]
  reservations: DhcpReservation[]
  tags: DhcpTag[]
  odhcpd: { maindhcp: boolean } | null
}

export type PoolPatch = {
  enabled?: boolean
  start?: number
  limit?: number
  leaseTime?: string
  force?: boolean
  options?: DhcpOptionsInput
  confirm?: string
}

export type TagInput = { name?: string; options?: DhcpOptionsInput; force?: boolean }

export type ReservationPatch = {
  ip?: string | null
  hostname?: string | null
  leaseTime?: string | null
  publishDns?: boolean
  tags?: string[]
}

// ── DNS ─────────────────────────────────────────────────────────────────────

export type ItemOwner = 'perch' | 'router'

export type DnsInstanceSettings = {
  domain: string | null
  local: string | null
  rebindProtection: boolean
  noresolv: boolean
  port: number | null
  interfaces: string[]
  notInterfaces: string[]
  upstreams: Array<{ value: string; owner: ItemOwner }>
  forwards: Array<{ value: string; domains: string[]; server: string | null; owner: ItemOwner }>
  addresses: Array<{ value: string; domains: string[]; address: string; owner: ItemOwner }>
  rebindDomains: Array<{ value: string; owner: ItemOwner }>
  other: Array<{ option: string; value: string; owner: ItemOwner }>
}

export type DnsInstance = {
  perchId: string
  section: string
  settings: DnsInstanceSettings
  suggestRebindDomain: boolean
  sync: SyncInfo
}

export type DnsSettings = {
  gatewayId: number
  dnsmasqPort: number | null
  frontResolver: string | null
  adguard: boolean
  instances: DnsInstance[]
  controllerHost: {
    name: string | null
    addresses: string[]
    error: string | null
    source: string
    pinned: boolean
    local: boolean
  }
  observedAt: string | null
}

export type GatewayDnsFull = GatewayDns & { settings: DnsSettings }

export type DnsSettingsPatch = {
  instance?: string
  domain?: string | null
  local?: string | null
  rebindProtection?: boolean
  noresolv?: boolean
  upstreams?: string[]
  forwards?: Array<{ domain: string; server: string | null }>
  addresses?: Array<{ domain: string; address: string | null }>
  rebindDomains?: string[]
}

export type DnsSettingsWrite = GatewayDnsFull & {
  issues: NetworkIssue[]
  apply: NetworkApply | null
  applyError: { error: string; message: string } | null
}

// ── Routing ─────────────────────────────────────────────────────────────────

export type RouteType =
  | 'unicast'
  | 'local'
  | 'broadcast'
  | 'multicast'
  | 'unreachable'
  | 'prohibit'
  | 'blackhole'
  | 'anycast'
  | 'throw'

export const ROUTE_TYPES: RouteType[] = [
  'unicast',
  'local',
  'broadcast',
  'multicast',
  'unreachable',
  'prohibit',
  'blackhole',
  'anycast',
  'throw',
]

export type StaticRoute = {
  id: string
  family: 4 | 6
  interface: string | null
  target: string | null
  gateway: string | null
  metric: number | null
  table: string | null
  type: RouteType | string
  enabled: boolean
  managementPath: boolean
  installed: boolean | null
  extra: Record<string, string | string[]>
  sync: SyncInfo
}

export type PolicyRule = {
  id: string
  family: 4 | 6
  section: string
  options: Record<string, string | string[]>
  priority: number | null
  lookup: string | null
}

export type ConfigSectionRow = {
  id: string
  section: string
  type: string
  options: Record<string, string | string[]>
}

export type GatewayRouting = {
  gatewayId: number
  routes: StaticRoute[]
  policyRules: PolicyRule[]
  interfaces: Array<{ name: string; up: boolean | null; lan: boolean }>
  management: { network: string | null; controllerAddress: string | null }
  mwan3: { config: ConfigSectionRow[] | null; observed: Mwan3Observation | null }
  pbr: { config: ConfigSectionRow[] | null }
}

export type RouteInput = {
  family?: 4 | 6
  interface?: string | null
  target?: string
  gateway?: string | null
  metric?: number | null
  table?: string | null
  type?: RouteType
  enabled?: boolean
}

// ── System ──────────────────────────────────────────────────────────────────

export type SystemConfig = {
  hostname: string | null
  zonename: string | null
  timezone: string | null
  ntp: { enabled: boolean; server: boolean; servers: string[]; sync: SyncInfo } | null
  sync: SyncInfo | null
  zoneNames: string[]
}

export type SystemPatch = {
  hostname?: string
  timezone?: string
  ntpEnabled?: boolean
  ntpServe?: boolean
  ntpServers?: string[]
}
