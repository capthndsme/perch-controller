import Portal from '#models/portal'
import PortalGatewayState from '#models/portal_gateway_state'
import PortalGrant from '#models/portal_grant'
import PortalUser from '#models/portal_user'
import Voucher from '#models/voucher'
import VoucherBatch from '#models/voucher_batch'
import { voucherVerifierFor } from '#services/portal_keys'
import { getPortalSettings } from '#services/portal_settings'
import type {
  GrantFields,
  GrantRef,
  PortalDbChanges,
  RouterPortalReport,
  ServerGrant,
  ServerGroup,
  ServerPortal,
  ServerPortalState,
  ServerVoucher,
} from '#services/portal/reconcile'
import { groupKey, parseGroupKey } from '#services/portal/types'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * The portal domain's DB side of reconciliation (docs/gateway/portal.md
 * section 7): `loadServerPortalState` builds `reconcile`'s input for one
 * gateway, `applyPortalDbChanges` writes its output in one transaction.
 *
 * Both must run inside the gateway's portal queue (one reconcile, redeem or
 * admin change at a time per gateway): grant state and counters are written
 * as the values `reconcile` computed from what was loaded. Voucher totals are
 * added as deltas and grant counters only ever grow (`GREATEST`), so even an
 * out-of-queue writer cannot lose usage.
 */

const ms = (value: DateTime | null | undefined): number | null => (value ? value.toMillis() : null)
const dt = (value: number | null | undefined): DateTime | null =>
  value === null || value === undefined ? null : DateTime.fromMillis(value, { zone: 'utc' })
const num = (value: bigint | number | null | undefined): number => Number(value ?? 0)

/** Raw-query bindings; knex writes a null as NULL (its types leave null out). */
type Binding = string | number | boolean | null
const bind = (values: Binding[]) => values as Array<string | number>

export type LoadOptions = {
  now?: number
  /** The report about to be reconciled: ended grants and vouchers it names are loaded too. */
  report?: RouterPortalReport | null
  /**
   * Portal id → openNDS enabled, from the config plane's mirror. A portal
   * missing from the map counts as enabled.
   */
  enabled?: ReadonlyMap<number, boolean>
  client?: TransactionClientContract
}

/** The gateway's portal state row, created with defaults when missing. */
export async function ensurePortalGatewayState(
  gatewayId: number,
  client?: TransactionClientContract
): Promise<PortalGatewayState> {
  const existing = await PortalGatewayState.find(gatewayId, { client })
  if (existing) return existing
  await (client ?? db).rawQuery(
    'INSERT IGNORE INTO portal_gateway_states (gateway_id, acked_event_seq, key_epoch, created_at, updated_at) VALUES (?, 0, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
    [gatewayId]
  )
  return (await PortalGatewayState.find(gatewayId, { client }))!
}

export async function loadServerPortalState(
  gatewayId: number,
  options: LoadOptions = {}
): Promise<ServerPortalState> {
  const now = options.now ?? Date.now()
  const client = options.client
  const settings = await getPortalSettings()
  const state = await PortalGatewayState.find(gatewayId, { client })
  const keyEpoch = state?.keyEpoch ?? 1

  const portalRows = await Portal.query({ client })
    .where('gateway_id', gatewayId)
    .whereNull('deleted_at')
    .orderBy('id')
  const portalIds = portalRows.map((p) => p.id)
  const portals: ServerPortal[] = portalRows.map((p) => ({
    id: p.id,
    enabled: options.enabled?.get(p.id) ?? true,
  }))

  // --- grants: every non-ended one, plus those the report names ------------
  const reportIds = new Set<number>()
  const reportRefs = new Set<string>()
  const reportVoucherIds = new Set<number>()
  for (const e of options.report?.events ?? []) {
    if ('grantId' in e && typeof e.grantId === 'number') reportIds.add(e.grantId)
    if ('localRef' in e && e.localRef) reportRefs.add(e.localRef)
    if (e.type === 'offline_redeemed') reportVoucherIds.add(e.voucherId)
    if (e.type === 'offline_redeemed' && e.demotedGrantId) reportIds.add(e.demotedGrantId)
  }
  for (const u of options.report?.grants ?? []) {
    if (typeof u.grantId === 'number') reportIds.add(u.grantId)
    if (u.localRef) reportRefs.add(u.localRef)
  }

  const grantRows: PortalGrant[] = portalIds.length
    ? await PortalGrant.query({ client })
        .whereIn('portal_id', portalIds)
        .where((q) => {
          q.whereNot('state', 'ended')
          if (reportIds.size) q.orWhereIn('id', [...reportIds])
          if (reportRefs.size) q.orWhereIn('local_ref', [...reportRefs])
        })
        .orderBy('id')
    : []

  const grants: ServerGrant[] = grantRows.map((g) => ({
    id: num(g.id),
    portalId: g.portalId,
    mac: g.mac,
    groupKey: g.groupKey,
    source: g.source,
    voucherId: g.voucherId,
    // A `g:` group's deadline is its limits' (below); a `u:` grant's is its own.
    expiresAt: g.groupKey.startsWith('u:') ? ms(g.expiresAt) : null,
    createdAt: ms(g.createdAt)!,
    bytesUp: num(g.bytesUp),
    bytesDown: num(g.bytesDown),
    timeUsedSeconds: g.timeUsedSeconds,
    ip: g.ip,
    hostname: g.hostname,
    lastSeenAt: ms(g.lastSeenAt),
    localRef: g.localRef,
    lifecycle: {
      state: g.state,
      delivery: g.delivery,
      revision: g.revision,
      startedAt: ms(g.startedAt),
      endedAt: ms(g.endedAt),
      endReason: g.endReason,
    },
  }))

  // --- non-voucher groups ----------------------------------------------------
  const groups: ServerGroup[] = []
  const userIds = new Set<number>()
  for (const g of grantRows) {
    const parsed = parseGroupKey(g.groupKey)
    if (parsed?.kind === 'grant') {
      groups.push({
        groupKey: g.groupKey,
        revision: g.revision,
        limits: {
          durationMode: g.durationMode,
          expiresAt: ms(g.expiresAt),
          durationSeconds: g.timeBudgetSeconds,
          quotaBytes: g.quotaBytes === null ? null : num(g.quotaBytes),
          downKbps: g.downKbps,
          upKbps: g.upKbps,
          maxDevices: 1,
        },
      })
    } else if (parsed?.kind === 'user') {
      userIds.add(parsed.id)
    }
  }
  if (userIds.size) {
    const users = await PortalUser.query({ client }).whereIn('id', [...userIds])
    for (const u of users) {
      groups.push({
        groupKey: groupKey('user', u.id),
        revision: u.revision,
        limits: {
          durationMode: 'wall_clock',
          expiresAt: null,
          durationSeconds: null,
          quotaBytes: null,
          downKbps: u.downKbps,
          upKbps: u.upKbps,
          maxDevices: Math.max(1, u.maxDevices),
        },
      })
    }
  }

  // --- vouchers ----------------------------------------------------------------
  const voucherIds = new Set<number>(reportVoucherIds)
  for (const g of grantRows) if (g.voucherId !== null) voucherIds.add(g.voucherId)
  const rows = new Map<number, Voucher>()
  if (voucherIds.size) {
    for (const v of await Voucher.query({ client }).whereIn('id', [...voucherIds]))
      rows.set(v.id, v)
  }
  const offlineEnabled = settings.offlineRedemption && settings.offlineVoucherLimit > 0
  if (offlineEnabled && portalIds.length) {
    const nowSql = dt(now)!.toSQL({ includeOffset: false })!
    const candidates = await Voucher.query({ client })
      .select('vouchers.*')
      .join('voucher_batches', 'voucher_batches.id', 'vouchers.batch_id')
      .whereNull('vouchers.revoked_at')
      .whereNull('voucher_batches.revoked_at')
      .whereNull('vouchers.exhausted_at')
      .where((q) => {
        q.whereIn('vouchers.bound_portal_id', portalIds).orWhere((q2) => {
          q2.whereNull('vouchers.bound_portal_id').whereIn('voucher_batches.portal_id', portalIds)
        })
      })
      .where((q) => q.whereNull('vouchers.expires_at').orWhere('vouchers.expires_at', '>', nowSql))
      .where((q) =>
        q
          .whereNotNull('vouchers.first_used_at')
          .orWhereNull('voucher_batches.redeem_by')
          .orWhere('voucher_batches.redeem_by', '>', nowSql)
      )
      .orderByRaw('vouchers.first_used_at IS NULL')
      .orderBy('voucher_batches.created_at', 'desc')
      .orderBy('vouchers.id', 'desc')
      // Quota / active-time exhaustion is decided in JS: leave headroom.
      .limit(settings.offlineVoucherLimit + 64)
    for (const v of candidates) rows.set(v.id, v)
  }
  const batchIds = [...new Set([...rows.values()].map((v) => v.batchId))]
  const batches = new Map<number, VoucherBatch>()
  if (batchIds.length) {
    for (const b of await VoucherBatch.query({ client }).whereIn('id', batchIds))
      batches.set(b.id, b)
  }
  const vouchers: ServerVoucher[] = []
  for (const v of rows.values()) {
    const b = batches.get(v.batchId)
    if (!b) continue
    vouchers.push({
      id: v.id,
      batchPortalId: b.portalId,
      boundPortalId: v.boundPortalId,
      firstUsedAt: ms(v.firstUsedAt),
      revokedAt: ms(v.revokedAt),
      batchRevokedAt: ms(b.revokedAt),
      exhaustedAt: ms(v.exhaustedAt),
      redeemBy: ms(b.redeemBy),
      usage: { timeUsedSeconds: v.timeUsedSeconds, bytesUsed: num(v.bytesUsed) },
      revision: v.revision,
      createdAt: ms(b.createdAt)!,
      verifier: offlineEnabled ? voucherVerifierFor(gatewayId, keyEpoch, v.code) : null,
      startsAt: ms(v.startsAt),
      limits: {
        durationSeconds: b.durationMinutes === null ? null : b.durationMinutes * 60,
        durationMode: b.durationMode,
        startMode: b.startMode,
        quotaBytes: b.quotaBytes === null ? null : num(b.quotaBytes),
        downKbps: b.downKbps,
        upKbps: b.upKbps,
        maxDevices: Math.max(1, b.maxDevices),
        expiresAt: ms(v.expiresAt),
      },
    })
  }

  return {
    gatewayId,
    now,
    ackedEventSeq: num(state?.ackedEventSeq),
    portals,
    grants,
    groups,
    vouchers,
    offline: { enabled: offlineEnabled, limit: settings.offlineVoucherLimit },
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const GRANT_COLUMNS: Record<keyof GrantFields, string> = {
  state: 'state',
  delivery: 'delivery',
  revision: 'revision',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  endReason: 'end_reason',
  bytesUp: 'bytes_up',
  bytesDown: 'bytes_down',
  timeUsedSeconds: 'time_used_seconds',
  ip: 'ip',
  hostname: 'hostname',
  lastSeenAt: 'last_seen_at',
}
const TIME_FIELDS = new Set<keyof GrantFields>(['startedAt', 'endedAt', 'lastSeenAt'])
const COUNTER_FIELDS = new Set<keyof GrantFields>(['bytesUp', 'bytesDown', 'timeUsedSeconds'])

function sqlTime(value: number | null): string | null {
  return value === null ? null : dt(value)!.toSQL({ includeOffset: false })
}

/**
 * Writes one reconcile's `dbChanges` in a transaction and returns the ids of
 * the grants it inserted (offline redemptions), by `localRef`, for
 * `bindInsertedGrantIds`.
 */
export async function applyPortalDbChanges(
  gatewayId: number,
  changes: PortalDbChanges,
  options: { now?: number } = {}
): Promise<Map<string, number>> {
  const now = sqlTime(options.now ?? Date.now())!
  return db.transaction(async (trx) => {
    const ids = new Map<string, number>()
    const idOf = (ref: GrantRef): number | null =>
      'id' in ref ? ref.id : (ids.get(ref.localRef) ?? null)

    for (const ins of changes.grantInserts) {
      const [id] = await trx.table('portal_grants').insert({
        portal_id: ins.portalId,
        mac: ins.mac,
        ip: ins.ip,
        hostname: ins.hostname,
        source: ins.source,
        group_key: ins.groupKey,
        voucher_id: ins.voucherId,
        local_ref: ins.localRef,
        duration_mode: 'wall_clock',
        started_at: sqlTime(ins.startedAt),
        expires_at: null,
        time_used_seconds: ins.timeUsedSeconds,
        bytes_up: ins.bytesUp,
        bytes_down: ins.bytesDown,
        state: ins.state,
        delivery: ins.delivery,
        revision: ins.revision,
        last_seen_at: sqlTime(ins.lastSeenAt),
        ended_at: sqlTime(ins.endedAt),
        end_reason: ins.endReason,
        created_at: sqlTime(ins.createdAt),
        updated_at: now,
      })
      ids.set(ins.localRef, Number(id))
    }

    for (const u of changes.grantUpdates) {
      const sets: string[] = []
      const values: Binding[] = []
      for (const [field, value] of Object.entries(u.set) as Array<[keyof GrantFields, unknown]>) {
        const col = GRANT_COLUMNS[field]
        if (COUNTER_FIELDS.has(field)) {
          sets.push(`${col} = GREATEST(${col}, ?)`)
          values.push(value as number)
        } else {
          sets.push(`${col} = ?`)
          values.push(TIME_FIELDS.has(field) ? sqlTime(value as number | null) : (value as Binding))
        }
      }
      if (!sets.length) continue
      sets.push('updated_at = ?')
      values.push(now, u.id)
      await trx.rawQuery(`UPDATE portal_grants SET ${sets.join(', ')} WHERE id = ?`, bind(values))
    }

    for (const c of changes.grantClocks ?? []) {
      await trx.rawQuery(
        'UPDATE portal_grants SET expires_at = COALESCE(expires_at, ?), updated_at = ? WHERE id = ?',
        bind([sqlTime(c.expiresAt), now, c.id])
      )
    }

    for (const s of changes.sessions) {
      const grantId = idOf(s.grant)
      if (grantId === null) continue
      if (s.op === 'open') {
        await trx.table('portal_sessions').insert({
          grant_id: grantId,
          portal_id: s.portalId,
          mac: s.mac,
          ip: s.ip,
          started_at: sqlTime(s.startedAt),
          start_bytes_up: s.startBytesUp,
          start_bytes_down: s.startBytesDown,
          bytes_up: 0,
          bytes_down: 0,
        })
      } else {
        await trx.rawQuery(
          `UPDATE portal_sessions
              SET ended_at = ?, end_reason = ?,
                  bytes_up = GREATEST(0, CAST(? AS SIGNED) - CAST(start_bytes_up AS SIGNED)),
                  bytes_down = GREATEST(0, CAST(? AS SIGNED) - CAST(start_bytes_down AS SIGNED))
            WHERE grant_id = ? AND ended_at IS NULL`,
          bind([sqlTime(s.endedAt), s.endReason.slice(0, 24), s.bytesUp, s.bytesDown, grantId])
        )
      }
    }

    for (const v of changes.voucherUpdates) {
      const sets: string[] = []
      const values: Binding[] = []
      const { set, add } = v
      const timeCols: Array<[keyof typeof set, string]> = [
        ['firstUsedAt', 'first_used_at'],
        ['startsAt', 'starts_at'],
        ['expiresAt', 'expires_at'],
        ['exhaustedAt', 'exhausted_at'],
      ]
      for (const [field, col] of timeCols) {
        if (set[field] === undefined) continue
        // First writer wins for these facts.
        sets.push(`${col} = COALESCE(${col}, ?)`)
        values.push(sqlTime(set[field] as number))
      }
      if (set.boundPortalId !== undefined) {
        sets.push('bound_portal_id = COALESCE(bound_portal_id, ?)')
        values.push(set.boundPortalId)
      }
      if (set.revision !== undefined) {
        sets.push('revision = GREATEST(revision, ?)')
        values.push(set.revision)
      }
      if (add.bytesUsed) {
        sets.push('bytes_used = bytes_used + ?')
        values.push(add.bytesUsed)
      }
      if (add.timeUsedSeconds) {
        sets.push('time_used_seconds = time_used_seconds + ?')
        values.push(add.timeUsedSeconds)
      }
      if (!sets.length) continue
      sets.push('updated_at = ?')
      values.push(now, v.id)
      await trx.rawQuery(`UPDATE vouchers SET ${sets.join(', ')} WHERE id = ?`, bind(values))
    }

    if (changes.events.length) {
      // A router may name a portal that is not (or no longer) this gateway's:
      // the event is kept, without the foreign key.
      const ownRows = await trx.from('portals').where('gateway_id', gatewayId).select('id')
      const own = new Set(ownRows.map((r) => r.id))
      await trx.table('portal_events').multiInsert(
        changes.events.map((e) => ({
          gateway_id: gatewayId,
          portal_id: e.portalId !== null && own.has(e.portalId) ? e.portalId : null,
          grant_id: e.grant ? idOf(e.grant) : null,
          mac: e.mac,
          type: e.type,
          detail: JSON.stringify(e.detail),
          created_at: sqlTime(e.at),
        }))
      )
    }

    await trx.rawQuery(
      `INSERT INTO portal_gateway_states (gateway_id, acked_event_seq, key_epoch, last_sync_at, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE acked_event_seq = VALUES(acked_event_seq),
                               last_sync_at = VALUES(last_sync_at), updated_at = VALUES(updated_at)`,
      [gatewayId, changes.ackedEventSeq, now, now, now]
    )
    return ids
  })
}
