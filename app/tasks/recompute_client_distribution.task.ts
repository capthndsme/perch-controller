import { recomputeClientDistribution } from '#services/client_distribution_rollup'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'
import { DateTime } from 'luxon'

/**
 * How far back each run recomputes. Generous enough to refresh the live,
 * still-filling slots (up to the 1-hour grain) plus a margin for a couple of
 * missed runs, while staying a cheap scan (~3 h of raw snapshots).
 */
const LOOKBACK_HOURS = 3

/**
 * Keeps the `wifi_client_distribution` rollup fresh for the WiFi client
 * distribution graph. Distinct counts are not incrementally additive, so the
 * rollup is recomputed in a short batch rather than fanned in per poll.
 *
 * Runs every 5 minutes (the graph caches at a similar TTL, so the live edge is
 * never staler than it already was reading raw).
 */
export default class RecomputeClientDistributionTask extends Task {
  static options: TaskOptions = {
    schedule: '0 */5 * * * *', // every 5 minutes (croner 6-field cron)
  }

  async run(): Promise<void> {
    const until = DateTime.utc()
    const since = until.minus({ hours: LOOKBACK_HOURS })

    try {
      const results = await recomputeClientDistribution({ since, until })
      logger.debug(
        { since: since.toISO(), until: until.toISO(), results },
        'recompute_client_distribution: refreshed rollup'
      )
    } catch (err) {
      logger.error({ err }, 'recompute_client_distribution: recompute failed')
    }
  }
}
