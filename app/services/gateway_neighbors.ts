import db from '@adonisjs/lucid/services/db'
import type { StrictValues } from '@adonisjs/lucid/types/querybuilder'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import { deleteUnsightedOrphans } from '#services/gateway_dhcp'
import {
  bool,
  fingerprintOf,
  ipv4,
  ipv6,
  isObject,
  isUnicastMac,
  lastWritten,
  list,
  normalizeMac,
  OBSERVED_AT_REFRESH_MS,
  recall,
  remember,
  sqlTime,
  text,
  touchObservationRow,
  writeObservationRow,
} from '#services/gateway_observation_common'

/**
 * The `neighbors` part of the Gateway agent's observation (docs/gateway/
 * observation.md section 3.2): the router's ARP/NDP table (`ip neigh`, or
 * `/proc/net/arp`). Folded to one row per MAC into `gateway_hosts` beside
 * the DHCP facts: the IPv4 and IPv6 addresses the router reaches it on, its
 * device, and `neighbor_seen_at`, the last report that listed it as
 * reachable. That sighting is a presence source (presence setting
 * `gatewaySightings`): a quiet device the router still confirms at L2 is
 * there, whatever its lease (the live gateway's leases last 1200 days).
 *
 * Like every part: absent = nothing new; a present part is a full snapshot
 * (`[]` = the table is empty); an unchanged report writes no row but still
 * refreshes the reachable devices' sightings, at most once a minute.
 */

export const OBSERVATION_KIND_NEIGHBORS = 'neighbors'
export const MAX_NEIGHBORS = 4096
const MAX_V6_PER_MAC = 16

export type NeighborEntry = {
  ip: string
  family: 4 | 6
  mac: string
  device: string | null
  /** The logical network, when the agent knows it. */
  network: string | null
  /** The kernel confirmed it recently (REACHABLE, or the agent's reading of it). */
  reachable: boolean
}

export type NeighborRow = {
  mac: string
  ipv4: string | null
  ipv6: string[]
  device: string | null
  network: string | null
  reachable: boolean
}

/**
 * The part as the controller keeps it, or null when it is not a list.
 * Entries without a usable MAC (FAILED/INCOMPLETE have none) or with a
 * broadcast/multicast one are dropped; `reachable` absent reads from a
 * `state` string when one is sent (`REACHABLE`, `DELAY`, `PROBE`, `PERMANENT`
 * count), else false.
 */
export function normalizeNeighbors(value: unknown): NeighborEntry[] | null {
  if (!Array.isArray(value)) return null
  const out: NeighborEntry[] = []
  const seen = new Set<string>()
  for (const entry of list(value)) {
    if (out.length >= MAX_NEIGHBORS) break
    if (!isObject(entry)) continue
    const mac = normalizeMac(entry.mac)
    if (!mac || !isUnicastMac(mac)) continue
    const v4 = ipv4(entry.ip)
    const address = v4 ?? ipv6(entry.ip)
    if (!address) continue
    const key = `${mac}|${address}`
    if (seen.has(key)) continue
    seen.add(key)
    let reachable = bool(entry.reachable)
    if (reachable === null) {
      const state = typeof entry.state === 'string' ? entry.state.toUpperCase() : ''
      reachable = ['REACHABLE', 'DELAY', 'PROBE', 'PERMANENT'].includes(state)
    }
    out.push({
      ip: address,
      family: v4 ? 4 : 6,
      mac,
      device: text(entry.device, 32),
      network: text(entry.network, 32),
      reachable,
    })
  }
  return out
}

/**
 * One row per MAC: its IPv4 address (a reachable entry first, then the
 * lowest address), up to 16 IPv6 addresses, the device of the chosen entry,
 * and reachable when any entry is. Link-local IPv6 addresses are kept (they
 * map DHCPv6 leases to MACs). Sorted by MAC.
 */
export function foldNeighbors(entries: NeighborEntry[]): NeighborRow[] {
  const byMac = new Map<
    string,
    {
      v4: NeighborEntry | null
      v6: Set<string>
      device: string | null
      network: string | null
      reachable: boolean
    }
  >()
  const sorted = [...entries].sort((a, b) => (a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : 0))
  for (const entry of sorted) {
    let acc = byMac.get(entry.mac)
    if (!acc) {
      acc = { v4: null, v6: new Set(), device: null, network: null, reachable: false }
      byMac.set(entry.mac, acc)
    }
    if (entry.family === 4) {
      if (!acc.v4 || (entry.reachable && !acc.v4.reachable)) acc.v4 = entry
    } else if (acc.v6.size < MAX_V6_PER_MAC) {
      acc.v6.add(entry.ip)
    }
    acc.device = acc.v4?.device ?? acc.device ?? entry.device
    acc.network = acc.network ?? entry.network
    if (entry.reachable) acc.reachable = true
  }
  return [...byMac.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([mac, acc]) => ({
      mac,
      ipv4: acc.v4?.ip ?? null,
      ipv6: [...acc.v6].sort(),
      device: acc.v4?.device ?? acc.device,
      network: acc.v4?.network ?? acc.network,
      reachable: acc.reachable,
    }))
}

export type NeighborsPayload = { entries: number; macs: number; reachable: number }

export type NeighborRecordOutcome = 'written' | 'unchanged' | 'invalid'

/** When each collector's reachable sightings were last refreshed by an unchanged report (bounded with the memory). */
const SIGHTING_KIND = 'neighbors:sighting'

/**
 * Mirrors one `neighbors` report. Callers serialise it with the collector's
 * other parts and make it non-fatal (`gateway_observe.ts`).
 */
export async function recordNeighborObservation(
  collectorId: number,
  raw: unknown,
  now: DateTime = DateTime.utc()
): Promise<NeighborRecordOutcome> {
  const entries = normalizeNeighbors(raw)
  if (!entries) return 'invalid'
  const rows = foldNeighbors(entries)
  const fingerprint = fingerprintOf(rows)
  const stamp = sqlTime(now)
  const nowMs = now.toMillis()
  const reachable = rows.filter((r) => r.reachable).map((r) => r.mac)

  const last = await lastWritten(collectorId, OBSERVATION_KIND_NEIGHBORS)
  if (last && last.fingerprint === fingerprint) {
    // Same table, but a reachable entry is a fresh sighting each time the
    // agent sends it (it resends at least every 10 minutes).
    const lastSighting = recall(collectorId, SIGHTING_KIND)?.observedWrittenAt ?? 0
    if (nowMs - lastSighting >= OBSERVED_AT_REFRESH_MS) {
      await db.transaction(async (trx) => {
        if (reachable.length > 0) await markSighted(trx, collectorId, reachable, stamp)
        await touchObservationRow(trx, collectorId, OBSERVATION_KIND_NEIGHBORS, now)
      })
      remember(collectorId, SIGHTING_KIND, { fingerprint: '', observedWrittenAt: nowMs })
      remember(collectorId, OBSERVATION_KIND_NEIGHBORS, { fingerprint, observedWrittenAt: nowMs })
    }
    return 'unchanged'
  }

  const payload: NeighborsPayload = {
    entries: entries.length,
    macs: rows.length,
    reachable: reachable.length,
  }
  await db.transaction(async (trx) => {
    const macs = rows.map((r) => r.mac)
    await trx.rawQuery(
      `UPDATE gateway_hosts
          SET neighbor_present = 0, neighbor_reachable = 0, neighbor_ipv4 = NULL,
              neighbor_ipv6 = NULL, neighbor_device = NULL, last_reported_at = ?
        WHERE collector_id = ? AND neighbor_present = 1
          ${macs.length > 0 ? `AND mac NOT IN (${macs.map(() => '?').join(',')})` : ''}`,
      [stamp, collectorId, ...macs]
    )
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      const values: (string | number | boolean | null)[] = []
      for (const r of chunk) {
        values.push(
          collectorId,
          r.mac,
          r.ipv4,
          r.ipv6.length > 0 ? JSON.stringify(r.ipv6) : null,
          r.device,
          r.network,
          true,
          r.reachable,
          r.reachable ? stamp : null,
          stamp,
          stamp,
          stamp
        )
      }
      await trx.rawQuery(
        `INSERT INTO gateway_hosts
           (collector_id, mac, neighbor_ipv4, neighbor_ipv6, neighbor_device, network,
            neighbor_present, neighbor_reachable, neighbor_seen_at, last_reported_at, first_seen_at, updated_at)
         VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}
         ON DUPLICATE KEY UPDATE
           neighbor_ipv4 = VALUES(neighbor_ipv4), neighbor_ipv6 = VALUES(neighbor_ipv6),
           neighbor_device = VALUES(neighbor_device), neighbor_present = 1,
           network = IF(dhcp_present = 1 AND network IS NOT NULL, network,
                        COALESCE(VALUES(network), network)),
           neighbor_reachable = VALUES(neighbor_reachable),
           neighbor_seen_at = COALESCE(VALUES(neighbor_seen_at), neighbor_seen_at),
           last_reported_at = VALUES(last_reported_at), updated_at = VALUES(updated_at)`,
        values as StrictValues[]
      )
    }
    await deleteUnsightedOrphans(trx, collectorId)
    await writeObservationRow(
      trx,
      collectorId,
      OBSERVATION_KIND_NEIGHBORS,
      payload,
      fingerprint,
      now
    )
  })
  remember(collectorId, OBSERVATION_KIND_NEIGHBORS, { fingerprint, observedWrittenAt: nowMs })
  remember(collectorId, SIGHTING_KIND, { fingerprint: '', observedWrittenAt: nowMs })
  logger.debug({ collectorId, ...payload }, 'gateway_neighbors: observation written')
  return 'written'
}

async function markSighted(
  client: { rawQuery: (sql: string, bindings: StrictValues[]) => Promise<unknown> },
  collectorId: number,
  macs: string[],
  stamp: string
): Promise<void> {
  for (let i = 0; i < macs.length; i += 1000) {
    const chunk = macs.slice(i, i + 1000)
    await client.rawQuery(
      `UPDATE gateway_hosts SET neighbor_seen_at = ?
        WHERE collector_id = ? AND mac IN (${chunk.map(() => '?').join(',')})`,
      [stamp, collectorId, ...chunk]
    )
  }
}
