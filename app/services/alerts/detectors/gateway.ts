import type { ConditionInput, DetectorContext } from '#services/alerts/model'
import { registerDetector } from '#services/alerts/registry'
import { ISO_FORMAT, liveAlerts, rawRows, toBool } from '#services/alerts/detectors/liveness'
import db from '@adonisjs/lucid/services/db'

/**
 * Detector `gateway` (WP-A5b, events.md sections 3.1 and 3.3), every 15 s:
 * the config plane's standing states, read from the tables it keeps.
 *
 * - `gateway.drift` / `gateway.conflict`: any `gateway_sections` row of the
 *   gateway in that status (one alert per gateway, the count in the payload).
 * - `gateway.enforcement_suspended`: `gateways.enforcement = 'suspended'`.
 * - `gateway.apply_awaiting_confirm`: a `pending_confirm` apply that still
 *   needs the admin's confirm (one alert per apply).
 * - `gateway.sqm_paused`: a `qos_wan_queues` row the router paused (owner
 *   decision 15; one per queue).
 * - `ap.groups_failed`: `ap_group_states` `failed` / `rolled_back` holds,
 *   `applied` clears, every other state leaves the alert as it is.
 */

export const DRIFT_TYPE = 'gateway.drift'
export const CONFLICT_TYPE = 'gateway.conflict'
export const SUSPENDED_TYPE = 'gateway.enforcement_suspended'
export const AWAITING_TYPE = 'gateway.apply_awaiting_confirm'
export const SQM_TYPE = 'gateway.sqm_paused'
export const GROUPS_TYPE = 'ap.groups_failed'

const SOURCE = 'detector:gateway'
const MAX_EXAMPLES = 5

export type SectionIssueRow = {
  gatewayId: number
  status: 'drift' | 'conflict'
  config: string
  section: string
  domain: string | null
  driftSince: string | null
}

/** Drift and conflict per gateway: count, up to five examples, and since when (drift). */
export function summarizeSections(rows: SectionIssueRow[]) {
  const out = new Map<
    string,
    {
      gatewayId: number
      status: 'drift' | 'conflict'
      sections: number
      examples: Array<{ config: string; section: string; domain: string | null }>
      since: string | null
    }
  >()
  for (const row of rows) {
    const key = `${row.status}:${row.gatewayId}`
    const entry = out.get(key) ?? {
      gatewayId: row.gatewayId,
      status: row.status,
      sections: 0,
      examples: [],
      since: null,
    }
    entry.sections += 1
    if (entry.examples.length < MAX_EXAMPLES) {
      entry.examples.push({ config: row.config, section: row.section, domain: row.domain })
    }
    if (row.driftSince && (entry.since === null || row.driftSince < entry.since)) {
      entry.since = row.driftSince
    }
    out.set(key, entry)
  }
  return [...out.values()]
}

/**
 * `ap.groups_failed` per AP state: `true` holds, `false` clears, `null`
 * leaves the alert as it is (`offline`, `waiting`, `sending`,
 * `pending_confirm`, `idle`, `unsupported`, …).
 */
export function groupsFailedHolds(state: string): boolean | null {
  if (state === 'failed' || state === 'rolled_back') return true
  if (state === 'applied') return false
  return null
}

async function sectionConditions(): Promise<ConditionInput[]> {
  const rows = rawRows<Record<string, unknown>>(
    await db.rawQuery(
      `SELECT gateway_id AS gatewayId, status, config, section_name AS section, domain,
              DATE_FORMAT(drift_since, ${ISO_FORMAT}) AS driftSince
         FROM gateway_sections
        WHERE status IN ('drift', 'conflict')
        ORDER BY gateway_id, config, position, id`
    )
  )
  return summarizeSections(
    rows.map((row) => ({
      gatewayId: Number(row.gatewayId),
      status: row.status as 'drift' | 'conflict',
      config: String(row.config),
      section: String(row.section),
      domain: (row.domain as string | null) ?? null,
      driftSince: (row.driftSince as string | null) ?? null,
    }))
  ).map((entry) => {
    const type = entry.status === 'drift' ? DRIFT_TYPE : CONFLICT_TYPE
    return {
      type,
      subject: { kind: 'gateway', id: entry.gatewayId },
      dedupeKey: `${type}:gateway:${entry.gatewayId}`,
      source: SOURCE,
      payload: {
        gatewayId: entry.gatewayId,
        sections: entry.sections,
        examples: entry.examples,
        since: entry.since,
      },
    }
  })
}

async function suspendedConditions(): Promise<ConditionInput[]> {
  const rows = rawRows<{ id: number; since: string | null }>(
    await db.rawQuery(
      `SELECT id, DATE_FORMAT(enforcement_changed_at, ${ISO_FORMAT}) AS since
         FROM gateways WHERE enforcement = 'suspended'`
    )
  )
  return rows.map((row) => ({
    type: SUSPENDED_TYPE,
    subject: { kind: 'gateway', id: Number(row.id) },
    dedupeKey: `${SUSPENDED_TYPE}:gateway:${row.id}`,
    source: SOURCE,
    payload: { gatewayId: Number(row.id), since: row.since },
  }))
}

async function awaitingConditions(): Promise<ConditionInput[]> {
  const rows = rawRows<Record<string, unknown>>(
    await db.rawQuery(
      `SELECT id, gateway_id AS gatewayId, protected,
              DATE_FORMAT(deadline_at, ${ISO_FORMAT}) AS deadlineAt
         FROM gateway_applies
        WHERE state = 'pending_confirm'
          AND confirm_mode = 'admin_and_agent'
          AND admin_confirmed_at IS NULL`
    )
  )
  return rows.map((row) => ({
    type: AWAITING_TYPE,
    subject: { kind: 'gateway', id: Number(row.gatewayId) },
    dedupeKey: `${AWAITING_TYPE}:${row.id}`,
    source: SOURCE,
    payload: {
      gatewayId: Number(row.gatewayId),
      applyId: Number(row.id),
      deadlineAt: row.deadlineAt ?? null,
      protected: toBool(row.protected),
    },
  }))
}

async function sqmConditions(): Promise<ConditionInput[]> {
  const rows = rawRows<Record<string, unknown>>(
    await db.rawQuery(
      `SELECT id, gateway_id AS gatewayId, device,
              DATE_FORMAT(router_paused_at, ${ISO_FORMAT}) AS since
         FROM qos_wan_queues WHERE router_paused_at IS NOT NULL`
    )
  )
  return rows.map((row) => ({
    type: SQM_TYPE,
    subject: { kind: 'gateway', id: Number(row.gatewayId) },
    dedupeKey: `${SQM_TYPE}:${row.id}`,
    source: SOURCE,
    payload: {
      gatewayId: Number(row.gatewayId),
      queueId: Number(row.id),
      interface: row.device,
      since: row.since,
    },
  }))
}

async function groupsConditions(): Promise<ConditionInput[]> {
  const [rows, live] = await Promise.all([
    rawRows<Record<string, unknown>>(
      await db.rawQuery(
        `SELECT s.ap_id AS apId, s.state, s.error, s.revision,
                COALESCE(ap.friendly_name, ap.name) AS name
           FROM ap_group_states s
           JOIN wifi_access_points ap ON ap.id = s.ap_id`
      )
    ),
    liveAlerts([GROUPS_TYPE]),
  ])
  const out: ConditionInput[] = []
  for (const row of rows) {
    const apId = Number(row.apId)
    const key = `${GROUPS_TYPE}:ap:${apId}`
    const holds = groupsFailedHolds(String(row.state))
    if (holds === false || (holds === null && !live.has(key))) continue
    out.push({
      type: GROUPS_TYPE,
      subject: { kind: 'ap', id: apId },
      dedupeKey: key,
      source: SOURCE,
      payload: {
        apId,
        name: row.name,
        state: row.state,
        error: row.error ?? null,
        revision: Number(row.revision),
      },
    })
  }
  return out
}

export async function runGatewayDetector(ctx: DetectorContext): Promise<void> {
  const [sections, suspended, awaiting, sqm, groups] = await Promise.all([
    sectionConditions(),
    suspendedConditions(),
    awaitingConditions(),
    sqmConditions(),
    groupsConditions(),
  ])
  await ctx.reconcile(
    [DRIFT_TYPE],
    sections.filter((c) => c.type === DRIFT_TYPE)
  )
  await ctx.reconcile(
    [CONFLICT_TYPE],
    sections.filter((c) => c.type === CONFLICT_TYPE)
  )
  await ctx.reconcile([SUSPENDED_TYPE], suspended)
  await ctx.reconcile([AWAITING_TYPE], awaiting)
  await ctx.reconcile([SQM_TYPE], sqm)
  await ctx.reconcile([GROUPS_TYPE], groups)
}

registerDetector({
  id: 'gateway',
  everySeconds: 15,
  types: [DRIFT_TYPE, CONFLICT_TYPE, SUSPENDED_TYPE, AWAITING_TYPE, SQM_TYPE, GROUPS_TYPE],
  run: runGatewayDetector,
})
