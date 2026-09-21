import { runAllRollups } from '#services/rollup_maintainer'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * Once-a-minute rollup maintenance. Rebuilds the 5 m / hourly / daily tiers
 * (and the WiFi snapshot 5 m rollups) from the tier below over a two-slot
 * trailing window — see `rollup_maintainer` for why this replaced the
 * per-tick fan-out in the bucket writers.
 *
 * Offset to second 20 so it never coincides with the :00 / :05 poll ticks
 * that write the rows it reads.
 */
export default class RollupBucketsTask extends Task {
  static options: TaskOptions = {
    schedule: '20 * * * * *',
  }

  private running = false

  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const results = await runAllRollups()
      logger.debug({ results }, 'rollup_buckets: refreshed rollup tiers')
    } catch (err) {
      logger.error({ err }, 'rollup_buckets: rollup pass failed')
    } finally {
      this.running = false
    }
  }
}
