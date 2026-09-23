import Portal from '#models/portal'
import PortalApiClient from '#models/portal_api_client'
import PortalGrant from '#models/portal_grant'
import PortalUser from '#models/portal_user'
import User from '#models/user'
import Voucher from '#models/voucher'
import { type PortalDelivery, sendPortalPushes } from '#services/portal_agent_sender'
import { PortalError, grantNotFound } from '#services/portal_errors'
import {
  emptyPushes,
  endGrants,
  grantPushList,
  loadGroups,
  num,
  transition,
  utc,
} from '#services/portal_grants'
import { runInPortalQueue } from '#services/portal_queue'
import { LIVE_GRANT_STATES, normalizeMac } from '#services/portal/types'
import { type GrantView, grantView, iso } from '#transformers/portal'
import { firstOf } from '#services/portal_params'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

/**
 * Grants and sessions for the dashboard (docs/gateway/portal.md section
 * 11.4): the list, extend, revoke, the session history.
 */

/** Views of grant rows, with their groups and the rows they reference. */
export async function grantViews(
  grants: PortalGrant[],
  now: number = Date.now(),
  client?: TransactionClientContract
): Promise<GrantView[]> {
  if (!grants.length) return []
  const groups = await loadGroups(
    grants.map((g) => g.groupKey),
    client
  )
  const ids = (pick: (g: PortalGrant) => number | null) => [
    ...new Set(grants.map(pick).filter((id): id is number => id !== null)),
  ]
  const voucherIds = ids((g) => g.voucherId)
  const userIds = ids((g) => g.portalUserId)
  const clientIds = ids((g) => g.apiClientId)
  const creatorIds = ids((g) => g.createdByUserId)
  const vouchers = new Map(
    (voucherIds.length
      ? await Voucher.query({ client }).select(['id', 'batch_id', 'hint']).whereIn('id', voucherIds)
      : []
    ).map((v) => [v.id, { id: v.id, batchId: v.batchId, hint: v.hint }])
  )
  const users = new Map(
    (userIds.length
      ? await PortalUser.query({ client }).select(['id', 'username']).whereIn('id', userIds)
      : []
    ).map((u) => [u.id, { id: u.id, username: u.username }])
  )
  const clients = new Map(
    (clientIds.length
      ? await PortalApiClient.query({ client }).select(['id', 'name']).whereIn('id', clientIds)
      : []
    ).map((c) => [c.id, { id: c.id, name: c.name }])
  )
  const creators = new Map(
    (creatorIds.length
      ? await User.query({ client }).select(['id', 'email']).whereIn('id', creatorIds)
      : []
    ).map((u) => [u.id, { id: u.id, email: u.email }])
  )
  return grants.map((g) =>
    grantView(
      g,
      groups.get(g.groupKey) ?? null,
      {
        voucher: g.voucherId === null ? null : (vouchers.get(g.voucherId) ?? null),
        portalUser: g.portalUserId === null ? null : (users.get(g.portalUserId) ?? null),
        apiClient: g.apiClientId === null ? null : (clients.get(g.apiClientId) ?? null),
        createdBy: g.createdByUserId === null ? null : (creators.get(g.createdByUserId) ?? null),
      },
      now
    )
  )
}

export type GrantListFilter = {
  portalId?: number
  gatewayId?: number
  state?: 'active' | 'live' | 'queued' | 'ended' | 'all'
  mac?: string
  source?: string
  voucherId?: number
  limit: number
  offset: number
}

export async function listGrants(
  filter: GrantListFilter
): Promise<{ items: GrantView[]; total: number }> {
  const query = PortalGrant.query()
  if (filter.portalId) query.where('portal_id', filter.portalId)
  if (filter.gatewayId) {
    query.whereIn('portal_id', Portal.query().select('id').where('gateway_id', filter.gatewayId))
  }
  const state = filter.state ?? 'active'
  if (state === 'active') query.whereNot('state', 'ended')
  else if (state === 'live') query.whereIn('state', [...LIVE_GRANT_STATES])
  else if (state === 'queued') query.where('state', 'queued')
  else if (state === 'ended') query.where('state', 'ended')
  if (filter.mac) {
    const mac = normalizeMac(filter.mac)
    if (!mac) throw new PortalError(422, 'invalid_mac', `"${filter.mac}" is not a MAC address.`)
    query.where('mac', mac)
  }
  if (filter.source) query.where('source', filter.source)
  if (filter.voucherId) query.where('voucher_id', filter.voucherId)
  const [counted] = await query.clone().pojo<{ total: number | string }>().count('* as total')
  const rows = await query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(filter.limit)
    .offset(filter.offset)
  return { items: await grantViews(rows), total: Number(counted?.total ?? 0) }
}

async function grantWithGateway(id: number): Promise<{ grant: PortalGrant; gatewayId: number }> {
  const grant = await PortalGrant.find(id)
  if (!grant) throw grantNotFound(id)
  const portal = await Portal.find(grant.portalId)
  if (!portal) throw grantNotFound(id)
  return { grant, gatewayId: portal.gatewayId }
}

async function lockGrant(trx: TransactionClientContract, id: number): Promise<PortalGrant> {
  const grant = await PortalGrant.query({ client: trx }).where('id', id).forUpdate().first()
  if (!grant) throw grantNotFound(id)
  return grant
}

export type GrantChange = { grant: GrantView; delivery: PortalDelivery }

/**
 * `POST /portal/grants/:id/extend {minutes?, bytes?}`. Only limits the grant
 * owns can grow: an API/admin grant's time and quota, a portal-user login's
 * deadline. A voucher grant's limits are its batch's (409
 * `grant_not_extendable`: sell another voucher); a limit the grant does not
 * have (a time-only grant has unlimited data) is 422 `nothing_to_extend`.
 */
export async function extendGrant(
  id: number,
  input: { minutes?: number; bytes?: number }
): Promise<GrantChange> {
  const { gatewayId } = await grantWithGateway(id)
  return runInPortalQueue(gatewayId, async () => {
    const now = Date.now()
    const pushes = emptyPushes()
    const grant = await db.transaction(async (trx) => {
      const g = await lockGrant(trx, id)
      if (g.state === 'ended') {
        throw new PortalError(409, 'grant_ended', `Grant ${id} has ended.`, { grantId: id })
      }
      const kind = g.groupKey[0]
      if (kind === 'v') {
        throw new PortalError(
          409,
          'grant_not_extendable',
          'A voucher grant takes its limits from the voucher batch; issue another voucher instead.',
          { grantId: id }
        )
      }
      if (kind === 'u') {
        if (input.bytes !== undefined || g.expiresAt === null) {
          throw nothingToExtend(id, input.bytes !== undefined ? 'bytes' : 'minutes')
        }
        g.expiresAt = utc(Math.max(g.expiresAt.toMillis(), now) + input.minutes! * 60_000)
      } else {
        applyGrantExtension(g, input, now, id)
      }
      await transition(trx, g, { type: 'extend' }, now, pushes)
      g.useTransaction(trx)
      await g.save()
      return g
    })
    const delivery = await sendPortalPushes(gatewayId, grantPushList(pushes))
    return { grant: await firstOf(grantViews([grant], now)), delivery }
  })
}

function nothingToExtend(id: number, what: 'minutes' | 'bytes'): PortalError {
  return new PortalError(
    422,
    'nothing_to_extend',
    what === 'bytes'
      ? `Grant ${id} has no data quota to add to (its data is unlimited).`
      : `Grant ${id} has no time limit to add to.`,
    { grantId: id, field: what }
  )
}

/** Whether a `g:` grant has the limits an extension of `input` would grow. */
export function grantCovers(
  g: PortalGrant,
  input: { minutes?: number | null; bytes?: number | null; durationMode?: string }
): boolean {
  if (input.minutes) {
    if (g.timeBudgetSeconds === null && g.expiresAt === null) return false
    if (input.durationMode && input.durationMode !== g.durationMode) return false
  }
  if (input.bytes && g.quotaBytes === null) return false
  return true
}

/**
 * Grows a `g:` grant's own limits in place (not saved). Minutes: a running
 * wall clock moves on from `max(deadline, now)`; a waiting one (queued) and an
 * active-time budget grow their budget.
 */
export function applyGrantExtension(
  g: PortalGrant,
  input: { minutes?: number | null; bytes?: number | null },
  now: number,
  id: number = num(g.id)
): void {
  if (input.minutes) {
    if (g.timeBudgetSeconds === null && g.expiresAt === null) throw nothingToExtend(id, 'minutes')
    const seconds = input.minutes * 60
    g.timeBudgetSeconds = (g.timeBudgetSeconds ?? 0) + seconds
    if (g.durationMode === 'wall_clock' && g.expiresAt !== null) {
      g.expiresAt = utc(Math.max(g.expiresAt.toMillis(), now) + seconds * 1000)
    }
  }
  if (input.bytes) {
    if (g.quotaBytes === null) throw nothingToExtend(id, 'bytes')
    g.quotaBytes = num(g.quotaBytes) + input.bytes
  }
}

/** `POST /portal/grants/:id/revoke`: ends it (`revoked`); the device's next queued entitlement starts. */
export async function revokeGrant(id: number): Promise<GrantChange> {
  const { gatewayId } = await grantWithGateway(id)
  return runInPortalQueue(gatewayId, async () => {
    const now = Date.now()
    const pushes = emptyPushes()
    const grant = await db.transaction(async (trx) => {
      const g = await lockGrant(trx, id)
      await endGrants(trx, [g], 'revoked', now, pushes)
      return g
    })
    const delivery = await sendPortalPushes(gatewayId, grantPushList(pushes))
    return { grant: await firstOf(grantViews([grant], now)), delivery }
  })
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type SessionFilter = {
  portalId?: number
  gatewayId?: number
  mac?: string
  grantId?: number
  from?: Date
  to?: Date
  limit: number
  offset: number
}

export type SessionView = {
  id: number
  grantId: number
  portalId: number
  mac: string
  ip: string | null
  startedAt: string | null
  endedAt: string | null
  bytesUp: number
  bytesDown: number
  endReason: string | null
}

const sqlTime = (d: Date) => utc(d.getTime()).toSQL({ includeOffset: false })!

/**
 * The session history. An open session's bytes are its grant's counters
 * minus the counters at its start, like a closed one's.
 */
export async function listSessions(
  filter: SessionFilter
): Promise<{ items: SessionView[]; total: number }> {
  if (filter.from && filter.to && filter.from > filter.to) {
    throw new PortalError(422, 'invalid_range', '`from` must be before `to`.')
  }
  const base = db.from('portal_sessions as s').join('portal_grants as g', 'g.id', 's.grant_id')
  if (filter.portalId) base.where('s.portal_id', filter.portalId)
  if (filter.gatewayId) {
    base.whereIn(
      's.portal_id',
      db.from('portals').select('id').where('gateway_id', filter.gatewayId)
    )
  }
  if (filter.grantId) base.where('s.grant_id', filter.grantId)
  if (filter.mac) {
    const mac = normalizeMac(filter.mac)
    if (!mac) throw new PortalError(422, 'invalid_mac', `"${filter.mac}" is not a MAC address.`)
    base.where('s.mac', mac)
  }
  // Sessions overlapping [from, to].
  if (filter.to) base.where('s.started_at', '<=', sqlTime(filter.to))
  if (filter.from) {
    base.where((q) => q.whereNull('s.ended_at').orWhere('s.ended_at', '>=', sqlTime(filter.from!)))
  }
  const countRow = (await base.clone().count('* as n').first()) as { n: number | string }
  const rows = (await base
    .select(
      's.id',
      's.grant_id',
      's.portal_id',
      's.mac',
      's.ip',
      db.raw("DATE_FORMAT(s.started_at, '%Y-%m-%dT%H:%i:%sZ') AS started_at"),
      db.raw("DATE_FORMAT(s.ended_at, '%Y-%m-%dT%H:%i:%sZ') AS ended_at"),
      's.end_reason',
      db.raw(
        'CASE WHEN s.ended_at IS NULL THEN GREATEST(0, CAST(g.bytes_up AS SIGNED) - CAST(s.start_bytes_up AS SIGNED)) ELSE s.bytes_up END AS bytes_up'
      ),
      db.raw(
        'CASE WHEN s.ended_at IS NULL THEN GREATEST(0, CAST(g.bytes_down AS SIGNED) - CAST(s.start_bytes_down AS SIGNED)) ELSE s.bytes_down END AS bytes_down'
      )
    )
    .orderBy('s.started_at', 'desc')
    .orderBy('s.id', 'desc')
    .limit(filter.limit)
    .offset(filter.offset)) as Array<Record<string, unknown>>
  return {
    total: Number(countRow?.n ?? 0),
    items: rows.map((r) => ({
      id: Number(r.id),
      grantId: Number(r.grant_id),
      portalId: Number(r.portal_id),
      mac: String(r.mac),
      ip: (r.ip as string | null) ?? null,
      startedAt: (r.started_at as string | null) ?? null,
      endedAt: (r.ended_at as string | null) ?? null,
      bytesUp: Number(r.bytes_up ?? 0),
      bytesDown: Number(r.bytes_down ?? 0),
      endReason: (r.end_reason as string | null) ?? null,
    })),
  }
}

export { iso }
