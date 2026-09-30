import { alertNow, sqlTime } from '#services/alerts/clock'
import type { AlertsSettings } from '#services/alerts/model'
import db from '@adonisjs/lucid/services/db'
import type { DateTime } from 'luxon'

/**
 * Retention of the alerts tables (docs/design/alerts/README.md §3), batched
 * like `bucket_retention.ts` so a sweep never holds a long lock:
 * - `alert_events` older than `retention.eventDays`;
 * - resolved and posted `alerts` older than `retention.alertDays` (by their
 *   last event; active and pending alerts are never pruned; their
 *   deliveries cascade, their events keep a NULL `alert_id`);
 * - final deliveries and attempts older than `retention.deliveryDays`;
 * - `gone` push subscriptions after 30 days; expired mutes after 7 days.
 */
const BATCH = 1000

export type AlertsPruneResult = {
  events: number
  alerts: number
  deliveries: number
  attempts: number
  subscriptions: number
  mutes: number
}

async function batched(run: () => PromiseLike<unknown>): Promise<number> {
  let total = 0
  for (;;) {
    const result = await run()
    const affected = Number(Array.isArray(result) ? result[0] : result) || 0
    total += affected
    if (affected < BATCH) return total
  }
}

export async function pruneAlerts(
  settings: Pick<AlertsSettings, 'retention'>,
  now: DateTime = alertNow()
): Promise<AlertsPruneResult> {
  const { eventDays, alertDays, deliveryDays } = settings.retention
  const eventCutoff = sqlTime(now.minus({ days: eventDays }))
  const alertCutoff = sqlTime(now.minus({ days: alertDays }))
  const deliveryCutoff = sqlTime(now.minus({ days: deliveryDays }))

  const events = await batched(() =>
    db.from('alert_events').where('occurred_at', '<', eventCutoff).limit(BATCH).delete()
  )
  const alerts = await batched(() =>
    db
      .from('alerts')
      .whereIn('state', ['resolved', 'posted'])
      .whereNull('active_key')
      .where('last_event_at', '<', alertCutoff)
      .limit(BATCH)
      .delete()
  )
  const attempts = await batched(() =>
    db
      .from('alert_delivery_attempts')
      .where('attempted_at', '<', deliveryCutoff)
      .limit(BATCH)
      .delete()
  )
  const deliveries = await batched(() =>
    db
      .from('alert_deliveries')
      .whereIn('status', ['sent', 'failed', 'expired', 'collapsed'])
      .where('created_at', '<', deliveryCutoff)
      .limit(BATCH)
      .delete()
  )
  const subscriptions = await batched(() =>
    db
      .from('alert_push_subscriptions')
      .where('state', 'gone')
      .where('updated_at', '<', sqlTime(now.minus({ days: 30 })))
      .limit(BATCH)
      .delete()
  )
  const mutes = await batched(() =>
    db
      .from('alert_mutes')
      .whereNotNull('until')
      .where('until', '<', sqlTime(now.minus({ days: 7 })))
      .limit(BATCH)
      .delete()
  )
  return { events, alerts, deliveries, attempts, subscriptions, mutes }
}
