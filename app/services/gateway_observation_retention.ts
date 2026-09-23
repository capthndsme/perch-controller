import db from '@adonisjs/lucid/services/db'
import {
  getGatewayObservationSettings,
  type GatewayObservationSettings,
} from '#services/gateway_observation_settings'
import { bumpGatewayDhcpVersion } from '#services/gateway_dhcp'

/**
 * The observation channel's retention (docs/gateway/observation.md section
 * 6), run daily by `app/tasks/gateway_observation_retention.task.ts`:
 *
 * - `gateway_hosts` rows no report lists any more (`dhcp_present = 0` and
 *   `neighbor_present = 0`) whose `last_reported_at` is older than
 *   `hostRetentionDays`;
 * - `gateway_upnp_mappings` rows not reported for `hostRetentionDays` (a
 *   gateway that stopped sending `upnp` at all);
 * - `gateway_upnp_events` older than `upnpEventRetentionDays`;
 * - `gateway_backups` beyond the newest `backupsKept` per collector.
 *
 * Ages are computed by the database against `UTC_TIMESTAMP()` (stored times
 * are UTC wall times; the process zone does not matter). Deletes run in
 * batches so the task never holds a long lock against the ingest.
 */

const BATCH = 5000

export type GatewayRetentionResult = {
  hosts: number
  upnpMappings: number
  upnpEvents: number
  backups: number
}

function affected(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result
  return Number((header as { affectedRows?: number })?.affectedRows ?? 0)
}

async function deleteInBatches(sql: string, bindings: (string | number)[]): Promise<number> {
  let total = 0
  for (;;) {
    const deleted = affected(await db.rawQuery(`${sql} LIMIT ${BATCH}`, bindings))
    total += deleted
    if (deleted < BATCH) return total
  }
}

export async function pruneGatewayObservations(
  settings?: GatewayObservationSettings
): Promise<GatewayRetentionResult> {
  const s = settings ?? (await getGatewayObservationSettings())

  const hosts = await deleteInBatches(
    `DELETE FROM gateway_hosts
      WHERE dhcp_present = 0 AND neighbor_present = 0
        AND (last_reported_at IS NULL
             OR last_reported_at < UTC_TIMESTAMP() - INTERVAL ? DAY)`,
    [s.hostRetentionDays]
  )
  if (hosts > 0) bumpGatewayDhcpVersion()

  const upnpMappings = await deleteInBatches(
    `DELETE FROM gateway_upnp_mappings WHERE last_seen_at < UTC_TIMESTAMP() - INTERVAL ? DAY`,
    [s.hostRetentionDays]
  )
  const upnpEvents = await deleteInBatches(
    `DELETE FROM gateway_upnp_events WHERE at < UTC_TIMESTAMP() - INTERVAL ? DAY`,
    [s.upnpEventRetentionDays]
  )

  // Newest `backupsKept` per collector stay; ids break created_at ties.
  const backups = affected(
    await db.rawQuery(
      `DELETE b FROM gateway_backups b
         JOIN (SELECT id FROM (
                 SELECT id, ROW_NUMBER() OVER (PARTITION BY collector_id
                                               ORDER BY created_at DESC, id DESC) AS n
                   FROM gateway_backups) ranked
                WHERE ranked.n > ?) old ON old.id = b.id`,
      [s.backupsKept]
    )
  )

  return { hosts, upnpMappings, upnpEvents, backups }
}
