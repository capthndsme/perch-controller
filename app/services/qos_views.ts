import Gateway from '#models/gateway'
import type QosAssignment from '#models/qos_assignment'
import QosGatewayState from '#models/qos_gateway_state'
import type QosPolicy from '#models/qos_policy'
import collectorHub from '#services/collector_agent_hub'
import { resolveGateway, type GatewayRef } from '#services/qos_gateway'
import { qosLive, classRateKey, routerPaused, type QosLiveEntry } from '#services/qos_live'
import { bucketSectionName, DEVICE_MINOR_MIN, rateFromColumns } from '#services/qos_plan'
import { cachedShapingContext, type ShapingContext } from '#services/qos_plan_cache'
import { listPolicies, wireRate, type QosRate } from '#services/qos_reads'
import { qosDeliveryState, type ApplyState, type DevicesDelivery } from '#services/qos_sync'
import { listWanQueues } from '#services/qos_wan_queues'
import { planeConfigAccess } from '#services/plane_config_access'
import GatewayApply from '#models/gateway_apply'
import type { DateTime } from 'luxon'

/**
 * The live read side of traffic shaping (docs/gateway/qos.md section 7;
 * plan 3 section 5): `GET /qos` (`QosOverview`), `GET /qos/devices` and
 * `GET /devices/:mac/shaping` (`DeviceShaping`), and the `shaping` field of
 * `/devices` rows. Everything is read per request from the cached plan
 * (`qos_plan_cache.ts`), the sender's delivery state (`qos_sync.ts`) and the
 * latest router report (`qos_live.ts`): no history, no planning per row.
 */

export interface QosQuotaView {
  limitBytes: number
  usedBytes: number
  onExhausted: 'block' | 'throttle'
  throttle: QosRate | null
  exhaustedAt: string | null
  resetAt: string | null
}

export type ShapingState = 'enforced' | 'pending' | 'not_seen' | 'paused' | 'exhausted' | 'failed'

/** Plan 3 section 5 `DeviceShaping` (+ `gatewayId`, `network`, `schedules`, `includeLan`). */
export type DeviceShaping = {
  gatewayId: number
  collectorId: number | null
  mac: string
  via: 'device' | 'group' | 'network'
  assignmentId: number | null
  policy: { id: number; name: string } | null
  /** The per-device cap (null = unlimited that way). */
  cap: QosRate
  bucket: { policyId: number; name: string; rate: QosRate } | null
  quota: QosQuotaView | null
  state: ShapingState
  /** The MAC's own leaf on the router (`1:2a0`), null in a rest leaf or unseen. */
  classId: string | null
  /** Allocated by the router from a network default. */
  dynamic: boolean
  /** The network the router saw it on (from its report). */
  network: string | null
  /** The agent's own word for the MAC (`shaped`, `unshaped`, `blocked`, `throttled`), when reported. */
  routerState: string | null
  /** `perch-qos` schedule sections that can change it, in precedence order. */
  schedules: string[]
  includeLan: boolean
  usage: {
    downloadKbit: number
    uploadKbit: number
    dropPct: { download: number; upload: number }
    source: 'class' | 'capture'
    at: string
  } | null
}

function iso(value: DateTime | null | undefined): string | null {
  return value ? value.toUTC().toISO() : null
}

function quotaView(a: QosAssignment | undefined): QosQuotaView | null {
  if (!a || a.quotaBytes === null) return null
  return {
    limitBytes: Number(a.quotaBytes),
    usedBytes: Number(a.quotaUsedBytes ?? 0),
    onExhausted: a.quotaOnExhausted === 'block' ? 'block' : 'throttle',
    throttle: wireRate(rateFromColumns(a.throttleDownKbit, a.throttleUpKbit)),
    exhaustedAt: iso(a.exhaustedAt),
    resetAt: iso(a.quotaResetAt),
  }
}

function numOrNull(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string' || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

interface GatewayShapingInput {
  gateway: Gateway
  context: ShapingContext
  live: QosLiveEntry | null
  delivery: DevicesDelivery
  controllerPaused: boolean
}

/**
 * Every MAC a gateway shapes: the plan's entries, plus the dynamic ones the
 * router reported from a network default. Pure over its input.
 */
export function buildGatewayShaping(input: GatewayShapingInput): Map<string, DeviceShaping> {
  const { gateway, context, live, delivery } = input
  const { plan } = context
  const policies = new Map(context.policies.map((p) => [p.id, p]))
  const byBucket = new Map<string, QosPolicy>(
    context.policies.map((p) => [bucketSectionName(p.classMinor), p])
  )
  const assignments = new Map(context.assignments.map((a) => [a.id, a]))
  const report = live?.report ?? null
  const reported = new Map((report?.devices ?? []).map((d) => [d.mac, d]))
  const rejected = new Map(delivery.rejected.map((r) => [r.mac, r.error]))
  const at = live?.receivedAt ? new Date(live.receivedAt).toISOString() : null
  const paused = input.controllerPaused || report?.state === 'paused' || routerPaused(report, false)
  const behind =
    delivery.state !== 'in_sync' ||
    (report !== null &&
      report.devicesRevision !== null &&
      delivery.revision > 0 &&
      report.devicesRevision < delivery.revision)

  const bucketOf = (name: string | null) => {
    if (!name) return null
    const policy = byBucket.get(name)
    if (!policy) return null
    return {
      policyId: policy.id,
      name: policy.name,
      rate: wireRate(rateFromColumns(policy.sharedDownKbit, policy.sharedUpKbit)) ?? {
        downloadKbit: null,
        uploadKbit: null,
      },
    }
  }
  // Usage is exact only for the MAC's own leaf (0x200+); a rest leaf is shared.
  const ownLeaf = (classId: string | null) =>
    classId !== null && Number.parseInt(classId.split(':')[1] ?? '0', 16) >= DEVICE_MINOR_MIN
  const usageOf = (classId: string | null): DeviceShaping['usage'] => {
    if (!classId || !ownLeaf(classId) || !live || !at) return null
    const down = live.classRates.get(classRateKey(classId, 'down'))
    const up = live.classRates.get(classRateKey(classId, 'up'))
    if (!down || !up || down.kbit === null || up.kbit === null) return null
    return {
      downloadKbit: down.kbit,
      uploadKbit: up.kbit,
      dropPct: { download: down.dropPct ?? 0, upload: up.dropPct ?? 0 },
      source: 'class',
      at,
    }
  }
  const stateOf = (mac: string, quota: QosQuotaView | null): ShapingState => {
    if (paused) return 'paused'
    if (rejected.has(mac)) return 'failed'
    if (quota?.exhaustedAt) return 'exhausted'
    if (behind || !report) return 'pending'
    return reported.has(mac) ? 'enforced' : 'not_seen'
  }

  const out = new Map<string, DeviceShaping>()
  for (const entry of plan.devices) {
    const origin = plan.origins[entry.mac]
    const assignment = origin ? assignments.get(origin.assignmentId) : undefined
    const policy = origin?.policyId ? policies.get(origin.policyId) : undefined
    const quota = origin?.via === 'device' ? quotaView(assignment) : null
    const seen = reported.get(entry.mac)
    out.set(entry.mac, {
      gatewayId: gateway.id,
      collectorId: gateway.collectorId,
      mac: entry.mac,
      via: origin?.via ?? 'device',
      assignmentId: origin?.assignmentId ?? null,
      policy: policy ? { id: policy.id, name: policy.name } : null,
      cap: { downloadKbit: entry.downKbit, uploadKbit: entry.upKbit },
      bucket: bucketOf(entry.bucket),
      quota,
      state: stateOf(entry.mac, quota),
      classId: seen?.classId ?? null,
      dynamic: false,
      network: seen?.network ?? null,
      routerState: seen?.state ?? null,
      schedules: entry.schedules ?? [],
      includeLan: entry.includeLan === true,
      usage: usageOf(seen?.classId ?? null),
    })
  }

  // Dynamic MACs: shaped by a network default on the router.
  const networks = new Map(
    plan.sections.filter((s) => s.type === 'network').map((s) => [s.name, s])
  )
  for (const seen of report?.devices ?? []) {
    if (out.has(seen.mac) || !seen.network) continue
    const section = networks.get(seen.network)
    const origin = plan.networkOrigins[seen.network]
    if (!section || !origin) continue
    const policy = origin.policyId ? policies.get(origin.policyId) : undefined
    const schedule = section.options.schedule
    out.set(seen.mac, {
      gatewayId: gateway.id,
      collectorId: gateway.collectorId,
      mac: seen.mac,
      via: 'network',
      assignmentId: origin.assignmentId,
      policy: policy ? { id: policy.id, name: policy.name } : null,
      cap: {
        downloadKbit: numOrNull(section.options.each_down_kbit),
        uploadKbit: numOrNull(section.options.each_up_kbit),
      },
      bucket: bucketOf(
        typeof section.options.bucket === 'string' && section.options.bucket !== ''
          ? section.options.bucket
          : null
      ),
      quota: null,
      state: paused ? 'paused' : 'enforced',
      classId: seen.classId,
      dynamic: seen.dynamic,
      network: seen.network,
      routerState: seen.state,
      schedules: Array.isArray(schedule) ? schedule : [],
      includeLan: section.options.include_lan === '1',
      usage: usageOf(seen.classId),
    })
  }
  return out
}

async function shapingInput(gateway: Gateway): Promise<GatewayShapingInput> {
  const [context, state] = await Promise.all([
    cachedShapingContext(gateway.id),
    QosGatewayState.query().where('gatewayId', gateway.id).first(),
  ])
  return {
    gateway,
    context,
    live: qosLive(gateway.collectorId),
    delivery: qosDeliveryState(gateway.id).devices,
    controllerPaused: Boolean(state?.pausedAt),
  }
}

/** GET /qos/devices: every shaped MAC of a gateway, entries first, by MAC. */
export async function listDeviceShaping(ref: GatewayRef): Promise<DeviceShaping[]> {
  const { gateway } = await resolveGateway(ref)
  const shaping = buildGatewayShaping(await shapingInput(gateway))
  return [...shaping.values()].sort(
    (a, b) => Number(a.dynamic) - Number(b.dynamic) || a.mac.localeCompare(b.mac)
  )
}

/**
 * Shaping by MAC over every gateway (the `/devices` rows and
 * `/devices/:mac/shaping`). With no gateway it costs one query. When two
 * gateways shape the same MAC, the one whose collector saw the row wins
 * (`preferCollector`), else the lower gateway id.
 */
export async function shapingByMac(macs: string[] | null): Promise<Map<string, DeviceShaping[]>> {
  const gateways = await Gateway.query().orderBy('id')
  const out = new Map<string, DeviceShaping[]>()
  if (gateways.length === 0) return out
  const wanted = macs ? new Set(macs.map((m) => m.toLowerCase())) : null
  for (const gateway of gateways) {
    const shaping = buildGatewayShaping(await shapingInput(gateway))
    for (const [mac, view] of shaping) {
      if (wanted && !wanted.has(mac)) continue
      const list = out.get(mac) ?? []
      list.push(view)
      out.set(mac, list)
    }
  }
  return out
}

/** Picks the view for a row seen by `collectorId`. */
export function pickShaping(
  views: DeviceShaping[] | undefined,
  collectorId: number | null
): DeviceShaping | null {
  if (!views || views.length === 0) return null
  return views.find((v) => v.collectorId === collectorId) ?? views[0]
}

// ---------------------------------------------------------------------------
// GET /qos

const SHAPER_FEATURES = [
  'htb',
  'fq_codel',
  'cake',
  'ifb',
  'clsact',
  'flower',
  'skbedit',
  'mirred',
  'matchall',
] as const

/**
 * Sums the measured rates of a policy's bucket class (`b:<id>`), per
 * direction. `present`: the router reports the class at all. A direction
 * with a class but no measured rate (first report, a gap over the rate
 * window) is null = unknown, never 0 (a false drop on the chart).
 */
export function bucketLive(live: QosLiveEntry | null, policyId: number) {
  const report = live?.report
  if (!report) return null
  let down: number | null = null
  let up: number | null = null
  let present = false
  for (const c of report.classes) {
    if (c.key !== `b:${policyId}`) continue
    present = true
    const rate = live!.classRates.get(classRateKey(c.id, c.dir))?.kbit ?? null
    if (rate === null) continue
    if (c.dir === 'down') down = (down ?? 0) + rate
    else up = (up ?? 0) + rate
  }
  return { down, up, present }
}

/**
 * A policy's `live` block: the bucket's rates while the router reports its
 * class (unknown directions null), 0 when the report has no such class (the
 * bucket is not built: nothing flows through it), null without a report.
 */
export function policyLive(
  rates: ReturnType<typeof bucketLive>,
  activeMembers: number
): { downloadKbit: number | null; uploadKbit: number | null; activeMembers: number } | null {
  if (rates === null) return null
  if (rates.present) return { downloadKbit: rates.down, uploadKbit: rates.up, activeMembers }
  return { downloadKbit: 0, uploadKbit: 0, activeMembers }
}

/** The package's state from its config plane apply. */
function configStateOfApply(apply: GatewayApply): Pick<ApplyState, 'state' | 'error' | 'at'> {
  const at = (apply.finishedAt ?? apply.sentAt ?? apply.requestedAt)?.toUTC().toISO() ?? null
  switch (apply.state) {
    case 'queued':
      return { state: 'queued', error: null, at }
    case 'sending':
    case 'pending_confirm':
    case 'confirmed':
      // Confirmed: the file is on the router; in sync once its shaper runs it.
      return { state: 'applying', error: null, at }
    case 'rolled_back':
      return { state: 'rolled_back', error: apply.outcome?.reason ?? 'rolled_back', at }
    case 'cancelled':
      return apply.outcome?.reason === 'nothing_to_apply'
        ? { state: 'in_sync', error: null, at }
        : { state: 'failed', error: 'cancelled', at }
    default:
      return {
        state: 'failed',
        error: apply.outcome?.error ?? apply.outcome?.reason ?? apply.state,
        at,
      }
  }
}

export async function qosOverview(ref: GatewayRef) {
  const { gateway, online } = await resolveGateway(ref)
  const input = await shapingInput(gateway)
  const { plan } = input.context
  const live = input.live
  const report = live?.report ?? null
  const delivery = qosDeliveryState(gateway.id)
  const state = await QosGatewayState.query().where('gatewayId', gateway.id).first()
  const shaping = buildGatewayShaping(input)

  const probe = delivery.probe
  const capabilities = probe
    ? {
        sqm: { installed: probe.sqm.installed, version: probe.sqm.version, luci: probe.sqm.luci },
        shaper: {
          available: SHAPER_FEATURES.every((f) => probe.kernel[f] === true),
          missing: SHAPER_FEATURES.filter((f) => probe.kernel[f] !== true),
        },
        conflicts: probe.conflicts,
        flowOffload: probe.flowOffload,
        timezone: probe.timezone,
        clockSynced: probe.clockSynced,
        configured: probe.configured,
        probedAt: probe.at,
      }
    : null

  const paused = state?.pausedAt
    ? { by: 'controller' as const, at: iso(state.pausedAt)! }
    : routerPaused(report, false)
      ? {
          by: 'router' as const,
          at: live!.receivedAt ? new Date(live!.receivedAt).toISOString() : null,
        }
      : null

  // The package follows its config plane apply (queued → applying →
  // applied / rolled back) and is in sync once the router reports the
  // revision the plane wrote (or confirmed it, when the router does not
  // report the shaper).
  const config: ApplyState = { ...delivery.config }
  if (
    state?.configApplyKey &&
    (config.revision === 0 || config.revision === state.configRevision)
  ) {
    const apply = await GatewayApply.query()
      .where('gatewayId', gateway.id)
      .where('applyKey', state.configApplyKey)
      .first()
    if (apply) {
      config.revision = Number(state.configRevision ?? config.revision)
      const fromApply = configStateOfApply(apply)
      if (config.error !== 'apply_in_flight' || fromApply.state !== 'queued') {
        config.state = fromApply.state
        config.error = fromApply.error
        config.at = fromApply.at ?? config.at
      }
      if (apply.state === 'confirmed' && (!report || report.configRevision === null)) {
        config.state = 'in_sync'
      }
    }
  }
  if (
    config.error === null &&
    config.revision > 0 &&
    report?.configRevision !== null &&
    report?.configRevision !== undefined &&
    report.configRevision >= config.revision
  ) {
    config.state = 'in_sync'
  }
  const devices: DevicesDelivery = { ...delivery.devices }
  if (!online && devices.state !== 'queued') devices.state = 'offline'

  const wan = await listWanQueues({ gatewayId: gateway.id })
  const policyViews = await listPolicies({ gatewayId: gateway.id })
  const policies = policyViews.map((policy) => {
    const rates = bucketLive(live, policy.id)
    const members = [...shaping.values()].filter(
      (s) => s.policy?.id === policy.id && s.state === 'enforced'
    ).length
    return { ...policy, live: policyLive(rates, members) }
  })

  const errors: Array<{ code: string; message: string; mac?: string; device?: string }> = []
  for (const e of report?.errors ?? []) {
    errors.push({
      code: e.code,
      message: e.detail ?? e.code,
      ...(e.mac ? { mac: e.mac } : {}),
      ...(e.device ? { device: e.device } : {}),
    })
  }
  if (devices.error) {
    errors.push({ code: devices.error, message: 'The device entries were not delivered.' })
  }
  for (const r of devices.rejected) {
    errors.push({ code: 'qos_entry_rejected', message: r.error, mac: r.mac })
  }
  if (config.error && !['plane_unavailable', 'apply_in_flight'].includes(config.error)) {
    errors.push({
      code: config.error,
      message:
        config.state === 'rolled_back'
          ? 'The perch-qos package was rolled back on the router.'
          : 'The perch-qos package was not accepted.',
    })
  }
  // README 7.7: the router lets the plane write a config only when it is on
  // its allowlist (installed sibling packages join it by themselves).
  const planeAccess = {
    sqm: planeConfigAccess(gateway, 'sqm'),
    perchQos: planeConfigAccess(gateway, 'perch-qos'),
  }
  for (const access of [planeAccess.sqm, planeAccess.perchQos]) {
    if (access.allowed === false && gateway.mode === 'managed') {
      errors.push({ code: 'config_not_allowed', message: access.hint ?? access.config })
    }
  }
  if (delivery.probeError && delivery.probeError !== 'qos_unsupported' && online) {
    errors.push({ code: 'qos_probe_failed', message: delivery.probeError })
  }

  const values = [...shaping.values()]
  return {
    gatewayId: gateway.id,
    collectorId: gateway.collectorId,
    managed: gateway.mode === 'managed',
    /** Whether the router lets Perch write `sqm` / `perch-qos` (README 7.7), with what to do. */
    planeAccess,
    authoritative: Boolean(gateway.authoritative),
    online,
    agentSupportsQos: delivery.probeError === 'qos_unsupported' ? false : probe ? true : null,
    capabilities,
    paused,
    config,
    devices,
    /** WAN queue records: the controller serializes them with `QosWanQueueTransformer` (live filled in). */
    wan,
    policies,
    counts: {
      shapedDevices: values.filter((v) => !v.dynamic).length,
      dynamicDevices: values.filter((v) => v.dynamic).length,
      quotasExhausted: input.context.assignments.filter(
        (a) => a.quotaBytes !== null && a.exhaustedAt !== null
      ).length,
    },
    errors,
    issues: plan.issues,
    schedules: {
      /** Preview in the controller's zone (the router decides on its own clock). */
      activePreview: plan.activeSchedules,
      nextChangeAt: plan.nextChangeAt,
      /** What the router reported (`perch-qos` schedule sections). */
      reported: report?.schedules ?? [],
    },
    events: live?.events.slice().reverse() ?? [],
    report: report
      ? {
          epoch: report.epoch,
          state: report.state,
          configRevision: report.configRevision,
          devicesRevision: report.devicesRevision,
          reportedAt: live!.receivedAt ? new Date(live!.receivedAt).toISOString() : null,
        }
      : null,
  }
}

/** Is the collector's agent connected (for callers that only have the id). */
export function collectorOnline(collectorId: number | null): boolean {
  return collectorId !== null && collectorHub.isOnline(collectorId)
}
