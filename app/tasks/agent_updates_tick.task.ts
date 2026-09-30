import { agentUpdatesTick } from '#services/agent_updates/tick'
import logger from '@adonisjs/core/services/logger'
import { Task, type TaskOptions } from '@outloud/adonis-scheduler'

/**
 * Agent updates (docs/design/agent-updates/controller.md section 5.2): one
 * pass every 5 s. A pass that is still running (an agent taking its 30 s to
 * answer a stage) makes the next one skip rather than overlap.
 */
let running = false

export default class AgentUpdatesTickTask extends Task {
  static options: TaskOptions = {
    schedule: '*/5 * * * * *',
  }

  async run(): Promise<void> {
    if (running) return
    running = true
    try {
      await agentUpdatesTick()
    } catch (err) {
      logger.error({ err }, 'agent_updates: tick failed')
    } finally {
      running = false
    }
  }
}
