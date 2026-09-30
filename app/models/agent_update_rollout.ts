import { boolColumn, utcColumn } from '#models/agent_update_columns'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

export const ROLLOUT_STATES = [
  'canary',
  'observing',
  'rolling',
  'paused',
  'completed',
  'cancelled',
] as const
export type RolloutState = (typeof ROLLOUT_STATES)[number]
export const OPEN_ROLLOUT_STATES: readonly RolloutState[] = [
  'canary',
  'observing',
  'rolling',
  'paused',
]

export const ROLLOUT_WAITING = ['window', 'gap', 'observe', 'online', 'busy'] as const
export type RolloutWaiting = (typeof ROLLOUT_WAITING)[number]

/** A staged update of many devices (agent-updates controller.md section 2.5). */
export default class AgentUpdateRollout extends BaseModel {
  static table = 'agent_update_rollouts'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare product: 'perch-apd' | 'perch-collector'

  @column()
  declare releaseId: number | null

  /** The release's version, kept when the release is deleted. */
  @column()
  declare version: string

  @column()
  declare state: RolloutState

  @column()
  declare method: 'auto' | 'binary' | 'package'

  @column()
  declare batchSize: number

  @column()
  declare batchGapSeconds: number

  @column()
  declare canaryObserveMinutes: number

  @column()
  declare offlineWaitMinutes: number

  @boolColumn()
  declare stopOnFailure: boolean

  @boolColumn()
  declare respectWindow: boolean

  @boolColumn()
  declare auto: boolean

  @boolColumn()
  declare acceptUnrecoverable: boolean

  @column()
  declare waitingFor: RolloutWaiting | null

  @column()
  declare pausedReason: string | null

  @column()
  declare pausedDetail: string | null

  @column()
  declare createdByUserId: number | null

  @utcColumn()
  declare createdAt: DateTime

  @utcColumn()
  declare startedAt: DateTime | null

  @utcColumn()
  declare canaryConfirmedAt: DateTime | null

  @utcColumn()
  declare nextActionAt: DateTime | null

  @utcColumn()
  declare finishedAt: DateTime | null

  @utcColumn()
  declare updatedAt: DateTime

  get isOpen(): boolean {
    return OPEN_ROLLOUT_STATES.includes(this.state)
  }
}
