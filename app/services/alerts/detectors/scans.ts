import { getGatewayConfigSettings } from '#services/gateway_config/gateway_config_settings'
import { moneyText } from '#services/portal/hotspot'
import type { AlertSubject, DetectorContext, EmitInput } from '#services/alerts/model'
import { registerDetector } from '#services/alerts/registry'
import { parseJsonObject, rawRows, toNumberOrNull } from '#services/alerts/detectors/liveness'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'

/**
 * Watermark scans (WP-A5b, events.md section 1.5): the notices of sections
 * 3.1, 3.3, 3.6 and 3.7 from rows other code already writes. Per source table
 * a state key `scan:<table>` = `{ lastId }` (`{ lastAt }` for the AP join
 * time). The first run sets it to the current maximum and emits nothing (no
 * history flood after the upgrade); each tick reads at most `BATCH` new rows
 * per source, in id order, and each row is emitted once.
 *
 * A notice whose rule is disabled is not emitted (the watermark still moves),
 * so a busy source (payments) leaves no event rows while its type is off.
 */

export const BATCH = 200
const SOURCE = 'detector:scans'

type Row = Record<string, unknown>

/** A notice for one row, or null when the row is not one. */
export type RowMapper = (row: Row) => EmitInput | null

function text(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null
}

function detailOf(row: Row): Record<string, unknown> {
  return parseJsonObject(row.detail) ?? {}
}

/**
 * A checkout's amount: stored in minor units with its `decimals`; payloads
 * carry it in major units (`amount`, what the texts sum) and as the
 * dashboard's text (`PHP 5.00`).
 */
export function checkoutAmount(row: Row): {
  amount: number | null
  currency: string | null
  amountText: string | null
} {
  const minor = toNumberOrNull(row.amount)
  const currency = text(row.currency, 8)
  const decimals = Math.max(0, toNumberOrNull(row.decimals) ?? 0)
  if (minor === null) return { amount: null, currency, amountText: null }
  return {
    amount: minor / 10 ** decimals,
    currency,
    amountText: currency ? moneyText(minor, currency, decimals) : null,
  }
}

// ── mappers (pure) ─────────────────────────────────────────────────────────

/** `gateway_config_events` → the config plane's notices (events.md section 3.3). */
export function mapGatewayEvent(row: Row): EmitInput | null {
  const gatewayId = Number(row.gatewayId)
  const applyId = toNumberOrNull(row.applyId)
  const detail = detailOf(row)
  const subject: AlertSubject = { kind: 'gateway', id: gatewayId }
  const base = { phase: 'instant' as const, subject, source: SOURCE }
  const perApply = (type: string) => `${type}:${applyId ?? `event${Number(row.id)}`}`
  switch (row.event) {
    case 'rolled_back': {
      // An admin-requested revert is not an alert.
      if (row.userId !== null && row.userId !== undefined) return null
      if (detail.requested === true) return null
      return {
        ...base,
        type: 'gateway.apply_rolled_back',
        dedupeKey: perApply('gateway.apply_rolled_back'),
        payload: {
          gatewayId,
          applyId,
          applyKey: text(detail.applyId, 64),
          revision: toNumberOrNull(row.revision),
          reason: text(detail.reason, 64),
          discardedConfigs: Array.isArray(detail.discardedConfigs)
            ? detail.discardedConfigs.slice(0, 20)
            : [],
        },
      }
    }
    case 'failed':
      return {
        ...base,
        type: 'gateway.apply_failed',
        dedupeKey: perApply('gateway.apply_failed'),
        payload: {
          gatewayId,
          applyId,
          applyKey: text(detail.applyId, 64),
          error: text(detail.error, 64) ?? text(detail.reason, 64),
          message: text(detail.message, 200),
        },
      }
    case 'expired':
      return {
        ...base,
        type: 'gateway.apply_expired',
        dedupeKey: perApply('gateway.apply_expired'),
        payload: {
          gatewayId,
          applyId,
          applyKey: text(detail.applyId, 64),
          queueExpiryHours: toNumberOrNull(row.queueExpiryHours),
        },
      }
    case 'pairing_lost': {
      const keyId = text(detail.keyId, 64)
      return {
        ...base,
        type: 'gateway.pairing_lost',
        dedupeKey: `gateway.pairing_lost:${keyId ?? `event${Number(row.id)}`}`,
        payload: { gatewayId, keyId },
      }
    }
    case 'rejoin_offered':
      return {
        ...base,
        type: 'gateway.rejoin_offered',
        payload: {
          gatewayId,
          revision: toNumberOrNull(row.revision),
          reason: text(detail.reason, 64),
        },
      }
    case 'unmodeled_changed':
    case 'section_ambiguous':
      return {
        ...base,
        type: `gateway.${row.event}`,
        payload: {
          gatewayId,
          config: text(detail.config, 64),
          section: text(detail.section, 64),
          domain: text(detail.domain, 32),
        },
      }
    default:
      return null
  }
}

/** `hotspot_checkouts` → unclaimed coins and payments, coin or desk (events.md section 3.7). No guest MAC. */
export function mapCheckout(row: Row): EmitInput | null {
  const terminalId = toNumberOrNull(row.terminalId)
  const portalId = toNumberOrNull(row.portalId)
  const common = {
    checkoutId: Number(row.id),
    terminalId,
    terminalName: text(row.terminalName, 80),
    portalId,
    portalName: text(row.portalName, 80),
    ...checkoutAmount(row),
  }
  if (row.kind === 'unclaimed') {
    // The terminal, or its portal when the terminal is gone.
    const subject: AlertSubject | null =
      terminalId !== null && row.terminalExists
        ? { kind: 'terminal', id: terminalId }
        : portalId !== null
          ? { kind: 'portal', id: portalId }
          : null
    if (!subject) return null
    return {
      type: 'hotspot.unclaimed',
      phase: 'instant',
      subject,
      source: SOURCE,
      payload: { ...common, reason: text(row.reason, 16) },
    }
  }
  if (row.kind === 'payment' && portalId !== null) {
    return {
      type: 'hotspot.payment',
      phase: 'instant',
      subject: { kind: 'portal', id: portalId },
      source: SOURCE,
      payload: {
        checkoutId: common.checkoutId,
        portalId,
        portalName: common.portalName,
        terminalName: common.terminalName,
        // Sell Mode desk sales (docs/gateway/portal.md section 15).
        channel: row.channel === 'desk' ? 'desk' : 'coin',
        sellerName: text(row.sellerName, 120),
        amount: common.amount,
        currency: common.currency,
        amountText: common.amountText,
      },
    }
  }
  return null
}

/** `portal_events` → portal and hotspot notices (events.md sections 3.6, 3.7). No guest MAC. */
export function mapPortalEvent(row: Row): EmitInput | null {
  const gatewayId = Number(row.gatewayId)
  const detail = detailOf(row)
  switch (row.type) {
    case 'checkout_rejected':
    case 'offline_redeem_rejected':
      return {
        type: 'hotspot.checkout_rejected',
        phase: 'instant',
        subject: { kind: 'gateway', id: gatewayId },
        source: SOURCE,
        payload: {
          gatewayId,
          event: row.type,
          reason: text(detail.reason, 48),
          checkoutRef: text(detail.checkoutRef, 64),
        },
      }
    case 'shaping_quota_exhausted': {
      const portalId = toNumberOrNull(row.portalId)
      return {
        type: 'portal.quota_exhausted',
        phase: 'instant',
        subject:
          portalId !== null ? { kind: 'portal', id: portalId } : { kind: 'gateway', id: gatewayId },
        source: SOURCE,
        payload: {
          portalId,
          portalName: text(row.portalName, 80),
          grantId: toNumberOrNull(row.grantId),
        },
      }
    }
    // The router journal's `external_auth` is stored as `external_auth_reverted` (portal/reconcile.ts).
    case 'external_auth':
    case 'external_auth_reverted':
      return {
        type: 'portal.external_auth',
        phase: 'instant',
        subject: { kind: 'gateway', id: gatewayId },
        source: SOURCE,
        payload: {
          gatewayId,
          portalId: toNumberOrNull(row.portalId),
          portalName: text(row.portalName, 80),
        },
      }
    default:
      return null
  }
}

/** New pending `collectors` rows (an announce or a socket hello). */
export function mapPendingCollector(row: Row): EmitInput | null {
  if (row.lifecycle !== 'pending') return null
  let address: string | null = null
  const announced = text(row.announcedBaseUrl, 255)
  if (announced) {
    try {
      address = new URL(announced).hostname || null
    } catch {
      address = null
    }
  }
  return {
    type: 'collector.pending',
    phase: 'instant',
    subject: { kind: 'collector', id: Number(row.id) },
    source: SOURCE,
    payload: {
      collectorId: Number(row.id),
      hostname: text(row.hostname, 128),
      version: text(row.version, 64),
      address,
    },
  }
}

export function mapApJoined(row: Row): EmitInput {
  return {
    type: 'ap.joined',
    phase: 'instant',
    subject: { kind: 'ap', id: Number(row.id) },
    source: SOURCE,
    payload: {
      apId: Number(row.id),
      name: text(row.name, 80),
      model: text(row.model, 80),
      agentVersion: text(row.agentVersion, 64),
    },
  }
}

// ── sources ────────────────────────────────────────────────────────────────

type IdSource = {
  table: string
  /** Rows with `id > ?` in id order, at most `BATCH`. */
  select(afterId: number): Promise<Row[]>
  map: RowMapper
}

const SOURCES: IdSource[] = [
  {
    table: 'gateway_config_events',
    select: async (afterId) => {
      const rows = rawRows<Row>(
        await db.rawQuery(
          `SELECT e.id, e.gateway_id AS gatewayId, e.event, e.apply_id AS applyId,
                  COALESCE(e.revision_number, a.revision_number) AS revision,
                  e.user_id AS userId, e.detail
             FROM gateway_config_events e
             LEFT JOIN gateway_applies a ON a.id = e.apply_id
            WHERE e.id > ? ORDER BY e.id LIMIT ${BATCH}`,
          [afterId]
        )
      )
      if (!rows.some((row) => row.event === 'expired')) return rows
      // The expired text names the queue bound in force.
      const { queueExpiryHours } = await getGatewayConfigSettings()
      return rows.map((row) => (row.event === 'expired' ? { ...row, queueExpiryHours } : row))
    },
    map: mapGatewayEvent,
  },
  {
    table: 'hotspot_checkouts',
    select: async (afterId) =>
      rawRows<Row>(
        await db.rawQuery(
          `SELECT c.id, c.kind, c.channel, c.terminal_id AS terminalId, c.terminal_name AS terminalName,
                  c.portal_id AS portalId, p.name AS portalName,
                  c.amount, c.currency, c.decimals, c.reason,
                  t.id IS NOT NULL AS terminalExists,
                  COALESCE(u.full_name, u.email) AS sellerName
             FROM hotspot_checkouts c
             LEFT JOIN hotspot_terminals t ON t.id = c.terminal_id
             LEFT JOIN portals p ON p.id = c.portal_id
             LEFT JOIN users u ON u.id = c.seller_user_id
            WHERE c.id > ? ORDER BY c.id LIMIT ${BATCH}`,
          [afterId]
        )
      ).map((row) => ({ ...row, terminalExists: Number(row.terminalExists) === 1 })),
    map: mapCheckout,
  },
  {
    table: 'portal_events',
    select: async (afterId) =>
      rawRows<Row>(
        await db.rawQuery(
          `SELECT e.id, e.gateway_id AS gatewayId,
                  COALESCE(e.portal_id, g.portal_id) AS portalId, e.grant_id AS grantId,
                  e.type, e.detail, p.name AS portalName
             FROM portal_events e
             LEFT JOIN portal_grants g ON g.id = e.grant_id
             LEFT JOIN portals p ON p.id = COALESCE(e.portal_id, g.portal_id)
            WHERE e.id > ? ORDER BY e.id LIMIT ${BATCH}`,
          [afterId]
        )
      ),
    map: mapPortalEvent,
  },
  {
    table: 'collectors',
    select: async (afterId) =>
      rawRows<Row>(
        await db.rawQuery(
          `SELECT id, lifecycle, hostname, version, announced_base_url AS announcedBaseUrl
             FROM collectors WHERE id > ? ORDER BY id LIMIT ${BATCH}`,
          [afterId]
        )
      ),
    map: mapPendingCollector,
  },
]

type IdWatermark = { lastId: number }
type TimeWatermark = { lastAt: string }

async function maxId(table: string): Promise<number> {
  const rows = rawRows<{ maxId: unknown }>(
    await db.rawQuery(`SELECT COALESCE(MAX(id), 0) AS maxId FROM ${table}`)
  )
  return Number(rows[0]?.maxId ?? 0)
}

/** Emits unless the type's rule is off (then nothing is recorded; the watermark still moves). */
function emitIfEnabled(ctx: DetectorContext, input: EmitInput): boolean {
  if (!ctx.rule(input.type).enabled) return false
  ctx.emit(input)
  return true
}

/** One pass over one id source. Returns how many notices were emitted. */
export async function scanIdSource(ctx: DetectorContext, source: IdSource): Promise<number> {
  const key = `scan:${source.table}`
  const mark = await ctx.state.get<IdWatermark>(key)
  if (!mark || typeof mark.lastId !== 'number') {
    await ctx.state.set(key, { lastId: await maxId(source.table) })
    return 0
  }
  const rows = await source.select(mark.lastId)
  if (rows.length === 0) return 0
  let emitted = 0
  for (const row of rows) {
    let input: EmitInput | null = null
    try {
      input = source.map(row)
    } catch (err) {
      logger.warn({ err, table: source.table, id: row.id }, 'alerts scans: row skipped')
    }
    if (input && emitIfEnabled(ctx, input)) emitted += 1
  }
  await ctx.state.set(key, { lastId: Number(rows[rows.length - 1].id) })
  return emitted
}

const AP_JOIN_KEY = 'scan:wifi_access_points'

/** `wifi_access_points.agent_joined_at` moves on every join (joins update rows): a time watermark. */
export async function scanApJoins(ctx: DetectorContext): Promise<number> {
  const mark = await ctx.state.get<TimeWatermark>(AP_JOIN_KEY)
  if (!mark || typeof mark.lastAt !== 'string') {
    const rows = rawRows<{ lastAt: string | null }>(
      await db.rawQuery(
        `SELECT DATE_FORMAT(MAX(agent_joined_at), '%Y-%m-%d %H:%i:%s') AS lastAt
           FROM wifi_access_points`
      )
    )
    await ctx.state.set(AP_JOIN_KEY, { lastAt: rows[0]?.lastAt ?? '1970-01-01 00:00:00' })
    return 0
  }
  const rows = rawRows<Row>(
    await db.rawQuery(
      `SELECT id, COALESCE(friendly_name, name) AS name, model, agent_version AS agentVersion,
              DATE_FORMAT(agent_joined_at, '%Y-%m-%d %H:%i:%s') AS joinedAt
         FROM wifi_access_points
        WHERE agent_joined_at > ?
        ORDER BY agent_joined_at, id LIMIT ${BATCH}`,
      [mark.lastAt]
    )
  )
  if (rows.length === 0) return 0
  let emitted = 0
  for (const row of rows) if (emitIfEnabled(ctx, mapApJoined(row))) emitted += 1
  await ctx.state.set(AP_JOIN_KEY, { lastAt: String(rows[rows.length - 1].joinedAt) })
  return emitted
}

export async function runScans(ctx: DetectorContext): Promise<number> {
  let emitted = 0
  for (const source of SOURCES) {
    try {
      emitted += await scanIdSource(ctx, source)
    } catch (err) {
      // One broken source (a table another area renamed) costs only itself.
      logger.warn({ err, table: source.table }, 'alerts scans: source failed')
    }
  }
  emitted += await scanApJoins(ctx)
  return emitted
}

registerDetector({
  id: 'scans',
  everySeconds: 15,
  run: async (ctx) => {
    await runScans(ctx)
  },
})
