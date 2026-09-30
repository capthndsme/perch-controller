import { boolColumn, utcColumn } from '#models/agent_update_columns'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

export const ROLLOUT_DEVICE_STATES = [
  'pending',
  'running',
  'confirmed',
  'failed',
  'skipped',
] as const
export type RolloutDeviceState = (typeof ROLLOUT_DEVICE_STATES)[number]

/** Why a device was left out: offline too long, held, cannot take the release, already on it, an admin, a failure skipped on resume. */
export type RolloutSkipReason =
  | 'offline'
  | 'pinned'
  | 'unsupported'
  | 'up_to_date'
  | 'admin'
  | 'failed'

/** One device of a rollout (agent-updates controller.md section 2.6). */
export default class AgentUpdateRolloutDevice extends BaseModel {
  static table = 'agent_update_rollout_devices'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare rolloutId: number

  @column()
  declare apId: number | null

  @column()
  declare collectorId: number | null

  @column()
  declare deviceName: string

  @column()
  declare position: number

  @boolColumn()
  declare isCanary: boolean

  @column()
  declare state: RolloutDeviceState

  @column()
  declare skipReason: RolloutSkipReason | null

  @column()
  declare detail: string | null

  @column({ consume: (value: unknown) => (value === null ? null : Number(value)) })
  declare jobId: number | null

  @utcColumn()
  declare offlineSince: DateTime | null

  @utcColumn()
  declare updatedAt: DateTime
}
