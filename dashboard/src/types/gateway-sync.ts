/**
 * Gateway sync: the rest of the managed gateway's native OpenWrt settings
 * (design docs/design/gateway-sync/rest.md, 2026-09-30). WAN, WireGuard,
 * IPv6, the ambiguity flow, firewall defaults, UPnP, DDNS, multi-WAN and
 * apply checks. Area types live here, not in `api.ts` or
 * `gateway-config.ts` (coordination rule), so the branches merge apart.
 */

import type { UpnpMapping } from '@/types/api'
import type { ApplyKind, ConfirmMode, GatewayApply, GatewayDraft, Issue } from '@/types/gateway-config'
import type { SyncInfo } from '@/types/gateway-native'

export type { SyncInfo }

// ── Shared (rest.md 1) ──────────────────────────────────────────────────────

export type DeviceRef = { mac: string; name: string | null }
/** Unmodeled options, shown read-only. */
export type Extra = Record<string, string | string[]>
/** Never a value: whether a secret is set, and who set it. */
export type SecretState = { set: boolean; owner: 'router' | 'controller' | null }

/** Why an area page cannot write (its overview's `unavailableReason`). */
export type SyncUnavailableReason = 'capability_missing' | 'not_installed' | 'router_access' | 'not_managed'

/** The envelope of every write of this area (native-sync.md 164-173). */
export type WriteAnswer<T> = {
  gatewayId: number
  object: T | null
  issues: Issue[]
  /** The first job of the request, with `changes` and `checks`. */
  apply: GatewayApplyWithChecks | null
  /** Why no apply started; the draft is kept. */
  applyError: { error: string; message: string } | null
}

// ── Applies: checks (rest.md 2, protocol.md 1) ──────────────────────────────

export type CheckKind = 'interface_up' | 'default_route' | 'reach' | 'resolve' | 'wg_handshake'
export type CheckItemState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'
export type ChecksState = 'pending' | 'running' | 'passed' | 'failed' | 'overridden'

export type CheckItem = {
  id: string
  kind: CheckKind
  network: string | null
  family: 4 | 6 | null
  targets: string[] | null
  name: string | null
  mustPass: boolean
  state: CheckItemState
  /** A short text from the router ("up after 4.1 s, 203.0.113.10/24"). */
  detail: string | null
  at: string | null
}

export type ApplyChecks = {
  state: ChecksState
  timeoutSeconds: number
  startedAt: string | null
  /** Every item that is not `mustPass` failed before the change and was skipped. */
  allSkipped: boolean
  items: CheckItem[]
  overriddenBy: { id: number; email: string } | null
  overriddenAt: string | null
}

/** What the router generated during an apply (a WireGuard key: only its public half). */
export type GeneratedValue = { config: string; section: string; option: string; publicKey: string }

/** `GatewayApply` with the fields this area adds (served when present). */
export type GatewayApplyWithChecks = Omit<GatewayApply, 'outcome'> & {
  checks?: ApplyChecks | null
  outcome:
    | (NonNullable<GatewayApply['outcome']> & {
        /** The failed items, when `reason` is `checks_failed`. */
        checks?: CheckItem[]
        generated?: GeneratedValue[]
      })
    | null
}

/** `POST /gateways/:id/applies/:applyId/confirm` body. */
export type ConfirmApplyBody = {
  overrideChecks?: boolean
  /** The gateway's name, with `overrideChecks`. */
  confirm?: string
}

/** A planned job of `GET /gateways/:id/draft`, with what the router will verify. */
export type SyncDraftJob = {
  kind: ApplyKind
  protected: boolean
  configs: string[]
  perchIds: string[]
  checked?: boolean
  /** The items the router would run (their `state` is `pending`). */
  checks?: CheckItem[] | null
  confirmTimeoutSeconds?: number
  confirmMode?: ConfirmMode
}

export type SyncDraft = Omit<GatewayDraft, 'jobs'> & { jobs: SyncDraftJob[] }

// ── WAN (rest.md 3) ─────────────────────────────────────────────────────────

export type WanRole = 'internet' | 'nat_link'
export type WanIpv6Mode = 'off' | 'auto' | 'dhcpv6' | 'relay' | 'static'

export type WanAlias = {
  id: string
  network: string
  addresses: string[]
  zone: string | null
  extra: Extra
  sync: SyncInfo
}

export type WanView = {
  /** The interface's perch id. */
  id: string
  network: string
  label: string
  role: WanRole
  /** 1 = primary; null for a NAT link. */
  failoverRank: number | null
  /** As in UCI: 'dhcp' | 'static' | 'pppoe' | 'qmi' | … */
  proto: string
  /** limited = a proto Perch shows verbatim: metric, dns, mtu, enabled only. */
  editable: 'full' | 'limited'
  device: string | null
  enabled: boolean
  metric: number | null
  defaultRoute: boolean
  dns: { useProvider: boolean; servers: string[] }
  static: { addresses: string[]; gateway: string | null; broadcast: string | null } | null
  pppoe: {
    username: string | null
    password: SecretState
    service: string | null
    ac: string | null
    keepalive: string | null
  } | null
  dhcp: { hostname: string | null; clientId: string | null; vendorId: string | null } | null
  mobile: { apn: string | null; pincode: SecretState; device: string | null } | null
  mtu: number | null
  mac: {
    effective: string | null
    source: 'device' | 'interface' | null
    deviceSection: string | null
    ignoredInterfaceMac: boolean
  }
  ipv6: {
    mode: WanIpv6Mode
    /** Perch id of the IPv6 companion interface. */
    companion: string | null
    reqAddress: string | null
    reqPrefix: string | null
    ip6prefix: string[]
    delegate: boolean | null
  }
  aliases: WanAlias[]
  pool: {
    perchId: string
    ignore: boolean
    ra: string | null
    dhcpv6: string | null
    ndp: string | null
    master: boolean
  } | null
  zone: string | null
  zoneMasq: boolean
  sqm: { queue: string; interface: string; enabled: boolean; mismatch: boolean } | null
  /** On the controller path. */
  management: boolean
  live: {
    up: boolean
    ipv4: string[]
    ipv6: string[]
    gateway4: string | null
    gateway6: string | null
    defaultRouteActive: boolean
    uptimeSeconds: number | null
    error: string | null
    ipv6Prefixes: Array<{ prefix: string; preferredUntil: string | null; validUntil: string | null }>
    mwan3Status: string | null
    observedAt: string
  } | null
  /** Perch ids: interface, companion, device, pool, aliases. */
  sections: string[]
  /** The worst of its sections. */
  sync: SyncInfo
  extra: Extra
  issues: Issue[]
  meta: { label: string; checkTargets: string[] | null; note: string | null; roleOverride: WanRole | null }
}

export type WanTransitionEvent = 'down' | 'up' | 'failover' | 'ip_changed' | 'prefix_changed'

export type WanTransition = {
  network: string
  device: string | null
  event: WanTransitionEvent
  detail: Record<string, unknown> | null
  at: string
}

export type WanOverview = {
  gatewayId: number
  available: boolean
  /** The read view still works. */
  unavailableReason: 'capability_missing' | 'router_access' | 'not_managed' | null
  uplinks: WanView[]
  natLinks: WanView[]
  failover: { mode: 'metric' | 'mwan3'; order: string[] }
  managementPath: { network: string | null; wanSide: boolean }
  /** This request comes from outside every LAN subnet. */
  adminOutside: boolean
  checks: { targets: string[]; resolveName: string | null; confirmTimeoutSeconds: number }
  /** Newest 50. */
  transitions: WanTransition[]
  observedAt: string | null
}

export type WanPatch = {
  label?: string
  enabled?: boolean
  proto?: 'dhcp' | 'static' | 'pppoe'
  metric?: number
  defaultRoute?: boolean
  dns?: { useProvider: boolean; servers: string[] }
  static?: { addresses: string[]; gateway: string | null; broadcast?: string | null }
  pppoe?: {
    username?: string
    /** Write-only; null = clear. */
    password?: string | null
    service?: string | null
    ac?: string | null
    keepalive?: string | null
  }
  dhcp?: { hostname?: string | null; clientId?: string | null; vendorId?: string | null }
  mobile?: { apn?: string | null; pincode?: string | null }
  mtu?: number | null
  /** Written to the device section; null = remove the override. */
  mac?: string | null
  ipv6?: {
    mode: 'off' | 'auto' | 'dhcpv6' | 'relay'
    reqAddress?: 'try' | 'force' | 'none'
    reqPrefix?: 'auto' | 'no' | number
  }
  /** A proto change: move the SQM queue to the new L3 device in the same job. */
  moveSqm?: boolean
  /** Perch-only (`gateway_wans`), no apply. */
  checkTargets?: string[] | null
  /** The gateway's name, for `wan_last_uplink`. */
  confirm?: string
}

export type WanCreate = WanPatch & {
  network: string
  device: string
  proto: 'dhcp' | 'static' | 'pppoe'
  /** Default: the zone of the primary uplink. */
  zone?: string | null
  createZone?: boolean
}

export type WanHistory = { gatewayId: number; from: string; to: string; transitions: WanTransition[] }

// ── WireGuard (rest.md 4) ───────────────────────────────────────────────────

export type WgPeerView = {
  /** The peer section's perch id. */
  id: string
  interface: string
  /** UCI `description`. */
  label: string | null
  publicKey: string
  presharedKey: SecretState
  allowedIps: string[]
  routeAllowedIps: boolean
  endpoint: { host: string; port: number } | null
  keepalive: number | null
  device: DeviceRef | null
  clientConfigIssuedAt: string | null
  live: {
    endpoint: string | null
    latestHandshakeAt: string | null
    /** A handshake within `wgPeerStaleMinutes`. */
    online: boolean
    rxBytes: number
    txBytes: number
  } | null
  extra: Extra
  sync: SyncInfo
}

export type WgInterfaceView = {
  id: string
  network: string
  role: 'server' | 'client' | 'site'
  enabled: boolean
  /** From the observation or the last apply's `generated`. */
  publicKey: string | null
  privateKey: SecretState & { generatedOnRouter: boolean | null }
  listenPort: number | null
  addresses: string[]
  mtu: number | null
  zone: string | null
  /** An ACCEPT rule for udp `listen_port` from a WAN zone. */
  portOpen: { rule: string; zones: string[] } | null
  management: boolean
  peers: WgPeerView[]
  live: { up: boolean; observedAt: string } | null
  extra: Extra
  sync: SyncInfo
}

export type WgOverview = {
  gatewayId: number
  available: boolean
  unavailableReason: SyncUnavailableReason | null
  canGenerateKeys: boolean
  /** Secrets (PSK, pasted keys) need verified TLS. */
  secureTransport: boolean
  interfaces: WgInterfaceView[]
  orphanPeers: Array<{ perchId: string; section: string; type: string }>
}

/** Returned ONCE, never stored. */
export type WgClientConfig = { text: string; filename: string }

export type WgInterfaceCreate = {
  network: string
  role: 'server' | 'client'
  listenPort?: number
  addresses: string[]
  mtu?: number
  zone?: string | null
  /** A `vpn` zone forwarding to lan and the WAN zones. */
  createZone?: boolean
  openPort?: boolean
  /** Client role: a provider's key, TLS only. */
  privateKey?: string
  currentPassword: string
}

export type WgInterfacePatch = {
  enabled?: boolean
  listenPort?: number
  addresses?: string[]
  mtu?: number
  openPort?: boolean
}

export type WgPeerCreate = {
  label: string
  publicKey?: string
  generateKeys?: true
  presharedKey?: 'generate' | 'none'
  allowedIps?: string[]
  endpoint?: { host: string; port: number }
  keepalive?: number
  routeAllowedIps?: boolean
  deviceMac?: string
  client?: { dns?: string[]; allowedIps?: string[]; endpointHost?: string }
  currentPassword: string
}

export type WgPeerPatch = {
  label?: string
  allowedIps?: string[]
  endpoint?: { host: string; port: number } | null
  keepalive?: number | null
  routeAllowedIps?: boolean
  deviceMac?: string | null
}

export type WgPeerCreateAnswer = WriteAnswer<WgPeerView> & { clientConfig: WgClientConfig | null }

// ── IPv6 (rest.md 5) ────────────────────────────────────────────────────────

export type Ipv6Mode = 'server' | 'relay' | 'hybrid' | 'disabled'

export type Ipv6Lan = {
  network: string
  poolPerchId: string | null
  ip6assign: number | null
  ip6hint: string | null
  ip6class: string[]
  ip6ifaceid: string | null
  /** Observed. */
  assigned: string[]
  ra: Ipv6Mode | null
  dhcpv6: Ipv6Mode | null
  ndp: 'relay' | 'hybrid' | 'disabled' | null
  raFlags: string[]
  raSlaac: boolean | null
  dns: string[]
  raDefault: number | null
  management: boolean
  /** router = not widened yet. */
  ownership: 'perch' | 'router'
  sync: SyncInfo
}

export type Ipv6Overview = {
  gatewayId: number
  ula: { prefix: string | null; perchId: string | null; sync: SyncInfo | null }
  upstream: Array<{
    wan: string
    companion: string | null
    mode: WanIpv6Mode
    delegated: Array<{ prefix: string; preferredUntil: string | null; validUntil: string | null }>
    addresses: string[]
  }>
  lans: Ipv6Lan[]
  /** Read-only. */
  odhcpd: { perchId: string | null; maindhcp: boolean | null; running: boolean | null; options: Extra }
  leases6: number
  observedAt: string | null
}

export type Ipv6Patch = { ula: string | null | 'generate'; confirm?: string }

export type Ipv6LanPatch = {
  ip6assign?: number | null
  ip6hint?: string | null
  ip6class?: string[]
  ra?: Ipv6Mode | null
  dhcpv6?: Ipv6Mode | null
  ndp?: 'relay' | 'hybrid' | 'disabled' | null
  raFlags?: string[]
  raSlaac?: boolean
  dns?: string[]
  confirm?: string
}

// ── Ambiguities (rest.md 6) ─────────────────────────────────────────────────

export type AmbiguityMember = {
  perchId: string
  section: string
  anonymous: boolean
  position: number | null
  /** "GAME: wan tcp/udp 25500-25600 → 192.168.x.5:25500-25600 (disabled)" */
  summary: string
  enabled: boolean
  options: Extra
  suggestedName: string | null
  excluded: boolean
}

export type AmbiguityGroup = {
  /** The shared identity key, e.g. 'redirect:game'. */
  key: string
  domain: string
  config: string
  type: string
  reason: 'ambiguous' | 'duplicate'
  /** The option a rename edits ('name' for rules/redirects); null = rename not offered. */
  nameOption: string | null
  members: AmbiguityMember[]
}

export type AmbiguitiesView = {
  gatewayId: number
  headRevision: number
  groups: AmbiguityGroup[]
  blocksAuthoritative: boolean
}

export type AmbiguityAction = 'keep' | 'rename' | 'delete' | 'exclude'

export type AmbiguityResolveItem = { perchId: string; action: AmbiguityAction; name?: string }

export type AmbiguityResolveRequest = { expectRevision: number; items: AmbiguityResolveItem[] }

export type AmbiguityResolveAnswer = {
  gatewayId: number
  promoted: string[]
  excluded: string[]
  /** What is left. */
  groups: AmbiguityGroup[]
  issues: Issue[]
  apply: GatewayApplyWithChecks | null
  applyError: { error: string; message: string } | null
}

// ── Firewall defaults and DNS host records (rest.md 7) ─────────────────────

export type FirewallPolicy = 'ACCEPT' | 'REJECT' | 'DROP'

export type FirewallDefaultsView = {
  perchId: string
  input: string
  output: string
  forward: string
  synfloodProtect: boolean
  dropInvalid: boolean
  flowOffloading: boolean
  flowOffloadingHw: boolean
  live: { flowOffloading: boolean | null; flowOffloadingHw: boolean | null } | null
  collectorWarning: string | null
  extra: Extra
  sync: SyncInfo
}

export type FirewallDefaultsPatch = {
  input?: FirewallPolicy
  output?: FirewallPolicy
  forward?: FirewallPolicy
  synfloodProtect?: boolean
  dropInvalid?: boolean
  flowOffloading?: boolean
  flowOffloadingHw?: boolean
  /** The gateway's name: input/output to REJECT/DROP. */
  confirm?: string
}

/** M3's DNS record plus the MAC-less `host` type (a `dhcp` host with `dns '1'`). */
export type DnsRecordType = 'a' | 'cname' | 'host'
export type DnsHostRecordPatch = { name?: string; value?: string; publishDns?: boolean }

// ── UPnP (rest.md 8) ────────────────────────────────────────────────────────

export type UpnpAclRule = {
  id: string
  position: number | null
  action: 'allow' | 'deny'
  extPorts: string
  intAddr: string
  intPorts: string
  comment: string | null
  /** When `intAddr` is one reserved address. */
  device: DeviceRef | null
  shadowedBy: string | null
  extra: Extra
  sync: SyncInfo
}

export type UpnpOrderStatus = 'in_sync' | 'ahead' | 'conflict' | 'drift'

export type UpnpConfigView = {
  gatewayId: number
  installed: boolean
  available: boolean
  unavailableReason: SyncUnavailableReason | null
  settings: {
    perchId: string
    enabled: boolean
    upnp: boolean | null
    natpmp: boolean | null
    secureMode: boolean
    internalInterfaces: string[]
    externalInterface: string | null
    extra: Extra
    sync: SyncInfo
  } | null
  acl: UpnpAclRule[]
  aclOrder: { status: UpnpOrderStatus; desired: string[]; router: string[] } | null
  running: boolean | null
  mappings: UpnpMapping[]
  canDeleteMappings: boolean
}

export type UpnpConfigPatch = {
  enabled?: boolean
  upnp?: boolean
  natpmp?: boolean
  secureMode?: boolean
  internalInterfaces?: string[]
}

export type UpnpAclInput = {
  action: 'allow' | 'deny'
  extPorts: string
  intAddr?: string
  deviceMac?: string
  intPorts: string
  comment?: string | null
  placement?: 'top' | 'bottom'
}

export type UpnpAclPatch = Partial<Omit<UpnpAclInput, 'placement'>>

export type UpnpMappingRef = { proto: 'TCP' | 'UDP'; externalPort: number }

export type UpnpMappingsDeleteAnswer = { deleted: number; notFound: number; restarted: boolean }

export type UpnpDeviceBlockAnswer = WriteAnswer<UpnpAclRule> & { deletedMappings: number | null }

// ── DDNS (rest.md 9) ────────────────────────────────────────────────────────

export type DdnsServiceView = {
  id: string
  name: string
  enabled: boolean
  /** `service_name`. */
  provider: string | null
  updateUrl: string | null
  domain: string | null
  lookupHost: string | null
  username: string | null
  password: SecretState
  ipSource: 'network' | 'interface' | 'web' | 'script'
  ipNetwork: string | null
  ipInterface: string | null
  useIpv6: boolean
  useHttps: boolean
  checkIntervalMinutes: number | null
  forceIntervalHours: number | null
  live: {
    registeredIp: string | null
    lastUpdateAt: string | null
    running: boolean
    lastError: string | null
    wanIp: string | null
    matches: boolean | null
    observedAt: string
  } | null
  extra: Extra
  sync: SyncInfo
}

export type DdnsOverview = {
  gatewayId: number
  installed: boolean
  available: boolean
  unavailableReason: SyncUnavailableReason | null
  installPackages: string[]
  providers: string[]
  secureTransport: boolean
  services: DdnsServiceView[]
}

export type DdnsServiceInput = {
  /** ^[A-Za-z0-9_]{1,32}$, create only. */
  name: string
  enabled?: boolean
  provider?: string | null
  updateUrl?: string | null
  domain: string
  lookupHost?: string
  username?: string | null
  /** Write-only. */
  password?: string | null
  ipSource?: 'network' | 'web'
  /** Default: the primary uplink. */
  ipNetwork?: string
  useIpv6?: boolean
  useHttps?: boolean
  checkIntervalMinutes?: number
  forceIntervalHours?: number
}

export type DdnsServicePatch = Partial<Omit<DdnsServiceInput, 'name'>>

// ── Multi-WAN (rest.md 10) ──────────────────────────────────────────────────

export type MultiwanProfile = {
  kind: 'failover' | 'balance' | 'custom'
  members: Array<{ wan: string; metric: number; weight: number }>
  tracking: {
    targets: string[]
    reliability: number
    count: number
    timeout: number
    interval: number
    down: number
    up: number
  } | null
  lastResort: 'unreachable' | 'blackhole' | 'default' | null
  /** Beyond the default rule. */
  rules: Array<{ name: string; summary: string; policy: string; sticky: boolean }>
  /** e.g. "wan and lan2 share metric 1: traffic is balanced, not failed over". */
  notes: string[]
}

export type MultiwanConfigSection = { perchId: string; section: string; type: string; options: Extra }

export type MultiwanView = {
  gatewayId: number
  package: 'mwan3' | 'pbr' | null
  installed: boolean
  service: { enabled: boolean | null; running: boolean | null }
  writable: boolean
  writeBlockedReason: 'owner_decision_12' | 'router_read_only' | 'capability_missing' | 'not_installed' | null
  profile: MultiwanProfile | null
  config: MultiwanConfigSection[] | null
  /** The mwan3 observation (observation.md 2.1). */
  live: Record<string, unknown> | null
  pbr: { installed: boolean; config: MultiwanConfigSection[] | null }
}

/** `PUT /gateways/:id/multiwan` (only with owner decision D3). */
export type MultiwanPut = {
  profile: {
    kind: 'failover' | 'balance'
    members: Array<{ wan: string; metric: number; weight: number }>
    tracking: MultiwanProfile['tracking']
    lastResort: MultiwanProfile['lastResort']
  }
  serviceEnabled?: boolean
  confirm: string
}

// ── Settings → Gateway sync (rest.md 11) ────────────────────────────────────

export type GatewaySyncSettings = {
  /** 1–8 entries: IPv4/IPv6 literals or `$gateway`. */
  checkTargets: string[]
  checkTcpPort: number
  /** A host name, or '' (off). */
  checkResolveName: string
  checkTimeoutDhcpSeconds: number
  checkTimeoutStaticSeconds: number
  checkTimeoutPppoeSeconds: number
  checkTimeoutMobileSeconds: number
  checkTimeoutOtherSeconds: number
  wanConfirmTimeoutSeconds: number
  wanConfirmMode: ConfirmMode
  authoritativeWan: 'import' | 'enforce'
  transitionRetentionDays: number
  wgPeerStaleMinutes: number
  wgStepUp: boolean
  upnpOpenedEvents: boolean
  multiWanWrites: boolean
}

export type GatewaySyncNumericKey = {
  [K in keyof GatewaySyncSettings]: GatewaySyncSettings[K] extends number ? K : never
}[keyof GatewaySyncSettings]

export type GatewaySyncSettingsView = {
  settings: GatewaySyncSettings
  defaults: GatewaySyncSettings
  limits: Record<GatewaySyncNumericKey, { min: number; max: number }> & {
    checkTargets?: { min: number; max: number }
  }
  choices: { wanConfirmMode: ConfirmMode[]; authoritativeWan: Array<'import' | 'enforce'> }
}

/** Turning `multiWanWrites` on needs the admin's password (403 `invalid_password`). */
export type GatewaySyncSettingsPatch = Partial<GatewaySyncSettings> & { currentPassword?: string }
