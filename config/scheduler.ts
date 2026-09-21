import { defineConfig } from '@outloud/adonis-scheduler'
import env from '#start/env'

/**
 * Scheduler config. We run the scheduler in-process with the HTTP server
 * (single systemd unit, no IPC, scheduler shares the Adonis container + DB
 * pool) — see `SCHEDULER_HTTP_SERVER` in `start/env.ts`.
 *
 * Tasks are auto-discovered from `app/tasks/**\/*.task.js` so adding a new
 * cron is just dropping a new file in `app/tasks`.
 *
 * Locking is intentionally NOT enabled per-task at the moment: we ship a
 * single-process deployment and our task is short. `lockDuration` is still
 * specified so flipping `lock: true` on a future task Just Works without
 * revisiting the config.
 */
const schedulerConfig = defineConfig({
  httpServer: env.get('SCHEDULER_HTTP_SERVER', true),
  warnWhenLocked: false,
  lockDuration: '10m',
  locations: ['./app/**/*.task.js'],
})

export default schedulerConfig
