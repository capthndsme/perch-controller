import ApConfigEvent from '#models/ap_config_event'
import ApConfigRevision from '#models/ap_config_revision'
import WifiDivergence from '#models/wifi_divergence'
import WifiRollout from '#models/wifi_rollout'
import { revisionsToPrune } from '#services/gateway_config/revisions'
import { dropUnusedSecrets } from '#services/wifi_config/secrets'
import type { WifiConfigSettings } from '#services/wifi_config/settings'
import { DateTime } from 'luxon'

/** Resolved divergences are kept this long (controller.md 9). */
export const RESOLVED_DIVERGENCE_DAYS = 90

export type WifiPruneResult = {
  events: number
  revisions: number
  divergences: number
  rollouts: number
  secrets: number
}

/**
 * The Wi-Fi plane's retention (docs/design/wifi controller.md section 9):
 * events older than `auditRetentionDays`; revisions beyond `keepRevisions`
 * per AP, always keeping the newest confirmed one (the rejoin offer needs
 * it; sections keep their own B, so pruning never breaks a merge); resolved
 * divergences after 90 days; finished rollouts after `auditRetentionDays`;
 * passphrases nothing references any more.
 */
export async function pruneWifiConfigHistory(
  settings: Pick<WifiConfigSettings, 'auditRetentionDays' | 'keepRevisions'>,
  now: DateTime = DateTime.utc()
): Promise<WifiPruneResult> {
  const sql = (d: DateTime) => d.toFormat('yyyy-MM-dd HH:mm:ss')
  const auditCutoff = sql(now.minus({ days: settings.auditRetentionDays }))
  const events = await ApConfigEvent.query().where('created_at', '<', auditCutoff).delete()

  let revisions = 0
  const perAp = await ApConfigRevision.query().select('ap_id').count('* as total').groupBy('ap_id')
  for (const row of perAp) {
    if (Number(row.$extras.total) <= settings.keepRevisions) continue
    const refs = await ApConfigRevision.query()
      .where('ap_id', row.apId)
      .select('number', 'confirmed_at')
    const numbers = revisionsToPrune(
      refs.map((r) => ({ number: r.number, confirmedAt: r.confirmedAt })),
      settings.keepRevisions
    )
    for (let i = 0; i < numbers.length; i += 500) {
      const chunk = numbers.slice(i, i + 500)
      const deleted = await ApConfigRevision.query()
        .where('ap_id', row.apId)
        .whereIn('number', chunk)
        .delete()
      revisions += Number(Array.isArray(deleted) ? deleted[0] : deleted)
    }
  }

  const divergences = await WifiDivergence.query()
    .whereNotNull('resolved_at')
    .where('resolved_at', '<', sql(now.minus({ days: RESOLVED_DIVERGENCE_DAYS })))
    .delete()
  const rollouts = await WifiRollout.query()
    .whereIn('state', ['completed', 'cancelled'])
    .whereNotNull('finished_at')
    .where('finished_at', '<', auditCutoff)
    .delete()
  const secrets = await dropUnusedSecrets()
  const n = (value: unknown) => Number(Array.isArray(value) ? value[0] : value) || 0
  return {
    events: n(events),
    revisions,
    divergences: n(divergences),
    rollouts: n(rollouts),
    secrets,
  }
}
