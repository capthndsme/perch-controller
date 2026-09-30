import { runDueDetectors } from '#services/alerts/detector_context'
import '#services/alerts/detectors/index'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * Alert detectors (docs/design/alerts/README.md section 2.4), every 15 s:
 * each registered detector whose period is due runs once, one after the
 * other, each in its own try/catch (`runDueDetectors`). A tick still running
 * when the next one fires is not overlapped: the next tick is skipped.
 */
let running = false

export default class AlertsEvaluateTask extends Task {
  static options: TaskOptions = {
    schedule: '*/15 * * * * *',
  }

  async run(): Promise<void> {
    if (running) return
    running = true
    try {
      await runDueDetectors()
    } catch (err) {
      logger.error({ err }, 'alerts_evaluate: tick failed')
    } finally {
      running = false
    }
  }
}
