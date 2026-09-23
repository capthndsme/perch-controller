import type Gateway from '#models/gateway'
import GatewaySection from '#models/gateway_section'
import InfraNode from '#models/infra_node'
import InfraPort from '#models/infra_port'
import QosWanQueue from '#models/qos_wan_queue'
import type { UciConfig, UciOptions } from '#services/gateway_config/types'
import {
  qosRefusal,
  requireManaged,
  resolveGateway,
  type GatewayRef,
  type ResolvedGateway,
} from '#services/qos_gateway'
import { getQosSettings } from '#services/qos_settings'
import { SQM_CONFIG, SQM_QUEUE_TYPE } from '#services/sqm_domain'
import {
  applySqmPatch,
  changedOptions,
  newSqmQueueOptions,
  parseSqmQueue,
  SqmMappingError,
  sqmOptionsEqual,
  sqmQueueSetFlags,
  type NewSqmQueue,
  type SqmPatchResult,
  type SqmQueuePatch,
  type SqmQueueView,
} from '#services/sqm_mapping'
import {
  SqmPlaneError,
  sqmPlaneWriter,
  type SqmPlaneAccepted,
  type SqmQueueChange,
} from '#services/sqm_plane'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * WAN SQM queues (docs/gateway/qos.md sections 2 and 5): reads from
 * `qos_wan_queues`, writes through the config plane (`sqm_plane.ts`), and
 * the router-side import (`recordRouterSqm`) the plane's observe path calls
 * with each read of the router's `sqm` config.
 */

/** Plan 3 section 5 `ApplyState`. */
export type QosApplyStateName =
  | 'in_sync'
  | 'queued'
  | 'applying'
  | 'rolled_back'
  | 'failed'
  | 'offline'
  | 'drift'
  | 'conflict'

export interface QosApplyState {
  revision: number
  state: QosApplyStateName
  at: string | null
  error: string | null
}

/** The row plus what the wire shape needs from outside it. */
export interface WanQueueRecord {
  queue: QosWanQueue
  view: SqmQueueView
  gatewayId: number
  collectorId: number | null
  sync: QosApplyState
}

/**
 * Maps a config-plane section status onto the QoS apply state. No section
 * row: an imported queue is in sync with what the router reported, a
 * controller one is waiting for its first apply.
 */
export function applyStateOf(
  section: Pick<GatewaySection, 'status' | 'updatedAt'> | null,
  queue: Pick<QosWanQueue, 'origin' | 'uciSection' | 'routerUpdatedAt' | 'updatedAt'>,
  online: boolean,
  revision: number
): QosApplyState {
  let state: QosApplyStateName
  let at: DateTime | null
  if (section) {
    switch (section.status) {
      case 'in_sync':
        state = 'in_sync'
        break
      case 'conflict':
        state = 'conflict'
        break
      case 'drift':
        state = 'drift'
        break
      case 'pending':
      case 'reverting':
        state = 'applying'
        break
      default:
        state = 'queued'
    }
    at = section.updatedAt ?? null
  } else if (queue.uciSection !== null) {
    state = 'in_sync'
    at = queue.routerUpdatedAt ?? queue.updatedAt ?? null
  } else {
    state = 'queued'
    at = queue.updatedAt ?? null
  }
  if (state === 'queued' && !online) state = 'offline'
  return { revision, state, at: at ? at.toUTC().toISO() : null, error: null }
}

async function recordsFor(resolved: ResolvedGateway, queues: QosWanQueue[]) {
  const { gateway, online } = resolved
  const sectionNames = queues.map((q) => q.uciSection).filter((s): s is string => s !== null)
  const sections =
    sectionNames.length === 0
      ? []
      : await GatewaySection.query()
          .where('gatewayId', gateway.id)
          .where('config', SQM_CONFIG)
          .whereIn('sectionName', sectionNames)
  const byName = new Map(sections.map((s) => [s.sectionName, s]))
  const setFlags = sqmQueueSetFlags(queues)
  return queues.map((queue, index): WanQueueRecord => {
    const view = parseSqmQueue(queue.options)
    const flags = new Set([...view.flags, ...setFlags[index]])
    if (queue.routerPausedAt) flags.add('router_paused')
    return {
      queue,
      view: { ...view, flags: [...flags].sort() },
      gatewayId: gateway.id,
      collectorId: gateway.collectorId,
      sync: applyStateOf(
        queue.uciSection ? (byName.get(queue.uciSection) ?? null) : null,
        queue,
        online,
        gateway.headRevision
      ),
    }
  })
}

async function queuesOf(gatewayId: number): Promise<QosWanQueue[]> {
  return QosWanQueue.query().where('gatewayId', gatewayId).orderBy('device').orderBy('id')
}

export async function listWanQueues(ref: GatewayRef): Promise<WanQueueRecord[]> {
  const resolved = await resolveGateway(ref)
  return recordsFor(resolved, await queuesOf(resolved.gateway.id))
}

async function recordOf(resolved: ResolvedGateway, queueId: number): Promise<WanQueueRecord> {
  const all = await queuesOf(resolved.gateway.id)
  const records = await recordsFor(resolved, all)
  const record = records.find((r) => r.queue.id === queueId)
  if (!record) throw queueNotFound(queueId)
  return record
}

function queueNotFound(id: number) {
  return qosRefusal(404, 'qos_not_found', `There is no WAN queue ${id}.`, {
    resource: 'wan_queue',
    id,
  })
}

/**
 * Devices a queue may shape: the gateway's WAN interfaces (its last gateway
 * report), the router's Ethernet ports (the infrastructure view) and the
 * devices of the queues it already has (a PPPoE device is only listed while
 * the link is up, and editing its queue must keep working while it is down).
 */
export async function knownWanDevices(resolved: ResolvedGateway): Promise<string[]> {
  const devices = new Set<string>(resolved.collector?.lastStatus?.gateway?.wanInterfaces ?? [])
  if (resolved.collector) {
    const nodes = await InfraNode.query().where('collectorId', resolved.collector.id)
    if (nodes.length > 0) {
      const ports = await InfraPort.query().whereIn(
        'nodeId',
        nodes.map((n) => n.id)
      )
      for (const port of ports) devices.add(port.portKey)
    }
  }
  for (const queue of await queuesOf(resolved.gateway.id)) {
    const device = parseSqmQueue(queue.options).device
    if (device) devices.add(device)
  }
  return [...devices].sort()
}

/**
 * The 7-day p95 of the gateway's summed WAN rate, kbit/s per direction
 * (`router_samples`), or null without samples. Only meaningful on a
 * single-WAN gateway (the samples sum every WAN).
 */
async function observedWanP95(): Promise<{ downKbit: number; upKbit: number } | null> {
  const since = DateTime.utc().minus({ days: 7 }).toFormat('yyyy-MM-dd HH:mm:ss')
  const [rows] = (await db.rawQuery(
    `SELECT
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY wan_rx_bps) OVER () AS rx,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY wan_tx_bps) OVER () AS tx
     FROM router_samples
     WHERE recorded_at >= ? AND wan_rx_bps IS NOT NULL AND wan_tx_bps IS NOT NULL
     LIMIT 1`,
    [since]
  )) as [Array<{ rx: number | string | null; tx: number | string | null }>, unknown]
  const row = rows[0]
  if (!row || row.rx === null || row.tx === null) return null
  return { downKbit: Math.round(Number(row.rx) / 1000), upKbit: Math.round(Number(row.tx) / 1000) }
}

export interface QosWarning {
  code: string
  message: string
  field?: string
  observedKbit?: number
}

/**
 * `qos_rate_far_below_observed`: a shaped rate below half the 7-day p95 of
 * what the WAN actually carried (single-WAN gateways only).
 */
async function rateWarnings(resolved: ResolvedGateway, view: SqmQueueView): Promise<QosWarning[]> {
  const wans = resolved.collector?.lastStatus?.gateway?.wanInterfaces ?? []
  if (wans.length !== 1 || wans[0] !== view.device) return []
  const observed = await observedWanP95()
  if (!observed) return []
  const warnings: QosWarning[] = []
  const check = (field: 'downloadKbit' | 'uploadKbit', rate: number, observedKbit: number) => {
    if (rate > 0 && observedKbit > 0 && rate < observedKbit * 0.5) {
      warnings.push({
        code: 'qos_rate_far_below_observed',
        message: `${field} is below half of what this WAN carried at its busiest (7-day p95).`,
        field,
        observedKbit,
      })
    }
  }
  check('downloadKbit', view.downloadKbit, observed.downKbit)
  check('uploadKbit', view.uploadKbit, observed.upKbit)
  return warnings
}

/** Router writes need sqm-scripts; checked only when the agent listed its packages. */
function requireSqmPackage(gateway: Gateway) {
  const packages = gateway.capabilities?.packages
  if (packages && typeof packages === 'object' && !('sqm-scripts' in packages)) {
    throw qosRefusal(
      409,
      'qos_capability_missing',
      'sqm-scripts is not installed on the gateway.',
      {
        missing: ['sqm-scripts'],
      }
    )
  }
}

async function requireFloor(view: { downloadKbit: number; uploadKbit: number }) {
  const { minWanKbit } = await getQosSettings()
  for (const field of ['downloadKbit', 'uploadKbit'] as const) {
    const rate = view[field]
    if (rate !== 0 && rate < minWanKbit) {
      throw qosRefusal(
        422,
        'qos_rate_below_floor',
        `${field} must be 0 (unshaped) or at least ${minWanKbit} kbit/s.`,
        { field, min: minWanKbit }
      )
    }
  }
}

function mapPatch(run: () => SqmPatchResult): SqmPatchResult {
  try {
    return run()
  } catch (error) {
    if (error instanceof SqmMappingError) {
      throw qosRefusal(422, error.code, error.message, error.field ? { field: error.field } : {})
    }
    throw error
  }
}

function requireNoDuplicate(
  queues: QosWanQueue[],
  options: UciOptions,
  selfId: number | null
): void {
  const view = parseSqmQueue(options)
  if (!view.enabled) return
  const other = queues.find(
    (q) =>
      q.id !== selfId &&
      parseSqmQueue(q.options).enabled &&
      parseSqmQueue(q.options).device === view.device
  )
  if (other) {
    throw qosRefusal(
      409,
      'qos_duplicate_device',
      `Queue ${other.id} already shapes ${view.device}.`,
      { device: view.device, queueId: other.id }
    )
  }
}

async function submit(change: SqmQueueChange, warnings: QosWarning[]): Promise<SqmPlaneAccepted> {
  try {
    return await sqmPlaneWriter().submit(change)
  } catch (error) {
    if (error instanceof SqmPlaneError) {
      throw qosRefusal(error.status === 503 ? 409 : error.status, error.code, error.message, {
        ...error.extra,
        intended: {
          action: change.action,
          queueId: change.queueId,
          uciSection: change.uciSection,
          options: change.options,
          changed: change.changed,
        },
        warnings,
      })
    }
    throw error
  }
}

export interface WanQueueWriteResult {
  record: WanQueueRecord
  warnings: QosWarning[]
}

/** POST /qos/wan-queues. */
export async function createWanQueue(
  ref: GatewayRef,
  input: NewSqmQueue,
  userId: number | null
): Promise<WanQueueWriteResult> {
  const resolved = await resolveGateway(ref)
  requireManaged(resolved.gateway)
  requireSqmPackage(resolved.gateway)
  const known = await knownWanDevices(resolved)
  if (!known.includes(input.device)) {
    throw qosRefusal(
      422,
      'qos_unknown_device',
      `${input.device} is not a WAN interface or port of this gateway.`,
      { device: input.device, known }
    )
  }
  await requireFloor(input)
  const result = mapPatch(() => newSqmQueueOptions(input))
  const queues = await queuesOf(resolved.gateway.id)
  requireNoDuplicate(queues, result.options, null)
  const view = parseSqmQueue(result.options)
  const warnings = [
    ...result.warnings.map((code) => ({ code, message: warningMessage(code) })),
    ...(await rateWarnings(resolved, view)),
  ]

  const accepted = await submit(
    {
      action: 'create',
      gatewayId: resolved.gateway.id,
      queueId: null,
      perchId: null,
      uciSection: null,
      options: result.options,
      changed: result.changed,
      userId,
      requestedAt: DateTime.utc().toISO()!,
    },
    warnings
  )
  const queue = await QosWanQueue.create({
    gatewayId: resolved.gateway.id,
    uciSection: accepted.uciSection,
    perchId: accepted.perchId,
    device: view.device,
    enabled: view.enabled,
    options: result.options,
    origin: 'controller',
  })
  return { record: await recordOf(await resolveGateway(ref), queue.id), warnings }
}

/** PATCH /qos/wan-queues/:id. */
export async function updateWanQueue(
  queueId: number,
  patch: SqmQueuePatch,
  userId: number | null
): Promise<WanQueueWriteResult> {
  const queue = await QosWanQueue.find(queueId)
  if (!queue) throw queueNotFound(queueId)
  const resolved = await resolveGateway({ gatewayId: queue.gatewayId })
  requireManaged(resolved.gateway)
  requireSqmPackage(resolved.gateway)
  if (patch.device !== undefined && patch.device !== parseSqmQueue(queue.options).device) {
    const known = await knownWanDevices(resolved)
    if (!known.includes(patch.device)) {
      throw qosRefusal(
        422,
        'qos_unknown_device',
        `${patch.device} is not a WAN interface or port of this gateway.`,
        { device: patch.device, known }
      )
    }
  }
  const result = mapPatch(() => applySqmPatch(queue.options, patch))
  const view = parseSqmQueue(result.options)
  if (patch.downloadKbit !== undefined || patch.uploadKbit !== undefined) {
    await requireFloor({
      downloadKbit: patch.downloadKbit ?? 0,
      uploadKbit: patch.uploadKbit ?? 0,
    })
  }
  requireNoDuplicate(await queuesOf(resolved.gateway.id), result.options, queue.id)
  const warnings = [
    ...result.warnings.map((code) => ({ code, message: warningMessage(code) })),
    ...(await rateWarnings(resolved, view)),
  ]
  if (result.changed.length === 0 || sqmOptionsEqual(queue.options, result.options)) {
    // Nothing the router would see changes: no plane round trip.
    return { record: await recordOf(resolved, queue.id), warnings }
  }

  const accepted = await submit(
    {
      action: 'update',
      gatewayId: resolved.gateway.id,
      queueId: queue.id,
      perchId: queue.perchId,
      uciSection: queue.uciSection,
      options: result.options,
      changed: result.changed,
      userId,
      requestedAt: DateTime.utc().toISO()!,
    },
    warnings
  )
  queue.merge({
    options: result.options,
    device: view.device,
    enabled: view.enabled,
    perchId: accepted.perchId ?? queue.perchId,
    uciSection: accepted.uciSection ?? queue.uciSection,
  })
  await queue.save()
  return { record: await recordOf(resolved, queue.id), warnings }
}

/** DELETE /qos/wan-queues/:id. */
export async function deleteWanQueue(queueId: number, userId: number | null): Promise<void> {
  const queue = await QosWanQueue.find(queueId)
  if (!queue) throw queueNotFound(queueId)
  const resolved = await resolveGateway({ gatewayId: queue.gatewayId })
  requireManaged(resolved.gateway)
  await submit(
    {
      action: 'delete',
      gatewayId: resolved.gateway.id,
      queueId: queue.id,
      perchId: queue.perchId,
      uciSection: queue.uciSection,
      options: null,
      changed: changedOptions(queue.options, {}),
      userId,
      requestedAt: DateTime.utc().toISO()!,
    },
    []
  )
  await queue.delete()
}

function warningMessage(code: string): string {
  switch (code) {
    case 'sqm_inert_opts_replaced':
      return 'The queue had cake keywords sqm was ignoring; they were replaced by the new settings.'
    default:
      return code
  }
}

export interface RouterSqmImport {
  created: number
  updated: number
  removed: number
  /** Queues the router turned off since the last read (decision 15). */
  paused: number[]
  resumed: number[]
}

/**
 * Records a read of the router's `sqm` config (plan 3 section 2.3, lab test
 * S0): new sections become `origin: 'router'` rows, as they are; changed
 * ones take the router's options; vanished ones are removed. Untagged
 * sections keep a null `perch_id` until the ledger (`perchIds`, section name
 * → id) knows them.
 *
 * A queue the router turned from enabled to disabled gets
 * `router_paused_at` (owner decision 15: a safety pause, never reverted,
 * shown loudly); turning it back on clears it. Controller-created rows that
 * never reached the router (null `uci_section`) are left alone.
 */
export async function recordRouterSqm(
  gatewayId: number,
  config: UciConfig,
  at: DateTime = DateTime.utc(),
  perchIds: Record<string, string> = {}
): Promise<RouterSqmImport> {
  const result: RouterSqmImport = { created: 0, updated: 0, removed: 0, paused: [], resumed: [] }
  const sections = config.sections.filter((s) => s.type === SQM_QUEUE_TYPE)
  await db.transaction(async (trx) => {
    const existing = await QosWanQueue.query({ client: trx })
      .where('gatewayId', gatewayId)
      .whereNotNull('uciSection')
      .forUpdate()
    const byName = new Map(existing.map((q) => [q.uciSection!, q]))
    const seen = new Set<string>()
    for (const section of sections) {
      seen.add(section.name)
      const view = parseSqmQueue(section.options)
      const row = byName.get(section.name)
      if (!row) {
        await QosWanQueue.create(
          {
            gatewayId,
            uciSection: section.name,
            perchId: perchIds[section.name] ?? null,
            device: view.device.slice(0, 15),
            enabled: view.enabled,
            options: section.options,
            origin: 'router',
            routerUpdatedAt: at,
          },
          { client: trx }
        )
        result.created++
        continue
      }
      const before = parseSqmQueue(row.options)
      const textChanged = changedOptions(row.options, section.options).length > 0
      const perchId = perchIds[section.name] ?? row.perchId
      if (!textChanged && perchId === row.perchId) continue
      if (before.enabled && !view.enabled) {
        row.routerPausedAt = at
        result.paused.push(row.id)
      } else if (!before.enabled && view.enabled && row.routerPausedAt) {
        row.routerPausedAt = null
        result.resumed.push(row.id)
      }
      row.merge({
        options: section.options,
        device: view.device.slice(0, 15),
        enabled: view.enabled,
        perchId,
      })
      if (textChanged) row.routerUpdatedAt = at
      row.useTransaction(trx)
      await row.save()
      result.updated++
    }
    for (const row of existing) {
      if (seen.has(row.uciSection!)) continue
      row.useTransaction(trx)
      await row.delete()
      result.removed++
    }
  })
  return result
}
