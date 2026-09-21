import Collector, { type CollectorStatus } from '#models/collector'
import {
  closeSessionOnKeyMismatch,
  presentedSessionKey,
  probeCollectorAgent,
  sendCollectorConfigure,
  syncCollectorProtocols,
} from '#services/collector_agent'
import collectorHub, { CLOSE_CODES } from '#services/collector_agent_hub'
import { apiKeyFingerprint } from '#services/collector_announce'
import { probeCollector } from '#services/collector_probe'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Business logic behind `/api/v1/settings/collectors`, mirroring
 * `app/services/wifi_source_registry.ts`: list / create / update / probe /
 * delete, each persisting the probe outcome, so the controller stays thin.
 *
 * Adoption and dismissal live here too — they are lifecycle transitions on
 * the same rows, not a separate concern.
 */

export type CollectorInput = {
  name: string
  baseUrl: string
  apiKey?: string | null
  pollIntervalSeconds?: number
  enabled?: boolean
}

export type CollectorUpdateInput = Partial<CollectorInput>

export type CollectorAdoptInput = {
  name?: string
  apiKey?: string | null
  pollIntervalSeconds?: number
  enabled?: boolean
  acceptKeyChange?: boolean
}

/**
 * Emitted when an update points an `announced` row somewhere else: the row
 * becomes `manual`, so later announces refresh its metadata but never move it
 * again. This is how a collector behind a NAT gateway (whose announces arrive
 * from the gateway's WAN address) gets a pollable address.
 */
export const ANNOUNCED_ADDRESS_WARNING = 'announced_address_taken_over'

export type CollectorUpdateResult = {
  collector: Collector
  probe: CollectorStatus | null
  warnings: string[]
}

export type CollectorAdoptResult =
  | { status: 'adopted'; collector: Collector; probe: CollectorStatus }
  | { status: 'key_mismatch' }

/** Default poll interval for a hand-registered collector (`setup_controller`). */
const DEFAULT_POLL_INTERVAL_SECONDS = 5

/**
 * What "this collector has recorded data" means.
 *
 * `device_traffic_buckets` is the densest of the fourteen cascading
 * children, but it is NOT sufficient on its own: the poller's first tick
 * only baselines counters (no bucket is written until the second tick) while
 * it already upserts identities, so a collector polled once has identities,
 * peers and no buckets at all. Deleting it would cascade those away in
 * silence. `device_identities` is the earliest thing written and is indexed
 * by `collector_id` (device_identities_unique_idx), so counting both is
 * cheap and closes that window.
 */
const HISTORY_TABLE = 'device_traffic_buckets'
const IDENTITY_TABLE = 'device_identities'

export type CollectorDataCounts = {
  /** Native traffic buckets. The documented `bucketRows` in the 409 body. */
  bucketRows: number
  /** Device identities, which exist from the very first poll. */
  identityRows: number
  /** True when either is non-zero. */
  hasData: boolean
}

/**
 * Trailing slashes are stripped before anything is stored or compared:
 * `http://x:9800` and `http://x:9800/` are one daemon, and two rows pointing
 * at one daemon would double-write every bucket under two `collector_id`s.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * Settings list. `dismissed` rows are hidden unless asked for; DISABLED rows
 * are always listed, because Settings is where you go to re-enable them.
 * Pending rows sort first — they are the ones waiting on a decision.
 */
export function listCollectors(options: { includeDismissed?: boolean } = {}) {
  const query = Collector.query()
    .orderByRaw(`CASE WHEN lifecycle = 'pending' THEN 0 ELSE 1 END ASC`)
    .orderBy('name', 'asc')
  if (!options.includeDismissed) {
    query.whereNot('lifecycle', 'dismissed')
  }
  return query
}

/**
 * What a non-admin may see (`GET /api/v1/collectors`). Only adopted rows:
 * pending and dismissed collectors are not polled, so they can never own any
 * data an operator could filter by.
 */
export function listAdoptedCollectors() {
  return Collector.query().where('lifecycle', 'adopted').orderBy('name', 'asc')
}

/**
 * Another row already pointing at this address, if any. Used by create and
 * by update (which cannot use Vine's `unique` rule — it would trip on the
 * row's own value).
 */
export async function findCollectorAtBaseUrl(
  baseUrl: string,
  exceptId?: number
): Promise<Collector | null> {
  const query = Collector.query().where('base_url', normalizeBaseUrl(baseUrl))
  if (exceptId !== undefined) query.whereNot('id', exceptId)
  return query.first()
}

/**
 * Creates a collector and persists the first probe outcome immediately, so
 * operators can see "saved but unreachable" vs "saved and healthy" — exactly
 * what `createWifiAccessPoint` and the setup wizard do.
 */
export async function createCollector(
  input: CollectorInput
): Promise<{ collector: Collector; probe: CollectorStatus }> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const apiKey = input.apiKey ?? null
  const probe = await probeCollector(baseUrl, { apiKey })

  const collector = await Collector.create({
    name: input.name,
    baseUrl,
    transport: 'poll',
    apiKey,
    apiKeyFingerprint: apiKey ? apiKeyFingerprint(apiKey) : null,
    pollIntervalSeconds: input.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
    enabled: input.enabled ?? true,
    source: 'manual',
    lifecycle: 'adopted',
    captureInterface: probe.captureInterface ?? null,
    version: probe.version ?? null,
    lastSeenAt: probe.ok ? DateTime.fromISO(probe.checkedAt, { zone: 'utc' }) : null,
    lastStatus: probe,
  })

  return { collector, probe }
}

/**
 * Partial update, re-probing afterwards unless the caller opts out — the
 * same contract as `updateWifiAccessPoint`.
 */
export async function updateCollector(
  collector: Collector,
  input: CollectorUpdateInput,
  options: { probeAfterUpdate?: boolean } = {}
): Promise<CollectorUpdateResult> {
  const warnings: string[] = []

  if (input.name !== undefined) collector.name = input.name
  if (input.baseUrl !== undefined) {
    const nextBaseUrl = normalizeBaseUrl(input.baseUrl)
    if (nextBaseUrl !== collector.baseUrl && collector.source === 'announced') {
      // The admin knows better than the announce's source address (NAT, proxy):
      // take the address over. Announces keep refreshing metadata only.
      collector.source = 'manual'
      warnings.push(ANNOUNCED_ADDRESS_WARNING)
    }
    collector.baseUrl = nextBaseUrl
  }
  if (input.apiKey !== undefined) {
    collector.apiKey = input.apiKey
    collector.apiKeyFingerprint = input.apiKey ? apiKeyFingerprint(input.apiKey) : null
  }
  if (input.pollIntervalSeconds !== undefined) {
    collector.pollIntervalSeconds = input.pollIntervalSeconds
  }
  if (input.enabled !== undefined) collector.enabled = input.enabled

  let probe: CollectorStatus | null = null
  if (options.probeAfterUpdate ?? true) {
    probe = await probeRow(collector)
    applyProbe(collector, probe)
  }

  await collector.save()
  if (collector.transport === 'agent') {
    // A key the live session does not hold closes it (4001); otherwise the
    // session learns its new schedule (0 when disabled) right away.
    if (!closeSessionOnKeyMismatch(collector)) sendCollectorConfigure(collector)
  }
  return { collector, probe, warnings }
}

/** Explicit re-probe of a stored row; the result is persisted. */
export async function probeCollectorById(collector: Collector): Promise<CollectorStatus> {
  const probe = await probeRow(collector)
  applyProbe(collector, probe)
  await collector.save()
  return probe
}

/**
 * HTTP probe for polled rows, `collector.status` over the socket for agent
 * rows (docs/collector-agent.md section 5.4).
 */
async function probeRow(collector: Collector): Promise<CollectorStatus> {
  if (collector.transport === 'agent') return probeCollectorAgent(collector)
  if (!collector.baseUrl) {
    return { ok: false, checkedAt: new Date().toISOString(), error: 'no address to poll' }
  }
  return probeCollector(collector.baseUrl, { apiKey: collector.apiKey })
}

/**
 * Brings a pending (or dismissed) collector into service: from the next
 * scheduler tick it is polled, or — for a socket collector — it is told its
 * schedule at once and starts pushing. A failed probe still adopts and is
 * visible, the way the wizard persists a failed probe.
 *
 * A socket collector is never adopted keyless: its key is what authenticates
 * every later connect. When the admin gave none and the row learned none, the
 * key the connected collector presented is bound (it must match the announced
 * fingerprint, when there is one).
 */
export async function adoptCollector(
  collector: Collector,
  input: CollectorAdoptInput = {}
): Promise<CollectorAdoptResult> {
  if (
    input.apiKey !== undefined &&
    input.apiKey !== null &&
    collector.apiKeyFingerprint !== null &&
    apiKeyFingerprint(input.apiKey) !== collector.apiKeyFingerprint &&
    input.acceptKeyChange !== true
  ) {
    return { status: 'key_mismatch' }
  }

  if (input.name !== undefined) collector.name = input.name
  if (input.pollIntervalSeconds !== undefined) {
    collector.pollIntervalSeconds = input.pollIntervalSeconds
  }
  if (input.apiKey !== undefined) {
    collector.apiKey = input.apiKey
    collector.apiKeyFingerprint = input.apiKey ? apiKeyFingerprint(input.apiKey) : null
  }
  if (collector.transport === 'agent' && collector.apiKey === null) {
    const presented = presentedSessionKey(collector.id)
    const fingerprint = collector.apiKeyFingerprint
    if (presented && (fingerprint === null || apiKeyFingerprint(presented) === fingerprint)) {
      collector.apiKey = presented
      collector.apiKeyFingerprint = apiKeyFingerprint(presented)
    }
  }
  collector.lifecycle = 'adopted'
  collector.enabled = input.enabled ?? true

  const probe = await probeRow(collector)
  applyProbe(collector, probe)
  await collector.save()

  if (collector.transport === 'agent' && !closeSessionOnKeyMismatch(collector)) {
    if (sendCollectorConfigure(collector)) void syncCollectorProtocols(collector.id)
  }

  return { status: 'adopted', collector, probe }
}

/**
 * "Stop talking to this thing." Allowed from any lifecycle, and the row is
 * kept so the collector's continued announces refresh a hidden row instead
 * of reappearing in the pending list. The key is dropped: we were never
 * asked to hold that secret.
 */
export async function dismissCollector(collector: Collector): Promise<Collector> {
  collector.lifecycle = 'dismissed'
  collector.enabled = false
  collector.apiKey = null
  collector.apiKeyFingerprint = null
  await collector.save()
  // A socket collector is sent away (4003) and retries in hours, like the
  // announce interval of a dismissed row.
  collectorHub.disconnect(collector.id, CLOSE_CODES.DISMISSED, 'dismissed')
  return collector
}

/**
 * What this collector has recorded. Anything non-zero means a bare delete
 * would cascade across fourteen tables inside one HTTP request, so the API
 * refuses and points at `node ace collectors:purge`.
 */
export async function countCollectorHistory(collectorId: number): Promise<CollectorDataCounts> {
  const [bucketRows, identityRows] = await Promise.all([
    countRows(HISTORY_TABLE, collectorId),
    countRows(IDENTITY_TABLE, collectorId),
  ])
  return { bucketRows, identityRows, hasData: bucketRows > 0 || identityRows > 0 }
}

async function countRows(table: string, collectorId: number): Promise<number> {
  const rows = await db.from(table).where('collector_id', collectorId).count('* as total')
  const row = rows[0] as { total?: unknown } | undefined
  return Number(row?.total ?? 0)
}

/** Only ever called once history has been shown to be empty. */
export async function deleteCollector(collector: Collector): Promise<void> {
  await collector.delete()
  collectorHub.disconnect(collector.id, CLOSE_CODES.REVOKED, 'collector deleted')
}

/**
 * Name to pre-fill in the "add a collector" form: what the collector says it
 * is capturing, else the host we would be talking to.
 */
export function suggestCollectorName(baseUrl: string, probe: CollectorStatus): string | null {
  if (probe.captureInterface) return probe.captureInterface
  try {
    return new URL(baseUrl).hostname || null
  } catch {
    return null
  }
}

/**
 * Mirrors a successful probe into the row's denormalised columns so the
 * settings list can still show the interface and build while the collector
 * is down. A failed probe only updates `last_status`, leaving `last_seen_at`
 * as the genuine "last time this thing answered".
 */
function applyProbe(collector: Collector, probe: CollectorStatus): void {
  // The gateway block names the Gateway page's source; a probe says nothing
  // about it, so it is carried over.
  const gateway = collector.lastStatus?.gateway
  collector.lastStatus = gateway ? { ...probe, gateway } : probe
  if (!probe.ok) return
  collector.lastSeenAt = DateTime.fromISO(probe.checkedAt, { zone: 'utc' })
  collector.captureInterface = probe.captureInterface ?? collector.captureInterface
  collector.version = probe.version ?? collector.version
}
