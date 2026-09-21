import WifiAccessPoint from '#models/wifi_access_point'
import { checkAgentPushFreshness } from '#services/ap_agent_metrics'
import { lastWifiPollAtFor, pollWifiOnce } from '#services/wifi_metrics_poller'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * Global WiFi poll dispatcher. Mirrors `poll_collectors.task.ts`: one static
 * 5-second tick, per-source dynamic interval from DB rows. Perch AP Daemon rows
 * (`transport = 'agent'`) push their metrics instead; for them the tick only
 * checks that pushes keep arriving.
 */
export default class PollWifiAccessPointsTask extends Task {
  static options: TaskOptions = {
    schedule: '*/5 * * * * *',
  }

  async run(): Promise<void> {
    try {
      await checkAgentPushFreshness()
    } catch (error) {
      logger.error({ err: error }, 'wifi_metrics_poller: agent freshness check failed')
    }

    const accessPoints = await WifiAccessPoint.query()
      .where('enabled', true)
      .whereNot('transport', 'agent')
    if (accessPoints.length === 0) return

    const now = Date.now()
    const due = accessPoints.filter(
      (ap) => now - lastWifiPollAtFor(ap.id) >= ap.pollIntervalSeconds * 1000 - 1500
    )
    if (due.length === 0) return

    await Promise.allSettled(
      due.map(async (ap) => {
        try {
          const outcome = await pollWifiOnce(ap)
          if (outcome.status === 'failed') {
            logger.warn({ apId: ap.id, error: outcome.error }, 'wifi_metrics_poller: poll failed')
          } else if (outcome.status === 'wrote') {
            logger.debug(
              {
                apId: ap.id,
                networks: outcome.networkSnapshots,
                stations: outcome.stationSnapshots,
                buckets: outcome.interfaceBucketsWritten,
                roamingEvents: outcome.roamingEvents,
              },
              'wifi_metrics_poller: wrote wifi snapshot batch'
            )
          } else {
            logger.info(
              {
                apId: ap.id,
                reason: outcome.reason,
                networks: outcome.networkSnapshots,
                stations: outcome.stationSnapshots,
              },
              'wifi_metrics_poller: baselined snapshot'
            )
          }
        } catch (error) {
          logger.error({ apId: ap.id, err: error }, 'wifi_metrics_poller: unhandled poll exception')
        }
      })
    )
  }
}
