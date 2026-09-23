/**
 * The firewall of a managed gateway (metrics-be docs/gateway/firewall.md
 * section 6; the write envelope and the apply are config-plane.md sections
 * 10.1 and 10.3). The config plane shapes used here (section status, the
 * apply, the gateway row) are the config plane's own types from
 * `types/gateway-config.ts`, narrowed to what this page reads.
 */

import type {
  ApplyError,
  ApplyState,
  Gateway,
  GatewayApply,
  SectionStatus,
} from '@/types/gateway-config'

export type FwSectionStatus = SectionStatus

export type FirewallSync = {
  perchId: string
  section: string
  /** `perch` = synced (Perch may write it), `router` = excluded or unmodeled (observed only). */
  owner: 'perch' | 'router'
  scope: 'synced' | 'excluded' | 'unmodeled'
  issue: 'ambiguous' | 'no_round_trip' | 'duplicate' | null
  status: FwSectionStatus
  applied: boolean
  conflict: boolean
  driftSince: string | null
}

export type FirewallZone = {
  name: string
  networks: string[]
  input: string | null
  output: string | null
  forward: string | null
  masq: boolean
  mtuFix: boolean
  wan: boolean
  /** The zone the gateway reaches the controller through. */
  management: boolean
  sync: FirewallSync
}

export type FirewallForwarding = {
  src: string
  dest: string
  family: string
  enabled: boolean
  sync: FirewallSync
}

export type FirewallPathIssue = 'firewall_controller_path' | 'firewall_admin_path'

export type FirewallRule = {
  /** The perchId. */
  id: string
  name: string | null
  enabled: boolean
  /** Index among the rules in file order. */
  position: number | null
  src: string | null
  dest: string | null
  proto: string[]
  srcIp: string[]
  srcMac: string[]
  destIp: string[]
  srcPort: string | null
  destPort: string | null
  family: string | null
  target: string
  ipset: string | null
  /** A rule of the per-device WAN block (changed from the device page only). */
  perchBlock: boolean
  shadowedBy: string | null
  pathIssue: FirewallPathIssue | null
  sync: FirewallSync
}

export type PortForward = {
  id: string
  name: string | null
  enabled: boolean
  position: number | null
  proto: string[]
  srcZone: string | null
  externalPort: string | null
  destZone: string | null
  destIp: string | null
  destPort: string | null
  reflection: boolean
  family: string | null
  srcIp: string[]
  /** The DHCP host holding `destIp` (the reservation), when there is one. */
  device: { mac: string; name: string | null } | null
  shadowedBy: string | null
  sync: FirewallSync
}

export type FirewallOrderStatus = 'in_sync' | 'ahead' | 'conflict' | 'drift'

export type FirewallOrder = {
  status: FirewallOrderStatus
  /** Perch's order (perch ids of synced members). */
  desired: string[]
  /** The router's order of the same members. */
  router: string[]
  conflict: { router: string[]; detectedAt: string } | null
  driftSince: string | null
}

export type FirewallIpset = {
  perchId: string
  section: string
  name: string | null
  match: string[]
  entries: number
  family: string | null
  managed: boolean
}

export type FirewallInclude = {
  perchId: string
  section: string
  type: string | null
  path: string | null
  position: string | null
  owner: 'package' | 'perch' | 'operator'
  sha256: null
}

export type FirewallIssue = {
  severity: 'error' | 'warning'
  code: string
  message: string
  perchId?: string | null
  config?: string
  section?: string
  option?: string
}

export type FirewallOverview = {
  gatewayId: number
  mode: 'off' | 'observe' | 'managed'
  authoritative: boolean
  zones: FirewallZone[]
  forwardings: FirewallForwarding[]
  rules: FirewallRule[]
  portForwards: PortForward[]
  ipsets: FirewallIpset[]
  includes: FirewallInclude[]
  /** Other sections Perch only observes (`nat`, SNAT redirects). */
  observed: Array<{ perchId: string; section: string; type: string }>
  defaults: Record<string, string | string[]> | null
  flowOffloading: boolean
  flowOffloadingHw: boolean
  wanZones: string[]
  managementZone: string | null
  orders: { rule: FirewallOrder | null; redirect: FirewallOrder | null }
  issues: FirewallIssue[]
}

export type FwApplyState = ApplyState

/** The subset of the config plane's `GatewayApply` this page shows. */
export type FwApply = Pick<
  GatewayApply,
  'id' | 'kind' | 'state' | 'confirmMode' | 'confirmTimeoutSeconds' | 'protected' | 'deadlineAt' | 'perchIds' | 'configs'
>

export type FwApplyError = NonNullable<ApplyError>

/** The envelope every firewall write answers with. */
export type FirewallWrite<T> = {
  gatewayId: number
  object: T
  issues: FirewallIssue[]
  apply: FwApply | null
  applyError: FwApplyError | null
}

export type FirewallOrderWrite = {
  gatewayId: number
  order: FirewallOrder | null
  rules?: FirewallRule[]
  portForwards?: PortForward[]
  apply: FwApply | null
  applyError: FwApplyError | null
}

/** What any write leaves for the page's "last change" note. */
export type FirewallWriteSummary = {
  what: string
  issues: FirewallIssue[]
  apply: FwApply | null
  applyError: FwApplyError | null
}

export type PortForwardInput = {
  name: string
  proto: Array<'tcp' | 'udp'>
  externalPort: string
  destIp?: string
  deviceMac?: string
  destPort?: string | null
  reflection?: boolean
  enabled?: boolean
  srcZone?: string
  destZone?: string
  allowUnreserved?: boolean
}

export type PortForwardPatch = Partial<PortForwardInput>

export type RuleTarget = 'ACCEPT' | 'REJECT' | 'DROP'

export type FirewallRuleInput = {
  name: string
  src?: string
  dest?: string | null
  proto?: string[] | null
  srcMac?: string[] | null
  srcIp?: string[] | null
  destIp?: string[] | null
  destPort?: string | null
  target: RuleTarget
  family?: 'ipv4' | 'ipv6' | 'any' | null
  enabled?: boolean
  placement?: 'top' | 'bottom'
}

export type FirewallRulePatch = Partial<Omit<FirewallRuleInput, 'placement'>>

export type WanFlush = {
  at: string
  /** null: not attempted (no capability, offline, no known address). */
  flushed: boolean | null
  ips: string[]
  matched?: number
  deleted?: number
  skipped?: number
  reason?: string
  applyId?: string
}

export type WanAccess = {
  gatewayId: number
  mac: string
  blocked: boolean
  /** The router has the same state as Perch's draft. */
  applied: boolean
  since: string | null
  by: number | null
  note: string | null
  /** false: a block rule is disabled on the router. */
  ruleEnabled: boolean | null
  /** The router's set is excluded or unmodeled: Perch cannot change it. */
  routerOwned: boolean
  lastFlush: WanFlush | null
}

export type WanAccessWrite = {
  gatewayId: number
  object: Omit<WanAccess, 'gatewayId'>
  flushed: boolean | null
  perchIds: string[]
  issues: FirewallIssue[]
  apply: FwApply | null
  applyError: FwApplyError | null
}

/** The subset of the config plane's gateway row the firewall page needs. */
export type FwGateway = Pick<Gateway, 'id' | 'name' | 'online' | 'mode' | 'authoritative' | 'writable' | 'writeBlockedReason'> & {
  pendingApply: FwApply | null
  managementPath?: Gateway['managementPath']
}
