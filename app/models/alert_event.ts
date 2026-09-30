import { jsonColumn } from '#models/json_column'
import type { EventPhase, Severity } from '#services/alerts/model'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

/** One event the alerts engine processed, and what it did (`outcome`). */
export default class AlertEvent extends BaseModel {
  static table = 'alert_events'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare type: string

  @column()
  declare phase: EventPhase

  @column()
  declare severity: Severity

  @column()
  declare category: string

  @column()
  declare subjectKind: string

  @column()
  declare subjectRef: string

  @column()
  declare dedupeKey: string

  @jsonColumn('payload')
  declare payload: Record<string, unknown> | null

  @column()
  declare source: string | null

  @column.dateTime()
  declare occurredAt: DateTime

  @column.dateTime()
  declare recordedAt: DateTime

  @column()
  declare alertId: number | null

  @column()
  declare outcome: string
}
