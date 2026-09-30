import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { randomUUID } from 'node:crypto'

/**
 * `node ace alerts:emit --type <type> [--subject <kind>:<ref>] [--phase raise|clear|instant]
 *   [--severity info|warning|critical] [--count N] [--payload '{"k":1}'] [--dedupe-key K]`
 *
 * Emits alert events through the real engine, for tests and the lab
 * (docs/design/alerts/README.md §10.2): `--type system.test --count 200`
 * exercises the rate limit and the digest. The events are processed in this
 * process before it exits; deliveries it creates are sent by the running
 * server's delivery worker (this command never sends anything itself).
 * `system.test` gets a fresh key per event (never merged).
 */
export default class AlertsEmit extends BaseCommand {
  static commandName = 'alerts:emit'
  static description = 'Emit alert events through the engine (tests and the lab)'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'Catalogue type, e.g. system.test or ap.offline', required: true })
  declare type: string

  @flags.string({
    description: 'Subject key: controller (default), ap:4, collector:1, device:<mac>…',
  })
  declare subject: string

  @flags.string({ description: 'raise | clear | instant (default: from the catalogue)' })
  declare phase: string

  @flags.string({ description: 'info | warning | critical (default: the catalogue severity)' })
  declare severity: string

  @flags.number({ description: 'How many events to emit (1–5000)', default: 1 })
  declare count: number

  @flags.string({ description: 'JSON object used as the event payload' })
  declare payload: string

  @flags.string({ description: 'Explicit dedupe key' })
  declare dedupeKey: string

  async run() {
    const { emitAlertEvent } = await import('#services/alerts/emit')
    const { engineStats, flushAlertQueue } = await import('#services/alerts/engine')
    const { getAlertType } = await import('#services/alerts/catalogue/index')
    const { parseSubjectKey } = await import('#services/alerts/subjects')

    const def = getAlertType(this.type)
    if (!def) {
      this.logger.error(`Unknown alert type "${this.type}"`)
      this.exitCode = 1
      return
    }
    const subject = parseSubjectKey(this.subject ?? 'controller')
    if (!subject) {
      this.logger.error(`Malformed subject "${this.subject}" (expected <kind>:<ref> or controller)`)
      this.exitCode = 1
      return
    }
    const phase = this.phase as 'raise' | 'clear' | 'instant' | undefined
    if (phase && !['raise', 'clear', 'instant'].includes(phase)) {
      this.logger.error('--phase must be raise, clear or instant')
      this.exitCode = 1
      return
    }
    const severity = this.severity as 'info' | 'warning' | 'critical' | undefined
    if (severity && !['info', 'warning', 'critical'].includes(severity)) {
      this.logger.error('--severity must be info, warning or critical')
      this.exitCode = 1
      return
    }
    let payload: Record<string, unknown> | undefined
    if (this.payload) {
      try {
        payload = JSON.parse(this.payload)
      } catch {
        this.logger.error('--payload is not valid JSON')
        this.exitCode = 1
        return
      }
    }
    if (this.type === 'system.test') {
      payload = { from: 'node ace alerts:emit', ...(payload ?? {}) }
    }

    const count = Math.max(1, Math.min(5000, Math.floor(this.count ?? 1)))
    for (let i = 0; i < count; i++) {
      emitAlertEvent({
        type: this.type,
        phase,
        subject,
        severity: severity ?? (this.type === 'system.test' ? 'info' : undefined),
        payload,
        dedupeKey:
          this.dedupeKey ??
          (this.type === 'system.test' ? `system.test:${randomUUID()}` : undefined),
        source: 'cli',
      })
    }
    await flushAlertQueue()
    const stats = engineStats()
    this.logger.success(
      `Emitted ${count} ${this.type} event(s)${stats.dropped ? `, ${stats.dropped} dropped (queue full)` : ''}`
    )
  }
}
