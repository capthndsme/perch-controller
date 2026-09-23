import type { WireGrant, WireGroup, WireOfflineVoucher } from '#services/portal/crypto'
import {
  type GrantLifecycle,
  type GrantEvent,
  transitionGrant,
} from '#services/portal/grant_lifecycle'
import {
  type Entitlement,
  type GrantUsageRow,
  exhaustion,
  grantLimits,
  groupUsage,
  orderEntitlements,
  startVoucherClock,
  voucherGroupLimits,
} from '#services/portal/groups'
import { type VoucherFacts, voucherPortal, voucherStatus } from '#services/portal/redemption'
import type {
  GrantEndReason,
  GrantSource,
  GroupLimits,
  GroupUsage,
  StartMode,
} from '#services/portal/types'
import { groupKey, isLiveState, normalizeMac, parseGroupKey } from '#services/portal/types'

/**
 * Reconnect (and periodic) reconciliation between the controller's portal
 * state and one gateway's report (docs/gateway/portal.md §7). Pure: the
 * caller loads `ServerPortalState`, calls `portal.sync` for the
 * `RouterPortalReport`, runs `reconcile`, writes `dbChanges` in one
 * transaction (`applyPortalDbChanges`), then signs and sends `desired`
 * (`portal.authorize {full:true}` + `portal.vouchers`).
 *
 * Order of work, each step on the result of the previous one:
 *  1. Journal events after `ackedEventSeq`, in `seq` order. Ends are facts;
 *     offline redemptions become grant rows; externals are logged.
 *  2. The usage snapshot: counters merge with `max`, the router's revision
 *     acknowledges delivery, grants missing on the router are re-sent.
 *  3. Voucher totals grow by the counter deltas.
 *  4. The server's own accounting: exhausted or revoked groups end.
 *  5. Stacking (decision 23): one live grant per device and portal, the next
 *     queued entitlement promoted when the current one ended.
 *  6. The desired set: every live grant of an enabled portal with its group
 *     and `base*` usage, externals to revert (always: decision 25), and the
 *     vouchers the gateway may redeem offline (decision 20).
 */

// ---------------------------------------------------------------------------
// Input: the controller's side
// ---------------------------------------------------------------------------

export type ServerPortal = { id: number; enabled: boolean }

export type ServerGrant = {
  id: number
  portalId: number
  mac: string
  groupKey: string
  source: GrantSource
  voucherId: number | null
  lifecycle: GrantLifecycle
  /** Grant-level deadline (portal-user login, API grant). */
  expiresAt: number | null
  createdAt: number
  bytesUp: number
  bytesDown: number
  timeUsedSeconds: number
  ip: string | null
  hostname: string | null
  lastSeenAt: number | null
  /** Set for grants the router created offline. */
  localRef: string | null
}

/** A non-voucher group (`u:` / `g:`): limits given as they are. */
export type ServerGroup = {
  groupKey: string
  limits: GroupLimits
  revision: number
}

export type ServerVoucher = VoucherFacts & {
  revision: number
  /** The batch's creation time (offline list order: newest batches first). */
  createdAt: number
  /**
   * Offline verifier of the code for **this** gateway at its current key
   * epoch (`offlineVoucherVerifier`); null when the code cannot be recovered
   * (APP_KEY rotated) or offline redemption is off: then it is never offered.
   */
  verifier: string | null
  startsAt: number | null
}

export type ServerPortalState = {
  gatewayId: number
  now: number
  /** `portal_gateway_states.acked_event_seq`. */
  ackedEventSeq: number
  /** The gateway's portals that are not deleted. */
  portals: readonly ServerPortal[]
  /**
   * Every non-ended grant of those portals, plus any ended grant the report
   * names (by id or localRef): the caller loads those by the report's refs.
   */
  grants: readonly ServerGrant[]
  /** Groups of the non-voucher grants. */
  groups: readonly ServerGroup[]
  /**
   * Vouchers of the grants above, vouchers named by offline redemptions in
   * the report, and every voucher eligible for this gateway's offline list.
   */
  vouchers: readonly ServerVoucher[]
  offline: { enabled: boolean; limit: number }
}

// ---------------------------------------------------------------------------
// Input: the router's side (`portal.sync` result)
// ---------------------------------------------------------------------------

/** Why the router ended a grant. `removed` = because the controller asked. */
export type RouterEndReason = 'expired' | 'quota' | 'router_deauth' | 'logout' | 'moved' | 'removed'

type EventBase = { seq: number; at: number; portalId: number | null; mac: string }
type GrantRefFields = { grantId: number | null; localRef?: string | null }

export type RouterEvent =
  | (EventBase & GrantRefFields & { type: 'grant_active'; ip?: string | null })
  | (EventBase & GrantRefFields & { type: 'session_paused' | 'session_resumed' })
  | (EventBase &
      GrantRefFields & {
        type: 'grant_ended'
        reason: RouterEndReason
        bytesUp?: number
        bytesDown?: number
        activeSeconds?: number
      })
  | (EventBase & { type: 'external_auth'; ip?: string | null })
  | (EventBase & { type: 'external_deauth' })
  | (EventBase & {
      type: 'offline_redeemed'
      voucherId: number
      localRef: string
      ip?: string | null
      hostname?: string | null
      placement: 'current' | 'queue' | 'swap'
      /** `swap`: the device's data bucket the router put back in the queue. */
      demotedGrantId?: number | null
      demotedLocalRef?: string | null
      /** When the router started the voucher's wall clock (else null). */
      startsAt?: number | null
      expiresAt?: number | null
    })

export type RouterGrantUsage = {
  grantId: number | null
  localRef: string | null
  portalId: number
  mac: string
  ip: string | null
  bytesUp: number
  bytesDown: number
  activeSeconds: number
  state: 'active' | 'paused' | 'pending_device'
  lastSeenAt: number | null
  /** The revision the router holds (acknowledges delivery). */
  revision: number | null
}

export type RouterExternal = {
  portalId: number | null
  mac: string
  ip: string | null
  since: number | null
  bytesUp: number
  bytesDown: number
}

export type RouterPortalReport = {
  lastEventSeq: number
  /** The journal overflowed: events between `ackedEventSeq` and the first one sent are lost. */
  truncated: boolean
  events: readonly RouterEvent[]
  grants: readonly RouterGrantUsage[]
  externals: readonly RouterExternal[]
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** A grant row by id, or by the router's `localRef` when it is inserted in the same batch. */
export type GrantRef = { id: number } | { localRef: string }

export type GrantFields = {
  state: GrantLifecycle['state']
  delivery: GrantLifecycle['delivery']
  revision: number
  startedAt: number | null
  endedAt: number | null
  endReason: GrantEndReason | null
  bytesUp: number
  bytesDown: number
  timeUsedSeconds: number
  ip: string | null
  hostname: string | null
  lastSeenAt: number | null
}

export type GrantInsert = GrantFields & {
  localRef: string
  portalId: number
  mac: string
  source: 'voucher'
  groupKey: string
  voucherId: number
  expiresAt: null
  createdAt: number
}

export type GrantUpdate = { id: number; set: Partial<GrantFields> }

export type SessionOpen = {
  op: 'open'
  grant: GrantRef
  portalId: number
  mac: string
  ip: string | null
  startedAt: number
  /** The grant's cumulative counters when the session started. */
  startBytesUp: number
  startBytesDown: number
}

export type SessionClose = {
  op: 'close'
  grant: GrantRef
  endedAt: number
  endReason: string
  /** The grant's cumulative counters when the session ended. */
  bytesUp: number
  bytesDown: number
}

export type VoucherUpdate = {
  id: number
  set: Partial<{
    boundPortalId: number
    firstUsedAt: number
    startsAt: number
    expiresAt: number
    exhaustedAt: number
    revision: number
  }>
  /**
   * Usage to add to the stored totals (the counter deltas of its grants).
   * Deltas, not absolute values, so a concurrent writer never loses counts.
   */
  add: { timeUsedSeconds: number; bytesUsed: number }
}

export type PortalEventType =
  | 'external_auth_reverted'
  | 'external_deauth'
  | 'offline_redeemed'
  | 'offline_redeem_rejected'
  | 'grant_lost'
  | 'unknown_grant'
  | 'journal_truncated'
  | 'journal_reset'

export type PortalEventRow = {
  at: number
  type: PortalEventType
  portalId: number | null
  grant: GrantRef | null
  mac: string | null
  detail: Record<string, unknown>
}

/**
 * A queued `g:` (API/admin) grant with a wall-clock duration was promoted:
 * its deadline starts now (`expires_at`, first writer wins).
 */
export type GrantClockStart = { id: number; expiresAt: number }

export type PortalDbChanges = {
  ackedEventSeq: number
  grantInserts: GrantInsert[]
  grantUpdates: GrantUpdate[]
  grantClocks: GrantClockStart[]
  /** Session rows to open and close, in the order they happened. */
  sessions: Array<SessionOpen | SessionClose>
  voucherUpdates: VoucherUpdate[]
  events: PortalEventRow[]
}

export type DesiredPortalState = {
  gatewayId: number
  full: true
  serverNow: number
  /**
   * The journal position this set reflects. The router keeps offline grants
   * it created after this seq even though they are not in `grants`.
   */
  ackedEventSeq: number
  groups: WireGroup[]
  grants: WireGrant[]
  /** Authorizations made outside Perch: always undone (decision 25). */
  revertExternals: { portalId: number | null; mac: string }[]
  /** null = offline redemption is off: the router drops its list. */
  offlineVouchers: WireOfflineVoucher[] | null
}

export type ReconcileResult = { dbChanges: PortalDbChanges; desired: DesiredPortalState }

// ---------------------------------------------------------------------------
// Working state
// ---------------------------------------------------------------------------

type WorkGrant = {
  ref: GrantRef
  id: number | null
  localRef: string | null
  portalId: number
  mac: string
  groupKey: string
  source: GrantSource
  voucherId: number | null
  expiresAt: number | null
  createdAt: number
  lc: GrantLifecycle
  usage: { bytesUp: number; bytesDown: number; timeUsedSeconds: number }
  ip: string | null
  hostname: string | null
  lastSeenAt: number | null
  original: ServerGrant | null
  /** Seen in the router's usage snapshot. */
  onRouter: boolean
}

export type WorkVoucher = {
  v: ServerVoucher
  set: VoucherUpdate['set']
  add: VoucherUpdate['add']
}

function grantFieldsOf(w: WorkGrant): GrantFields {
  return {
    state: w.lc.state,
    delivery: w.lc.delivery,
    revision: w.lc.revision,
    startedAt: w.lc.startedAt,
    endedAt: w.lc.endedAt,
    endReason: w.lc.endReason,
    bytesUp: w.usage.bytesUp,
    bytesDown: w.usage.bytesDown,
    timeUsedSeconds: w.usage.timeUsedSeconds,
    ip: w.ip,
    hostname: w.hostname,
    lastSeenAt: w.lastSeenAt,
  }
}

function grantFieldsOfServer(g: ServerGrant): GrantFields {
  return {
    state: g.lifecycle.state,
    delivery: g.lifecycle.delivery,
    revision: g.lifecycle.revision,
    startedAt: g.lifecycle.startedAt,
    endedAt: g.lifecycle.endedAt,
    endReason: g.lifecycle.endReason,
    bytesUp: g.bytesUp,
    bytesDown: g.bytesDown,
    timeUsedSeconds: g.timeUsedSeconds,
    ip: g.ip,
    hostname: g.hostname,
    lastSeenAt: g.lastSeenAt,
  }
}

function nonNegInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null
}

/**
 * The reconciliation. `authoritative` is the gateway's Authoritative Mode.
 * Under owner decision 25 it no longer changes any outcome here (outside
 * authorizations are undone in both modes); it is recorded on the logged
 * events so the audit shows which mode the gateway was in.
 */
export function reconcile(
  server: ServerPortalState,
  report: RouterPortalReport,
  authoritative: boolean
): ReconcileResult {
  const now = server.now
  const portalIds = new Set(server.portals.map((p) => p.id))
  const enabledPortals = new Set(server.portals.filter((p) => p.enabled).map((p) => p.id))

  const events: PortalEventRow[] = []
  const sessions: Array<SessionOpen | SessionClose> = []
  const grantClocks: GrantClockStart[] = []
  const grantInserts = new Map<string, WorkGrant>()

  // --- index ------------------------------------------------------------
  const byId = new Map<number, WorkGrant>()
  const byLocalRef = new Map<string, WorkGrant>()
  for (const g of server.grants) {
    const w: WorkGrant = {
      ref: { id: g.id },
      id: g.id,
      localRef: g.localRef,
      portalId: g.portalId,
      mac: g.mac,
      groupKey: g.groupKey,
      source: g.source,
      voucherId: g.voucherId,
      expiresAt: g.expiresAt,
      createdAt: g.createdAt,
      lc: { ...g.lifecycle },
      usage: { bytesUp: g.bytesUp, bytesDown: g.bytesDown, timeUsedSeconds: g.timeUsedSeconds },
      ip: g.ip,
      hostname: g.hostname,
      lastSeenAt: g.lastSeenAt,
      original: g,
      onRouter: false,
    }
    byId.set(g.id, w)
    if (g.localRef) byLocalRef.set(g.localRef, w)
  }
  const vouchers = new Map<number, WorkVoucher>()
  for (const v of server.vouchers) {
    vouchers.set(v.id, { v, set: {}, add: { timeUsedSeconds: 0, bytesUsed: 0 } })
  }
  const groups = new Map<string, ServerGroup>()
  for (const g of server.groups) groups.set(g.groupKey, g)

  const resolve = (grantId: number | null | undefined, localRef?: string | null) => {
    if (typeof grantId === 'number') return byId.get(grantId) ?? null
    if (localRef) return byLocalRef.get(localRef) ?? null
    return null
  }

  const apply = (w: WorkGrant, event: GrantEvent, at: number, sessionReason?: string) => {
    const before = w.lc
    const t = transitionGrant(before, event)
    if (!t.ok) return false
    if (!t.changed) return true
    w.lc = t.grant
    if (t.session === 'open') {
      sessions.push({
        op: 'open',
        grant: w.ref,
        portalId: w.portalId,
        mac: w.mac,
        ip: w.ip,
        startedAt: at,
        startBytesUp: w.usage.bytesUp,
        startBytesDown: w.usage.bytesDown,
      })
    } else if (t.session === 'close') {
      sessions.push({
        op: 'close',
        grant: w.ref,
        endedAt: at,
        endReason: sessionReason ?? t.grant.endReason ?? t.grant.state,
        bytesUp: w.usage.bytesUp,
        bytesDown: w.usage.bytesDown,
      })
    }
    return true
  }

  const mergeUsage = (
    w: WorkGrant,
    up: unknown,
    down: unknown,
    active: unknown
  ): { dUp: number; dDown: number; dTime: number } => {
    const nUp = nonNegInt(up)
    const nDown = nonNegInt(down)
    const nTime = nonNegInt(active)
    const before = { ...w.usage }
    if (nUp !== null && nUp > w.usage.bytesUp) w.usage.bytesUp = nUp
    if (nDown !== null && nDown > w.usage.bytesDown) w.usage.bytesDown = nDown
    if (nTime !== null && nTime > w.usage.timeUsedSeconds) w.usage.timeUsedSeconds = nTime
    const delta = {
      dUp: w.usage.bytesUp - before.bytesUp,
      dDown: w.usage.bytesDown - before.bytesDown,
      dTime: w.usage.timeUsedSeconds - before.timeUsedSeconds,
    }
    if (w.voucherId !== null) {
      const wv = vouchers.get(w.voucherId)
      if (wv) {
        wv.add.bytesUsed += delta.dUp + delta.dDown
        wv.add.timeUsedSeconds += delta.dTime
      }
    }
    return delta
  }

  // --- 1. journal -----------------------------------------------------------
  const journalReset = report.lastEventSeq < server.ackedEventSeq
  if (journalReset) {
    events.push({
      at: now,
      type: 'journal_reset',
      portalId: null,
      grant: null,
      mac: null,
      detail: { ackedEventSeq: server.ackedEventSeq, lastEventSeq: report.lastEventSeq },
    })
  }
  if (report.truncated) {
    events.push({
      at: now,
      type: 'journal_truncated',
      portalId: null,
      grant: null,
      mac: null,
      detail: { ackedEventSeq: server.ackedEventSeq, lastEventSeq: report.lastEventSeq },
    })
  }
  const floor = journalReset ? -1 : server.ackedEventSeq
  const journal = [...report.events].filter((e) => e.seq > floor).sort((a, b) => a.seq - b.seq)

  for (const e of journal) {
    const mac = normalizeMac(e.mac)
    switch (e.type) {
      case 'offline_redeemed': {
        handleOfflineRedeemed(e, mac)
        break
      }
      case 'external_auth': {
        events.push({
          at: e.at,
          type: 'external_auth_reverted',
          portalId: e.portalId,
          grant: null,
          mac,
          detail: { ip: e.ip ?? null, authoritative, seq: e.seq },
        })
        break
      }
      case 'external_deauth': {
        events.push({
          at: e.at,
          type: 'external_deauth',
          portalId: e.portalId,
          grant: null,
          mac,
          detail: { seq: e.seq },
        })
        break
      }
      default: {
        const w = resolve(e.grantId, e.localRef)
        if (!w) {
          events.push({
            at: e.at,
            type: 'unknown_grant',
            portalId: e.portalId,
            grant: null,
            mac,
            detail: { seq: e.seq, event: e.type, grantId: e.grantId, localRef: e.localRef ?? null },
          })
          break
        }
        if (e.type === 'grant_active') {
          if (e.ip) w.ip = e.ip
          w.lastSeenAt = Math.max(w.lastSeenAt ?? 0, e.at)
          apply(w, { type: 'router_active', at: e.at }, e.at)
        } else if (e.type === 'session_paused') {
          apply(w, { type: 'router_paused', at: e.at }, e.at, 'idle')
        } else if (e.type === 'session_resumed') {
          w.lastSeenAt = Math.max(w.lastSeenAt ?? 0, e.at)
          apply(w, { type: 'router_resumed', at: e.at }, e.at)
        } else if (e.type === 'grant_ended') {
          mergeUsage(w, e.bytesUp, e.bytesDown, e.activeSeconds)
          if (e.reason !== 'removed') {
            apply(w, { type: 'router_ended', reason: e.reason, at: e.at }, e.at, e.reason)
          }
        }
      }
    }
  }

  function handleOfflineRedeemed(
    e: Extract<RouterEvent, { type: 'offline_redeemed' }>,
    mac: string | null
  ) {
    if (byLocalRef.has(e.localRef)) return // already materialized by an earlier sync
    const reject = (reason: string) =>
      events.push({
        at: e.at,
        type: 'offline_redeem_rejected',
        portalId: e.portalId,
        grant: null,
        mac,
        detail: { seq: e.seq, voucherId: e.voucherId, localRef: e.localRef, reason },
      })
    const wv = vouchers.get(e.voucherId)
    if (!wv) return reject('unknown_voucher')
    if (!mac) return reject('invalid_mac')
    if (e.portalId === null || !portalIds.has(e.portalId)) return reject('unknown_portal')
    const allowed = voucherPortal(wv.v)
    if (allowed !== null && allowed !== e.portalId) return reject('wrong_portal')
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(e.localRef)) return reject('invalid_local_ref')

    const v = wv.v
    const at = e.at
    const queued = e.placement === 'queue'
    const w: WorkGrant = {
      ref: { localRef: e.localRef },
      id: null,
      localRef: e.localRef,
      portalId: e.portalId,
      mac,
      groupKey: groupKey('voucher', v.id),
      source: 'voucher',
      voucherId: v.id,
      expiresAt: null,
      createdAt: at,
      lc: {
        state: queued ? 'queued' : 'pending_device',
        // The router holds it under its localRef; the controller still has to
        // send it back with its id.
        delivery: queued ? 'applied' : 'pending',
        revision: 1,
        startedAt: null,
        endedAt: null,
        endReason: null,
      },
      usage: { bytesUp: 0, bytesDown: 0, timeUsedSeconds: 0 },
      ip: e.ip ?? null,
      hostname: e.hostname ?? null,
      lastSeenAt: null,
      original: null,
      onRouter: false,
    }
    grantInserts.set(e.localRef, w)
    byLocalRef.set(e.localRef, w)

    // The voucher's facts, as the router decided them.
    if (v.boundPortalId === null && wv.set.boundPortalId === undefined) {
      wv.set.boundPortalId = e.portalId
    }
    if (v.firstUsedAt === null && wv.set.firstUsedAt === undefined) wv.set.firstUsedAt = at
    const currentExpiry = wv.set.expiresAt ?? v.limits.expiresAt
    if (!queued && currentExpiry === null) {
      const routerClock =
        typeof e.startsAt === 'number' && typeof e.expiresAt === 'number'
          ? { startsAt: e.startsAt, expiresAt: e.expiresAt }
          : startVoucherClock(v.limits, at)
      if (routerClock) {
        wv.set.startsAt = routerClock.startsAt
        wv.set.expiresAt = routerClock.expiresAt
      }
    }
    events.push({
      at,
      type: 'offline_redeemed',
      portalId: e.portalId,
      grant: w.ref,
      mac,
      detail: { seq: e.seq, voucherId: v.id, placement: e.placement },
    })
    // Revoked (or batch revoked) before the router redeemed it: the router
    // could not know. The grant is recorded, then ended.
    if (e.placement === 'swap') {
      const demoted = resolve(e.demotedGrantId, e.demotedLocalRef)
      if (demoted && isLiveState(demoted.lc.state)) apply(demoted, { type: 'queue' }, at, 'queued')
    }
    const revokedAt = v.revokedAt ?? v.batchRevokedAt
    if (revokedAt !== null && revokedAt <= at) {
      apply(w, { type: 'end', reason: 'revoked', at: now }, now, 'revoked')
    }
  }

  // --- 2. usage snapshot ------------------------------------------------------
  const routerHas = new Set<WorkGrant>()
  for (const u of report.grants) {
    const w = resolve(u.grantId, u.localRef)
    if (!w) continue // the desired set will drop it on the router
    routerHas.add(w)
    w.onRouter = true
    mergeUsage(w, u.bytesUp, u.bytesDown, u.activeSeconds)
    if (u.ip) w.ip = u.ip
    const seen = nonNegInt(u.lastSeenAt)
    if (seen !== null) w.lastSeenAt = Math.max(w.lastSeenAt ?? 0, seen)
    if (!isLiveState(w.lc.state)) continue
    // Paused first, so an acknowledgement below keeps it paused.
    if (u.state === 'paused' && w.lc.state !== 'paused') {
      apply(w, { type: 'router_paused', at: now }, now, 'idle')
    }
    if (u.revision !== null && u.revision === w.lc.revision) {
      apply(
        w,
        {
          type: 'delivered',
          revision: u.revision,
          result: u.state === 'active' ? 'active' : 'pending_device',
          at: now,
        },
        now
      )
    }
    if (u.state === 'active' && w.lc.state !== 'active') {
      apply(w, { type: 'router_active', at: now }, now)
    }
  }
  // The snapshot lists every grant the router holds (pending_device too).
  for (const w of [...byId.values(), ...grantInserts.values()]) {
    if (routerHas.has(w)) continue
    if (!isLiveState(w.lc.state)) {
      // Ended or queued here and gone there: the removal is acknowledged.
      if (w.lc.delivery === 'pending') {
        apply(w, { type: 'removed', revision: w.lc.revision }, now)
      }
      continue
    }
    // Live on the server, applied, but the router does not hold it (lost in
    // a router reset, or ended there with the event lost to a truncated
    // journal): send it again. Expired or used-up ones are ended by the
    // accounting below instead of being resurrected.
    if (!enabledPortals.has(w.portalId)) continue
    if (w.lc.delivery === 'applied') {
      w.lc = { ...w.lc, delivery: 'pending' }
      if (w.lc.state === 'active') {
        sessions.push({
          op: 'close',
          grant: w.ref,
          endedAt: now,
          endReason: 'lost',
          bytesUp: w.usage.bytesUp,
          bytesDown: w.usage.bytesDown,
        })
        w.lc = { ...w.lc, state: 'pending_device' }
      }
      events.push({
        at: now,
        type: 'grant_lost',
        portalId: w.portalId,
        grant: w.ref,
        mac: w.mac,
        detail: { truncated: report.truncated },
      })
    }
  }

  // --- 3/4. server accounting -------------------------------------------------
  const allWork = () => [...byId.values(), ...grantInserts.values()]
  const voucherFacts = (wv: WorkVoucher): VoucherFacts => ({
    ...wv.v,
    boundPortalId: wv.set.boundPortalId ?? wv.v.boundPortalId,
    firstUsedAt: wv.set.firstUsedAt ?? wv.v.firstUsedAt,
    exhaustedAt: wv.set.exhaustedAt ?? wv.v.exhaustedAt,
    limits: { ...wv.v.limits, expiresAt: wv.set.expiresAt ?? wv.v.limits.expiresAt },
    usage: {
      timeUsedSeconds: wv.v.usage.timeUsedSeconds + wv.add.timeUsedSeconds,
      bytesUsed: wv.v.usage.bytesUsed + wv.add.bytesUsed,
    },
  })

  const limitsOf = (key: string): GroupLimits | null => {
    const parsed = parseGroupKey(key)
    if (!parsed) return null
    if (parsed.kind === 'voucher') {
      const wv = vouchers.get(parsed.id)
      return wv ? voucherGroupLimits(voucherFacts(wv).limits) : null
    }
    return groups.get(key)?.limits ?? null
  }

  const members = (key: string) => allWork().filter((w) => w.groupKey === key)

  const usageOf = (key: string): GroupUsage => {
    const parsed = parseGroupKey(key)
    if (parsed?.kind === 'voucher') {
      const wv = vouchers.get(parsed.id)
      if (wv) return voucherFacts(wv).usage
    }
    return groupUsage(members(key).map(toUsageRow))
  }

  for (const [, wv] of vouchers) {
    const facts = voucherFacts(wv)
    const status = voucherStatus(facts, now)
    if ((status === 'expired' || status === 'exhausted') && facts.exhaustedAt === null) {
      // Only a voucher that was used is "exhausted"; an unused one past
      // redeemBy simply expired and keeps exhausted_at null.
      if (facts.firstUsedAt !== null) wv.set.exhaustedAt = now
    }
  }

  const groupKeys = new Set(allWork().map((w) => w.groupKey))
  for (const key of groupKeys) {
    const limits = limitsOf(key)
    const parsed = parseGroupKey(key)
    const wv = parsed?.kind === 'voucher' ? vouchers.get(parsed.id) : undefined
    const revoked = wv ? voucherStatus(voucherFacts(wv), now) === 'revoked' : false
    const usage = usageOf(key)
    for (const w of members(key)) {
      if (w.lc.state === 'ended') continue
      let reason: GrantEndReason | null = revoked ? 'revoked' : null
      if (!reason && limits) reason = exhaustion(grantLimits(limits, w.expiresAt), usage, now)
      if (reason) apply(w, { type: 'end', reason, at: now }, now, reason)
    }
  }

  // --- 5. stacking --------------------------------------------------------------
  const byDevice = new Map<string, WorkGrant[]>()
  for (const w of allWork()) {
    if (w.lc.state === 'ended') continue
    const key = `${w.portalId}|${w.mac}`
    const list = byDevice.get(key)
    if (list) list.push(w)
    else byDevice.set(key, [w])
  }
  for (const list of byDevice.values()) {
    const entitlements = list
      .map((w) => {
        const limits = limitsOf(w.groupKey)
        return limits
          ? ({
              grantId: w.id ?? Number.MAX_SAFE_INTEGER,
              limits: grantLimits(limits, w.expiresAt),
              createdAt: w.createdAt,
              w,
            } as Entitlement & { w: WorkGrant })
          : null
      })
      .filter((x): x is Entitlement & { w: WorkGrant } => x !== null)
    const live = entitlements.filter((x) => isLiveState(x.w.lc.state))
    if (live.length > 1) {
      // Two live entitlements for one device (an offline redemption raced
      // one made here): the first in consumption order stays.
      const [, ...rest] = orderEntitlements(live)
      for (const x of rest) apply(x.w, { type: 'queue' }, now, 'queued')
    } else if (live.length === 0) {
      const queued = orderEntitlements(entitlements.filter((x) => x.w.lc.state === 'queued'))
      const next = queued[0]
      if (next) {
        apply(next.w, { type: 'promote' }, now)
        const parsed = parseGroupKey(next.w.groupKey)
        const wv = parsed?.kind === 'voucher' ? vouchers.get(parsed.id) : undefined
        if (wv) {
          const facts = voucherFacts(wv)
          const clock = startVoucherClock(facts.limits, now)
          if (clock) {
            wv.set.startsAt = clock.startsAt
            wv.set.expiresAt = clock.expiresAt
          }
        } else if (parsed?.kind === 'grant' && next.w.id !== null) {
          // A queued API/admin grant's wall clock waits for its turn too
          // (paid time never runs while another entitlement is current).
          const group = groups.get(next.w.groupKey)
          const clock = group ? startVoucherClock(group.limits, now) : null
          if (group && clock) {
            groups.set(group.groupKey, {
              ...group,
              limits: { ...group.limits, expiresAt: clock.expiresAt },
            })
            grantClocks.push({ id: next.w.id, expiresAt: clock.expiresAt })
          }
        }
      }
    }
  }

  // --- 6. desired -----------------------------------------------------------------
  const desiredGrants: WireGrant[] = []
  const desiredGroupKeys = new Set<string>()
  const liveOnRouterByGroup = new Map<string, WorkGrant[]>()
  for (const w of allWork()) {
    if (!isLiveState(w.lc.state) || !enabledPortals.has(w.portalId)) continue
    if (!limitsOf(w.groupKey)) continue
    desiredGrants.push({
      grantId: w.id,
      localRef: w.localRef,
      portalId: w.portalId,
      groupKey: w.groupKey,
      mac: w.mac,
      expiresAt: w.expiresAt,
      revision: w.lc.revision,
    })
    desiredGroupKeys.add(w.groupKey)
    const list = liveOnRouterByGroup.get(w.groupKey)
    if (list) list.push(w)
    else liveOnRouterByGroup.set(w.groupKey, [w])
  }
  desiredGrants.sort(
    (a, b) =>
      (a.grantId ?? Number.MAX_SAFE_INTEGER) - (b.grantId ?? Number.MAX_SAFE_INTEGER) ||
      (a.localRef ?? '').localeCompare(b.localRef ?? '')
  )

  const desiredGroups: WireGroup[] = []
  for (const key of [...desiredGroupKeys].sort()) {
    const limits = limitsOf(key)!
    const live = liveOnRouterByGroup.get(key) ?? []
    const liveUsage = groupUsage(live.map(toUsageRow))
    const total = usageOf(key)
    const parsed = parseGroupKey(key)!
    const wv = parsed.kind === 'voucher' ? vouchers.get(parsed.id) : undefined
    desiredGroups.push({
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
      revision: wv
        ? (wv.set.revision ?? wv.v.revision)
        : (groups.get(key)?.revision ?? live[0]?.lc.revision ?? 1),
    })
  }

  // Voucher revisions: any change to the facts the router holds bumps it.
  for (const wv of vouchers.values()) {
    const s = wv.set
    if (
      s.boundPortalId !== undefined ||
      s.startsAt !== undefined ||
      s.expiresAt !== undefined ||
      s.exhaustedAt !== undefined
    ) {
      s.revision = wv.v.revision + 1
    }
  }
  // Group revisions were read before the bump above: refresh them.
  for (const g of desiredGroups) {
    const parsed = parseGroupKey(g.groupKey)!
    if (parsed.kind === 'voucher') {
      const wv = vouchers.get(parsed.id)
      if (wv) g.revision = wv.set.revision ?? wv.v.revision
    }
  }

  const revertExternals: { portalId: number | null; mac: string }[] = []
  const seenExternal = new Set<string>()
  for (const x of report.externals) {
    const mac = normalizeMac(x.mac)
    if (!mac) continue
    const key = `${x.portalId ?? ''}|${mac}`
    if (seenExternal.has(key)) continue
    seenExternal.add(key)
    revertExternals.push({ portalId: x.portalId, mac })
  }

  const offlineVouchers = server.offline.enabled
    ? buildOfflineVouchers(
        [...vouchers.values()],
        voucherFacts,
        portalIds,
        now,
        server.offline.limit
      )
    : null

  // --- output ------------------------------------------------------------------
  const grantUpdates: GrantUpdate[] = []
  for (const w of byId.values()) {
    const before = grantFieldsOfServer(w.original!)
    const after = grantFieldsOf(w)
    const set: Partial<GrantFields> = {}
    for (const key of Object.keys(after) as Array<keyof GrantFields>) {
      if (before[key] !== after[key]) (set as Record<string, unknown>)[key] = after[key]
    }
    if (Object.keys(set).length) grantUpdates.push({ id: w.id!, set })
  }
  const inserts: GrantInsert[] = [...grantInserts.values()].map((w) => ({
    ...grantFieldsOf(w),
    localRef: w.localRef!,
    portalId: w.portalId,
    mac: w.mac,
    source: 'voucher',
    groupKey: w.groupKey,
    voucherId: w.voucherId!,
    expiresAt: null,
    createdAt: w.createdAt,
  }))
  const voucherUpdates: VoucherUpdate[] = []
  for (const wv of vouchers.values()) {
    if (Object.keys(wv.set).length || wv.add.bytesUsed || wv.add.timeUsedSeconds) {
      voucherUpdates.push({ id: wv.v.id, set: wv.set, add: wv.add })
    }
  }

  const ackedEventSeq = journalReset
    ? report.lastEventSeq
    : Math.max(server.ackedEventSeq, report.lastEventSeq)

  return {
    dbChanges: {
      ackedEventSeq,
      grantInserts: inserts,
      grantUpdates,
      grantClocks,
      sessions,
      voucherUpdates,
      events,
    },
    desired: {
      gatewayId: server.gatewayId,
      full: true,
      serverNow: now,
      ackedEventSeq,
      groups: desiredGroups,
      grants: desiredGrants,
      revertExternals,
      offlineVouchers,
    },
  }
}

function toUsageRow(w: WorkGrant): GrantUsageRow {
  return {
    id: w.id ?? -1,
    state: w.lc.state,
    bytesUp: w.usage.bytesUp,
    bytesDown: w.usage.bytesDown,
    timeUsedSeconds: w.usage.timeUsedSeconds,
  }
}

/**
 * The vouchers a gateway may redeem while the controller is unreachable
 * (decision 20). Eligible: the voucher's portal (bound, else its batch's) is
 * one of this gateway's portals, so no other gateway can redeem it (no
 * double spend); status unused or active; a verifier is available. Vouchers
 * valid on any portal are not offered until they are bound by a first
 * (online) redemption. Active ones first (a device may need to move),
 * then newest batches; at most `limit`.
 */
export function buildOfflineVouchers(
  vouchers: readonly WorkVoucher[],
  facts: (wv: WorkVoucher) => VoucherFacts,
  portalIds: ReadonlySet<number>,
  now: number,
  limit: number
): WireOfflineVoucher[] {
  const eligible: { wv: WorkVoucher; f: VoucherFacts; status: string }[] = []
  for (const wv of vouchers) {
    if (!wv.v.verifier) continue
    const f = facts(wv)
    const portal = voucherPortal(f)
    if (portal === null || !portalIds.has(portal)) continue
    const status = voucherStatus(f, now)
    if (status !== 'unused' && status !== 'active') continue
    eligible.push({ wv, f, status })
  }
  eligible.sort(
    (a, b) =>
      (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) ||
      b.wv.v.createdAt - a.wv.v.createdAt ||
      b.wv.v.id - a.wv.v.id
  )
  return eligible.slice(0, Math.max(0, limit)).map(({ wv, f }) => ({
    voucherId: f.id,
    verifier: wv.v.verifier!,
    portalIds: [voucherPortal(f)!],
    groupKey: groupKey('voucher', f.id),
    durationMode: f.limits.durationMode,
    startMode: f.limits.startMode as StartMode,
    durationSeconds: f.limits.durationSeconds,
    quotaBytes: f.limits.quotaBytes,
    downKbps: f.limits.downKbps,
    upKbps: f.limits.upKbps,
    maxDevices: f.limits.maxDevices,
    redeemBy: f.redeemBy,
    expiresAt: f.limits.expiresAt,
    timeUsedSeconds: f.usage.timeUsedSeconds,
    bytesUsed: f.usage.bytesUsed,
    revision: wv.set.revision ?? wv.v.revision,
    firstUsedAt: f.firstUsedAt,
  }))
}
