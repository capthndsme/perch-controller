import AgentArtefact from '#models/agent_artefact'
import { utcColumn } from '#models/agent_update_columns'
import { BaseModel, column, hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import type { DateTime } from 'luxon'

/** A signed Perch daemon release (agent-updates controller.md section 2.1). */
export default class AgentRelease extends BaseModel {
  static table = 'agent_releases'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare product: 'perch-apd' | 'perch-collector'

  @column()
  declare version: string

  @column()
  declare versionSort: string

  @column()
  declare channel: 'stable' | 'pre' | 'local'

  @column()
  declare source: 'github' | 'upload'

  /** The manifest bytes as received (UTF-8 JSON). */
  @column()
  declare manifest: string

  @column({ columnName: 'manifest_sha256' })
  declare manifestSha256: string

  @column()
  declare signature: string

  @column()
  declare keyId: string

  @column()
  declare minVersion: string | null

  @column()
  declare minFromVersion: string | null

  @column()
  declare minControllerVersion: string | null

  @utcColumn()
  declare releasedAt: DateTime | null

  @column()
  declare notesUrl: string | null

  @column({ consume: (value: unknown) => (value === null ? null : Number(value)) })
  declare githubReleaseId: number | null

  @utcColumn()
  declare importedAt: DateTime

  @column()
  declare importedByUserId: number | null

  @utcColumn()
  declare withdrawnAt: DateTime | null

  @column()
  declare withdrawnByUserId: number | null

  @hasMany(() => AgentArtefact, { foreignKey: 'releaseId' })
  declare artefacts: HasMany<typeof AgentArtefact>
}
