import Gateway from '#models/gateway'
import QosAssignment from '#models/qos_assignment'
import QosGatewayState from '#models/qos_gateway_state'
import { getQosSettings } from '#services/qos_settings'
import { invalidateQosPlanCache } from '#services/qos_plan_cache'
import { qosDeliveryState, requestQosSync } from '#services/qos_sync'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * Live QoS state from the router (docs/gateway/qos.md section 7; plan 3
 * section 6, WP-D): the `qos` object of `collector.push` (or of a polled
 * summary) and the `qos.event` notifications.
 *
 * - `parseQosReport` is the tolerant, bounded parser (pure).
 * - `recordQosReport` keeps the latest report per collector in memory with
 *   rates from counter deltas (a new `epoch` or a counter going backwards
 *   gives null), asks the sender for a resend on a new epoch or when the
 *   agent's `devicesRevision` falls behind, and persists quota usage every
 *   `quotaPersistSeconds` (at once when a quota runs out).
 * - `handleQosEvent` records `qos.event` (a bounded ring per collector) and
 *   acts on `quota_exhausted`.
 *
 * No history table in v1: everything here is in-process and bounded
 * (`MAX_LIVE_COLLECTORS` entries, each report capped at the protocol's
 * limits), per CLAUDE.md's cache rule. A restart forgets it until the next
 * push (5 s).
 */

// ---------------------------------------------------------------------------
// Report shape (plan 3 section 6, amendment qos-kernel section 6)

export interface QdiscCounters {
  kind: string
  bandwidthKbit: number | null
  bytes: number
  packets: number
  drops: number
  overlimits: number
  backlogBytes: number
  ecnMarks: number | null
  peakDelayUs: number | null
}

export interface QosClassReport {
  /** `1:2a0` (per ifb: `dir` tells download from upload). */
  id: string
  /** `d:<mac>` device leaf, `b:<policyId>` bucket, `r:<policyId>` rest leaf, `n:<network>` network default. */
  key: string
  dir: 'down' | 'up'
  /** As applied now (a schedule may have changed it). */
  rateKbit: number | null
  ceilKbit: number | null
  bytes: number
  packets: number
  drops: number
  overlimits: number
  backlogBytes: number
}

export interface QosDeviceReport {
  mac: string
  /** The MAC's own leaf, null when it sits in a rest leaf or a network default. */
  classId: string | null
  network: string | null
  /** Allocated by the agent from a network default (not an entry of the controller). */
  dynamic: boolean
  /** The agent's word for it (`shaped`, `unshaped`, `blocked`, `throttled`), when sent. */
  state: string | null
}

export interface QosQuotaReport {
  mac: string
  usedBytes: number
  limitBytes: number
  exhausted: boolean
}

export interface QosScheduleReport {
  name: string
  active: boolean
  since: string | null
  until: string | null
}

export interface QosReport {
  epoch: string
  state: 'active' | 'paused' | 'error'
  pausedBy: 'controller' | 'router' | null
  configRevision: number | null
  devicesRevision: number | null
  wan: Array<{
    device: string
    /** The `sqm` section the queue belongs to, when sent. */
    section: string | null
    egress: QdiscCounters | null
    ingress: QdiscCounters | null
  }>
  classes: QosClassReport[]
  devices: QosDeviceReport[]
  quotas: QosQuotaReport[]
  schedules: QosScheduleReport[]
  errors: Array<{ code: string; detail: string | null; mac?: string; device?: string }>
}

export const MAX_REPORT_CLASSES = 4096
export const MAX_REPORT_DEVICES = 8192
const MAX_REPORT_WAN = 16
const MAX_REPORT_SCHEDULES = 256
const MAX_REPORT_ERRORS = 64
export const MAX_LIVE_COLLECTORS = 64
export const MAX_EVENTS = 50
/** Deltas over longer gaps than this are not a "current" rate. */
const MAX_RATE_GAP_MS = 120_000
const MIN_RATE_GAP_MS = 500
/** A revision mismatch triggers at most one resend per this long. */
const RESEND_BACKOFF_MS = 60_000

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/
const CLASS_ID = /^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/
const CLASS_KEY = /^(d:[0-9a-f]{2}(:[0-9a-f]{2}){5}|[br]:\d{1,10}|n:[A-Za-z0-9_]{1,32})$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null
}

function mac(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.trim().toLowerCase().replace(/-/g, ':')
  return MAC.test(cleaned) ? cleaned : null
}

function qdisc(value: unknown): QdiscCounters | null {
  if (!isObject(value)) return null
  return {
    kind: text(value.kind, 32) ?? 'unknown',
    bandwidthKbit: countOrNull(value.bandwidthKbit),
    bytes: count(value.bytes),
    packets: count(value.packets),
    drops: count(value.drops),
    overlimits: count(value.overlimits),
    backlogBytes: count(value.backlogBytes),
    ecnMarks: countOrNull(value.ecnMarks),
    peakDelayUs: countOrNull(value.peakDelayUs),
  }
}

/** A revision as a number; a numeric string (UCI options are strings) counts too. */
function revisionOf(value: unknown): number | null {
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return Number(value)
  return countOrNull(value)
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : []
}

/**
 * The `qos` push section, or null when it is not an object (absent = not
 * reported, never "no shaping"). Malformed items are dropped one by one;
 * lists are capped at the protocol's limits.
 */
export function parseQosReport(raw: unknown): QosReport | null {
  if (!isObject(raw)) return null
  const epoch =
    typeof raw.epoch === 'string' || typeof raw.epoch === 'number'
      ? String(raw.epoch).slice(0, 64)
      : ''
  const state = raw.state === 'paused' || raw.state === 'error' ? raw.state : 'active'
  const pausedBy = raw.pausedBy === 'router' || raw.pausedBy === 'controller' ? raw.pausedBy : null

  const wan: QosReport['wan'] = []
  for (const item of list(raw.wan, MAX_REPORT_WAN)) {
    if (!isObject(item)) continue
    const device = text(item.device, 32)
    if (!device) continue
    wan.push({
      device,
      section: text(item.section, 64),
      egress: qdisc(item.egress),
      ingress: qdisc(item.ingress),
    })
  }

  const classes: QosClassReport[] = []
  for (const item of list(raw.classes, MAX_REPORT_CLASSES)) {
    if (!isObject(item)) continue
    const id = typeof item.id === 'string' ? item.id.toLowerCase() : ''
    const key = typeof item.key === 'string' ? item.key.toLowerCase() : ''
    if (!CLASS_ID.test(id) || !CLASS_KEY.test(key)) continue
    if (item.dir !== 'down' && item.dir !== 'up') continue
    classes.push({
      id,
      key: key.startsWith('n:') ? `n:${String(item.key).slice(2)}` : key,
      dir: item.dir,
      rateKbit: countOrNull(item.rateKbit),
      ceilKbit: countOrNull(item.ceilKbit),
      bytes: count(item.bytes),
      packets: count(item.packets),
      drops: count(item.drops),
      overlimits: count(item.overlimits),
      backlogBytes: count(item.backlogBytes),
    })
  }

  const devices: QosDeviceReport[] = []
  const seen = new Set<string>()
  for (const item of list(raw.devices, MAX_REPORT_DEVICES)) {
    if (!isObject(item)) continue
    const address = mac(item.mac)
    if (!address || seen.has(address)) continue
    seen.add(address)
    const classId = typeof item.classId === 'string' ? item.classId.toLowerCase() : null
    devices.push({
      mac: address,
      classId: classId && CLASS_ID.test(classId) ? classId : null,
      network: text(item.network, 32),
      dynamic: item.dynamic === true,
      state: text(item.state, 16),
    })
  }

  const quotas: QosQuotaReport[] = []
  for (const item of list(raw.quotas, MAX_REPORT_DEVICES)) {
    if (!isObject(item)) continue
    const address = mac(item.mac)
    if (!address) continue
    quotas.push({
      mac: address,
      usedBytes: count(item.usedBytes),
      limitBytes: count(item.limitBytes),
      exhausted: item.exhausted === true,
    })
  }

  const schedules: QosScheduleReport[] = []
  for (const item of list(raw.schedules, MAX_REPORT_SCHEDULES)) {
    if (!isObject(item)) continue
    const name = text(item.name, 64)
    if (!name) continue
    schedules.push({
      name,
      active: item.active === true,
      since: text(item.since, 40),
      until: text(item.until, 40),
    })
  }

  const errors: QosReport['errors'] = []
  for (const item of list(raw.errors, MAX_REPORT_ERRORS)) {
    if (!isObject(item)) continue
    const code = text(item.code, 64)
    if (!code) continue
    const entry: QosReport['errors'][number] = {
      code,
      detail: text(item.detail, 500),
    }
    const address = mac(item.mac)
    if (address) entry.mac = address
    const device = text(item.device, 32)
    if (device) entry.device = device
    errors.push(entry)
  }

  return {
    epoch,
    state,
    pausedBy,
    configRevision: revisionOf(raw.configRevision),
    devicesRevision: revisionOf(raw.devicesRevision),
    wan,
    classes,
    devices,
    quotas,
    schedules,
    errors,
  }
}

// ---------------------------------------------------------------------------
// Rates (pure)

export interface ClassRate {
  /** Measured over the last report interval; null on the first report, a new epoch or a reset. */
  kbit: number | null
  /** Drops / (packets + drops) over the interval, percent. */
  dropPct: number | null
}

export interface QdiscRate {
  kbit: number | null
}

function rateOf(bytes: number, prevBytes: number | undefined, gapMs: number | null): number | null {
  if (prevBytes === undefined || gapMs === null || bytes < prevBytes) return null
  return Math.round(((bytes - prevBytes) * 8) / gapMs)
}

/** `<classId>|<dir>`: class ids repeat on the two ifbs. */
export function classRateKey(id: string, dir: 'down' | 'up'): string {
  return `${id}|${dir}`
}

/**
 * Rates between two consecutive reports of one collector: kbit/s from byte
 * deltas (bytes × 8 / ms = kbit/s), drop share from packet deltas. Null when
 * there is no usable previous report (none, another epoch, a gap outside
 * 0.5 s-120 s) or a counter went backwards.
 */
export function computeRates(
  report: QosReport,
  receivedAt: number,
  previous: { report: QosReport; receivedAt: number } | null
): { classes: Map<string, ClassRate>; wan: Map<string, QdiscRate> } {
  const gap = previous ? receivedAt - previous.receivedAt : null
  const usable =
    previous !== null &&
    previous.report.epoch === report.epoch &&
    gap !== null &&
    gap >= MIN_RATE_GAP_MS &&
    gap <= MAX_RATE_GAP_MS
  const gapMs = usable ? gap : null
  const before = new Map<string, QosClassReport>()
  if (usable) {
    for (const c of previous!.report.classes) before.set(classRateKey(c.id, c.dir), c)
  }
  const classes = new Map<string, ClassRate>()
  for (const c of report.classes) {
    const key = classRateKey(c.id, c.dir)
    const prev = before.get(key)
    const kbit = rateOf(c.bytes, prev?.bytes, gapMs)
    let dropPct: number | null = null
    if (kbit !== null && prev && c.packets >= prev.packets && c.drops >= prev.drops) {
      const packets = c.packets - prev.packets
      const drops = c.drops - prev.drops
      dropPct = packets + drops > 0 ? Math.round((drops / (packets + drops)) * 1000) / 10 : 0
    }
    classes.set(key, { kbit, dropPct })
  }
  const wanBefore = new Map<string, QdiscCounters | null>()
  if (usable) {
    for (const w of previous!.report.wan) {
      wanBefore.set(`${w.device}|egress`, w.egress)
      wanBefore.set(`${w.device}|ingress`, w.ingress)
    }
  }
  const wan = new Map<string, QdiscRate>()
  for (const w of report.wan) {
    for (const side of ['egress', 'ingress'] as const) {
      const now = w[side]
      if (!now) continue
      const key = `${w.device}|${side}`
      wan.set(key, { kbit: rateOf(now.bytes, wanBefore.get(key)?.bytes ?? undefined, gapMs) })
    }
  }
  return { classes, wan }
}

// ---------------------------------------------------------------------------
// Live state

export interface QosEventRecord {
  type: string
  at: string
  receivedAt: string
  mac?: string
  detail?: unknown
}

export interface QosLiveEntry {
  collectorId: number
  gatewayId: number | null
  gatewayCheckedAt: number
  report: QosReport | null
  receivedAt: number | null
  classRates: Map<string, ClassRate>
  wanRates: Map<string, QdiscRate>
  events: QosEventRecord[]
  lastResendAt: number | null
}

const live = new Map<number, QosLiveEntry>()
/** Per gateway: when quota usage was last persisted, and the MACs known exhausted. */
const quotaPersist = new Map<number, { at: number; exhausted: Set<string> }>()

function entryFor(collectorId: number): QosLiveEntry {
  let entry = live.get(collectorId)
  if (entry) {
    // Refresh the LRU position.
    live.delete(collectorId)
  } else {
    entry = {
      collectorId,
      gatewayId: null,
      gatewayCheckedAt: 0,
      report: null,
      receivedAt: null,
      classRates: new Map(),
      wanRates: new Map(),
      events: [],
      lastResendAt: null,
    }
    if (live.size >= MAX_LIVE_COLLECTORS) {
      const oldest = live.keys().next().value
      if (oldest !== undefined) live.delete(oldest)
    }
  }
  live.set(collectorId, entry)
  return entry
}

async function gatewayIdOf(entry: QosLiveEntry, now: number): Promise<number | null> {
  if (entry.gatewayId !== null && now - entry.gatewayCheckedAt < 60_000) return entry.gatewayId
  const gateway = await Gateway.findBy('collectorId', entry.collectorId)
  entry.gatewayId = gateway?.id ?? null
  entry.gatewayCheckedAt = now
  return entry.gatewayId
}

/** The latest live state of a collector, or null when it never reported QoS. */
export function qosLive(collectorId: number | null): QosLiveEntry | null {
  if (collectorId === null) return null
  return live.get(collectorId) ?? null
}

/**
 * Records one `qos` push section. Runs after the gateway sample in
 * `ingestCollectorSnapshot`; the caller treats a throw as non-fatal.
 */
export async function recordQosReport(
  collectorId: number,
  raw: unknown,
  now: DateTime = DateTime.utc()
): Promise<QosReport | null> {
  const report = parseQosReport(raw)
  if (!report) return null
  const at = now.toMillis()
  const entry = entryFor(collectorId)
  const previous =
    entry.report && entry.receivedAt !== null
      ? { report: entry.report, receivedAt: entry.receivedAt }
      : null
  const rates = computeRates(report, at, previous)
  entry.report = report
  entry.receivedAt = at
  entry.classRates = rates.classes
  entry.wanRates = rates.wan

  const gatewayId = await gatewayIdOf(entry, at)
  if (gatewayId === null) return report

  // A new epoch (agent restart, `qos stop` + `apply`) lost the runtime entries.
  if (previous && previous.report.epoch !== report.epoch) {
    logger.info(
      { collectorId, gatewayId, epoch: report.epoch },
      'qos_live: new shaper epoch; resending the device entries'
    )
    entry.lastResendAt = at
    requestQosSync(gatewayId, { forceDevices: true, immediate: true })
  } else {
    const delivery = qosDeliveryState(gatewayId).devices
    const behind =
      delivery.state === 'in_sync' &&
      delivery.revision > 0 &&
      report.devicesRevision !== null &&
      report.devicesRevision < delivery.revision
    const notActive = delivery.error === 'qos_not_active' && report.state === 'active'
    if (
      (behind || notActive) &&
      (entry.lastResendAt === null || at - entry.lastResendAt >= RESEND_BACKOFF_MS)
    ) {
      entry.lastResendAt = at
      requestQosSync(gatewayId, { forceDevices: true, immediate: true })
    }
  }

  if (report.quotas.length > 0) await persistQuotas(collectorId, gatewayId, report.quotas, now)
  return report
}

// ---------------------------------------------------------------------------
// Quotas

export interface QuotaExhaustedEvent {
  collectorId: number
  gatewayId: number
  assignmentId: number
  mac: string
  sourceRef: string | null
  at: string
}

type QuotaListener = (event: QuotaExhaustedEvent) => void

const quotaListeners = new Set<QuotaListener>()

/** Subscribes to quota exhaustion (the portal's `onQuotaExhausted`); returns the unsubscribe. */
export function onQuotaExhausted(listener: QuotaListener): () => void {
  quotaListeners.add(listener)
  return () => {
    quotaListeners.delete(listener)
  }
}

function emitExhausted(event: QuotaExhaustedEvent) {
  for (const listener of quotaListeners) {
    try {
      listener(event)
    } catch (error) {
      logger.error({ err: error, mac: event.mac }, 'qos_live: quota listener failed')
    }
  }
}

/**
 * Takes the router's quota counts over into `qos_assignments` every
 * `quotaPersistSeconds`, at once when a quota newly ran out. A reset the
 * agent has not acknowledged yet (a set sent after `quota_reset_at` not yet
 * accepted) is not overwritten by the old count.
 */
export async function persistQuotas(
  collectorId: number,
  gatewayId: number,
  quotas: QosQuotaReport[],
  now: DateTime = DateTime.utc(),
  options: { force?: boolean } = {}
): Promise<number> {
  const at = now.toMillis()
  let memo = quotaPersist.get(gatewayId)
  if (!memo) {
    memo = { at: 0, exhausted: new Set() }
    quotaPersist.set(gatewayId, memo)
  }
  const { quotaPersistSeconds } = await getQosSettings()
  const newlyExhausted = quotas.some((q) => q.exhausted && !memo!.exhausted.has(q.mac))
  if (!options.force && !newlyExhausted && at - memo.at < quotaPersistSeconds * 1000) return 0

  const byMac = new Map(quotas.map((q) => [q.mac, q]))
  const [rows, state] = await Promise.all([
    QosAssignment.query()
      .where('gatewayId', gatewayId)
      .where('targetType', 'device')
      .whereNotNull('quotaBytes')
      .whereIn('mac', [...byMac.keys()]),
    QosGatewayState.query().where('gatewayId', gatewayId).first(),
  ])
  const ackedAt = state?.devicesAckedAt?.toMillis() ?? null
  let written = 0
  const fired: QuotaExhaustedEvent[] = []
  for (const row of rows) {
    const reported = byMac.get(row.mac!)
    if (!reported) continue
    if (row.quotaResetAt && (ackedAt === null || ackedAt < row.quotaResetAt.toMillis())) continue
    let changed = false
    if (reported.usedBytes !== Number(row.quotaUsedBytes)) {
      row.quotaUsedBytes = reported.usedBytes
      changed = true
    }
    if (reported.exhausted && !row.exhaustedAt) {
      row.exhaustedAt = now
      changed = true
      fired.push({
        collectorId,
        gatewayId,
        assignmentId: row.id,
        mac: row.mac!,
        sourceRef: row.sourceRef,
        at: now.toUTC().toISO()!,
      })
    } else if (
      !reported.exhausted &&
      row.exhaustedAt &&
      reported.usedBytes < Number(row.quotaBytes)
    ) {
      row.exhaustedAt = null
      changed = true
    }
    if (changed) {
      await row.save()
      written++
    }
  }
  if (options.force) {
    for (const q of quotas) if (q.exhausted) memo.exhausted.add(q.mac)
  } else {
    memo.at = at
    memo.exhausted = new Set(quotas.filter((q) => q.exhausted).map((q) => q.mac))
  }
  if (written > 0) invalidateQosPlanCache(gatewayId)
  for (const event of fired) emitExhausted(event)
  return written
}

// ---------------------------------------------------------------------------
// Events (`qos.event` notifications)

export const QOS_EVENT_TYPES = [
  'quota_exhausted',
  'pool_exhausted',
  'apply_failed',
  'local_pause',
  'local_resume',
  'schedule_clock_unsynced',
] as const

/**
 * One `qos.event` (plan 3 section 6): kept in the collector's ring (the last
 * `MAX_EVENTS`), logged, and for `quota_exhausted` the assignment is marked
 * at once (with `detail.usedBytes` when given). Never throws.
 */
export async function handleQosEvent(
  collectorId: number,
  params: unknown,
  now: DateTime = DateTime.utc()
): Promise<QosEventRecord | null> {
  if (!isObject(params) || typeof params.type !== 'string' || params.type.length === 0) {
    logger.debug({ collectorId }, 'qos_live: malformed qos.event dropped')
    return null
  }
  const record: QosEventRecord = {
    type: params.type.slice(0, 64),
    at: text(params.at, 40) ?? now.toUTC().toISO()!,
    receivedAt: now.toUTC().toISO()!,
  }
  const address = mac(params.mac)
  if (address) record.mac = address
  if (params.detail !== undefined) {
    const detail = JSON.stringify(params.detail)
    record.detail = detail !== undefined && detail.length <= 2000 ? params.detail : null
  }
  const entry = entryFor(collectorId)
  entry.events.push(record)
  if (entry.events.length > MAX_EVENTS) entry.events.splice(0, entry.events.length - MAX_EVENTS)

  const known = (QOS_EVENT_TYPES as readonly string[]).includes(record.type)
  const level = record.type === 'apply_failed' || record.type === 'pool_exhausted' ? 'warn' : 'info'
  logger[level](
    { collectorId, type: record.type, mac: record.mac, known },
    'qos_live: shaper event from the router'
  )

  if (record.type === 'quota_exhausted' && address) {
    try {
      const gatewayId = await gatewayIdOf(entry, now.toMillis())
      if (gatewayId !== null) {
        const detail = isObject(params.detail) ? params.detail : {}
        const row = await QosAssignment.query()
          .where('gatewayId', gatewayId)
          .where('targetType', 'device')
          .where('mac', address)
          .whereNotNull('quotaBytes')
          .first()
        if (row) {
          const usedBytes = countOrNull(detail.usedBytes) ?? Number(row.quotaBytes)
          await persistQuotas(
            collectorId,
            gatewayId,
            [{ mac: address, usedBytes, limitBytes: Number(row.quotaBytes), exhausted: true }],
            now,
            { force: true }
          )
        }
      }
    } catch (error) {
      logger.warn({ collectorId, err: error }, 'qos_live: quota_exhausted not recorded')
    }
  }
  return record
}

// ---------------------------------------------------------------------------
// WAN queue counters (`QosWanQueue.live`)

function qdiscStats(
  counters: QdiscCounters | null,
  rate: { kbit: number | null } | undefined
): Record<string, unknown> | null {
  if (!counters) return null
  return {
    kind: counters.kind,
    bandwidthKbit: counters.bandwidthKbit,
    rateKbit: rate?.kbit ?? null,
    bytes: counters.bytes,
    packets: counters.packets,
    drops: counters.drops,
    overlimits: counters.overlimits,
    backlogBytes: counters.backlogBytes,
    ecnMarks: counters.ecnMarks,
    peakDelayUs: counters.peakDelayUs,
  }
}

/** `QosWanQueue.live` from the router's report (null when it did not report the device). */
export function wanQueueLive(entry: QosLiveEntry | null, device: string) {
  const report = entry?.report
  if (!report || !entry.receivedAt) return null
  const wan = report.wan.find((w) => w.device === device)
  if (!wan) return null
  return {
    egress: qdiscStats(wan.egress, entry.wanRates.get(`${device}|egress`)),
    ingress: qdiscStats(wan.ingress, entry.wanRates.get(`${device}|ingress`)),
    reportedAt: new Date(entry.receivedAt).toISOString(),
  }
}

/** Test-only: forget every live report, event and quota memo. */
export function _resetQosLive(): void {
  live.clear()
  quotaPersist.clear()
  quotaListeners.clear()
}
