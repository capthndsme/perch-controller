import type {
  AlertsSettings,
  ConditionInput,
  DetectorContext,
  EmitInput,
  ParamValue,
  Rule,
} from '#services/alerts/model'
import { resetDeviceLabelCacheForTesting } from '#services/device_labels'
import { resetHostnameEnrichmentCacheForTesting } from '#services/hostname_enrichment'
import { _resetPortsDetectorState } from '#services/alerts/detectors/ports'
import { truncateAllTables } from '#tests/helpers/alerts'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Test side of the alerts detectors (WP-A5a/A5b): a detector context that
 * records what a detector reconciles and emits, keeps its state in memory,
 * and seed helpers whose times are relative to the database clock (the
 * detectors measure ages with `UTC_TIMESTAMP()`). Placeholder MACs and
 * addresses only.
 */

const BASE_RULE: Rule = {
  enabled: true,
  notify: true,
  severity: 'auto',
  holdSeconds: 60,
  recoveryHoldSeconds: 30,
  notifyRecovery: true,
  flapThreshold: 3,
  flapWindowMinutes: 30,
  groupSeconds: 0,
  dedupeMinutes: 60,
  repeatMinutes: 0,
  maxPerHour: 0,
  push: true,
  webhooks: true,
  params: {},
}

export type FakeDetectorContext = DetectorContext & {
  emits: EmitInput[]
  reconciles: Array<{ types: string[]; current: ConditionInput[] }>
  store: Map<string, unknown>
  /** Keys the last reconcile of `type` held. */
  held(type: string): string[]
  /** The last reconcile's condition of `key`. */
  condition(key: string): ConditionInput | undefined
  emitted(type: string): EmitInput[]
  clear(): void
}

export function fakeDetectorContext(
  options: {
    now?: DateTime
    inBootGrace?: boolean
    massOffline?: AlertsSettings['massOffline']
    rules?: Record<string, { enabled?: boolean; params?: Record<string, ParamValue> }>
  } = {}
): FakeDetectorContext {
  const emits: EmitInput[] = []
  const reconciles: Array<{ types: string[]; current: ConditionInput[] }> = []
  const store = new Map<string, unknown>()
  const lastOf = (type: string) =>
    [...reconciles].reverse().find((r) => r.types.includes(type))?.current ?? []
  return {
    now: options.now ?? DateTime.utc(),
    settings: {
      massOffline: options.massOffline ?? { enabled: true, fractionPercent: 75, minAgents: 3 },
    } as AlertsSettings,
    rule(type: string): Rule {
      const override = options.rules?.[type]
      return {
        ...BASE_RULE,
        enabled: override?.enabled ?? true,
        params: override?.params ?? {},
      }
    },
    inBootGrace: options.inBootGrace ?? false,
    state: {
      async get<T>(key: string) {
        return store.has(key) ? (JSON.parse(JSON.stringify(store.get(key))) as T) : null
      },
      async set(key: string, value: unknown) {
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
      async delete(key: string) {
        store.delete(key)
      },
    },
    async reconcile(types: string[], current: ConditionInput[]) {
      reconciles.push({ types, current })
    },
    emit(input: EmitInput) {
      emits.push(input)
    },
    emits,
    reconciles,
    store,
    held: (type) =>
      lastOf(type)
        .filter((c) => c.type === type)
        .map((c) => c.dedupeKey),
    condition: (key) =>
      [...reconciles]
        .reverse()
        .flatMap((r) => r.current)
        .find((c) => c.dedupeKey === key),
    emitted: (type) => emits.filter((e) => e.type === type),
    clear() {
      emits.length = 0
      reconciles.length = 0
    },
  }
}

/**
 * Empties every table and forgets the detectors' in-process state. Uses the
 * alerts helper that skips `migration:run` (`testUtils.db().truncate()` runs
 * it and takes MariaDB's server-wide advisory lock "1", which collides with
 * the other areas' test runs on the same server).
 */
export async function resetDetectorTests() {
  await truncateAllTables()
  _resetPortsDetectorState()
  resetDeviceLabelCacheForTesting()
  resetHostnameEnrichmentCacheForTesting()
}

/** `UTC_TIMESTAMP() - n seconds` for inserts. */
export const ago = (seconds: number) =>
  db.raw('UTC_TIMESTAMP() - INTERVAL ? SECOND', [Math.round(seconds)])

export async function seedCollector(
  fields: {
    name?: string
    lifecycle?: string
    enabled?: boolean
    pollIntervalSeconds?: number
    silentSeconds?: number | null
    transport?: string
  } = {}
): Promise<number> {
  const [id] = await db.table('collectors').insert({
    name: fields.name ?? 'gateway',
    lifecycle: fields.lifecycle ?? 'adopted',
    enabled: fields.enabled ?? true,
    transport: fields.transport ?? 'agent',
    poll_interval_seconds: fields.pollIntervalSeconds ?? 5,
    last_seen_at: fields.silentSeconds === null ? null : ago(fields.silentSeconds ?? 2),
    created_at: ago(86_400),
  })
  return Number(id)
}

export async function seedAp(
  fields: {
    name?: string
    enabled?: boolean
    pollIntervalSeconds?: number
    silentSeconds?: number | null
    macs?: string[]
  } = {}
): Promise<number> {
  const [id] = await db.table('wifi_access_points').insert({
    name: fields.name ?? 'ap',
    enabled: fields.enabled ?? true,
    transport: 'agent',
    poll_interval_seconds: fields.pollIntervalSeconds ?? 5,
    last_seen_at: fields.silentSeconds === null ? null : ago(fields.silentSeconds ?? 2),
    agent_info: JSON.stringify({ macs: fields.macs ?? [] }),
    created_at: ago(86_400),
  })
  return Number(id)
}

export async function seedGateway(collectorId: number | null): Promise<number> {
  const [id] = await db
    .table('gateways')
    .insert({ collector_id: collectorId, created_at: ago(86_400) })
  return Number(id)
}

/** A live alert row (pending or active) as the engine would keep it. */
export async function seedLiveAlert(
  type: string,
  dedupeKey: string,
  state: 'pending' | 'active' = 'active'
): Promise<void> {
  const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
  await db.table('alerts').insert({
    type,
    category: 'agents',
    kind: 'condition',
    state,
    severity: 'warning',
    dedupe_key: dedupeKey,
    active_key: dedupeKey,
    subject_kind: 'controller',
    subject_ref: '',
    first_raised_at: now,
    raised_at: now,
    last_event_at: now,
    bumped_at: now,
    created_at: now,
  })
}
