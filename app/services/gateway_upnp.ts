import db from '@adonisjs/lucid/services/db'
import type { StrictValues } from '@adonisjs/lucid/types/querybuilder'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import {
  bool,
  count,
  fingerprintOf,
  ipAny,
  isObject,
  lastWritten,
  list,
  rawRows,
  refreshObservedAt,
  remember,
  sqlTime,
  text,
  unixSeconds,
  writeObservationRow,
} from '#services/gateway_observation_common'

/**
 * The `upnp` part of the Gateway agent's observation (docs/gateway/
 * observation.md section 3.3): miniupnpd's port mappings (its lease file,
 * `upnpd.config.upnp_lease_file`). Mirrored into `gateway_upnp_mappings`;
 * every mapping that appears or goes away between two reports is an
 * `opened` / `closed` row in `gateway_upnp_events` (a changed target is a
 * close and an open). The device behind each internal address is resolved
 * from the host mirror at ingest, so the part needs no MACs.
 *
 * Absent = nothing new (miniupnpd not installed: the agent leaves it out, or
 * sends `installed: false`); `mappings: []` = none open.
 */

export const OBSERVATION_KIND_UPNP = 'upnp'
export const MAX_UPNP_MAPPINGS = 512

export type UpnpMappingInput = {
  proto: 'TCP' | 'UDP'
  extPort: number
  intIp: string
  intPort: number
  /** Unix seconds; 0 = no lease time. */
  expires: number
  description: string | null
}

export type UpnpObservation = {
  /** miniupnpd enabled in its config (`upnpd.config.enabled`); null when not said. */
  enabled: boolean | null
  /** The package is installed; false = no UPnP on this router. */
  installed: boolean
  /** A miniupnpd process runs; null when not said. */
  running: boolean | null
  mappings: UpnpMappingInput[]
}

export function normalizeUpnp(value: unknown): UpnpObservation | null {
  if (!isObject(value)) return null
  const byKey = new Map<string, UpnpMappingInput>()
  for (const entry of list(value.mappings)) {
    if (byKey.size >= MAX_UPNP_MAPPINGS) break
    if (!isObject(entry)) continue
    const proto = typeof entry.proto === 'string' ? entry.proto.trim().toUpperCase() : ''
    if (proto !== 'TCP' && proto !== 'UDP') continue
    const extPort = count(entry.extPort, 65535)
    const intPort = count(entry.intPort, 65535)
    const intIp = ipAny(entry.intIp)
    if (!extPort || !intPort || !intIp) continue
    // A later entry for the same external port replaces the earlier one.
    byKey.set(`${proto}:${extPort}`, {
      proto,
      extPort,
      intIp,
      intPort,
      expires: unixSeconds(entry.expires) ?? 0,
      description: text(entry.description, 128),
    })
  }
  return {
    enabled: bool(value.enabled),
    installed: value.installed === false ? false : true,
    running: bool(value.running),
    mappings: [...byKey.values()].sort((a, b) =>
      a.proto === b.proto ? a.extPort - b.extPort : a.proto < b.proto ? -1 : 1
    ),
  }
}

export type UpnpPayload = {
  enabled: boolean | null
  installed: boolean
  running: boolean | null
  mappings: number
}

export type UpnpRecordOutcome = 'written' | 'unchanged' | 'invalid'

type StoredMapping = {
  proto: string
  extPort: number
  intIp: string
  intPort: number
  mac: string | null
  description: string | null
}

/** Internal address → MAC from the host mirror (lease first, then the neighbour table). */
async function macsForAddresses(
  collectorId: number,
  addresses: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(addresses)]
  if (unique.length === 0) return new Map()
  const marks = unique.map(() => '?').join(',')
  const rows = rawRows<{ mac: string; ipv4: string | null; neighborIpv4: string | null }>(
    await db.rawQuery(
      `SELECT mac, ipv4, neighbor_ipv4 AS neighborIpv4 FROM gateway_hosts
        WHERE collector_id = ? AND (ipv4 IN (${marks}) OR neighbor_ipv4 IN (${marks}))`,
      [collectorId, ...unique, ...unique]
    )
  )
  const out = new Map<string, string>()
  for (const row of rows) if (row.ipv4) out.set(row.ipv4, row.mac)
  for (const row of rows) {
    if (row.neighborIpv4 && !out.has(row.neighborIpv4)) out.set(row.neighborIpv4, row.mac)
  }
  return out
}

/**
 * Mirrors one `upnp` report and records what opened and closed. Callers
 * serialise it with the collector's other parts and make it non-fatal.
 */
export async function recordUpnpObservation(
  collectorId: number,
  raw: unknown,
  now: DateTime = DateTime.utc()
): Promise<UpnpRecordOutcome> {
  const obs = normalizeUpnp(raw)
  if (!obs) return 'invalid'
  const fingerprint = fingerprintOf(obs)
  const last = await lastWritten(collectorId, OBSERVATION_KIND_UPNP)
  if (last && last.fingerprint === fingerprint) {
    await refreshObservedAt(collectorId, OBSERVATION_KIND_UPNP, last, now)
    return 'unchanged'
  }

  const stamp = sqlTime(now)
  const macs = await macsForAddresses(
    collectorId,
    obs.mappings.map((m) => m.intIp)
  )
  const payload: UpnpPayload = {
    enabled: obs.enabled,
    installed: obs.installed,
    running: obs.running,
    mappings: obs.mappings.length,
  }

  await db.transaction(async (trx) => {
    const before = rawRows<StoredMapping>(
      await trx.rawQuery(
        `SELECT proto, ext_port AS extPort, int_ip AS intIp, int_port AS intPort, mac, description
           FROM gateway_upnp_mappings WHERE collector_id = ? FOR UPDATE`,
        [collectorId]
      )
    )
    const key = (m: { proto: string; extPort: number }) => `${m.proto}:${Number(m.extPort)}`
    const listed = new Map(obs.mappings.map((m) => [key(m), m]))
    const was = new Map(before.map((m) => [key(m), m]))
    const sameTarget = (a: StoredMapping, b: UpnpMappingInput) =>
      a.intIp === b.intIp && Number(a.intPort) === b.intPort

    const events: (string | number | null)[][] = []
    const closed: StoredMapping[] = []
    for (const [k, old] of was) {
      const current = listed.get(k)
      if (!current || !sameTarget(old, current)) {
        closed.push(old)
        events.push([
          collectorId,
          'closed',
          old.proto,
          Number(old.extPort),
          old.intIp,
          Number(old.intPort),
          old.mac,
          old.description,
          stamp,
        ])
      }
    }
    for (const [k, current] of listed) {
      const old = was.get(k)
      if (!old || !sameTarget(old, current)) {
        events.push([
          collectorId,
          'opened',
          current.proto,
          current.extPort,
          current.intIp,
          current.intPort,
          macs.get(current.intIp) ?? null,
          current.description,
          stamp,
        ])
      }
    }

    for (const gone of closed.filter((m) => !listed.has(key(m)))) {
      await trx.rawQuery(
        'DELETE FROM gateway_upnp_mappings WHERE collector_id = ? AND proto = ? AND ext_port = ?',
        [collectorId, gone.proto, Number(gone.extPort)]
      )
    }
    for (let i = 0; i < obs.mappings.length; i += 500) {
      const chunk = obs.mappings.slice(i, i + 500)
      const values: (string | number | null)[] = []
      for (const m of chunk) {
        values.push(
          collectorId,
          m.proto,
          m.extPort,
          m.intIp,
          m.intPort,
          macs.get(m.intIp) ?? null,
          m.description,
          m.expires > 0 ? sqlTime(DateTime.fromSeconds(m.expires, { zone: 'utc' })) : null,
          stamp,
          stamp
        )
      }
      // A changed target starts a new mapping: its first_seen_at restarts.
      await trx.rawQuery(
        `INSERT INTO gateway_upnp_mappings
           (collector_id, proto, ext_port, int_ip, int_port, mac, description, expires_at,
            first_seen_at, last_seen_at)
         VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}
         ON DUPLICATE KEY UPDATE
           first_seen_at = IF(int_ip = VALUES(int_ip) AND int_port = VALUES(int_port),
                              first_seen_at, VALUES(first_seen_at)),
           int_ip = VALUES(int_ip), int_port = VALUES(int_port), mac = VALUES(mac),
           description = VALUES(description), expires_at = VALUES(expires_at),
           last_seen_at = VALUES(last_seen_at)`,
        values as StrictValues[]
      )
    }
    for (let i = 0; i < events.length; i += 500) {
      const chunk = events.slice(i, i + 500)
      await trx.rawQuery(
        `INSERT INTO gateway_upnp_events
           (collector_id, event, proto, ext_port, int_ip, int_port, mac, description, at)
         VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}`,
        chunk.flat() as StrictValues[]
      )
    }
    await writeObservationRow(trx, collectorId, OBSERVATION_KIND_UPNP, payload, fingerprint, now)
  })
  remember(collectorId, OBSERVATION_KIND_UPNP, { fingerprint, observedWrittenAt: now.toMillis() })
  logger.debug({ collectorId, ...payload }, 'gateway_upnp: observation written')
  return 'written'
}
