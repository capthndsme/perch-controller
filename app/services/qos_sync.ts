import Gateway from '#models/gateway'
import QosGatewayState from '#models/qos_gateway_state'
import collectorHub, {
  AgentOfflineError,
  AgentRpcError,
  AgentTimeoutError,
  RPC_ERRORS,
} from '#services/collector_agent_hub'
import { isDuplicateEntryError } from '#services/db_errors'
import { qosPlaneWriter, QosPlaneError } from '#services/qos_plane'
import { planQos, type DeviceEntry } from '#services/qos_plan'
import { invalidateQosPlanCache } from '#services/qos_plan_cache'
import { loadPlanInput } from '#services/qos_reads'
import { getQosSettings } from '#services/qos_settings'
import logger from '@adonisjs/core/services/logger'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * The QoS sender (docs/gateway/qos.md section 6; plan 3 sections 5 and 6):
 * turns a gateway's policies, groups, assignments and schedules into what
 * the router runs, and delivers it.
 *
 * - **Device entries** (runtime state, never config) go straight to the
 *   collector as the `qos.devices.set` RPC, 1 s after the last write, only
 *   when their fingerprint (blind to quota usage) changed since the agent
 *   last accepted a set on the current session. They are sent again on every
 *   (re)connect, when the agent reports a new `epoch`, and from the 30 s sweep
 *   (`qos_expire.task.ts`) while a delivery is not in sync. The revision is
 *   monotonic across restarts (`qos_gateway_states.devices_revision`).
 * - **The `perch-qos` package** (Perch-owned config, one-way) goes to the
 *   config plane through `QosPlaneWriter` (`qos_plane.ts`),
 *   `applyDebounceSeconds` after the last write, when its fingerprint changed
 *   since the plane last accepted it. A refusal (today the stub's
 *   `plane_unavailable`) is kept as the config state and retried by the
 *   sweep at most every 5 minutes, or at once on the next change.
 *
 * One delivery at a time per gateway (a promise chain), in-process like the
 * rest of the agent plumbing (the API is single-instance). The per-gateway
 * state is bounded (`MAX_GATEWAYS`).
 */

export type ApplyStateName =
  | 'in_sync'
  | 'queued'
  | 'applying'
  | 'rolled_back'
  | 'failed'
  | 'offline'
  | 'drift'
  | 'conflict'

/** Plan 3 section 5 `ApplyState`. */
export interface ApplyState {
  revision: number
  state: ApplyStateName
  at: string | null
  error: string | null
}

export interface DevicesDelivery extends ApplyState {
  /** Entries in the last set sent. */
  entries: number
  /** MACs the agent refused in the last accepted set. */
  rejected: Array<{ mac: string; error: string }>
}

/** What `qos.probe` answered on the current session (plan 3 section 6). */
export interface QosProbe {
  sqm: { installed: boolean; version: string | null; luci: boolean; queues: string[] }
  kernel: Record<string, boolean>
  conflicts: string[]
  flowOffload: { software: boolean; hardware: boolean }
  lanDevices: Array<{ network: string; device: string; prefixes: string[] }>
  /** perch-collector's additions: the router's zone (schedules run on it), NTP state, tc flavour. */
  timezone: string | null
  clockSynced: boolean | null
  /** `/etc/config/perch-qos` exists on the router. */
  configured: boolean | null
  tc: string | null
  at: string
}

/** How long the agent may take to apply a device set. */
export const DEVICES_SET_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 10_000
/** A refused config package is offered again at most this often (unless it changes). */
const CONFIG_RETRY_MS = 5 * 60_000
/** Gateways whose state is kept (a controller runs a handful). */
export const MAX_GATEWAYS = 256
/** The agent's error code for "perch-qos is not active" (plan 3 section 6). */
export const QOS_NOT_ACTIVE = -32010

interface GatewaySync {
  gatewayId: number
  timers: { devices: NodeJS.Timeout | null; config: NodeJS.Timeout | null }
  chain: Promise<void>
  forceDevices: boolean
  forceConfig: boolean
  overrideRouterPause: boolean
  userId: number | null
  devices: DevicesDelivery & { fingerprint: string | null; session: string | null }
  config: ApplyState & { attemptedFingerprint: string | null; attemptedAt: number | null }
  probe: QosProbe | null
  probeError: string | null
  touchedAt: number
}

const states = new Map<number, GatewaySync>()
let deviceDebounceMs = 1000
/** Test override of `applyDebounceSeconds` (null = the setting). */
let configDebounceMs: number | null = null

function initial(gatewayId: number): GatewaySync {
  return {
    gatewayId,
    timers: { devices: null, config: null },
    chain: Promise.resolve(),
    forceDevices: false,
    forceConfig: false,
    overrideRouterPause: false,
    userId: null,
    devices: {
      revision: 0,
      state: 'queued',
      at: null,
      error: null,
      entries: 0,
      rejected: [],
      fingerprint: null,
      session: null,
    },
    config: {
      revision: 0,
      state: 'queued',
      at: null,
      error: null,
      attemptedFingerprint: null,
      attemptedAt: null,
    },
    probe: null,
    probeError: null,
    touchedAt: Date.now(),
  }
}

function syncFor(gatewayId: number): GatewaySync {
  let state = states.get(gatewayId)
  if (!state) {
    if (states.size >= MAX_GATEWAYS) evictOne()
    state = initial(gatewayId)
    states.set(gatewayId, state)
  }
  state.touchedAt = Date.now()
  return state
}

function evictOne() {
  let oldest: GatewaySync | null = null
  for (const state of states.values()) {
    if (state.timers.devices || state.timers.config) continue
    if (!oldest || state.touchedAt < oldest.touchedAt) oldest = state
  }
  if (oldest) states.delete(oldest.gatewayId)
}

function enqueue(state: GatewaySync, task: () => Promise<void>) {
  state.chain = state.chain.then(task).catch((error) => {
    logger.error({ gatewayId: state.gatewayId, err: error }, 'qos_sync: delivery failed')
  })
}

/** The per-gateway row (created on first use). */
export async function stateRow(
  gatewayId: number,
  trx?: TransactionClientContract
): Promise<QosGatewayState> {
  const options = trx ? { client: trx } : undefined
  const existing = await QosGatewayState.query(options).where('gatewayId', gatewayId).first()
  if (existing) return existing
  try {
    return await QosGatewayState.create({ gatewayId, devicesRevision: 0 }, options)
  } catch (error) {
    if (!isDuplicateEntryError(error)) throw error
    return QosGatewayState.query(options).where('gatewayId', gatewayId).firstOrFail()
  }
}

export interface SyncRequest {
  /** Send the device entries even when they did not change. */
  forceDevices?: boolean
  /** Submit the package even when it did not change. */
  forceConfig?: boolean
  /** Resume over a router-side pause (POST /qos/resume with overrideRouter). */
  overrideRouterPause?: boolean
  /** Who made the change (passed to the plane). */
  userId?: number | null
  /** Skip the debounce (connect, epoch change). */
  immediate?: boolean
}

/**
 * Plans and delivers a gateway's shaping soon: device entries after the
 * 1 s debounce, the package after `applyDebounceSeconds`. Repeated requests
 * inside the debounce coalesce.
 */
export function requestQosSync(gatewayId: number, request: SyncRequest = {}): void {
  const state = syncFor(gatewayId)
  if (request.forceDevices) state.forceDevices = true
  if (request.forceConfig) state.forceConfig = true
  if (request.overrideRouterPause) {
    state.overrideRouterPause = true
    state.forceConfig = true
  }
  if (request.userId !== undefined) state.userId = request.userId
  schedule(state, 'devices', request.immediate ? 0 : deviceDebounceMs)
  if (configDebounceMs !== null) {
    schedule(state, 'config', request.immediate ? 0 : configDebounceMs)
  } else {
    void getQosSettings()
      .then((settings) =>
        schedule(state, 'config', request.immediate ? 0 : settings.applyDebounceSeconds * 1000)
      )
      .catch((error) =>
        logger.warn({ gatewayId, err: error }, 'qos_sync: settings unreadable; config not queued')
      )
  }
}

function schedule(state: GatewaySync, kind: 'devices' | 'config', delayMs: number) {
  const existing = state.timers[kind]
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    state.timers[kind] = null
    enqueue(state, () =>
      kind === 'devices' ? runDevices(state.gatewayId) : runConfig(state.gatewayId)
    )
  }, delayMs)
  timer.unref()
  state.timers[kind] = timer
}

function sessionKey(collectorId: number): string | null {
  const session = collectorHub.session(collectorId)
  return session ? `${collectorId}:${session.connectedAt.toMillis()}` : null
}

function nowIso() {
  return DateTime.utc().toISO()!
}

function parseRejected(result: unknown): Array<{ mac: string; error: string }> {
  if (!result || typeof result !== 'object') return []
  const rejected = (result as { rejected?: unknown }).rejected
  if (!Array.isArray(rejected)) return []
  return rejected
    .slice(0, 4096)
    .filter(
      (entry): entry is { mac: string; error?: unknown } =>
        Boolean(entry) && typeof entry === 'object' && typeof entry.mac === 'string'
    )
    .map((entry) => ({
      mac: entry.mac.toLowerCase().slice(0, 17),
      error: typeof entry.error === 'string' ? entry.error.slice(0, 200) : 'rejected',
    }))
}

async function runDevices(gatewayId: number): Promise<void> {
  const state = syncFor(gatewayId)
  const gateway = await Gateway.find(gatewayId)
  if (!gateway) {
    states.delete(gatewayId)
    return
  }
  const set = (patch: Partial<GatewaySync['devices']>) => {
    state.devices = { ...state.devices, at: nowIso(), ...patch }
  }
  if (gateway.mode !== 'managed') {
    set({ state: 'queued', error: 'qos_not_managed' })
    return
  }
  const collectorId = gateway.collectorId
  if (collectorId === null || !collectorHub.isOnline(collectorId)) {
    set({ state: 'offline', error: null })
    return
  }
  const session = sessionKey(collectorId)
  // A collector without the shaper (perch-qos not installed) answered
  // "method not found" on this session: it stays so until it reconnects
  // (installing perch-qos restarts it), so the sweep does not ask again.
  if (state.devices.error === 'qos_unsupported' && state.devices.session === session) return
  const plan = planQos(await loadPlanInput(gatewayId))
  const fingerprint = plan.fingerprints.devices
  if (
    !state.forceDevices &&
    state.devices.state === 'in_sync' &&
    state.devices.fingerprint === fingerprint &&
    state.devices.session === session
  ) {
    return
  }
  state.forceDevices = false

  const row = await stateRow(gatewayId)
  const revision = Number(row.devicesRevision ?? 0) + 1
  row.devicesRevision = revision
  await row.save()
  set({ state: 'applying', revision, error: null, entries: plan.devices.length })

  try {
    const result = await collectorHub.request(
      collectorId,
      'qos.devices.set',
      { revision, devices: plan.devices as DeviceEntry[] },
      { timeoutMs: DEVICES_SET_TIMEOUT_MS }
    )
    const rejected = parseRejected(result)
    set({ state: 'in_sync', error: null, rejected, fingerprint, session })
    row.devicesAckedRevision = revision
    row.devicesAckedAt = DateTime.utc()
    await row.save()
    if (rejected.length > 0) {
      logger.warn(
        { gatewayId, revision, rejected: rejected.length },
        'qos_sync: the agent refused some device entries'
      )
    }
  } catch (error) {
    // A later success must not be skipped as "unchanged".
    state.devices.fingerprint = null
    if (error instanceof AgentOfflineError) {
      set({ state: 'offline', error: null })
    } else if (error instanceof AgentTimeoutError) {
      set({ state: 'failed', error: 'timeout' })
    } else if (error instanceof AgentRpcError) {
      const code =
        error.code === QOS_NOT_ACTIVE
          ? 'qos_not_active'
          : error.code === RPC_ERRORS.METHOD_NOT_FOUND
            ? 'qos_unsupported'
            : error.message.slice(0, 200)
      set({
        state: code === 'qos_not_active' ? 'queued' : 'failed',
        error: code,
        ...(code === 'qos_unsupported' ? { session } : {}),
      })
    } else {
      throw error
    }
    logger.debug(
      { gatewayId, revision, error: state.devices.error, state: state.devices.state },
      'qos_sync: device set not delivered'
    )
  }
}

async function runConfig(gatewayId: number): Promise<void> {
  const state = syncFor(gatewayId)
  const gateway = await Gateway.find(gatewayId)
  if (!gateway) {
    states.delete(gatewayId)
    return
  }
  const set = (patch: Partial<GatewaySync['config']>) => {
    state.config = { ...state.config, at: nowIso(), ...patch }
  }
  if (gateway.mode !== 'managed') {
    set({ state: 'queued', error: 'qos_not_managed' })
    return
  }
  const plan = planQos(await loadPlanInput(gatewayId))
  const fingerprint = plan.fingerprints.config
  const row = await stateRow(gatewayId)
  const force = state.forceConfig
  const writer = qosPlaneWriter()
  if (!force && row.configFingerprint === fingerprint) {
    if (state.config.error === 'apply_in_flight' && writer.resume) {
      // The package is in the draft and waited for another apply.
      try {
        const resumed = await writer.resume(gatewayId, state.userId)
        if (resumed) {
          if (resumed.applyId) row.configApplyKey = resumed.applyId
          await row.save()
          set({
            state: resumed.state ?? 'queued',
            revision: resumed.revision,
            error: resumed.error ?? null,
          })
          return
        }
      } catch (error) {
        if (!(error instanceof QosPlaneError)) throw error
        set({ state: 'failed', error: error.code })
        return
      }
    }
    if (state.config.error !== null || state.config.revision === 0) {
      set({ state: 'queued', revision: row.configRevision ?? 0, error: null })
    }
    return
  }
  if (
    !force &&
    state.config.attemptedFingerprint === fingerprint &&
    state.config.error !== null &&
    state.config.error !== 'apply_in_flight' &&
    state.config.attemptedAt !== null &&
    Date.now() - state.config.attemptedAt < CONFIG_RETRY_MS
  ) {
    return
  }
  state.forceConfig = false
  const overrideRouterPause = state.overrideRouterPause
  try {
    const accepted = await writer.submit({
      gatewayId,
      sections: plan.sections,
      fingerprint,
      overrideRouterPause,
      userId: state.userId,
      requestedAt: nowIso(),
    })
    row.configFingerprint = fingerprint
    row.configRevision = accepted.revision
    row.configSubmittedAt = DateTime.utc()
    if (accepted.applyId !== undefined) row.configApplyKey = accepted.applyId
    await row.save()
    state.overrideRouterPause = false
    set({
      state: accepted.state ?? 'queued',
      revision: accepted.revision,
      error: accepted.error ?? null,
      attemptedFingerprint: fingerprint,
      attemptedAt: Date.now(),
    })
  } catch (error) {
    if (!(error instanceof QosPlaneError)) throw error
    set({
      state:
        error.code === 'plane_unavailable' || error.code === 'apply_in_flight'
          ? 'queued'
          : 'failed',
      error: error.code,
      attemptedFingerprint: fingerprint,
      attemptedAt: Date.now(),
    })
    logger.debug({ gatewayId, code: error.code }, 'qos_sync: config package not accepted')
  }
}

/**
 * A collector (re)connected: when it runs a managed gateway, ask it what its
 * shaper can do (`qos.probe`) and send it the device entries at once.
 * Never throws.
 */
export async function onCollectorConnected(collectorId: number): Promise<void> {
  try {
    const gateway = await Gateway.findBy('collectorId', collectorId)
    if (!gateway || gateway.mode !== 'managed') return
    const state = syncFor(gateway.id)
    await runProbe(state, collectorId)
    requestQosSync(gateway.id, { forceDevices: true, immediate: true })
  } catch (error) {
    logger.warn({ collectorId, err: error }, 'qos_sync: connect handling failed')
  }
}

function strings(value: unknown, max = 64): string[] {
  return Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === 'string')
        .slice(0, max)
        .map((v) => v.slice(0, 128))
    : []
}

/** Normalises a `qos.probe` answer (plan 3 section 6); tolerant of missing parts. */
export function parseProbe(result: unknown, at: string = nowIso()): QosProbe | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const raw = result as Record<string, any>
  const sqm = raw.sqm && typeof raw.sqm === 'object' ? raw.sqm : {}
  const kernel: Record<string, boolean> = {}
  if (raw.kernel && typeof raw.kernel === 'object') {
    for (const [key, value] of Object.entries(raw.kernel).slice(0, 32)) {
      if (typeof value === 'boolean') kernel[key.slice(0, 32)] = value
    }
  }
  const offload = raw.flowOffload && typeof raw.flowOffload === 'object' ? raw.flowOffload : {}
  const lanDevices = Array.isArray(raw.lanDevices)
    ? raw.lanDevices
        .slice(0, 64)
        .filter((d: any) => d && typeof d.network === 'string' && typeof d.device === 'string')
        .map((d: any) => ({
          network: String(d.network).slice(0, 32),
          device: String(d.device).slice(0, 32),
          prefixes: strings(d.prefixes, 32),
        }))
    : []
  return {
    sqm: {
      installed: sqm.installed === true,
      version: typeof sqm.version === 'string' ? sqm.version.slice(0, 64) : null,
      luci: sqm.luci === true,
      queues: strings(sqm.queues, 16),
    },
    kernel,
    conflicts: strings(raw.conflicts, 16),
    flowOffload: { software: offload.software === true, hardware: offload.hardware === true },
    lanDevices,
    timezone: typeof raw.tz === 'string' && raw.tz.length > 0 ? raw.tz.slice(0, 64) : null,
    clockSynced: typeof raw.clockSynced === 'boolean' ? raw.clockSynced : null,
    configured: typeof raw.configured === 'boolean' ? raw.configured : null,
    tc: typeof raw.tc === 'string' && raw.tc.length > 0 ? raw.tc.slice(0, 32) : null,
    at,
  }
}

async function runProbe(state: GatewaySync, collectorId: number): Promise<void> {
  try {
    const result = await collectorHub.request(
      collectorId,
      'qos.probe',
      {},
      { timeoutMs: PROBE_TIMEOUT_MS }
    )
    state.probe = parseProbe(result)
    state.probeError = state.probe ? null : 'invalid probe result'
  } catch (error) {
    state.probe = null
    state.probeError =
      error instanceof AgentRpcError && error.code === RPC_ERRORS.METHOD_NOT_FOUND
        ? 'qos_unsupported'
        : error instanceof AgentRpcError && error.code === QOS_NOT_ACTIVE
          ? 'qos_not_active'
          : error instanceof Error
            ? error.message.slice(0, 200)
            : String(error)
  }
}

/**
 * The 30 s sweep (`qos_expire.task.ts`): every managed gateway is re-planned
 * (expired assignments drop out of the entries) and delivered where anything
 * changed or a delivery is not in sync; an online gateway without a probe is
 * probed again.
 */
export async function sweepQosSync(): Promise<number[]> {
  const gateways = await Gateway.query().where('mode', 'managed').select('id', 'collectorId')
  const swept: number[] = []
  for (const gateway of gateways) {
    const state = syncFor(gateway.id)
    if (
      gateway.collectorId !== null &&
      collectorHub.isOnline(gateway.collectorId) &&
      state.probe === null &&
      state.probeError !== 'qos_unsupported'
    ) {
      await runProbe(state, gateway.collectorId)
    }
    // What the sweep submits (an expiry) is Perch's own change, unless an
    // admin's write still waits in the debounce.
    requestQosSync(gateway.id, {
      immediate: true,
      ...(state.timers.config ? {} : { userId: null }),
    })
    swept.push(gateway.id)
  }
  return swept
}

/**
 * A config plane apply carrying the package moved (the plane's apply
 * listener, `qos_plane_writers.ts`): queued → applying → applied / rolled
 * back. The router's report still decides `in_sync` (it runs the package).
 */
export function noteQosConfigApply(
  gatewayId: number,
  apply: { applyKey: string; state: string; outcome: { reason?: string; error?: string } | null }
): void {
  const state = states.get(gatewayId)
  if (!state) return
  const at = nowIso()
  switch (apply.state) {
    case 'queued':
      state.config = { ...state.config, state: 'queued', at }
      break
    case 'sending':
    case 'pending_confirm':
      state.config = { ...state.config, state: 'applying', error: null, at }
      break
    case 'confirmed':
      state.config = { ...state.config, state: 'applying', error: null, at }
      break
    case 'rolled_back':
      state.config = {
        ...state.config,
        state: 'rolled_back',
        error: apply.outcome?.reason ?? 'rolled_back',
        at,
      }
      break
    case 'failed':
    case 'expired':
      state.config = {
        ...state.config,
        state: 'failed',
        error: apply.outcome?.error ?? apply.outcome?.reason ?? apply.state,
        at,
      }
      break
  }
}

/** The package waits for another apply to end (`apply_in_flight`). */
export function qosConfigWaiting(gatewayId: number): boolean {
  return states.get(gatewayId)?.config.error === 'apply_in_flight'
}

/** What the sender knows about a gateway's deliveries (for `GET /qos` and `/qos/devices`). */
export function qosDeliveryState(gatewayId: number): {
  devices: DevicesDelivery
  config: ApplyState
  probe: QosProbe | null
  probeError: string | null
} {
  const state = states.get(gatewayId) ?? initial(gatewayId)
  const d = state.devices
  const c = state.config
  return {
    devices: {
      revision: d.revision,
      state: d.state,
      at: d.at,
      error: d.error,
      entries: d.entries,
      rejected: d.rejected,
    },
    config: { revision: c.revision, state: c.state, at: c.at, error: c.error },
    probe: state.probe,
    probeError: state.probeError,
  }
}

// ---------------------------------------------------------------------------
// Tests

/** Test-only: debounce lengths (null = the `applyDebounceSeconds` setting). */
export function setQosSyncTiming(options: {
  deviceDebounceMs?: number
  configDebounceMs?: number | null
}): void {
  if (options.deviceDebounceMs !== undefined) deviceDebounceMs = options.deviceDebounceMs
  if (options.configDebounceMs !== undefined) configDebounceMs = options.configDebounceMs
}

/** Test-only: runs every pending delivery now and waits until all are done. */
export async function flushQosSync(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    let pending = false
    for (const state of states.values()) {
      for (const kind of ['devices', 'config'] as const) {
        const timer = state.timers[kind]
        if (!timer) continue
        clearTimeout(timer)
        state.timers[kind] = null
        pending = true
        enqueue(state, () =>
          kind === 'devices' ? runDevices(state.gatewayId) : runConfig(state.gatewayId)
        )
      }
    }
    await Promise.all([...states.values()].map((state) => state.chain))
    // requestQosSync reads the settings asynchronously before it schedules.
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (!pending && [...states.values()].every((s) => !s.timers.devices && !s.timers.config)) {
      return
    }
  }
}

/** Test-only: forget every gateway's delivery state and cached plan. */
export function _resetQosSync(): void {
  for (const state of states.values()) {
    if (state.timers.devices) clearTimeout(state.timers.devices)
    if (state.timers.config) clearTimeout(state.timers.config)
  }
  states.clear()
  invalidateQosPlanCache()
}
