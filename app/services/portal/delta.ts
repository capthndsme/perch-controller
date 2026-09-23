import type { WireGrant, WireGroup, WireOfflineVoucher } from '#services/portal/crypto'
import { groupUsage, voucherGroupLimits } from '#services/portal/groups'
import {
  type ServerGrant,
  type ServerPortalState,
  type WorkVoucher,
  buildOfflineVouchers,
} from '#services/portal/reconcile'
import type { GroupLimits, GroupUsage } from '#services/portal/types'
import { isLiveState, parseGroupKey } from '#services/portal/types'

/**
 * Steady-state deltas (docs/gateway/portal.md section 13.4): the wire items
 * of a `portal.authorize {full: false}` for some grants, and the offline
 * voucher list, computed from the controller's state alone. Pure; the same
 * group math as `reconcile` step 6, so a delta and the next full set agree:
 *
 * - a group's `base*` = its total usage − Σ counters of its grants that are
 *   live on this gateway (the router adds its live counters to it);
 * - a voucher group's total is the voucher's stored totals, any other
 *   group's the sum of its grants' counters.
 *
 * Only live grants of the gateway's portals are sent; grants that ended or
 * were queued since the push was made are left to `portal.deauthorize`.
 */

export type PortalDelta = { groups: WireGroup[]; grants: WireGrant[] }

function limitsOf(server: ServerPortalState, key: string): GroupLimits | null {
  const parsed = parseGroupKey(key)
  if (!parsed) return null
  if (parsed.kind === 'voucher') {
    const v = server.vouchers.find((x) => x.id === parsed.id)
    return v ? voucherGroupLimits(v.limits) : null
  }
  return server.groups.find((g) => g.groupKey === key)?.limits ?? null
}

function revisionOf(server: ServerPortalState, key: string, fallback: number): number {
  const parsed = parseGroupKey(key)
  if (parsed?.kind === 'voucher') {
    return server.vouchers.find((x) => x.id === parsed.id)?.revision ?? fallback
  }
  return server.groups.find((g) => g.groupKey === key)?.revision ?? fallback
}

function usageRow(g: ServerGrant) {
  return {
    id: g.id,
    state: g.lifecycle.state,
    bytesUp: g.bytesUp,
    bytesDown: g.bytesDown,
    timeUsedSeconds: g.timeUsedSeconds,
  }
}

function totalUsage(server: ServerPortalState, key: string): GroupUsage {
  const parsed = parseGroupKey(key)
  if (parsed?.kind === 'voucher') {
    const v = server.vouchers.find((x) => x.id === parsed.id)
    if (v) return v.usage
  }
  return groupUsage(server.grants.filter((g) => g.groupKey === key).map(usageRow))
}

/** The wire group of `key` as the full set would carry it. */
export function wireGroupOf(server: ServerPortalState, key: string): WireGroup | null {
  const limits = limitsOf(server, key)
  if (!limits) return null
  const enabled = new Set(server.portals.filter((p) => p.enabled).map((p) => p.id))
  const live = server.grants.filter(
    (g) => g.groupKey === key && isLiveState(g.lifecycle.state) && enabled.has(g.portalId)
  )
  const liveUsage = groupUsage(live.map(usageRow))
  const total = totalUsage(server, key)
  return {
    groupKey: key,
    durationMode: limits.durationMode,
    expiresAt: limits.expiresAt,
    durationSeconds: limits.durationSeconds,
    quotaBytes: limits.quotaBytes,
    baseTimeUsedSeconds: Math.max(0, total.timeUsedSeconds - liveUsage.timeUsedSeconds),
    baseBytesUsed: Math.max(0, total.bytesUsed - liveUsage.bytesUsed),
    downKbps: limits.downKbps,
    upKbps: limits.upKbps,
    maxDevices: limits.maxDevices,
    revision: revisionOf(server, key, live[0]?.lifecycle.revision ?? 1),
  }
}

export function wireGrantOf(g: ServerGrant): WireGrant {
  return {
    grantId: g.id,
    localRef: g.localRef,
    portalId: g.portalId,
    groupKey: g.groupKey,
    mac: g.mac,
    expiresAt: g.expiresAt,
    revision: g.lifecycle.revision,
  }
}

/** The authorize delta for `grantIds`: their live grants and every group they use. */
export function portalDelta(server: ServerPortalState, grantIds: Iterable<number>): PortalDelta {
  const wanted = new Set(grantIds)
  const enabled = new Set(server.portals.filter((p) => p.enabled).map((p) => p.id))
  const grants: WireGrant[] = []
  const keys = new Set<string>()
  for (const g of server.grants) {
    if (!wanted.has(g.id) || !isLiveState(g.lifecycle.state) || !enabled.has(g.portalId)) continue
    if (!limitsOf(server, g.groupKey)) continue
    grants.push(wireGrantOf(g))
    keys.add(g.groupKey)
  }
  grants.sort((a, b) => (a.grantId ?? 0) - (b.grantId ?? 0))
  const groups = [...keys]
    .sort()
    .map((k) => wireGroupOf(server, k))
    .filter((g): g is WireGroup => g !== null)
  return { groups, grants }
}

/** The gateway's offline voucher list (decision 20), or null when offline redemption is off. */
export function offlineVoucherList(server: ServerPortalState): WireOfflineVoucher[] | null {
  if (!server.offline.enabled) return null
  const work: WorkVoucher[] = server.vouchers.map((v) => ({
    v,
    set: {},
    add: { timeUsedSeconds: 0, bytesUsed: 0 },
  }))
  return buildOfflineVouchers(
    work,
    (wv) => wv.v,
    new Set(server.portals.map((p) => p.id)),
    server.now,
    server.offline.limit
  )
}
