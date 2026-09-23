import ApiClient from '#models/portal_api_client'
import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewaySection from '#models/gateway_section'
import Portal, { type PortalStatus } from '#models/portal'
import type PortalGatewayState from '#models/portal_gateway_state'
import PortalGrant from '#models/portal_grant'
import PortalTemplate from '#models/portal_template'
import PortalTemplateFile from '#models/portal_template_file'
import {
  AgentOfflineError,
  AgentRpcError,
  AgentTimeoutError,
  type AgentHub,
} from '#services/agent_hub'
import collectorHub from '#services/collector_agent_hub'
import {
  type PortalAgentSender,
  type PortalDelivery,
  type PortalPush,
  enqueuePortalPush,
  sendPortalPushes,
  setPortalAgentSender,
} from '#services/portal_agent_sender'
import { grantPushList, num, utc } from '#services/portal_grants'
import { guestRefusal, loginPortalUser, redeemVoucherOnline } from '#services/portal_guest'
import { portalGatewayKeys } from '#services/portal_keys'
import { runInPortalQueue } from '#services/portal_queue'
import { handlePortalRelay } from '#services/portal_relay'
import { getPortalSettings } from '#services/portal_settings'
import { bestEffortShaping, shapingEntries, shapingSourceRef } from '#services/portal_shaping'
import {
  applyPortalDbChanges,
  ensurePortalGatewayState,
  loadServerPortalState,
} from '#services/portal_store'
import { gatewayKeyForWire, signGrant, signGroup } from '#services/portal/crypto'
import { offlineVoucherList, portalDelta, wireGrantOf, wireGroupOf } from '#services/portal/delta'
import {
  type GrantEvent,
  type GrantLifecycle,
  transitionGrant,
} from '#services/portal/grant_lifecycle'
import {
  bindInsertedGrantIds,
  buildAuthorizeParams,
  buildDeauthorizeParams,
  buildVouchersMessages,
} from '#services/portal/messages'
import {
  type RouterEvent,
  type RouterExternal,
  type RouterGrantUsage,
  type RouterPortalReport,
  reconcile,
} from '#services/portal/reconcile'
import { EMPTY_SET_SHA256 } from '#services/portal/templates'
import { isLiveState } from '#services/portal/types'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * The guest portal on the collector socket (docs/gateway/portal.md section
 * 13, WP3): what the controller sends a gateway's router (`portal.configure`,
 * `portal.template`, `portal.authorize`, `portal.deauthorize`,
 * `portal.vouchers`, `portal.sync`) and what it answers (`portal.redeem`,
 * `portal.login`, `portal.relay`; notifications `portal.event`,
 * `portal.sessions`).
 *
 * - **Capability.** A router that lists `portal` in its hello capabilities is
 *   portal-capable; the hello's `portal` object (key epoch, config revision,
 *   enforcement, storage) is stored on `portal_gateway_states`.
 * - **Connect sequence** (design section 4), in the gateway's portal queue:
 *   `portal.configure` (with the gateway key when the router's epoch
 *   differs), `portal.template` for any template it lacks, `portal.sync` →
 *   `reconcile` → `applyPortalDbChanges`, `portal.authorize {full}`,
 *   `portal.vouchers`; the outbox rows it superseded are dropped, the rest
 *   drained. Only then does the gateway count as ready.
 * - **Sender.** `SocketPortalAgentSender` replaces the outbox stub: every
 *   push is written to `portal_outbox` first and, while the gateway is ready,
 *   the outbox is drained at once (read, delete, send, re-enqueue on
 *   failure). `applied` only when the router acknowledged everything.
 * - **Retries.** A failed delivery (timeout, refusal) is re-enqueued and
 *   retried with exponential backoff (2 s … 5 min); an offline gateway waits
 *   for its reconnect. A refusal that means "wrong key" re-sends the key
 *   first.
 * - **Reports.** `portal.event` schedules a sync within a second;
 *   `portal.sessions` one every `usageIntervalSeconds` at most.
 *
 * In-process state (timers, readiness) is bounded by the gateways online.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PORTAL_CAPABILITY = 'portal'
/** portal.sync can be a full grant table; everything else is small. */
const DEFAULT_TIMINGS = {
  syncTimeoutMs: 30_000,
  callTimeoutMs: 15_000,
  retryBaseMs: 2_000,
  retryMaxMs: 5 * 60_000,
  eventSyncDelayMs: 1_000,
  /** A sign-in must start within this (the router gives up after 8 s). */
  signInStartMs: 5_000,
}
let timings = { ...DEFAULT_TIMINGS }

/** Test-only: shorter timeouts and backoff (no argument restores the defaults). */
export function _setPortalAgentTimings(patch: Partial<typeof DEFAULT_TIMINGS> = {}): void {
  timings = { ...DEFAULT_TIMINGS, ...patch }
}
/** Refusals after which the router's key is re-sent before the next try. */
const KEY_ERRORS = new Set(['no_keys', 'key_epoch_mismatch', 'bad_signature'])

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export type PortalHelloCapabilities = {
  version: number | null
  keyEpoch: number | null
  configRevision: number | null
  enforcement: Record<string, unknown> | null
  storage: Record<string, unknown> | null
  port: number | null
  maxPortals: number | null
}

type GatewaySession = {
  gatewayId: number
  collectorId: number
  capable: boolean
  /** The connect sequence completed: pushes are delivered at once. */
  ready: boolean
  /** Bumped per hello: work scheduled for an older session is dropped. */
  generation: number
  syncTimer: NodeJS.Timeout | null
  retryTimer: NodeJS.Timeout | null
  retryAttempt: number
  lastSyncAt: number
}

const sessions = new Map<number, GatewaySession>()
const gatewayOfCollector = new Map<number, number>()
let generations = 0
let hub: AgentHub = collectorHub

function online(s: GatewaySession): boolean {
  return hub.isOnline(s.collectorId) && sessions.get(s.gatewayId) === s
}

function live(gatewayId: number, generation?: number): GatewaySession | null {
  const s = sessions.get(gatewayId)
  if (!s || !s.capable || !online(s)) return null
  if (generation !== undefined && s.generation !== generation) return null
  return s
}

/** Whether the gateway's router takes portal pushes right now. */
export function isPortalGatewayReady(gatewayId: number): boolean {
  return Boolean(live(gatewayId)?.ready)
}

function clearTimers(s: GatewaySession) {
  if (s.syncTimer) clearTimeout(s.syncTimer)
  if (s.retryTimer) clearTimeout(s.retryTimer)
  s.syncTimer = null
  s.retryTimer = null
}

/** Test-only: forget every session and timer. */
export function _resetPortalAgentState(): void {
  for (const s of sessions.values()) clearTimers(s)
  sessions.clear()
  gatewayOfCollector.clear()
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

class NotReadyError extends Error {
  constructor() {
    super('gateway not connected')
  }
}

async function call<T = unknown>(
  gatewayId: number,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = timings.callTimeoutMs
): Promise<T> {
  const s = live(gatewayId)
  if (!s) throw new NotReadyError()
  return hub.request<T>(s.collectorId, method, params, { timeoutMs })
}

function rpcErrorCode(error: unknown): string | null {
  if (!(error instanceof AgentRpcError)) return null
  const data = error.data as { error?: unknown } | null | undefined
  return data && typeof data.error === 'string' ? data.error : null
}

function isOffline(error: unknown): boolean {
  return error instanceof AgentOfflineError || error instanceof NotReadyError
}

function describe(error: unknown): string {
  if (error instanceof AgentRpcError) {
    const code = rpcErrorCode(error)
    return `rpc ${error.code}${code ? ` ${code}` : ''}: ${error.message}`.slice(0, 255)
  }
  if (error instanceof AgentTimeoutError) return `${error.method}: timeout`
  return String(error instanceof Error ? error.message : error).slice(0, 255)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sqlNow = (at: number = Date.now()) => utc(at).toSQL({ includeOffset: false })!

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function nonNeg(value: unknown): number {
  const n = int(value)
  return n !== null && n >= 0 ? n : 0
}

function strOrNull(value: unknown, max = 64): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

async function gatewayState(gatewayId: number): Promise<PortalGatewayState> {
  return ensurePortalGatewayState(gatewayId)
}

async function logEvent(
  gatewayId: number,
  type: string,
  detail: Record<string, unknown>,
  refs: { portalId?: number | null; grantId?: number | null; mac?: string | null } = {}
): Promise<void> {
  await db.table('portal_events').insert({
    gateway_id: gatewayId,
    portal_id: refs.portalId ?? null,
    grant_id: refs.grantId ?? null,
    mac: refs.mac ?? null,
    type,
    detail: JSON.stringify(detail),
    created_at: sqlNow(),
  })
}

// ---------------------------------------------------------------------------
// portal.configure and portal.template
// ---------------------------------------------------------------------------

export type PortalConfigureParams = {
  revision: number
  gatewayId: number
  keys?: { epoch: number; gatewayKey: string }
  settings: Record<string, unknown>
  storage?: { path?: string; flushIntervalSeconds?: number }
  portals: Array<{
    portalId: number
    name: string
    network: string
    enabled: boolean
    methods: { voucher: boolean; password: boolean }
    templateSha256: string
    cspConnectSrc: string[]
    privacyNotice: string
    gatewayName: string
    walledGarden: string[]
    relay: boolean
  }>
}

/** The complete `portal.configure` of a gateway (all its live portals). */
export async function buildConfigureParams(
  gatewayId: number,
  revision: number,
  keys: PortalConfigureParams['keys'] | null
): Promise<{ params: PortalConfigureParams; revisions: Map<number, number>; skipped: number[] }> {
  const gateway = await Gateway.findOrFail(gatewayId)
  const collector = gateway.collectorId ? await Collector.find(gateway.collectorId) : null
  const settings = await getPortalSettings()
  const portals = await Portal.query()
    .where('gateway_id', gatewayId)
    .whereNull('deleted_at')
    .orderBy('id')
  const perchIds = [...new Set(portals.map((p) => p.networkPerchId))]
  const sections = perchIds.length
    ? await GatewaySection.query()
        .where('gateway_id', gatewayId)
        .where('config', 'network')
        .where('section_type', 'interface')
        .whereIn('perch_id', perchIds)
    : []
  const templateIds = [...new Set(portals.map((p) => p.templateId).filter((x) => x !== null))]
  const templates = templateIds.length
    ? await PortalTemplate.query().whereIn('id', templateIds as number[])
    : []
  const clients = await ApiClient.query().whereNull('revoked_at')
  const relayPortals = new Set(clients.flatMap((c) => c.portalIds ?? []))

  const revisions = new Map<number, number>()
  const skipped: number[] = []
  const out: PortalConfigureParams['portals'] = []
  for (const p of portals) {
    const section = sections.find((s) => s.perchId === p.networkPerchId)
    if (!section?.sectionName) {
      // The network's section is not known (yet): the router cannot place it.
      skipped.push(p.id)
      continue
    }
    const template = templates.find((t) => t.id === p.templateId)
    revisions.set(p.id, p.revision)
    out.push({
      portalId: p.id,
      name: p.name,
      network: section.sectionName,
      enabled: true,
      methods: { voucher: Boolean(p.methods?.voucher), password: Boolean(p.methods?.password) },
      templateSha256: template && !template.builtin ? template.sha256 : EMPTY_SET_SHA256,
      cspConnectSrc: p.cspConnectSrc ?? [],
      privacyNotice: p.privacyNotice ?? '',
      gatewayName: collector?.name ?? '',
      walledGarden: [],
      relay: relayPortals.has(p.id),
    })
  }

  const params: PortalConfigureParams = {
    revision,
    gatewayId,
    settings: {
      enforceIntervalSeconds: settings.enforceIntervalSeconds,
      usageIntervalSeconds: settings.usageIntervalSeconds,
      guestFailuresPerDevicePerMinute: settings.guestFailuresPerDevicePerMinute,
      guestFailuresPerDevicePerHour: settings.guestFailuresPerDevicePerHour,
      guestFailuresPerPortalPerMinute: settings.guestFailuresPerPortalPerMinute,
      preauthDnsPerDevicePerMinute: settings.preauthDnsPerDevicePerMinute,
      offlineRedemption: settings.offlineRedemption && settings.offlineVoucherLimit > 0,
    },
    portals: out,
  }
  if (keys) params.keys = keys
  if (gateway.localStatePath || gateway.localStateFlushSeconds) {
    params.storage = {
      ...(gateway.localStatePath ? { path: gateway.localStatePath } : {}),
      ...(gateway.localStateFlushSeconds
        ? { flushIntervalSeconds: gateway.localStateFlushSeconds }
        : {}),
    }
  }
  return { params, revisions, skipped }
}

/** Sends `portal.configure` (and the templates it reports missing). */
async function sendConfigure(gatewayId: number, options: { forceKeys?: boolean } = {}) {
  const state = await gatewayState(gatewayId)
  if (state.routerKeyEpoch !== null && state.routerKeyEpoch > state.keyEpoch) {
    // The router holds a newer epoch than this database (restored backup):
    // never go back to an epoch, move past it.
    state.keyEpoch = state.routerKeyEpoch + 1
  }
  const sendKeys = options.forceKeys || state.routerKeyEpoch !== state.keyEpoch
  const keys = sendKeys ? gatewayKeyForWire(portalGatewayKeys(gatewayId, state.keyEpoch)) : null
  state.configRevision += 1
  await state.save()

  const { params, revisions, skipped } = await buildConfigureParams(
    gatewayId,
    state.configRevision,
    keys
  )
  const raw = obj(await call(gatewayId, 'portal.configure', params))
  const now = Date.now()
  const epoch = int(raw?.keyEpoch)
  state.routerKeyEpoch = epoch ?? (keys ? keys.epoch : state.routerKeyEpoch)
  state.routerConfigRevision = int(raw?.revision) ?? params.revision
  state.configuredAt = DateTime.fromMillis(now, { zone: 'utc' })
  state.routerStatus = {
    enforcement: obj(raw?.enforcement),
    storage: obj(raw?.storage),
    issues: Array.isArray(raw?.issues) ? (raw.issues as unknown[]).map(String).slice(0, 32) : [],
    at: new Date(now).toISOString(),
  }
  await state.save()

  const reported = new Map<number, Record<string, unknown>>()
  for (const item of Array.isArray(raw?.portals) ? (raw.portals as unknown[]) : []) {
    const o = obj(item)
    const id = int(o?.portalId)
    if (o && id !== null) reported.set(id, o)
  }
  for (const [portalId, revision] of revisions) {
    const r = reported.get(portalId)
    const sent = params.portals.find((p) => p.portalId === portalId)!
    const status: PortalStatus = {
      revision,
      templateSha256: sent.templateSha256,
      state: (strOrNull(r?.state, 24) as PortalStatus['state']) ?? 'unknown',
      device: strOrNull(r?.device, 32),
      counting: r?.counting === true,
      issues: Array.isArray(r?.issues) ? (r.issues as unknown[]).map(String).slice(0, 16) : [],
      listen: strOrNull(r?.listen, 64),
      at: new Date(now).toISOString(),
    }
    await db
      .from('portals')
      .where('id', portalId)
      .update({
        status: JSON.stringify(status),
        applied_revision: r ? revision : null,
        updated_at: sqlNow(now),
      })
  }
  for (const portalId of skipped) {
    const status: PortalStatus = {
      revision: 0,
      templateSha256: null,
      state: 'error',
      device: null,
      counting: false,
      issues: ['network_unknown'],
      listen: null,
      at: new Date(now).toISOString(),
    }
    await db
      .from('portals')
      .where('id', portalId)
      .update({ status: JSON.stringify(status) })
  }

  const missing = Array.isArray(raw?.missingTemplates)
    ? (raw.missingTemplates as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  for (const sha of missing) await sendTemplate(gatewayId, sha)
}

/** `portal.template` for a stored template by its set digest. */
async function sendTemplate(gatewayId: number, sha256: string): Promise<boolean> {
  if (sha256 === EMPTY_SET_SHA256) return true
  const template = await PortalTemplate.query().where('sha256', sha256).first()
  if (!template || template.builtin) {
    logger.warn({ gatewayId, sha256 }, 'portal_agent: router asked for an unknown template')
    return false
  }
  const files = await PortalTemplateFile.query().where('template_id', template.id).orderBy('name')
  await call(gatewayId, 'portal.template', {
    sha256: template.sha256,
    files: files.map((f) => ({
      name: f.name,
      contentType: f.contentType,
      dataBase64: Buffer.from(f.content).toString('base64'),
    })),
  })
  return true
}

// ---------------------------------------------------------------------------
// Router answers → grant rows
// ---------------------------------------------------------------------------

type RouterAnswer = { grantId: number; event: (grant: GrantLifecycle) => GrantEvent | null }

/**
 * Applies router acknowledgements (authorize results, removals) to the grant
 * rows through the pure lifecycle, with the session rows they open or close.
 */
async function applyRouterAnswers(gatewayId: number, answers: RouterAnswer[], now: number) {
  if (!answers.length) return
  const rejected: Array<{ grant: PortalGrant; error: string | null }> = []
  await db.transaction(async (trx: TransactionClientContract) => {
    const rows = await PortalGrant.query({ client: trx })
      .whereIn(
        'id',
        answers.map((a) => a.grantId)
      )
      .forUpdate()
    const byId = new Map(rows.map((g) => [num(g.id), g]))
    for (const a of answers) {
      const g = byId.get(a.grantId)
      if (!g) continue
      const before: GrantLifecycle = {
        state: g.state,
        delivery: g.delivery,
        revision: g.revision,
        startedAt: g.startedAt ? g.startedAt.toMillis() : null,
        endedAt: g.endedAt ? g.endedAt.toMillis() : null,
        endReason: g.endReason,
      }
      const event = a.event(before)
      if (!event) continue
      const t = transitionGrant(before, event)
      if (!t.ok || !t.changed) continue
      g.state = t.grant.state
      g.delivery = t.grant.delivery
      g.revision = t.grant.revision
      g.startedAt = t.grant.startedAt === null ? null : utc(t.grant.startedAt)
      g.endedAt = t.grant.endedAt === null ? null : utc(t.grant.endedAt)
      g.endReason = t.grant.endReason
      g.useTransaction(trx)
      await g.save()
      if (t.session === 'open') {
        await trx.table('portal_sessions').insert({
          grant_id: num(g.id),
          portal_id: g.portalId,
          mac: g.mac,
          ip: g.ip,
          started_at: sqlNow(now),
          start_bytes_up: num(g.bytesUp),
          start_bytes_down: num(g.bytesDown),
          bytes_up: 0,
          bytes_down: 0,
        })
      } else if (t.session === 'close') {
        await trx.rawQuery(
          `UPDATE portal_sessions
              SET ended_at = ?, end_reason = ?,
                  bytes_up = GREATEST(0, CAST(? AS SIGNED) - CAST(start_bytes_up AS SIGNED)),
                  bytes_down = GREATEST(0, CAST(? AS SIGNED) - CAST(start_bytes_down AS SIGNED))
            WHERE grant_id = ? AND ended_at IS NULL`,
          [
            sqlNow(now),
            (t.grant.endReason ?? t.grant.state).slice(0, 24),
            num(g.bytesUp),
            num(g.bytesDown),
            num(g.id),
          ]
        )
      }
      if (event.type === 'delivered' && event.result === 'rejected') {
        rejected.push({ grant: g, error: null })
      }
    }
  })
  for (const r of rejected) {
    await logEvent(
      gatewayId,
      'grant_rejected',
      {},
      { portalId: r.grant.portalId, grantId: num(r.grant.id), mac: r.grant.mac }
    )
  }
}

/** Grant answers of a `portal.authorize` result (`results`, and `ended` of a full set). */
async function applyAuthorizeResult(gatewayId: number, raw: unknown, now: number) {
  const result = obj(raw)
  const answers: RouterAnswer[] = []
  for (const item of Array.isArray(result?.results) ? (result.results as unknown[]) : []) {
    const o = obj(item)
    const grantId = int(o?.grantId)
    const revision = int(o?.revision)
    const state = o?.state
    if (grantId === null || revision === null) continue
    const outcome: 'active' | 'pending_device' | 'rejected' =
      state === 'active' ? 'active' : state === 'rejected' ? 'rejected' : 'pending_device'
    answers.push({
      grantId,
      event: () => ({ type: 'delivered', revision, result: outcome, at: now }),
    })
  }
  for (const item of Array.isArray(result?.ended) ? (result.ended as unknown[]) : []) {
    const grantId = int(obj(item)?.grantId)
    if (grantId === null) continue
    answers.push({ grantId, event: (g) => ({ type: 'removed', revision: g.revision }) })
  }
  await applyRouterAnswers(gatewayId, answers, now)
}

// ---------------------------------------------------------------------------
// portal.sync → reconcile
// ---------------------------------------------------------------------------

/** Reads a `portal.sync` result defensively into `RouterPortalReport`. */
export function parseRouterReport(raw: unknown): RouterPortalReport {
  const o = obj(raw) ?? {}
  const events: RouterEvent[] = []
  for (const item of Array.isArray(o.events) ? (o.events as unknown[]) : []) {
    const e = obj(item)
    const seq = int(e?.seq)
    const at = int(e?.at)
    const type = e?.type
    if (!e || seq === null || at === null || typeof type !== 'string') continue
    if (typeof e.mac !== 'string') continue
    events.push({ ...e, seq, at, portalId: int(e.portalId), mac: e.mac } as RouterEvent)
  }
  const grants: RouterGrantUsage[] = []
  for (const item of Array.isArray(o.grants) ? (o.grants as unknown[]) : []) {
    const g = obj(item)
    const portalId = int(g?.portalId)
    if (!g || portalId === null || typeof g.mac !== 'string') continue
    const state = g.state === 'active' || g.state === 'paused' ? g.state : 'pending_device'
    grants.push({
      grantId: int(g.grantId),
      localRef: strOrNull(g.localRef),
      portalId,
      mac: g.mac,
      ip: strOrNull(g.ip, 45),
      bytesUp: nonNeg(g.bytesUp),
      bytesDown: nonNeg(g.bytesDown),
      activeSeconds: nonNeg(g.activeSeconds),
      state,
      lastSeenAt: int(g.lastSeenAt),
      revision: int(g.revision),
    })
  }
  const externals: RouterExternal[] = []
  for (const item of Array.isArray(o.externals) ? (o.externals as unknown[]) : []) {
    const x = obj(item)
    if (!x || typeof x.mac !== 'string') continue
    externals.push({
      portalId: int(x.portalId),
      mac: x.mac,
      ip: strOrNull(x.ip, 45),
      since: int(x.since),
      bytesUp: nonNeg(x.bytesUp),
      bytesDown: nonNeg(x.bytesDown),
    })
  }
  return {
    lastEventSeq: nonNeg(o.lastEventSeq),
    truncated: o.truncated === true,
    events,
    grants,
    externals,
  }
}

/**
 * One full reconciliation (docs/gateway/portal.md section 7): the router's
 * report, `reconcile`, the database, then the full desired set and the
 * offline voucher list. Runs in the gateway's portal queue.
 */
async function fullSync(gatewayId: number): Promise<void> {
  const state = await gatewayState(gatewayId)
  const report = parseRouterReport(
    await call(
      gatewayId,
      'portal.sync',
      { ackedEventSeq: num(state.ackedEventSeq) },
      timings.syncTimeoutMs
    )
  )
  const now = Date.now()
  const server = await loadServerPortalState(gatewayId, { now, report })
  const gateway = await Gateway.find(gatewayId)
  const { dbChanges, desired } = reconcile(server, report, Boolean(gateway?.authoritative))
  const ids = await applyPortalDbChanges(gatewayId, dbChanges, { now })
  await db
    .from('portal_gateway_states')
    .where('gateway_id', gatewayId)
    .update({ last_report_at: sqlNow(now) })

  const bound = bindInsertedGrantIds(desired, ids)
  const keys = portalGatewayKeys(gatewayId, state.keyEpoch)
  const result = await call(gatewayId, 'portal.authorize', buildAuthorizeParams(bound, keys))
  await applyAuthorizeResult(gatewayId, result, now)
  for (const message of buildVouchersMessages(bound, keys)) {
    await call(gatewayId, 'portal.vouchers', message)
  }

  const liveBytes = new Map<string, number>()
  for (const g of report.grants) {
    liveBytes.set(
      shapingSourceRef({ grantId: g.grantId, localRef: g.localRef, portalId: g.portalId }),
      g.bytesUp + g.bytesDown
    )
  }
  const entries = shapingEntries(bound.grants, bound.groups, liveBytes)
  await bestEffortShaping(gatewayId, (shaping) => shaping.sync(gatewayId, entries))
  const s = sessions.get(gatewayId)
  if (s) s.lastSyncAt = Date.now()
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

async function sendAuthorizeDelta(gatewayId: number, grantIds: number[]): Promise<void> {
  const state = await gatewayState(gatewayId)
  const now = Date.now()
  const server = await loadServerPortalState(gatewayId, { now })
  const delta = portalDelta(server, grantIds)
  if (!delta.grants.length) return
  const keys = portalGatewayKeys(gatewayId, state.keyEpoch)
  const params = buildAuthorizeParams(
    {
      gatewayId,
      full: false,
      serverNow: now,
      ackedEventSeq: num(state.ackedEventSeq),
      groups: delta.groups,
      grants: delta.grants,
      revertExternals: [],
    },
    keys
  )
  const result = await call(gatewayId, 'portal.authorize', params)
  await applyAuthorizeResult(gatewayId, result, now)
  const entries = shapingEntries(delta.grants, delta.groups)
  await bestEffortShaping(gatewayId, (shaping) => shaping.apply(gatewayId, entries, []))
}

async function sendDeauthorize(gatewayId: number, grantIds: number[]): Promise<void> {
  if (!grantIds.length) return
  const state = await gatewayState(gatewayId)
  const rows = await PortalGrant.query().whereIn('id', grantIds)
  // A grant live again since the push (re-promoted) must stay on the router.
  const off = rows.filter((g) => !isLiveState(g.state))
  const byReason = new Map<string, PortalGrant[]>()
  for (const g of off) {
    const reason = g.state === 'ended' ? (g.endReason ?? 'revoked') : 'queued'
    const list = byReason.get(reason)
    if (list) list.push(g)
    else byReason.set(reason, [g])
  }
  const keys = portalGatewayKeys(gatewayId, state.keyEpoch)
  for (const [reason, grants] of byReason) {
    const now = Date.now()
    await call(
      gatewayId,
      'portal.deauthorize',
      buildDeauthorizeParams(
        grants.map((g) => num(g.id)),
        reason,
        keys,
        now
      )
    )
    // Ended or queued on the router now: the removal is acknowledged.
    await applyRouterAnswers(
      gatewayId,
      grants.map((g) => ({
        grantId: num(g.id),
        event: (lc) => ({ type: 'removed', revision: lc.revision }),
      })),
      now
    )
  }
  const releases = off.map((g) =>
    shapingSourceRef({ grantId: num(g.id), localRef: g.localRef, portalId: g.portalId })
  )
  if (releases.length) {
    await bestEffortShaping(gatewayId, (shaping) => shaping.apply(gatewayId, [], releases))
  }
}

async function sendVouchers(gatewayId: number): Promise<void> {
  const state = await gatewayState(gatewayId)
  const now = Date.now()
  const server = await loadServerPortalState(gatewayId, { now })
  const keys = portalGatewayKeys(gatewayId, state.keyEpoch)
  const messages = buildVouchersMessages(
    { serverNow: now, offlineVouchers: offlineVoucherList(server) },
    keys
  )
  for (const message of messages) await call(gatewayId, 'portal.vouchers', message)
}

async function sendTemplateOfPortal(gatewayId: number, portalId: number): Promise<void> {
  const portal = await Portal.find(portalId)
  if (portal?.templateId) {
    const template = await PortalTemplate.find(portal.templateId)
    if (template && !template.builtin) await sendTemplate(gatewayId, template.sha256)
  }
  // The portal's templateSha256 changed with it.
  await sendConfigure(gatewayId)
}

// ---------------------------------------------------------------------------
// Outbox drain and retries
// ---------------------------------------------------------------------------

type OutboxRow = {
  id: number | string
  kind: string
  portal_id: number | null
  grant_ids: string | null
  attempts: number
}

function pushOf(row: OutboxRow): PortalPush | null {
  const ids = (() => {
    try {
      const parsed = JSON.parse(row.grant_ids ?? '[]')
      return Array.isArray(parsed) ? parsed.filter((x) => Number.isSafeInteger(x)) : []
    } catch {
      return []
    }
  })()
  switch (row.kind) {
    case 'authorize':
    case 'deauthorize':
      return { kind: row.kind, grantIds: ids }
    case 'configure':
    case 'template':
      return row.portal_id === null ? null : { kind: row.kind, portalId: row.portal_id }
    case 'vouchers':
    case 'sync':
      return { kind: row.kind }
    default:
      return null
  }
}

const KIND_ORDER: Record<PortalPush['kind'], number> = {
  configure: 0,
  template: 1,
  sync: 2,
  deauthorize: 3,
  authorize: 4,
  vouchers: 5,
}

async function deliver(gatewayId: number, push: PortalPush): Promise<void> {
  switch (push.kind) {
    case 'configure':
      return sendConfigure(gatewayId)
    case 'template':
      return sendTemplateOfPortal(gatewayId, push.portalId)
    case 'sync':
      // Settings changes come as `sync`: the router's side of them
      // (intervals, rate limits, offline redemption) is in configure.
      await sendConfigure(gatewayId)
      return fullSync(gatewayId)
    case 'deauthorize':
      return sendDeauthorize(gatewayId, push.grantIds)
    case 'authorize':
      return sendAuthorizeDelta(gatewayId, push.grantIds)
    case 'vouchers':
      return sendVouchers(gatewayId)
  }
}

async function requeue(gatewayId: number, pushes: PortalPush[], error: string, attempts: number) {
  for (const push of pushes) await enqueuePortalPush(gatewayId, push)
  if (!pushes.length) return
  await db
    .from('portal_outbox')
    .where('gateway_id', gatewayId)
    .update({ attempts: attempts + 1, last_error: error.slice(0, 255), updated_at: sqlNow() })
}

async function recordDeliveryFailure(gatewayId: number, error: string) {
  await db
    .from('portal_gateway_states')
    .where('gateway_id', gatewayId)
    .update({
      delivery_failures: db.raw('delivery_failures + 1'),
      delivery_error: error.slice(0, 255),
      delivery_failed_at: sqlNow(),
    })
}

async function clearDeliveryFailure(gatewayId: number) {
  await db
    .from('portal_gateway_states')
    .where('gateway_id', gatewayId)
    .where('delivery_failures', '>', 0)
    .update({ delivery_failures: 0, delivery_error: null })
  const s = sessions.get(gatewayId)
  if (s) s.retryAttempt = 0
}

/** Marks the router's key unknown so the next configure re-sends it. */
async function forgetRouterKey(gatewayId: number) {
  await db
    .from('portal_gateway_states')
    .where('gateway_id', gatewayId)
    .update({ router_key_epoch: null })
}

/**
 * Delivers the gateway's outbox: rows in id order, deleted first, then sent
 * (configure and template first; a pending full sync covers the deltas).
 * On a failure the undelivered pushes go back to the outbox and a retry is
 * scheduled. Resolves true when everything was acknowledged. Runs in the
 * gateway's portal queue.
 */
async function drainOutbox(gatewayId: number): Promise<boolean> {
  const s = live(gatewayId)
  if (!s?.ready) return false
  const rows = (await db
    .from('portal_outbox')
    .where('gateway_id', gatewayId)
    .orderBy('id')
    .select('id', 'kind', 'portal_id', 'grant_ids', 'attempts')) as OutboxRow[]
  if (!rows.length) return true
  await db
    .from('portal_outbox')
    .whereIn(
      'id',
      rows.map((r) => r.id)
    )
    .delete()
  const attempts = Math.max(...rows.map((r) => Number(r.attempts) || 0))
  let pushes = rows.map(pushOf).filter((p): p is PortalPush => p !== null)
  if (pushes.some((p) => p.kind === 'sync')) {
    pushes = pushes.filter(
      (p) => p.kind === 'sync' || p.kind === 'configure' || p.kind === 'template'
    )
  }
  pushes.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])

  const state = await gatewayState(gatewayId)
  const needsKey = state.routerKeyEpoch !== state.keyEpoch
  for (let i = 0; i < pushes.length; i++) {
    try {
      if (i === 0 && needsKey && pushes[0].kind !== 'configure') await sendConfigure(gatewayId)
      await deliver(gatewayId, pushes[i])
    } catch (error) {
      const rest = pushes.slice(i)
      const message = describe(error)
      await requeue(gatewayId, rest, message, attempts)
      if (isOffline(error)) return false
      if (KEY_ERRORS.has(rpcErrorCode(error) ?? '')) await forgetRouterKey(gatewayId)
      await recordDeliveryFailure(gatewayId, message)
      logger.warn({ gatewayId, err: message }, 'portal_agent: delivery failed; will retry')
      scheduleRetry(gatewayId)
      return false
    }
  }
  await clearDeliveryFailure(gatewayId)
  return true
}

function retryDelay(attempt: number): number {
  const base = Math.min(timings.retryMaxMs, timings.retryBaseMs * 2 ** Math.max(0, attempt - 1))
  // ±20 % jitter so gateways that failed together do not retry together.
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

function scheduleRetry(gatewayId: number) {
  const s = live(gatewayId)
  if (!s || s.retryTimer) return
  s.retryAttempt += 1
  const generation = s.generation
  s.retryTimer = setTimeout(() => {
    s.retryTimer = null
    if (!live(gatewayId, generation)) return
    void runInPortalQueue(gatewayId, async () => {
      if (s.ready) await drainOutbox(gatewayId)
      else await connectSequence(gatewayId, generation)
    }).catch((error) => logger.error({ gatewayId, err: error }, 'portal_agent: retry failed'))
  }, retryDelay(s.retryAttempt))
  s.retryTimer.unref()
}

/** A full sync soon (debounced per gateway), when the gateway is ready. */
export function schedulePortalSync(gatewayId: number, delayMs = timings.eventSyncDelayMs): void {
  const s = live(gatewayId)
  if (!s?.ready || s.syncTimer) return
  const generation = s.generation
  s.syncTimer = setTimeout(() => {
    s.syncTimer = null
    if (!live(gatewayId, generation)?.ready) return
    void runInPortalQueue(gatewayId, async () => {
      try {
        await fullSync(gatewayId)
      } catch (error) {
        if (isOffline(error)) return
        const message = describe(error)
        if (KEY_ERRORS.has(rpcErrorCode(error) ?? '')) await forgetRouterKey(gatewayId)
        await enqueuePortalPush(gatewayId, { kind: 'sync' })
        await recordDeliveryFailure(gatewayId, message)
        scheduleRetry(gatewayId)
      }
    }).catch((error) => logger.error({ gatewayId, err: error }, 'portal_agent: sync failed'))
  }, delayMs)
  s.syncTimer.unref()
}

// ---------------------------------------------------------------------------
// Connect sequence
// ---------------------------------------------------------------------------

/**
 * Design section 4, after hello + `agent.configure`: configure → templates
 * → sync → reconcile → full authorize → vouchers, then the outbox. Runs in
 * the gateway's portal queue.
 */
async function connectSequence(gatewayId: number, generation: number): Promise<void> {
  const s = live(gatewayId, generation)
  if (!s || s.ready) return
  const state = await gatewayState(gatewayId)
  const portals = await db.from('portals').where('gateway_id', gatewayId).count('* as n')
  const hasPortals = Number((portals[0] as { n: number | string }).n) > 0
  const routerHasConfig =
    state.capabilities?.configRevision !== null && state.capabilities?.configRevision !== undefined
  if (!hasPortals && !routerHasConfig) {
    // Nothing to set up: the first portal's configure push does it.
    s.ready = true
    await drainOutbox(gatewayId)
    return
  }
  const [maxRow] = await db.from('portal_outbox').where('gateway_id', gatewayId).max('id as maxId')
  const superseded = Number((maxRow as { maxId: unknown })?.maxId ?? 0)
  try {
    await sendConfigure(gatewayId)
    await fullSync(gatewayId)
  } catch (error) {
    if (isOffline(error)) return
    const message = describe(error)
    if (KEY_ERRORS.has(rpcErrorCode(error) ?? '')) await forgetRouterKey(gatewayId)
    await recordDeliveryFailure(gatewayId, message)
    logger.warn({ gatewayId, err: message }, 'portal_agent: connect sequence failed; will retry')
    scheduleRetry(gatewayId)
    return
  }
  // Everything queued before the sequence is covered by it.
  if (superseded > 0) {
    await db
      .from('portal_outbox')
      .where('gateway_id', gatewayId)
      .where('id', '<=', superseded)
      .delete()
  }
  s.ready = true
  await clearDeliveryFailure(gatewayId)
  await drainOutbox(gatewayId)
}

// ---------------------------------------------------------------------------
// Hello / close
// ---------------------------------------------------------------------------

export function parsePortalHello(value: unknown): PortalHelloCapabilities {
  const o = obj(value) ?? {}
  return {
    version: int(o.version),
    keyEpoch: int(o.keyEpoch),
    configRevision: int(o.configRevision),
    enforcement: obj(o.enforcement),
    storage: obj(o.storage),
    port: int(o.port),
    maxPortals: int(o.maxPortals),
  }
}

/**
 * The collector's hello was accepted and its session registered (call after
 * `agent.configure`). `capabilities` is the hello's list; `portal` its
 * `portal` object. Starts the connect sequence for a portal-capable gateway.
 */
export async function onPortalHello(
  collectorId: number,
  hello: { capabilities?: unknown; portal?: unknown }
): Promise<void> {
  const gateway = await Gateway.findBy('collectorId', collectorId)
  if (!gateway) return
  const capable =
    Array.isArray(hello.capabilities) && hello.capabilities.includes(PORTAL_CAPABILITY)
  const caps = capable ? parsePortalHello(hello.portal) : null

  const state = await gatewayState(gateway.id)
  state.capabilities = caps
  state.capabilitiesAt = DateTime.utc()
  if (caps) state.routerKeyEpoch = caps.keyEpoch
  await state.save()

  const previous = sessions.get(gateway.id)
  if (previous) clearTimers(previous)
  const session: GatewaySession = {
    gatewayId: gateway.id,
    collectorId,
    capable,
    ready: false,
    generation: ++generations,
    syncTimer: null,
    retryTimer: null,
    retryAttempt: 0,
    lastSyncAt: 0,
  }
  sessions.set(gateway.id, session)
  gatewayOfCollector.set(collectorId, gateway.id)
  if (!capable) return
  await runInPortalQueue(gateway.id, () => connectSequence(gateway.id, session.generation))
}

/** The collector's socket closed (it was the current session). */
export function onPortalSessionClosed(collectorId: number): void {
  const gatewayId = gatewayOfCollector.get(collectorId)
  if (gatewayId === undefined) return
  gatewayOfCollector.delete(collectorId)
  const s = sessions.get(gatewayId)
  if (!s || s.collectorId !== collectorId) return
  clearTimers(s)
  sessions.delete(gatewayId)
}

async function gatewayOf(collectorId: number): Promise<number | null> {
  const known = gatewayOfCollector.get(collectorId)
  if (known !== undefined) return known
  const gateway = await Gateway.findBy('collectorId', collectorId)
  return gateway?.id ?? null
}

// ---------------------------------------------------------------------------
// Requests from the router
// ---------------------------------------------------------------------------

type SignedReply = {
  grant: Record<string, unknown> | null
  group: Record<string, unknown> | null
  queued: boolean
}

async function grantReply(gatewayId: number, grantId: number | null, queued: boolean) {
  if (grantId === null) return { grant: null, group: null, queued } satisfies SignedReply
  const state = await gatewayState(gatewayId)
  const now = Date.now()
  const server = await loadServerPortalState(gatewayId, { now })
  const g = server.grants.find((x) => x.id === grantId)
  const group = g ? wireGroupOf(server, g.groupKey) : null
  if (!g || !group) return { grant: null, group: null, queued } satisfies SignedReply
  const keys = portalGatewayKeys(gatewayId, state.keyEpoch)
  const wire = wireGrantOf(g)
  return {
    grant: { ...wire, sig: signGrant(keys, wire) },
    group: { ...group, sig: signGroup(keys, group) },
    queued,
  } satisfies SignedReply
}

async function guestSignIn(
  collectorId: number,
  run: (gatewayId: number) => ReturnType<typeof redeemVoucherOnline>
): Promise<SignedReply> {
  const gatewayId = await gatewayOf(collectorId)
  if (gatewayId === null) throw guestRefusal('wrong_portal')
  // The router waits 8 s for the answer, then redeems offline from its own
  // list. A sign-in stuck behind a long sync must not run after that (the
  // same code would be spent twice): it is given up, unstarted, and the
  // router told the controller cannot answer (no offline fallback then).
  let started = false
  let abandoned = false
  const work = runInPortalQueue(gatewayId, async () => {
    if (abandoned) return null
    started = true
    const out = await run(gatewayId)
    return { reply: await grantReply(gatewayId, out.grantId, out.queued), pushes: out.pushes }
  })
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), timings.signInStartMs)
  })
  const first = await Promise.race([work.then(() => 'done' as const), deadline])
  if (first === 'late' && !started) {
    abandoned = true
    clearTimeout(timer)
    void work.catch(() => {})
    throw guestRefusal('controller_unreachable')
  }
  clearTimeout(timer)
  const done = await work
  if (!done) throw guestRefusal('controller_unreachable')
  const { reply, pushes } = done
  const list = grantPushList(pushes)
  if (list.length) {
    // After the answer: the router applies the new grant first.
    setImmediate(() => {
      void runInPortalQueue(gatewayId, () => sendPortalPushes(gatewayId, list)).catch((error) =>
        logger.error({ gatewayId, err: error }, 'portal_agent: sign-in pushes failed')
      )
    })
  }
  return reply
}

async function onSessions(collectorId: number, params: unknown) {
  const gatewayId = await gatewayOf(collectorId)
  if (gatewayId === null) return
  await db
    .from('portal_gateway_states')
    .where('gateway_id', gatewayId)
    .update({ last_report_at: sqlNow() })
  const s = live(gatewayId)
  if (!s?.ready) return
  const settings = await getPortalSettings()
  const clients = obj(params)?.clients
  if (!Array.isArray(clients) || clients.length === 0) return
  if (Date.now() - s.lastSyncAt >= settings.usageIntervalSeconds * 1000) {
    schedulePortalSync(gatewayId, 0)
  }
}

/**
 * Wires the portal's methods into the collector hub and installs the socket
 * sender. Called once from the collector endpoint's `attach()`.
 */
export function attachPortalAgent(target: AgentHub = collectorHub): void {
  hub = target
  target.onRequest('portal.redeem', (collectorId, params) =>
    guestSignIn(collectorId, (gatewayId) => redeemVoucherOnline(gatewayId, params))
  )
  target.onRequest('portal.login', (collectorId, params) =>
    guestSignIn(collectorId, (gatewayId) => loginPortalUser(gatewayId, params))
  )
  target.onRequest('portal.relay', async (collectorId, params) => {
    const gatewayId = await gatewayOf(collectorId)
    if (gatewayId === null) {
      return { status: 404, body: { error: 'portal_not_found', message: 'No portal here.' } }
    }
    return handlePortalRelay(gatewayId, params)
  })
  target.onNotification('portal.event', async (collectorId) => {
    const gatewayId = await gatewayOf(collectorId)
    if (gatewayId !== null) schedulePortalSync(gatewayId)
  })
  target.onNotification('portal.sessions', onSessions)
  setPortalAgentSender(new SocketPortalAgentSender())
}

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

/**
 * `PortalAgentSender` over the socket (docs/gateway/portal.md 11.2): every
 * push goes through `portal_outbox`; while the gateway is ready the outbox is
 * drained at once. Called inside the gateway's portal queue.
 */
export class SocketPortalAgentSender implements PortalAgentSender {
  async send(gatewayId: number, push: PortalPush): Promise<PortalDelivery> {
    if ('grantIds' in push && push.grantIds.length === 0) return 'applied'
    await enqueuePortalPush(gatewayId, push)
    if (!isPortalGatewayReady(gatewayId)) return 'pending'
    return (await drainOutbox(gatewayId)) ? 'applied' : 'pending'
  }
}

// ---------------------------------------------------------------------------
// Key rotation
// ---------------------------------------------------------------------------

/**
 * Rotates the gateway key (docs/gateway/portal.md 6.1): a new epoch, so new
 * voucher verifiers and signatures. The router gets the key with the next
 * `portal.configure`, then a full sync re-sends every grant and voucher under
 * it. Offline, it happens on reconnect (the router's epoch differs).
 */
export async function rotatePortalGatewayKey(
  gatewayId: number,
  byUserId: number | null
): Promise<{ keyEpoch: number; delivery: PortalDelivery }> {
  return runInPortalQueue(gatewayId, async () => {
    const state = await gatewayState(gatewayId)
    const previous = state.keyEpoch
    state.keyEpoch = Math.max(state.keyEpoch, state.routerKeyEpoch ?? 0) + 1
    await state.save()
    await logEvent(gatewayId, 'key_rotated', { from: previous, to: state.keyEpoch, byUserId })
    // configure carries the key (epochs differ); sync re-signs the rest.
    await enqueuePortalPush(gatewayId, { kind: 'sync' })
    const portals = await Portal.query().where('gateway_id', gatewayId).whereNull('deleted_at')
    if (portals.length) {
      await enqueuePortalPush(gatewayId, { kind: 'configure', portalId: portals[0].id })
    }
    const delivered = isPortalGatewayReady(gatewayId) ? await drainOutbox(gatewayId) : false
    return { keyEpoch: state.keyEpoch, delivery: delivered ? 'applied' : 'pending' }
  })
}
