import { revisionsToPrune } from '#services/gateway_config/revisions'
import type { GatewayConfigSettings } from '#services/gateway_config/gateway_config_settings'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Retention of the config plane's history (docs/gateway/config-plane.md
 * section 9), run by the daily prune task next to the bucket ladder:
 *
 * - `gateway_config_events` older than `auditRetentionDays`, batched;
 * - `gateway_revisions` beyond the newest `keepRevisions` of each gateway,
 *   always keeping the newest confirmed one (the rejoin offer, README 3.7).
 *   Sections keep their own `base_content`, so pruning never breaks a merge.
 */

export type ConfigRetentionResult = {
  eventCutoff: string
  events: number
  revisions: number
}

const BATCH = 5000

function sqlTime(dt: DateTime): string {
  return dt.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
}

export async function pruneGatewayConfigHistory(
  settings: Pick<GatewayConfigSettings, 'auditRetentionDays' | 'keepRevisions'>,
  options: { now?: DateTime; dryRun?: boolean } = {}
): Promise<ConfigRetentionResult> {
  const now = options.now ?? DateTime.utc()
  const eventCutoff = sqlTime(now.minus({ days: settings.auditRetentionDays }))

  let events = 0
  if (options.dryRun) {
    const [row] = await db
      .from('gateway_config_events')
      .where('created_at', '<', eventCutoff)
      .count('* as total')
    events = Number((row as { total?: unknown })?.total ?? 0)
  } else {
    for (;;) {
      const affected = await db
        .from('gateway_config_events')
        .where('created_at', '<', eventCutoff)
        .limit(BATCH)
        .delete()
      const n = Number(Array.isArray(affected) ? affected[0] : affected) || 0
      events += n
      if (n < BATCH) break
    }
  }

  let revisions = 0
  const crowded = (await db
    .from('gateway_revisions')
    .select('gateway_id')
    .groupBy('gateway_id')
    .havingRaw('COUNT(*) > ?', [settings.keepRevisions])) as Array<{ gateway_id: number }>
  for (const { gateway_id: gatewayId } of crowded) {
    const rows = (await db
      .from('gateway_revisions')
      .where('gateway_id', gatewayId)
      .select('number', 'confirmed_at')) as Array<{ number: number; confirmed_at: unknown }>
    const doomed = revisionsToPrune(
      rows.map((r) => ({ number: Number(r.number), confirmedAt: r.confirmed_at })),
      settings.keepRevisions
    )
    revisions += doomed.length
    if (options.dryRun) continue
    for (let i = 0; i < doomed.length; i += BATCH) {
      await db
        .from('gateway_revisions')
        .where('gateway_id', gatewayId)
        .whereIn('number', doomed.slice(i, i + BATCH))
        .delete()
    }
  }

  return { eventCutoff, events, revisions }
}
