import { jsonTextColumn, utcColumn } from '#models/agent_update_columns'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

/** The agent-updates audit trail (agent-updates controller.md section 2.7). */
export default class AgentUpdateEvent extends BaseModel {
  static table = 'agent_update_events'

  @column({ isPrimary: true, consume: (value: unknown) => Number(value) })
  declare id: number

  @utcColumn()
  declare createdAt: DateTime

  @column()
  declare event: string

  @column()
  declare severity: 'info' | 'warning' | 'critical'

  @column()
  declare apId: number | null

  @column()
  declare collectorId: number | null

  @column()
  declare deviceName: string | null

  @column({ consume: (value: unknown) => (value === null ? null : Number(value)) })
  declare jobId: number | null

  @column()
  declare rolloutId: number | null

  @column()
  declare releaseId: number | null

  @column()
  declare userId: number | null

  @column()
  declare systemActor: string | null

  @jsonTextColumn()
  declare detail: Record<string, unknown> | null
}
