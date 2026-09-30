import { collectorStaleSeconds } from '#services/collector_agent'
import { apStaleSeconds, type PresenceThresholds } from '#services/wifi_presence'
import db from '@adonisjs/lucid/services/db'

/**
 * What the alerts detectors share (WP-A5a/A5b): whether each collector and
 * AP is silent, by the bounds the rest of the controller uses
 * (`collectorStaleSeconds`: max(3 × interval, 30 s); `apStaleSeconds` with
 * Settings → Presence), and which alerts are live. Ages come from the
 * database (`TIMESTAMPDIFF` against `UTC_TIMESTAMP()`), never from the
 * process clock: stored times are UTC and mysql2 parses DATETIME in the
 * process zone (CLAUDE.md).
 *
 * A silent agent's reports say nothing: its ports, WANs, portals and
 * terminals are unknown, not down. The WAN, ports and portal detectors skip
 * whatever hangs off a silent agent (`collector.offline` / `ap.offline`
 * cover it) and leave its live alerts as they are.
 */

export const ISO_FORMAT = `'%Y-%m-%dT%H:%i:%sZ'`

export function rawRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result[0] : result) as T[]
}

export function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Silent when the last report is older than the bound; never reported = not evaluated. */
export function isSilent(silentSeconds: number | null, boundSeconds: number): boolean {
  return silentSeconds !== null && silentSeconds > boundSeconds
}

export type CollectorLiveness = {
  id: number
  name: string
  hostname: string | null
  lifecycle: string
  enabled: boolean
  transport: string
  version: string | null
  pollIntervalSeconds: number
  lastSeenAt: string | null
  silentSeconds: number | null
  boundSeconds: number
  silent: boolean
  lastStatus: Record<string, unknown> | null
}

export type ApLiveness = {
  id: number
  name: string
  model: string | null
  enabled: boolean
  transport: string
  agentVersion: string | null
  pollIntervalSeconds: number
  lastSeenAt: string | null
  silentSeconds: number | null
  boundSeconds: number
  silent: boolean
}

export async function loadCollectorLiveness(): Promise<CollectorLiveness[]> {
  const rows = rawRows<Record<string, unknown>>(
    await db.rawQuery(
      `SELECT id, name, hostname, lifecycle, enabled, transport, version,
              poll_interval_seconds AS pollIntervalSeconds,
              DATE_FORMAT(last_seen_at, ${ISO_FORMAT}) AS lastSeenAt,
              TIMESTAMPDIFF(SECOND, last_seen_at, UTC_TIMESTAMP()) AS silentSeconds,
              last_status AS lastStatus
         FROM collectors ORDER BY id`
    )
  )
  return rows.map((row) => {
    const pollIntervalSeconds = Number(row.pollIntervalSeconds) || 0
    const boundSeconds = collectorStaleSeconds(pollIntervalSeconds)
    const silentSeconds = toNumberOrNull(row.silentSeconds)
    return {
      id: Number(row.id),
      name: String(row.name ?? `Collector ${row.id}`),
      hostname: (row.hostname as string | null) ?? null,
      lifecycle: String(row.lifecycle),
      enabled: toBool(row.enabled),
      transport: String(row.transport ?? 'poll'),
      version: (row.version as string | null) ?? null,
      pollIntervalSeconds,
      lastSeenAt: (row.lastSeenAt as string | null) ?? null,
      silentSeconds: silentSeconds === null ? null : Math.max(0, silentSeconds),
      boundSeconds,
      silent: isSilent(silentSeconds, boundSeconds),
      lastStatus: parseJsonObject(row.lastStatus),
    }
  })
}

export async function loadApLiveness(presence: PresenceThresholds): Promise<ApLiveness[]> {
  const rows = rawRows<Record<string, unknown>>(
    await db.rawQuery(
      `SELECT id, name, friendly_name AS friendlyName, model, enabled, transport,
              agent_version AS agentVersion,
              poll_interval_seconds AS pollIntervalSeconds,
              DATE_FORMAT(last_seen_at, ${ISO_FORMAT}) AS lastSeenAt,
              TIMESTAMPDIFF(SECOND, last_seen_at, UTC_TIMESTAMP()) AS silentSeconds
         FROM wifi_access_points ORDER BY id`
    )
  )
  return rows.map((row) => {
    const pollIntervalSeconds = Number(row.pollIntervalSeconds) || 0
    const boundSeconds = apStaleSeconds(presence, pollIntervalSeconds)
    const silentSeconds = toNumberOrNull(row.silentSeconds)
    return {
      id: Number(row.id),
      name: String(row.friendlyName ?? row.name ?? `AP ${row.id}`),
      model: (row.model as string | null) ?? null,
      enabled: toBool(row.enabled),
      transport: String(row.transport ?? 'scrape'),
      agentVersion: (row.agentVersion as string | null) ?? null,
      pollIntervalSeconds,
      lastSeenAt: (row.lastSeenAt as string | null) ?? null,
      silentSeconds: silentSeconds === null ? null : Math.max(0, silentSeconds),
      boundSeconds,
      silent: isSilent(silentSeconds, boundSeconds),
    }
  })
}

/** Collectors `collector.offline` watches: adopted, enabled, reported at least once. */
export function monitoredCollectors(rows: CollectorLiveness[]): CollectorLiveness[] {
  return rows.filter((c) => c.lifecycle === 'adopted' && c.enabled && c.lastSeenAt !== null)
}

/** APs `ap.offline` watches: enabled, reported at least once (agent or scraped). */
export function monitoredAps(rows: ApLiveness[]): ApLiveness[] {
  return rows.filter((a) => a.enabled && a.lastSeenAt !== null)
}

/**
 * Collectors whose reports can be believed right now: adopted, enabled and
 * not silent. The WAN, portal and port detectors evaluate only what hangs off
 * one of these.
 */
export function liveCollectorIds(collectors: CollectorLiveness[]): Set<number> {
  return new Set(
    monitoredCollectors(collectors)
      .filter((c) => !c.silent)
      .map((c) => c.id)
  )
}

export function liveApIds(aps: ApLiveness[]): Set<number> {
  return new Set(
    monitoredAps(aps)
      .filter((a) => !a.silent)
      .map((a) => a.id)
  )
}

/** Live (pending or active) alerts of these types: dedupe key → state. */
export async function liveAlerts(types: string[]): Promise<Map<string, 'pending' | 'active'>> {
  if (types.length === 0) return new Map()
  const rows = (await db
    .from('alerts')
    .whereIn('type', types)
    .whereNotNull('active_key')
    .select('dedupe_key', 'state')) as Array<{ dedupe_key: string; state: string }>
  return new Map(
    rows.map((row) => [row.dedupe_key, row.state === 'pending' ? 'pending' : 'active'] as const)
  )
}
