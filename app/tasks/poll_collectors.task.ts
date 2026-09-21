import Collector from '#models/collector'
import { checkCollectorPushFreshness } from '#services/collector_agent'
import { nextAttemptAtFor, pollOnce } from '#services/collector_poller'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * Collector IDs that currently have a pollOnce() in flight. Checked
 * before dispatching so a slow poll cycle (> 5 s under heavy traffic)
 * can't race a second cycle for the same collector — the root cause of
 * the gap-lock deadlocks on `device_top_peers`.
 */
const inFlight = new Set<number>()

/**
 * The single global tick. Runs every 5 s (matches our minimum supported
 * `poll_interval_seconds`) and inside each tick decides per polled collector
 * whether to poll by asking the poller when that collector may next be
 * attempted (`nextAttemptAtFor`). That schedule is written on every
 * outcome, so a collector that is down backs off instead of being hammered
 * on every tick.
 *
 * Why one task and not one per collector: the scheduler library binds the
 * cron pattern to the Task class statically, but our poll intervals live
 * in the DB and can change at runtime. A single dispatcher gives us
 * dynamic intervals without re-registering tasks when collectors are
 * added, edited, or removed.
 *
 * Concurrency model:
 *   - Two different collectors may be polled in parallel (Promise.allSettled).
 *   - The same collector is guarded by `inFlight` so it cannot be
 *     double-polled even when a cycle takes longer than the tick interval.
 */
export default class PollCollectorsTask extends Task {
  static options: TaskOptions = {
    schedule: '*/5 * * * * *', // every 5 seconds (croner 6-field cron)
  }

  async run(): Promise<void> {
    // Socket collectors push on their own; for them the tick only checks
    // that pushes keep arriving (docs/collector-agent.md section 5.5).
    try {
      await checkCollectorPushFreshness()
    } catch (err) {
      logger.error({ err }, 'collector_poller: socket freshness check failed')
    }

    /**
     * `lifecycle = 'adopted'` is belt and braces — announced rows are
     * created with `enabled = false` — but the belt is what stops a future
     * "enable" toggle on a pending row from quietly starting a poll against
     * an unadopted address. Served by `collectors_lifecycle_enabled_idx`.
     * `transport = 'poll'`: a socket collector is never polled, or every
     * bucket would be written twice.
     */
    const collectors = await Collector.query()
      .where('enabled', true)
      .where('lifecycle', 'adopted')
      .where('transport', 'poll')
    if (collectors.length === 0) return

    const now = Date.now()
    const due = collectors.filter((c) => !inFlight.has(c.id) && now >= nextAttemptAtFor(c.id))
    if (due.length === 0) return

    await Promise.allSettled(
      due.map(async (c) => {
        inFlight.add(c.id)
        try {
          const outcome = await pollOnce(c)
          if (outcome.status === 'failed') {
            logger.warn(
              { collectorId: c.id, error: outcome.error },
              'collector_poller: poll failed'
            )
          } else if (outcome.status === 'wrote') {
            logger.debug(
              {
                collectorId: c.id,
                buckets: outcome.bucketsWritten,
                protocolBuckets: outcome.protocolBucketsWritten,
                peers: outcome.peersWritten,
                devices: outcome.deviceCount,
              },
              'collector_poller: wrote bucket batch'
            )
          } else {
            logger.info(
              { collectorId: c.id, reason: outcome.reason, devices: outcome.deviceCount },
              'collector_poller: baselined snapshot'
            )
          }
        } catch (err) {
          logger.error({ collectorId: c.id, err }, 'collector_poller: unhandled poll exception')
        } finally {
          inFlight.delete(c.id)
        }
      })
    )
  }
}
