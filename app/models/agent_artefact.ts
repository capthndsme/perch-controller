import { utcColumn } from '#models/agent_update_columns'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

/** One artefact of a release manifest (agent-updates controller.md section 2.2). */
export default class AgentArtefact extends BaseModel {
  static table = 'agent_artefacts'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare releaseId: number

  @column()
  declare fileName: string

  @column()
  declare kind: 'binary' | 'package' | 'files'

  @column()
  declare arch: string | null

  @column()
  declare variant: string | null

  @column()
  declare manager: 'opkg' | 'apk' | null

  @column()
  declare openwrtSeries: string | null

  @column()
  declare pkgArch: string | null

  @column()
  declare packageName: string | null

  @column()
  declare packageVersion: string | null

  @column({ consume: (value: unknown) => Number(value) })
  declare sizeBytes: number

  @column({ consume: (value: unknown) => (value === null ? null : Number(value)) })
  declare gzipBytes: number | null

  @column({ columnName: 'sha256' })
  declare sha256: string

  @column()
  declare sourceUrl: string | null

  /** Relative to the store root; null until fetched or uploaded. */
  @column()
  declare storedPath: string | null

  @utcColumn()
  declare storedAt: DateTime | null
}
