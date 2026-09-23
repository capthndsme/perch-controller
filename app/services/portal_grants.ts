import PortalGrant from '#models/portal_grant'
import PortalUser from '#models/portal_user'
import Voucher from '#models/voucher'
import VoucherBatch from '#models/voucher_batch'
import type { PortalPush } from '#services/portal_agent_sender'
import { PortalError } from '#services/portal_errors'
import {
  type Entitlement,
  entitlementClass,
  grantLimits,
  groupUsage,
  orderEntitlements,
  remaining,
  startVoucherClock,
  voucherGroupLimits,
} from '#services/portal/groups'
import {
  type GrantEvent,
  type GrantLifecycle,
  transitionGrant,
} from '#services/portal/grant_lifecycle'
import {
  type GrantEndReason,
  type GroupLimits,
  type GroupUsage,
  LIVE_GRANT_STATES,
  isLiveState,
  parseGroupKey,
} from '#services/portal/types'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * Grant changes made by the REST layer (docs/gateway/portal.md section 11.4):
 * end, extend, queue, promote, each through the pure lifecycle
 * (`grant_lifecycle.ts`), with the session rows and the stacking rule of
 * decision 23 kept the way reconciliation keeps them. Every function takes the
 * transaction of a caller that runs inside the gateway's portal queue and
 * returns the router pushes it implies; the caller sends them after commit.
 */

export const ms = (value: DateTime | null | undefined): number | null =>
  value ? value.toMillis() : null
export const utc = (value: number): DateTime => DateTime.fromMillis(value, { zone: 'utc' })
export const num = (value: bigint | number | null | undefined): number => Number(value ?? 0)

/** Grant ids the router must be told about, by direction. */
export type GrantPushes = { authorize: Set<number>; deauthorize: Set<number>; vouchers: boolean }

export function emptyPushes(): GrantPushes {
  return { authorize: new Set(), deauthorize: new Set(), vouchers: false }
}

export function lifecycleOf(g: PortalGrant): GrantLifecycle {
  return {
    state: g.state,
    delivery: g.delivery,
    revision: g.revision,
    startedAt: ms(g.startedAt),
    endedAt: ms(g.endedAt),
    endReason: g.endReason,
  }
}

function setLifecycle(g: PortalGrant, lc: GrantLifecycle) {
  g.state = lc.state
  g.delivery = lc.delivery
  g.revision = lc.revision
  g.startedAt = lc.startedAt === null ? null : utc(lc.startedAt)
  g.endedAt = lc.endedAt === null ? null : utc(lc.endedAt)
  g.endReason = lc.endReason
}

/**
 * Applies a server command to a grant row (saved), closes its session when
 * it leaves `active`, and records the push. Throws `grant_ended` (409) when
 * the grant cannot take the command.
 */
export async function transition(
  trx: TransactionClientContract,
  grant: PortalGrant,
  event: GrantEvent,
  now: number,
  pushes: GrantPushes
): Promise<void> {
  const t = transitionGrant(lifecycleOf(grant), event)
  if (!t.ok) {
    throw new PortalError(
      409,
      t.error,
      t.error === 'grant_ended'
        ? `Grant ${grant.id} has ended.`
        : `Grant ${grant.id} cannot do that now.`,
      { grantId: num(grant.id) }
    )
  }
  if (!t.changed) return
  setLifecycle(grant, t.grant)
  grant.useTransaction(trx)
  await grant.save()
  const id = num(grant.id)
  if (t.session === 'close') {
    await trx.rawQuery(
      `UPDATE portal_sessions
          SET ended_at = ?, end_reason = ?,
              bytes_up = GREATEST(0, CAST(? AS SIGNED) - CAST(start_bytes_up AS SIGNED)),
              bytes_down = GREATEST(0, CAST(? AS SIGNED) - CAST(start_bytes_down AS SIGNED))
        WHERE grant_id = ? AND ended_at IS NULL`,
      [
        utc(now).toSQL({ includeOffset: false })!,
        (t.grant.endReason ?? t.grant.state).slice(0, 24),
        num(grant.bytesUp),
        num(grant.bytesDown),
        id,
      ]
    )
  }
  if (t.push === 'authorize') {
    pushes.authorize.add(id)
    pushes.deauthorize.delete(id)
  } else if (t.push === 'deauthorize') {
    pushes.deauthorize.add(id)
    pushes.authorize.delete(id)
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export type GroupInfo = {
  key: string
  limits: GroupLimits
  usage: GroupUsage
  /** Live (pending_device, active, paused) grants of the group. */
  devices: number
}

/**
 * Limits, usage and live device count of each group, the way reconciliation
 * computes them (`portal_store.loadServerPortalState`): a voucher group's
 * usage is the voucher's totals, a user group's the sum of its grants, a
 * grant group's the grant's own counters.
 */
export async function loadGroups(
  keys: Iterable<string>,
  client?: TransactionClientContract
): Promise<Map<string, GroupInfo>> {
  const voucherIds = new Set<number>()
  const userIds = new Set<number>()
  const grantIds = new Set<number>()
  const all = new Set<string>()
  for (const key of keys) {
    const parsed = parseGroupKey(key)
    if (!parsed) continue
    all.add(key)
    if (parsed.kind === 'voucher') voucherIds.add(parsed.id)
    else if (parsed.kind === 'user') userIds.add(parsed.id)
    else grantIds.add(parsed.id)
  }
  const out = new Map<string, GroupInfo>()
  if (!all.size) return out

  const q = client ?? db
  const deviceRows = (await q
    .from('portal_grants')
    .whereIn('group_key', [...all])
    .whereIn('state', [...LIVE_GRANT_STATES])
    .groupBy('group_key')
    .select('group_key')
    .count('* as n')) as Array<{ group_key: string; n: number | string }>
  const devices = new Map(deviceRows.map((r) => [r.group_key, Number(r.n)]))

  if (voucherIds.size) {
    const vouchers = await Voucher.query({ client }).whereIn('id', [...voucherIds])
    const batchRows = await VoucherBatch.query({ client }).whereIn('id', [
      ...new Set(vouchers.map((v) => v.batchId)),
    ])
    const batches = new Map(batchRows.map((b) => [b.id, b]))
    for (const v of vouchers) {
      const b = batches.get(v.batchId)
      if (!b) continue
      const key = `v:${v.id}`
      out.set(key, {
        key,
        limits: voucherGroupLimits(voucherLimitsInput(v, b)),
        usage: { timeUsedSeconds: v.timeUsedSeconds, bytesUsed: num(v.bytesUsed) },
        devices: devices.get(key) ?? 0,
      })
    }
  }
  if (userIds.size) {
    const users = await PortalUser.query({ client }).whereIn('id', [...userIds])
    const usageRows = (await q
      .from('portal_grants')
      .whereIn(
        'group_key',
        [...userIds].map((id) => `u:${id}`)
      )
      .groupBy('group_key')
      .select('group_key')
      .sum('time_used_seconds as t')
      .sum('bytes_up as up')
      .sum('bytes_down as down')) as Array<{
      group_key: string
      t: unknown
      up: unknown
      down: unknown
    }>
    const usage = new Map(
      usageRows.map((r) => [
        r.group_key,
        { timeUsedSeconds: Number(r.t ?? 0), bytesUsed: Number(r.up ?? 0) + Number(r.down ?? 0) },
      ])
    )
    for (const u of users) {
      const key = `u:${u.id}`
      out.set(key, {
        key,
        limits: userGroupLimits(u),
        usage: usage.get(key) ?? { timeUsedSeconds: 0, bytesUsed: 0 },
        devices: devices.get(key) ?? 0,
      })
    }
  }
  if (grantIds.size) {
    const grants = await PortalGrant.query({ client }).whereIn('id', [...grantIds])
    for (const g of grants) {
      const key = `g:${num(g.id)}`
      if (g.groupKey !== key) continue
      out.set(key, {
        key,
        limits: grantGroupLimits(g),
        usage: groupUsage([
          {
            id: num(g.id),
            state: g.state,
            bytesUp: num(g.bytesUp),
            bytesDown: num(g.bytesDown),
            timeUsedSeconds: g.timeUsedSeconds,
          },
        ]),
        devices: devices.get(key) ?? 0,
      })
    }
  }
  return out
}

export function voucherLimitsInput(v: Voucher, b: VoucherBatch) {
  return {
    durationSeconds: b.durationMinutes === null ? null : b.durationMinutes * 60,
    durationMode: b.durationMode,
    startMode: b.startMode,
    quotaBytes: b.quotaBytes === null ? null : num(b.quotaBytes),
    downKbps: b.downKbps,
    upKbps: b.upKbps,
    maxDevices: Math.max(1, b.maxDevices),
    expiresAt: ms(v.expiresAt),
  }
}

export function userGroupLimits(u: PortalUser): GroupLimits {
  return {
    durationMode: 'wall_clock',
    expiresAt: null,
    durationSeconds: null,
    quotaBytes: null,
    downKbps: u.downKbps,
    upKbps: u.upKbps,
    maxDevices: Math.max(1, u.maxDevices),
  }
}

/** A `g:` group's limits are its grant row's own. */
export function grantGroupLimits(g: PortalGrant): GroupLimits {
  return {
    durationMode: g.durationMode,
    expiresAt: ms(g.expiresAt),
    durationSeconds: g.timeBudgetSeconds,
    quotaBytes: g.quotaBytes === null ? null : num(g.quotaBytes),
    downKbps: g.downKbps,
    upKbps: g.upKbps,
    maxDevices: 1,
  }
}

/** Effective limits of one grant (a user login's own deadline tightens its group's). */
export function effectiveLimits(g: PortalGrant, group: GroupInfo): GroupLimits {
  return g.groupKey.startsWith('u:') ? grantLimits(group.limits, ms(g.expiresAt)) : group.limits
}

export function remainingOf(g: PortalGrant, group: GroupInfo, now: number) {
  return remaining(effectiveLimits(g, group), group.usage, now)
}

// ---------------------------------------------------------------------------
// Stacking (decision 23)
// ---------------------------------------------------------------------------

/**
 * The device's current (live) grant on the portal, if any: the first in
 * consumption order when a race left several.
 */
export async function deviceCurrent(
  trx: TransactionClientContract,
  portalId: number,
  mac: string
): Promise<{ grant: PortalGrant; entitlement: Entitlement } | null> {
  const live = await PortalGrant.query({ client: trx })
    .where('portal_id', portalId)
    .where('mac', mac)
    .whereIn('state', [...LIVE_GRANT_STATES])
    .forUpdate()
  if (!live.length) return null
  const groups = await loadGroups(
    live.map((g) => g.groupKey),
    trx
  )
  const items = live
    .map((g) => {
      const group = groups.get(g.groupKey)
      return group
        ? { grant: g, entitlement: entitlementOf(g, group) }
        : {
            grant: g,
            entitlement: { grantId: num(g.id), limits: openLimits(), createdAt: ms(g.createdAt)! },
          }
    })
    .sort((a, b) => orderIndex(a.entitlement, b.entitlement))
  return items[0]
}

function orderIndex(a: Entitlement, b: Entitlement): number {
  const [first] = orderEntitlements([a, b])
  return first === a ? -1 : 1
}

function openLimits(): GroupLimits {
  return {
    durationMode: 'wall_clock',
    expiresAt: null,
    durationSeconds: null,
    quotaBytes: null,
    downKbps: null,
    upKbps: null,
    maxDevices: 1,
  }
}

export function entitlementOf(g: PortalGrant, group: GroupInfo): Entitlement {
  return { grantId: num(g.id), limits: effectiveLimits(g, group), createdAt: ms(g.createdAt)! }
}

export { entitlementClass }

/**
 * When the device holds no live grant on the portal any more, promotes its
 * next queued entitlement (consumption order) and starts a wall clock that
 * waited for it: a voucher's (`first_use`) or a queued API/admin grant's.
 */
export async function promoteNext(
  trx: TransactionClientContract,
  portalId: number,
  mac: string,
  now: number,
  pushes: GrantPushes
): Promise<PortalGrant | null> {
  const nonEnded = await PortalGrant.query({ client: trx })
    .where('portal_id', portalId)
    .where('mac', mac)
    .whereNot('state', 'ended')
    .forUpdate()
  if (nonEnded.some((g) => isLiveState(g.state))) return null
  const queued = nonEnded.filter((g) => g.state === 'queued')
  if (!queued.length) return null
  const groups = await loadGroups(
    queued.map((g) => g.groupKey),
    trx
  )
  const candidates = queued
    .map((g) => {
      const group = groups.get(g.groupKey)
      return group ? { ...entitlementOf(g, group), g } : null
    })
    .filter((x): x is Entitlement & { g: PortalGrant } => x !== null)
  const [next] = orderEntitlements(candidates)
  if (!next) return null
  await transition(trx, next.g, { type: 'promote' }, now, pushes)
  await startWaitingClock(trx, next.g, now, pushes)
  return next.g
}

/** Starts the wall clock of a grant that just became live, when it waited for that. */
export async function startWaitingClock(
  trx: TransactionClientContract,
  grant: PortalGrant,
  now: number,
  pushes: GrantPushes
): Promise<void> {
  const parsed = parseGroupKey(grant.groupKey)
  if (parsed?.kind === 'voucher') {
    const voucher = await Voucher.query({ client: trx }).where('id', parsed.id).forUpdate().first()
    if (!voucher) return
    const batch = await VoucherBatch.findOrFail(voucher.batchId, { client: trx })
    const clock = startVoucherClock(voucherLimitsInput(voucher, batch), now)
    if (!clock) return
    voucher.startsAt = utc(clock.startsAt)
    voucher.expiresAt = utc(clock.expiresAt)
    voucher.revision += 1
    voucher.useTransaction(trx)
    await voucher.save()
    pushes.vouchers = true
  } else if (parsed?.kind === 'grant') {
    if (
      grant.durationMode === 'wall_clock' &&
      grant.timeBudgetSeconds !== null &&
      grant.expiresAt === null
    ) {
      grant.expiresAt = utc(now + grant.timeBudgetSeconds * 1000)
      grant.useTransaction(trx)
      await grant.save()
    }
  }
}

/**
 * Ends grants (server side) and promotes whatever each device had queued
 * next. Grants already ended are left alone.
 */
export async function endGrants(
  trx: TransactionClientContract,
  grants: PortalGrant[],
  reason: GrantEndReason,
  now: number,
  pushes: GrantPushes,
  options: { promote?: boolean } = {}
): Promise<void> {
  const devices = new Map<string, { portalId: number; mac: string }>()
  for (const g of grants) {
    if (g.state === 'ended') continue
    await transition(trx, g, { type: 'end', reason, at: now }, now, pushes)
    devices.set(`${g.portalId}|${g.mac}`, { portalId: g.portalId, mac: g.mac })
  }
  if (options.promote === false) return
  for (const d of devices.values()) await promoteNext(trx, d.portalId, d.mac, now, pushes)
}

/** The router pushes a set of grant changes implies, in send order. */
export function grantPushList(pushes: GrantPushes): PortalPush[] {
  const list: PortalPush[] = []
  if (pushes.deauthorize.size) {
    list.push({ kind: 'deauthorize', grantIds: [...pushes.deauthorize].sort((a, b) => a - b) })
  }
  if (pushes.authorize.size) {
    list.push({ kind: 'authorize', grantIds: [...pushes.authorize].sort((a, b) => a - b) })
  }
  if (pushes.vouchers) list.push({ kind: 'vouchers' })
  return list
}
