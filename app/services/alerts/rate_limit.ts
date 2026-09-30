import { fromSqlTime, sqlTime } from '#services/alerts/clock'
import type { AlertsSettings } from '#services/alerts/model'
import db from '@adonisjs/lucid/services/db'
import type { DateTime } from 'luxon'

/**
 * The per-destination rate limit (docs/design/alerts/delivery.md §4): at most
 * `destinationRateLimit.max` deliveries sent to one destination in the last
 * `windowMinutes`. Counted from the delivery log, so it survives restarts;
 * tests (their own 10 s limit) do not count.
 */
export type DestinationRef = { kind: 'push' | 'webhook'; id: number }

export function destinationColumn(kind: DestinationRef['kind']): string {
  return kind === 'push' ? 'push_subscription_id' : 'webhook_id'
}

/**
 * When the destination may send again: the moment the oldest counted send
 * leaves the window, or null when it is under the limit.
 */
export async function rateLimitHoldUntil(
  destination: DestinationRef,
  settings: Pick<AlertsSettings, 'destinationRateLimit'>,
  now: DateTime
): Promise<DateTime | null> {
  const { max, windowMinutes } = settings.destinationRateLimit
  const since = now.minus({ minutes: windowMinutes })
  const rows = (await db
    .from('alert_deliveries')
    .where(destinationColumn(destination.kind), destination.id)
    .where('status', 'sent')
    .whereNot('transition', 'test')
    .where('sent_at', '>', sqlTime(since))
    .orderBy('sent_at', 'asc')
    .limit(max)
    .select('sent_at')) as Array<{ sent_at: unknown }>
  if (rows.length < max) return null
  const oldest = fromSqlTime(rows[0].sent_at)
  if (!oldest) return null
  const free = oldest.plus({ minutes: windowMinutes })
  return free > now ? free : now.plus({ seconds: 1 })
}
