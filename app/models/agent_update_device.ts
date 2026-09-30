import { jsonTextColumn, utcColumn } from '#models/agent_update_columns'
import type { UpdateReport } from '#services/agent_updates/report'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

/** Facts about the host a session told us that the device rows do not keep. */
export type DeviceFacts = {
  arch?: string | null
  os?: string | null
}

/**
 * Per-device update settings and the last `update` status block
 * (agent-updates controller.md section 2.3). One of `apId` / `collectorId`.
 */
export default class AgentUpdateDevice extends BaseModel {
  static table = 'agent_update_devices'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare apId: number | null

  @column()
  declare collectorId: number | null

  /** null = the `defaultChannel` setting. */
  @column()
  declare channel: 'stable' | 'pre' | 'local' | null

  @column()
  declare autoUpdate: 'inherit' | 'off' | 'notify' | 'auto'

  @column()
  declare pinnedVersion: string | null

  @jsonTextColumn()
  declare report: UpdateReport | null

  @utcColumn()
  declare reportedAt: DateTime | null

  @column()
  declare versionSeen: string | null

  @jsonTextColumn()
  declare facts: DeviceFacts | null

  @utcColumn()
  declare updatedAt: DateTime
}
