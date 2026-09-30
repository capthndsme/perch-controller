import { jsonColumn } from '#models/json_column'
import type { AlertKind, AlertState, Category, Severity } from '#services/alerts/model'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

/**
 * One alert (docs/design/alerts/README.md §2.3, §3). The state machine lives
 * in `app/services/alerts/engine.ts`; this is the row.
 */
export default class Alert extends BaseModel {
  static table = 'alerts'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare type: string

  @column()
  declare category: Category | string

  @column()
  declare kind: AlertKind

  @column()
  declare state: AlertState

  @column()
  declare severity: Severity

  @column()
  declare dedupeKey: string

  /** = dedupeKey while pending or active, null otherwise (UNIQUE). */
  @column()
  declare activeKey: string | null

  @column()
  declare subjectKind: string

  @column()
  declare subjectRef: string

  @column()
  declare subjectLabel: string | null

  @column()
  declare title: string

  @column()
  declare body: string

  @column()
  declare path: string | null

  @jsonColumn('payload')
  declare payload: Record<string, unknown> | null

  @column.dateTime()
  declare firstRaisedAt: DateTime

  /** Start of the current (or last) episode. */
  @column.dateTime()
  declare raisedAt: DateTime

  @column.dateTime()
  declare lastEventAt: DateTime

  @column.dateTime()
  declare openedAt: DateTime | null

  @column.dateTime()
  declare resolvedAt: DateTime | null

  @column.dateTime()
  declare notifyAt: DateTime | null

  @column.dateTime()
  declare lastTransitionAt: DateTime | null

  @column.dateTime()
  declare nextReminderAt: DateTime | null

  @column.dateTime()
  declare recoveryDueAt: DateTime | null

  @column({ consume: (v) => Boolean(v) })
  declare quietResolve: boolean

  @column()
  declare eventCount: number

  @column()
  declare transitions: number

  @column({ consume: (v) => Boolean(v) })
  declare flapping: boolean

  @column({ consume: (v) => Boolean(v) })
  declare muted: boolean

  @column({ consume: (v) => Boolean(v) })
  declare notified: boolean

  @column.dateTime()
  declare bumpedAt: DateTime

  @column.dateTime()
  declare acknowledgedAt: DateTime | null

  @column()
  declare acknowledgedByUserId: number | null

  @column()
  declare ackNote: string | null

  @column()
  declare resolvedByUserId: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
