import Portal from '#models/portal'
import PortalGrant from '#models/portal_grant'
import User from '#models/user'
import Voucher from '#models/voucher'
import VoucherBatch from '#models/voucher_batch'
import { type PortalDelivery, sendPortalPushes } from '#services/portal_agent_sender'
import { PortalError, batchNotFound, voucherNotFound } from '#services/portal_errors'
import { grantViews } from '#services/portal_grant_admin'
import {
  emptyPushes,
  endGrants,
  grantPushList,
  ms,
  num,
  utc,
  voucherLimitsInput,
} from '#services/portal_grants'
import { hashVoucherCode } from '#services/portal_keys'
import { findPortal } from '#services/portal_portals'
import { runInPortalQueue } from '#services/portal_queue'
import { formatVoucherCode, generateVoucherCodes, voucherHint } from '#services/portal/codes'
import type { DurationMode, StartMode } from '#services/portal/types'
import {
  type VoucherFacts,
  type VoucherStatus,
  voucherCreationClock,
  voucherStatus,
} from '#services/portal/redemption'
import {
  type BatchView,
  type GrantView,
  type VoucherCounts,
  type VoucherView,
  batchView,
  voucherView,
} from '#transformers/portal'
import encryption from '@adonisjs/core/services/encryption'
import { firstOf } from '#services/portal_params'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Vouchers for the dashboard (docs/gateway/portal.md section 11.4): batches
 * (create, list, show, codes, CSV, revoke, delete), single vouchers (list,
 * lookup by code, revoke). Codes exist in clear text only in the create
 * answer and in the admin-only codes and CSV answers (`Cache-Control:
 * no-store`); the database keeps the lookup HMAC and an APP_KEY-encrypted
 * copy (`Voucher`).
 */

/** Columns needed for status and views: never the encrypted code (decrypting costs). */
const VOUCHER_COLUMNS = [
  'id',
  'batch_id',
  'hint',
  'bound_portal_id',
  'first_used_at',
  'starts_at',
  'expires_at',
  'time_used_seconds',
  'bytes_used',
  'revision',
  'revoked_at',
  'exhausted_at',
  'created_at',
  'updated_at',
]

export type BatchInput = {
  portalId: number | null
  name: string
  note?: string | null
  count: number
  codeLength: number
  durationMinutes?: number | null
  durationMode: DurationMode
  startMode: StartMode
  quotaBytes?: number | null
  downKbps?: number | null
  upKbps?: number | null
  maxDevices: number
  redeemBy?: Date | null
}

export function voucherFacts(v: Voucher, b: VoucherBatch): VoucherFacts {
  return {
    id: v.id,
    batchPortalId: b.portalId,
    boundPortalId: v.boundPortalId,
    firstUsedAt: ms(v.firstUsedAt),
    revokedAt: ms(v.revokedAt),
    batchRevokedAt: ms(b.revokedAt),
    exhaustedAt: ms(v.exhaustedAt),
    redeemBy: ms(b.redeemBy),
    limits: voucherLimitsInput(v, b),
    usage: { timeUsedSeconds: v.timeUsedSeconds, bytesUsed: num(v.bytesUsed) },
  }
}

function emptyCounts(): VoucherCounts {
  return { unused: 0, active: 0, exhausted: 0, expired: 0, revoked: 0 }
}

async function creatorsOf(ids: Array<number | null>) {
  const wanted = [...new Set(ids.filter((id): id is number => id !== null))]
  if (!wanted.length) return new Map<number, { id: number; email: string }>()
  const users = await User.query().select(['id', 'email']).whereIn('id', wanted)
  return new Map(users.map((u) => [u.id, { id: u.id, email: u.email }]))
}

/** Live device count per voucher. */
async function devicesOf(voucherIds: number[]): Promise<Map<number, number>> {
  if (!voucherIds.length) return new Map()
  const rows = (await db
    .from('portal_grants')
    .whereIn('voucher_id', voucherIds)
    .whereIn('state', ['pending_device', 'active', 'paused'])
    .groupBy('voucher_id')
    .select('voucher_id')
    .count('* as n')) as Array<{ voucher_id: number; n: number | string }>
  return new Map(rows.map((r) => [r.voucher_id, Number(r.n)]))
}

async function batchViews(batches: VoucherBatch[], now: number): Promise<BatchView[]> {
  if (!batches.length) return []
  const byBatch = new Map(batches.map((b) => [b.id, b]))
  const counts = new Map(batches.map((b) => [b.id, emptyCounts()]))
  const vouchers = await Voucher.query()
    .select(VOUCHER_COLUMNS)
    .whereIn(
      'batch_id',
      batches.map((b) => b.id)
    )
  for (const v of vouchers) {
    const status = voucherStatus(voucherFacts(v, byBatch.get(v.batchId)!), now)
    counts.get(v.batchId)![status] += 1
  }
  const creators = await creatorsOf(batches.map((b) => b.createdByUserId))
  return batches.map((b) =>
    batchView(
      b,
      counts.get(b.id)!,
      b.createdByUserId === null ? null : (creators.get(b.createdByUserId) ?? null)
    )
  )
}

async function vouchersOf(
  batch: VoucherBatch,
  now: number,
  withCodes: boolean
): Promise<VoucherView[]> {
  const query = Voucher.query().where('batch_id', batch.id).orderBy('id')
  if (!withCodes) query.select(VOUCHER_COLUMNS)
  const vouchers = await query
  const devices = await devicesOf(vouchers.map((v) => v.id))
  return vouchers.map((v) =>
    voucherView(
      v,
      voucherStatus(voucherFacts(v, batch), now),
      devices.get(v.id) ?? 0,
      withCodes ? (v.code ? formatVoucherCode(v.code) : null) : undefined
    )
  )
}

async function gatewayOfPortal(portalId: number | null): Promise<number | null> {
  if (portalId === null) return null
  const portal = await Portal.find(portalId)
  return portal?.gatewayId ?? null
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export async function createBatch(
  input: BatchInput,
  createdByUserId: number | null
): Promise<{ batch: BatchView; codes: string[]; delivery: PortalDelivery }> {
  if (input.portalId !== null) await findPortal(input.portalId)
  const durationMinutes = input.durationMinutes ?? null
  const quotaBytes = input.quotaBytes ?? null
  if (durationMinutes === null && quotaBytes === null) {
    throw new PortalError(422, 'no_limit', 'A voucher needs a duration, a data quota, or both.')
  }
  if (
    input.startMode === 'creation' &&
    (input.durationMode !== 'wall_clock' || durationMinutes === null)
  ) {
    throw new PortalError(
      422,
      'start_mode_requires_wall_clock',
      'Only a wall-clock duration can start at creation.'
    )
  }
  const now = Date.now()
  if (input.redeemBy && input.redeemBy.getTime() <= now) {
    throw new PortalError(422, 'redeem_by_past', '`redeemBy` must be in the future.')
  }

  let attempt = 0
  for (;;) {
    try {
      const created = await db.transaction(async (trx) => {
        const batch = new VoucherBatch()
        batch.fill({
          portalId: input.portalId,
          name: input.name,
          note: input.note ?? null,
          count: input.count,
          codeLength: input.codeLength,
          durationMinutes,
          durationMode: input.durationMode,
          startMode: input.startMode,
          quotaBytes,
          downKbps: input.downKbps ?? null,
          upKbps: input.upKbps ?? null,
          maxDevices: input.maxDevices,
          redeemBy: input.redeemBy ? DateTime.fromJSDate(input.redeemBy, { zone: 'utc' }) : null,
          createdByUserId,
          revokedAt: null,
        })
        batch.useTransaction(trx)
        await batch.save()
        const codes = generateVoucherCodes(input.count, input.codeLength)
        const clock = voucherCreationClock(
          {
            durationSeconds: durationMinutes === null ? null : durationMinutes * 60,
            durationMode: input.durationMode,
            startMode: input.startMode,
            quotaBytes,
            downKbps: null,
            upKbps: null,
            maxDevices: input.maxDevices,
            expiresAt: null,
          },
          now
        )
        const sqlNow = utc(now).toSQL({ includeOffset: false })
        const rows = codes.map((code) => ({
          batch_id: batch.id,
          code_hash: hashVoucherCode(code)!,
          code_encrypted: encryption.encrypt(code),
          hint: voucherHint(code),
          bound_portal_id: null,
          first_used_at: null,
          starts_at: clock ? utc(clock.startsAt).toSQL({ includeOffset: false }) : null,
          expires_at: clock ? utc(clock.expiresAt).toSQL({ includeOffset: false }) : null,
          time_used_seconds: 0,
          bytes_used: 0,
          revision: 1,
          revoked_at: null,
          exhausted_at: null,
          created_at: sqlNow,
          updated_at: sqlNow,
        }))
        for (let i = 0; i < rows.length; i += 500) {
          await trx.table('vouchers').multiInsert(rows.slice(i, i + 500))
        }
        return { batch, codes }
      })
      const { batch, codes } = created
      const gatewayId = await gatewayOfPortal(batch.portalId)
      const delivery =
        gatewayId === null
          ? 'applied'
          : await runInPortalQueue(gatewayId, () =>
              sendPortalPushes(gatewayId, [{ kind: 'vouchers' }])
            )
      const fresh = await VoucherBatch.findOrFail(batch.id)
      return {
        batch: await firstOf(batchViews([fresh], Date.now())),
        codes: codes.map(formatVoucherCode),
        delivery,
      }
    } catch (error) {
      // A code collided with an existing voucher: astronomically rare, retry.
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY' && ++attempt < 3) continue
      throw error
    }
  }
}

export async function listBatches(filter: { portalId?: number }): Promise<BatchView[]> {
  // Payment batches (one voucher per paid checkout) live in the payment
  // ledger, not in the printed batches (section 14.5).
  const query = VoucherBatch.query()
    .where('kind', 'batch')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
  if (filter.portalId) query.where('portal_id', filter.portalId)
  return batchViews(await query, Date.now())
}

async function findBatch(id: number): Promise<VoucherBatch> {
  const batch = await VoucherBatch.find(id)
  if (!batch) throw batchNotFound(id)
  return batch
}

export async function showBatch(
  id: number,
  withCodes = false
): Promise<{ batch: BatchView; vouchers: VoucherView[] }> {
  const batch = await findBatch(id)
  const now = Date.now()
  const vouchers = await vouchersOf(batch, now, withCodes)
  if (withCodes && vouchers.some((v) => v.code === null)) {
    throw new PortalError(
      410,
      'codes_unrecoverable',
      'The codes of this batch can no longer be shown (APP_KEY changed since it was created).'
    )
  }
  return { batch: await firstOf(batchViews([batch], now)), vouchers }
}

/** A CSV cell: quoted, and never read as a formula by a spreadsheet. */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

export const VOUCHER_CSV_COLUMNS = [
  'code',
  'hint',
  'status',
  'batch_id',
  'batch_name',
  'duration_minutes',
  'duration_mode',
  'quota_bytes',
  'max_devices',
  'redeem_by',
  'expires_at',
] as const

export async function batchCsv(id: number): Promise<{ filename: string; csv: string }> {
  const { batch, vouchers } = await showBatch(id, true)
  const lines = [VOUCHER_CSV_COLUMNS.join(',')]
  for (const v of vouchers) {
    lines.push(
      [
        v.code,
        v.hint,
        v.status,
        batch.id,
        batch.name,
        batch.durationMinutes,
        batch.durationMode,
        batch.quotaBytes,
        batch.maxDevices,
        batch.redeemBy,
        v.expiresAt,
      ]
        .map(csvCell)
        .join(',')
    )
  }
  return { filename: `perch-vouchers-batch-${batch.id}.csv`, csv: `${lines.join('\r\n')}\r\n` }
}

/**
 * Ends the grants of the given vouchers, per gateway and inside each
 * gateway's queue, and resends those gateways' offline lists.
 */
async function endVoucherGrants(
  voucherIds: number[],
  extraPortalIds: number[]
): Promise<PortalDelivery> {
  const grants = voucherIds.length
    ? await PortalGrant.query().whereIn('voucher_id', voucherIds).whereNot('state', 'ended')
    : []
  const portalIds = [...new Set([...grants.map((g) => g.portalId), ...extraPortalIds])]
  const portals = portalIds.length ? await Portal.query().whereIn('id', portalIds) : []
  const byGateway = new Map<number, number[]>()
  for (const p of portals) {
    const list = byGateway.get(p.gatewayId) ?? []
    list.push(p.id)
    byGateway.set(p.gatewayId, list)
  }
  let delivery: PortalDelivery = 'applied'
  for (const [gatewayId, ids] of byGateway) {
    const result = await runInPortalQueue(gatewayId, async () => {
      const now = Date.now()
      const pushes = emptyPushes()
      await db.transaction(async (trx) => {
        const rows = voucherIds.length
          ? await PortalGrant.query({ client: trx })
              .whereIn('voucher_id', voucherIds)
              .whereIn('portal_id', ids)
              .whereNot('state', 'ended')
              .forUpdate()
          : []
        await endGrants(trx, rows, 'revoked', now, pushes)
      })
      pushes.vouchers = true
      return sendPortalPushes(gatewayId, grantPushList(pushes))
    })
    if (result === 'pending') delivery = 'pending'
  }
  return delivery
}

export async function revokeBatch(
  id: number
): Promise<{ batch: BatchView; delivery: PortalDelivery }> {
  const batch = await findBatch(id)
  if (!batch.revokedAt) {
    batch.revokedAt = DateTime.utc()
    await batch.save()
    await db
      .from('vouchers')
      .where('batch_id', id)
      .update({
        revision: db.raw('revision + 1'),
        updated_at: utc(Date.now()).toSQL({ includeOffset: false }),
      })
  }
  const vouchers = await Voucher.query().select(['id', 'bound_portal_id']).where('batch_id', id)
  const extra = [
    ...(batch.portalId !== null ? [batch.portalId] : []),
    ...vouchers.map((v) => v.boundPortalId).filter((p): p is number => p !== null),
  ]
  const delivery = await endVoucherGrants(
    vouchers.map((v) => v.id),
    extra
  )
  return { batch: await firstOf(batchViews([batch], Date.now())), delivery }
}

/** Deletes a batch nobody ever redeemed a voucher of; otherwise 409 `batch_used` (revoke it). */
export async function deleteBatch(id: number): Promise<PortalDelivery> {
  const batch = await findBatch(id)
  const used = await db
    .from('vouchers')
    .where('batch_id', id)
    .where((q) =>
      q
        .whereNotNull('first_used_at')
        .orWhereExists(db.from('portal_grants').whereRaw('portal_grants.voucher_id = vouchers.id'))
    )
    .first()
  if (used) {
    throw new PortalError(
      409,
      'batch_used',
      'Vouchers of this batch were redeemed; revoke the batch instead of deleting it.'
    )
  }
  await batch.delete()
  const gatewayId = await gatewayOfPortal(batch.portalId)
  if (gatewayId === null) return 'applied'
  return runInPortalQueue(gatewayId, () => sendPortalPushes(gatewayId, [{ kind: 'vouchers' }]))
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

export type VoucherListFilter = {
  batchId?: number
  portalId?: number
  status?: VoucherStatus
  limit: number
  offset: number
}

export async function listVouchers(
  filter: VoucherListFilter
): Promise<{ items: VoucherView[]; total: number }> {
  const query = Voucher.query().select(VOUCHER_COLUMNS.map((c) => `vouchers.${c}`))
  if (filter.batchId) query.where('vouchers.batch_id', filter.batchId)
  if (filter.portalId) {
    const portalId = filter.portalId
    query
      .join('voucher_batches', 'voucher_batches.id', 'vouchers.batch_id')
      .where((q) =>
        q
          .where('vouchers.bound_portal_id', portalId)
          .orWhere((q2) =>
            q2.whereNull('vouchers.bound_portal_id').where('voucher_batches.portal_id', portalId)
          )
      )
  }
  if (filter.status === 'revoked') {
    query.where((q) =>
      q
        .whereNotNull('vouchers.revoked_at')
        .orWhereIn(
          'vouchers.batch_id',
          db.from('voucher_batches').select('id').whereNotNull('revoked_at')
        )
    )
  }
  const rows = await query.orderBy('vouchers.id', 'desc')
  const batches = new Map(
    (rows.length
      ? await VoucherBatch.query().whereIn('id', [...new Set(rows.map((v) => v.batchId))])
      : []
    ).map((b) => [b.id, b])
  )
  const now = Date.now()
  const withStatus = rows
    .map((v) => ({ v, status: voucherStatus(voucherFacts(v, batches.get(v.batchId)!), now) }))
    .filter((x) => !filter.status || x.status === filter.status)
  const page = withStatus.slice(filter.offset, filter.offset + filter.limit)
  const devices = await devicesOf(page.map((x) => x.v.id))
  return {
    total: withStatus.length,
    items: page.map((x) => voucherView(x.v, x.status, devices.get(x.v.id) ?? 0)),
  }
}

export async function lookupVoucher(
  code: string
): Promise<{ voucher: VoucherView; batch: BatchView; grants: GrantView[] }> {
  const hash = hashVoucherCode(code)
  if (!hash) throw voucherNotFound()
  const voucher = await Voucher.query().select(VOUCHER_COLUMNS).where('code_hash', hash).first()
  if (!voucher) throw voucherNotFound()
  return voucherDetail(voucher)
}

async function voucherDetail(voucher: Voucher) {
  const batch = await VoucherBatch.findOrFail(voucher.batchId)
  const now = Date.now()
  const grants = await PortalGrant.query()
    .where('voucher_id', voucher.id)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(100)
  const devices = await devicesOf([voucher.id])
  return {
    voucher: voucherView(
      voucher,
      voucherStatus(voucherFacts(voucher, batch), now),
      devices.get(voucher.id) ?? 0
    ),
    batch: await firstOf(batchViews([batch], now)),
    grants: await grantViews(grants, now),
  }
}

export async function revokeVoucher(
  id: number
): Promise<{ voucher: VoucherView; delivery: PortalDelivery }> {
  const voucher = await Voucher.query().select(VOUCHER_COLUMNS).where('id', id).first()
  if (!voucher) throw voucherNotFound(id)
  const batch = await VoucherBatch.findOrFail(voucher.batchId)
  if (!voucher.revokedAt) {
    await db
      .from('vouchers')
      .where('id', id)
      .update({
        revoked_at: utc(Date.now()).toSQL({ includeOffset: false }),
        revision: db.raw('revision + 1'),
        updated_at: utc(Date.now()).toSQL({ includeOffset: false }),
      })
  }
  const portalId = voucher.boundPortalId ?? batch.portalId
  const delivery = await endVoucherGrants([id], portalId === null ? [] : [portalId])
  const fresh = await Voucher.query().select(VOUCHER_COLUMNS).where('id', id).firstOrFail()
  const devices = await devicesOf([id])
  return {
    voucher: voucherView(
      fresh,
      voucherStatus(voucherFacts(fresh, batch), Date.now()),
      devices.get(id) ?? 0
    ),
    delivery,
  }
}
