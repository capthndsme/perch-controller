import { boolColumn, jsonTextColumn, utcColumn } from '#models/agent_update_columns'
import type { AgentPreflight } from '#services/agent_updates/report'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

export const JOB_STATES = [
  'queued',
  'staging',
  'staged',
  'installing',
  'probation',
  'unknown',
  'confirmed',
  'failed',
  'rolled_back',
  'rollback_failed',
  'rollback_unavailable',
  'cancelled',
  'expired',
] as const
export type JobState = (typeof JOB_STATES)[number]

export const OPEN_JOB_STATES: readonly JobState[] = [
  'queued',
  'staging',
  'staged',
  'installing',
  'probation',
  'unknown',
]
export const FINAL_JOB_STATES: readonly JobState[] = JOB_STATES.filter(
  (state) => !OPEN_JOB_STATES.includes(state)
)

/** One update or rollback of one device (agent-updates controller.md section 2.4). */
export default class AgentUpdateJob extends BaseModel {
  static table = 'agent_update_jobs'

  @column({ isPrimary: true, consume: (value: unknown) => Number(value) })
  declare id: number

  /** The wire `updateId`. */
  @column()
  declare updateKey: string

  @column()
  declare apId: number | null

  @column()
  declare collectorId: number | null

  /** `ap:4` while open, null once final. */
  @column()
  declare activeKey: string | null

  @column()
  declare deviceName: string

  @column()
  declare product: 'perch-apd' | 'perch-collector'

  @column()
  declare rolloutId: number | null

  @column()
  declare releaseId: number | null

  @column()
  declare source: 'release' | 'previous'

  @column()
  declare fromVersion: string

  @column()
  declare toVersion: string

  @column()
  declare method: 'binary' | 'package'

  @column()
  declare rollbackStore: 'flash' | 'ram' | null

  @column()
  declare state: JobState

  @column()
  declare reason: string | null

  @column()
  declare detail: string | null

  @jsonTextColumn()
  declare preflight: AgentPreflight | null

  @column({ consume: (value: unknown) => (value === null ? null : Number(value)) })
  declare progressBytes: number | null

  @column({ consume: (value: unknown) => (value === null ? null : Number(value)) })
  declare progressTotal: number | null

  @boolColumn()
  declare acceptUnrecoverable: boolean

  @boolColumn()
  declare respectWindow: boolean

  @column()
  declare restageCount: number

  @column()
  declare requestedByUserId: number | null

  @column()
  declare systemActor: string | null

  @utcColumn()
  declare createdAt: DateTime

  @utcColumn()
  declare notBefore: DateTime | null

  @utcColumn()
  declare stagedAt: DateTime | null

  @utcColumn()
  declare installSentAt: DateTime | null

  @utcColumn()
  declare deadlineAt: DateTime | null

  @utcColumn()
  declare reconnectedAt: DateTime | null

  @utcColumn()
  declare confirmedAt: DateTime | null

  @utcColumn()
  declare finishedAt: DateTime | null

  @utcColumn()
  declare updatedAt: DateTime

  @utcColumn()
  declare candidateConnectedAt: DateTime | null

  @column()
  declare pushesSeen: number

  get isOpen(): boolean {
    return OPEN_JOB_STATES.includes(this.state)
  }
}
