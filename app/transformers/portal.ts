import type Portal from '#models/portal'
import type PortalApiClient from '#models/portal_api_client'
import type PortalGrant from '#models/portal_grant'
import type PortalUser from '#models/portal_user'
import type Voucher from '#models/voucher'
import type VoucherBatch from '#models/voucher_batch'
import { type GroupInfo, effectiveLimits, ms, num, remainingOf } from '#services/portal_grants'
import type { VoucherStatus } from '#services/portal/redemption'
import type { DateTime } from 'luxon'

/**
 * Response shapes of the guest portal REST API (docs/gateway/portal.md
 * section 11.3). Pure mapping from rows the services loaded; every time is an
 * ISO string in UTC, every byte count a number.
 */

export const iso = (value: DateTime | null | undefined): string | null =>
  value ? value.toUTC().toISO() : null

const isoMs = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString()

// ---------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------

export type PortalGatewayRef = {
  id: number
  collectorId: number | null
  name: string | null
  online: boolean
  mode: string
  authoritative: boolean
  /** The collector reported the `portal` capability; null = not reported yet. */
  portalCapable: boolean | null
}

export type PortalNetworkRef = {
  perchId: string
  /** The `interface` section's name on the router, when the config plane mirrors it. */
  name: string | null
  label: string | null
  purpose: string | null
}

export type PortalView = {
  id: number
  gatewayId: number
  name: string
  gateway: PortalGatewayRef | null
  network: PortalNetworkRef
  methods: { voucher: boolean; password: boolean }
  templateId: number | null
  cspConnectSrc: string[]
  privacyNotice: string | null
  status: {
    /** Perch nftables enforcement on the router (decision 27); unknown before it answered. */
    state: 'active' | 'disabled' | 'waiting_device' | 'error' | 'unknown'
    device: string | null
    counting: boolean
    issues: string[]
    listen: string | null
    revision: number
    appliedRevision: number | null
    delivery: 'applied' | 'pending'
    clients: { authenticated: number; pending: number; paused: number; queued: number }
    lastReportAt: string | null
    lastConfiguredAt: string | null
  }
  createdAt: string | null
  updatedAt: string | null
}

export function portalView(
  p: Portal,
  refs: {
    gateway: PortalGatewayRef | null
    network: PortalNetworkRef
    clients: PortalView['status']['clients']
    lastReportAt: string | null
  }
): PortalView {
  const status = p.status
  return {
    id: p.id,
    gatewayId: p.gatewayId,
    name: p.name,
    gateway: refs.gateway,
    network: refs.network,
    methods: {
      voucher: Boolean(p.methods?.voucher),
      password: Boolean(p.methods?.password),
    },
    templateId: p.templateId,
    cspConnectSrc: p.cspConnectSrc ?? [],
    privacyNotice: p.privacyNotice,
    status: {
      state: status?.state ?? 'unknown',
      device: status?.device ?? null,
      counting: status?.counting ?? false,
      issues: status?.issues ?? [],
      listen: status?.listen ?? null,
      revision: p.revision,
      appliedRevision: p.appliedRevision,
      delivery: p.appliedRevision === p.revision ? 'applied' : 'pending',
      clients: refs.clients,
      lastReportAt: refs.lastReportAt,
      lastConfiguredAt: status?.at ?? null,
    },
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  }
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export type GroupView = {
  key: string
  devices: number
  maxDevices: number
  timeUsedSeconds: number
  bytesUsed: number
  remaining: { seconds: number | null; bytes: number | null }
  durationMinutes: number | null
  durationMode: 'wall_clock' | 'active_time'
  expiresAt: string | null
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
}

export type GrantRefs = {
  voucher: { id: number; batchId: number; hint: string } | null
  portalUser: { id: number; username: string } | null
  apiClient: { id: number; name: string } | null
  createdBy: { id: number; email: string } | null
}

export type GrantView = {
  id: number
  portalId: number
  mac: string
  ip: string | null
  hostname: string | null
  source: string
  state: string
  delivery: string
  revision: number
  voucher: GrantRefs['voucher']
  portalUser: GrantRefs['portalUser']
  apiClient: GrantRefs['apiClient']
  createdBy: GrantRefs['createdBy']
  externalRef: string | null
  note: string | null
  startedAt: string | null
  /** The grant's effective deadline (its group's, tightened by its own). */
  expiresAt: string | null
  lastSeenAt: string | null
  bytesUp: number
  bytesDown: number
  timeUsedSeconds: number
  group: GroupView | null
  endedAt: string | null
  endReason: string | null
  createdAt: string | null
}

export function groupView(g: PortalGrant, group: GroupInfo, now: number): GroupView {
  const limits = effectiveLimits(g, group)
  return {
    key: group.key,
    devices: group.devices,
    maxDevices: limits.maxDevices,
    timeUsedSeconds: group.usage.timeUsedSeconds,
    bytesUsed: group.usage.bytesUsed,
    remaining: remainingOf(g, group, now),
    durationMinutes:
      limits.durationSeconds === null ? null : Math.ceil(limits.durationSeconds / 60),
    durationMode: limits.durationMode,
    expiresAt: isoMs(limits.expiresAt),
    quotaBytes: limits.quotaBytes,
    downKbps: limits.downKbps,
    upKbps: limits.upKbps,
  }
}

export function grantView(
  g: PortalGrant,
  group: GroupInfo | null,
  refs: GrantRefs,
  now: number
): GrantView {
  const gv = group ? groupView(g, group, now) : null
  return {
    id: num(g.id),
    portalId: g.portalId,
    mac: g.mac,
    ip: g.ip,
    hostname: g.hostname,
    source: g.source,
    state: g.state,
    delivery: g.delivery,
    revision: g.revision,
    voucher: refs.voucher,
    portalUser: refs.portalUser,
    apiClient: refs.apiClient,
    createdBy: refs.createdBy,
    externalRef: g.externalRef,
    note: g.note,
    startedAt: iso(g.startedAt),
    expiresAt: gv ? gv.expiresAt : iso(g.expiresAt),
    lastSeenAt: iso(g.lastSeenAt),
    bytesUp: num(g.bytesUp),
    bytesDown: num(g.bytesDown),
    timeUsedSeconds: g.timeUsedSeconds,
    group: gv,
    endedAt: iso(g.endedAt),
    endReason: g.endReason,
    createdAt: iso(g.createdAt),
  }
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

export type VoucherCounts = Record<VoucherStatus, number>

export type BatchView = {
  id: number
  portalId: number | null
  name: string
  note: string | null
  count: number
  codeLength: number
  durationMinutes: number | null
  durationMode: string
  startMode: string
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
  maxDevices: number
  redeemBy: string | null
  createdAt: string | null
  createdBy: { id: number; email: string } | null
  revokedAt: string | null
  counts: VoucherCounts
}

export function batchView(
  b: VoucherBatch,
  counts: VoucherCounts,
  createdBy: { id: number; email: string } | null
): BatchView {
  return {
    id: b.id,
    portalId: b.portalId,
    name: b.name,
    note: b.note,
    count: b.count,
    codeLength: b.codeLength,
    durationMinutes: b.durationMinutes,
    durationMode: b.durationMode,
    startMode: b.startMode,
    quotaBytes: b.quotaBytes === null ? null : num(b.quotaBytes),
    downKbps: b.downKbps,
    upKbps: b.upKbps,
    maxDevices: b.maxDevices,
    redeemBy: iso(b.redeemBy),
    createdAt: iso(b.createdAt),
    createdBy,
    revokedAt: iso(b.revokedAt),
    counts,
  }
}

export type VoucherView = {
  id: number
  batchId: number
  hint: string
  status: VoucherStatus
  boundPortalId: number | null
  firstUsedAt: string | null
  startsAt: string | null
  expiresAt: string | null
  timeUsedSeconds: number
  bytesUsed: number
  devices: number
  revokedAt: string | null
  code?: string | null
}

export function voucherView(
  v: Voucher,
  status: VoucherStatus,
  devices: number,
  code?: string | null
): VoucherView {
  const view: VoucherView = {
    id: v.id,
    batchId: v.batchId,
    hint: v.hint,
    status,
    boundPortalId: v.boundPortalId,
    firstUsedAt: iso(v.firstUsedAt),
    startsAt: iso(v.startsAt),
    expiresAt: iso(v.expiresAt),
    timeUsedSeconds: v.timeUsedSeconds,
    bytesUsed: num(v.bytesUsed),
    devices,
    revokedAt: iso(v.revokedAt),
  }
  if (code !== undefined) view.code = code
  return view
}

// ---------------------------------------------------------------------------
// Portal users, API clients
// ---------------------------------------------------------------------------

export function portalUserView(u: PortalUser, activeDevices: number) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    enabled: Boolean(u.enabled),
    maxDevices: u.maxDevices,
    sessionMinutes: u.sessionMinutes,
    downKbps: u.downKbps,
    upKbps: u.upKbps,
    portalIds: u.portalIds,
    lastLoginAt: iso(u.lastLoginAt),
    activeDevices,
    createdAt: iso(u.createdAt),
  }
}

export function apiClientView(c: PortalApiClient, activeGrants: number) {
  return {
    id: c.id,
    name: c.name,
    prefix: c.tokenPrefix,
    scopes: c.scopes ?? [],
    portalIds: c.portalIds ?? [],
    maxMinutesPerCall: c.maxMinutesPerCall,
    maxBytesPerCall: num(c.maxBytesPerCall),
    maxActiveGrants: c.maxActiveGrants,
    activeGrants,
    lastUsedAt: iso(c.lastUsedAt),
    revokedAt: iso(c.revokedAt),
    createdAt: iso(c.createdAt),
    createdByUserId: c.createdByUserId,
  }
}

export { ms }
