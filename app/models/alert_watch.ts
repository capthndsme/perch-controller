import { jsonColumn } from '#models/json_column'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

/** A watched device and mode (`offline` / `arrival`), events.md §3.5. */
export default class AlertWatch extends BaseModel {
  static table = 'alert_watches'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare subjectKind: string

  @column()
  declare subjectRef: string

  @column()
  declare mode: 'offline' | 'arrival'

  @jsonColumn('params')
  declare params: Record<string, unknown> | null

  @column()
  declare createdByUserId: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
