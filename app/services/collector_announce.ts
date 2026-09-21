import Collector, { type CollectorLifecycle, type CollectorTransport } from '#models/collector'
import SystemSetting from '#models/system_setting'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import { createHash, timingSafeEqual } from 'node:crypto'
import { DateTime } from 'luxon'

/**
 * Collector self-announcement (docs/collector-management.md section 2).
 *
 * Everything an announce is allowed to do lives here: it may create or
 * refresh exactly ONE row, it never enables polling, never changes an
 * adopted row's key, never moves a `manual`/`env` row's address, and never
 * returns a secret. Adoption stays an explicit admin action under
 * `/api/v1/settings/collectors`.
 */

/** `SystemSetting` key for the feature switch. Absent = on. */
export const COLLECTOR_ANNOUNCE_ENABLED_KEY = 'collector_announce_enabled'

/** Rows a collector is told to wait before announcing again, per lifecycle. */
export const ANNOUNCE_INTERVAL_SECONDS: Record<CollectorLifecycle, number> = {
  pending: 60,
  adopted: 900,
  dismissed: 21_600,
}

/** At most this many rows may sit in `pending` at once. */
export const PENDING_LIMIT = 16

/** Poll interval a freshly announced row is created with. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5

const RATE_WINDOW_MS = 60_000
const RATE_WINDOW_SECONDS = 60
const PER_ADDRESS_LIMIT = 12
const GLOBAL_LIMIT = 60
/** Cap on the per-address table so LAN churn cannot grow it without bound. */
const MAX_TRACKED_ADDRESSES = 256

export type AnnounceInput = {
  instanceId: string
  hostname?: string
  version?: string
  captureInterface?: string
  /**
   * Port of the collector's HTTP API. Always present on an HTTP announce; a
   * socket hello omits it when that API answers on loopback only, and then
   * the row gets no pollable address from it (docs/collector-agent.md 3.2).
   */
  port?: number
  tls?: boolean
  baseUrl?: string
  apiKey?: string
  apiKeyFingerprint?: string
}

export type AnnounceContext = {
  /** Normalised TCP source address of the announce (see `announceSourceAddress`). */
  sourceAddress: string
  /** `Authorization: Bearer …` on the announce, if any. */
  bearerToken?: string | null
  /**
   * How the daemon introduced itself: `poll` for `POST …/announce` (the
   * default), `agent` for a `collector.hello` on the socket. Recorded on the
   * row: the poll task only dispatches `poll` rows.
   */
  transport?: CollectorTransport
  /** Override "now" for deterministic tests. */
  now?: DateTime
}

export type AnnounceOutcome =
  | {
      status: 'recorded'
      lifecycle: CollectorLifecycle
      collectorId: number
      announceIntervalSeconds: number
      /** Which branch of the match table fired; logged, not returned to the daemon. */
      action: 'created' | 'claimed' | 'refreshed'
    }
  | { status: 'rejected'; error: 'announce_key_mismatch' }
  | { status: 'rejected'; error: 'announce_pending_limit' }

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; scope: 'address' | 'global' }

type RateWindow = { count: number; startedAt: number }

/**
 * In-process token buckets. No limiter package is installed (`@adonisjs/lock`
 * is, `@adonisjs/limiter` is not) and the server is single-process, so a Map
 * is the whole implementation. Insertion order doubles as the LRU list.
 */
const perAddressWindows = new Map<string, RateWindow>()
let globalWindow: RateWindow = { count: 0, startedAt: 0 }

/** Test-only escape hatch: forget every rate-limit window. */
export function _resetAnnounceState(): void {
  perAddressWindows.clear()
  globalWindow = { count: 0, startedAt: 0 }
}

/**
 * The feature switch. Same key/value pattern as the hostname-enrichment
 * settings; unset means on, so a fresh install discovers collectors out of
 * the box (the announce is bounded and adoption is always manual).
 */
export async function isAnnounceEnabled(): Promise<boolean> {
  const stored = await SystemSetting.get<boolean>(COLLECTOR_ANNOUNCE_ENABLED_KEY)
  return stored ?? true
}

export async function setAnnounceEnabled(enabled: boolean): Promise<boolean> {
  await SystemSetting.set(COLLECTOR_ANNOUNCE_ENABLED_KEY, enabled)
  return enabled
}

/**
 * Strips the IPv4-mapped IPv6 prefix Node hands back when the listener is
 * dual-stack, so `::ffff:192.168.1.1` and `192.168.1.1` are the same
 * collector as far as the rate limiter and the address rule are concerned.
 */
export function announceSourceAddress(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  return mapped ? mapped[1] : ip
}

/**
 * `{scheme}://{announce source address}:{announced port}` — never the
 * address the collector claimed. A TCP source address is something the peer
 * had to actually possess to complete the handshake; a self-reported one is
 * worth nothing (a collector bound to 0.0.0.0 does not know how we reach it,
 * and a hostile one would happily name someone else's box).
 */
export function announcedPollUrl(address: string, port: number, tls: boolean): string {
  const scheme = tls ? 'https' : 'http'
  const host = address.includes(':') ? `[${address}]` : address
  return `${scheme}://${host}:${port}`
}

/** First 8 hex chars of sha256(key). Safe to display next to a pending row. */
export function apiKeyFingerprint(apiKey: string): string {
  return sha256(apiKey).toString('hex').slice(0, 8)
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * Constant-time comparison over the digests, so length never leaks. Also
 * what the collector socket checks its bearer with.
 */
export function keysMatch(stored: string, presented: string | null | undefined): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false
  return timingSafeEqual(sha256(stored), sha256(presented))
}

/**
 * Charges one announce against the per-address and global budgets.
 * Deliberately called before the body is validated so a flood costs the
 * server a Map lookup rather than a schema run.
 */
export function consumeAnnounceBudget(address: string, nowMs = Date.now()): RateLimitDecision {
  if (nowMs - globalWindow.startedAt >= RATE_WINDOW_MS) {
    globalWindow = { count: 0, startedAt: nowMs }
  }

  const stored = perAddressWindows.get(address)
  const window: RateWindow =
    stored && nowMs - stored.startedAt < RATE_WINDOW_MS ? stored : { count: 0, startedAt: nowMs }

  // Re-insert so the Map's insertion order stays "least recently seen first".
  perAddressWindows.delete(address)
  perAddressWindows.set(address, window)
  while (perAddressWindows.size > MAX_TRACKED_ADDRESSES) {
    const oldest = perAddressWindows.keys().next()
    if (oldest.done) break
    perAddressWindows.delete(oldest.value)
  }

  if (window.count >= PER_ADDRESS_LIMIT) {
    return { allowed: false, retryAfterSeconds: RATE_WINDOW_SECONDS, scope: 'address' }
  }
  if (globalWindow.count >= GLOBAL_LIMIT) {
    return { allowed: false, retryAfterSeconds: RATE_WINDOW_SECONDS, scope: 'global' }
  }

  window.count += 1
  globalWindow.count += 1
  return { allowed: true }
}

/**
 * The match table from section 2.4, in order:
 *
 *   1. same `instance_id`  → authenticate, then refresh metadata (and the
 *      address, but only for rows the collector itself created, and only
 *      when no other row already sits at that address)
 *   2. a row at the computed address → adopt its identity. With
 *      `instance_id IS NULL` that is the documented CLAIM; with a different
 *      non-null id it is the same daemon re-identified (reinstalled, new
 *      instance-id file), which is trusted for the same reason the address
 *      rule is: only the holder of that address can complete the handshake.
 *      An ADOPTED row that stores a key still has to present it.
 *   3. nothing matches → create one `pending` row, subject to the cap
 */
export async function recordAnnounce(
  input: AnnounceInput,
  context: AnnounceContext
): Promise<AnnounceOutcome> {
  const now = context.now ?? DateTime.utc()
  const transport = context.transport ?? 'poll'
  const pollUrl =
    input.port === undefined
      ? null
      : announcedPollUrl(context.sourceAddress, input.port, input.tls ?? false)
  const presentedKey = input.apiKey ?? context.bearerToken ?? null

  const known = await Collector.query().where('instance_id', input.instanceId).first()
  if (known) {
    if (known.apiKey !== null && !keysMatch(known.apiKey, presentedKey)) {
      warnKeyMismatch(known, input, context)
      return { status: 'rejected', error: 'announce_key_mismatch' }
    }

    applyAnnouncedMetadata(known, input, now)
    known.transport = transport
    // Only a row the collector itself created follows its address around.
    // A `manual`/`env` row keeps the address an admin (or COLLECTOR_URL) set.
    // A hello without a pollable address leaves the last one in place.
    if (known.source === 'announced' && pollUrl !== null && known.baseUrl !== pollUrl) {
      // ...and never onto an address another row already owns: two rows on
      // one daemon double-write every bucket under two `collector_id`s.
      const occupant = await rowAtAddress(pollUrl, known.id)
      if (occupant) {
        logger.warn(
          {
            collectorId: known.id,
            instanceId: input.instanceId,
            baseUrl: known.baseUrl,
            announcedFrom: pollUrl,
            occupiedBy: occupant.id,
          },
          'collector_announce: address already registered to another collector; keeping the old base_url'
        )
      } else {
        known.baseUrl = pollUrl
      }
    }
    // A pending row may still be learning its key — the admin can turn
    // `announce_api_key` on between beats. An adopted row's key is never
    // touched (2.4) and a dismissed row's key stays cleared (2.6).
    if (known.lifecycle === 'pending') applyAnnouncedKey(known, input)
    await known.save()
    return recorded(known, 'refreshed')
  }

  const atAddress = pollUrl === null ? null : await rowAtAddress(pollUrl)
  if (atAddress) {
    const reIdentified = atAddress.instanceId !== null
    // An adopted, keyed collector cannot be re-identified out from under the
    // admin without its key — the same binding 2.5 gives the refresh path.
    // A row that has never been identified (the documented claim) has no
    // identity to steal, and a pending/dismissed row is not in service.
    // (`pending` is also the only lifecycle whose key is relearned below,
    // so the two rules never fight over the same row.)
    if (reIdentified && atAddress.lifecycle === 'adopted' && atAddress.apiKey !== null) {
      if (!keysMatch(atAddress.apiKey, presentedKey)) {
        warnKeyMismatch(atAddress, input, context)
        return { status: 'rejected', error: 'announce_key_mismatch' }
      }
    }

    const previousInstanceId = atAddress.instanceId
    atAddress.instanceId = input.instanceId
    atAddress.transport = transport
    applyAnnouncedMetadata(atAddress, input, now)
    // A PENDING row relearns the key it is announcing now: nobody has
    // trusted the old one yet, and a rebuilt daemon arrives with a new key,
    // so keeping the stale one would leave the admin adopting a key the
    // collector no longer has (and comparing a stale fingerprint). An
    // ADOPTED row keeps the key it was adopted with, and a DISMISSED row
    // keeps its key cleared — same rule as the refresh path above.
    if (atAddress.lifecycle === 'pending') applyAnnouncedKey(atAddress, input)
    // lifecycle, base_url, name and enabled are left alone either way.
    const saved = await saveThroughInstanceIdRace(atAddress, input, now)
    if (saved.raced) return recorded(saved.row, 'refreshed')

    logger.info(
      {
        collectorId: atAddress.id,
        instanceId: input.instanceId,
        previousInstanceId,
        baseUrl: pollUrl,
      },
      reIdentified
        ? 'collector_announce: collector re-identified at a known address'
        : 'collector_announce: existing collector claimed its identity'
    )
    return recorded(atAddress, reIdentified ? 'refreshed' : 'claimed')
  }

  const pendingRows = await db.from('collectors').where('lifecycle', 'pending').count('* as total')
  const pendingCount = Number(pendingRows[0]?.total ?? 0)
  if (pendingCount >= PENDING_LIMIT) {
    logger.warn(
      { sourceAddress: context.sourceAddress, instanceId: input.instanceId, pendingCount },
      'collector_announce: pending collector limit reached; announce dropped'
    )
    return { status: 'rejected', error: 'announce_pending_limit' }
  }

  const created = new Collector()
  created.name = input.hostname ?? `collector-${input.instanceId.slice(0, 6)}`
  created.baseUrl = pollUrl
  created.transport = transport
  created.instanceId = input.instanceId
  created.source = 'announced'
  created.lifecycle = 'pending'
  created.enabled = false
  created.pollIntervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS
  created.apiKey = null
  created.apiKeyFingerprint = null
  created.announcedBaseUrl = null
  created.lastStatus = null
  applyAnnouncedMetadata(created, input, now)
  applyAnnouncedKey(created, input)

  const saved = await saveThroughInstanceIdRace(created, input, now)
  if (saved.raced) return recorded(saved.row, 'refreshed')

  logger.info(
    { collectorId: created.id, instanceId: input.instanceId, baseUrl: pollUrl },
    'collector_announce: new collector awaiting adoption'
  )
  return recorded(created, 'created')
}

/** Lowest-id row currently registered at `baseUrl`, optionally ignoring one. */
function rowAtAddress(baseUrl: string, exceptId?: number) {
  const query = Collector.query().where('base_url', baseUrl).orderBy('id', 'asc')
  if (exceptId !== undefined) query.whereNot('id', exceptId)
  return query.first()
}

function warnKeyMismatch(row: Collector, input: AnnounceInput, context: AnnounceContext): void {
  logger.warn(
    {
      collectorId: row.id,
      instanceId: input.instanceId,
      sourceAddress: context.sourceAddress,
    },
    'collector_announce: announce presented the wrong API key'
  )
}

/**
 * Persists a row that is taking on `instanceId`, surviving the one race the
 * unique index can lose: two announces from the same daemon arriving at once
 * both miss the `instance_id` lookup and both try to write it. The loser
 * gets ER_DUP_ENTRY, re-reads the winner's row and finishes as a refresh
 * instead of bubbling a 500 at a collector that did nothing wrong.
 */
async function saveThroughInstanceIdRace(
  row: Collector,
  input: AnnounceInput,
  now: DateTime
): Promise<{ row: Collector; raced: boolean }> {
  try {
    await row.save()
    return { row, raced: false }
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err

    const winner = await Collector.query().where('instance_id', input.instanceId).first()
    if (!winner) throw err

    logger.info(
      { collectorId: winner.id, instanceId: input.instanceId },
      'collector_announce: concurrent announce for the same instance id; refreshing the winner'
    )
    applyAnnouncedMetadata(winner, input, now)
    winner.transport = row.transport
    if (winner.lifecycle === 'pending') applyAnnouncedKey(winner, input)
    await winner.save()
    return { row: winner, raced: true }
  }
}

/** MySQL/MariaDB unique-constraint violation, however the driver wraps it. */
function isDuplicateKeyError(err: unknown): boolean {
  const candidate = err as { code?: unknown; errno?: unknown } | null
  return candidate?.code === 'ER_DUP_ENTRY' || candidate?.errno === 1062
}

function recorded(
  row: Collector,
  action: 'created' | 'claimed' | 'refreshed'
): Extract<AnnounceOutcome, { status: 'recorded' }> {
  const lifecycle = (row.lifecycle as CollectorLifecycle) ?? 'pending'
  return {
    status: 'recorded',
    lifecycle,
    collectorId: row.id,
    announceIntervalSeconds:
      ANNOUNCE_INTERVAL_SECONDS[lifecycle] ?? ANNOUNCE_INTERVAL_SECONDS.pending,
    action,
  }
}

/**
 * Self-reported, display-only fields. `announced_base_url` is what the
 * daemon claimed; keeping it next to `base_url` makes "it says
 * br-lan/192.168.1.1, we reach it at 192.168.1.1" debuggable.
 */
function applyAnnouncedMetadata(row: Collector, input: AnnounceInput, now: DateTime): void {
  if (input.hostname !== undefined) row.hostname = input.hostname
  if (input.version !== undefined) row.version = input.version
  if (input.captureInterface !== undefined) row.captureInterface = input.captureInterface
  // A daemon listening on a wildcard address omits `baseUrl` entirely; that
  // is "I cannot tell you", not "I have no address", so the last thing it
  // did claim is kept rather than blanked.
  if (input.baseUrl !== undefined) row.announcedBaseUrl = input.baseUrl
  row.lastAnnounceAt = now
}

/**
 * An announced key is stored (encrypted) so adoption needs no copy/paste; a
 * bare fingerprint is stored on its own when the daemon runs with
 * `announce_api_key false`, which is enough for the admin to verify the row
 * against `uci get perch-collector.main.api_key` before adopting.
 */
function applyAnnouncedKey(row: Collector, input: AnnounceInput): void {
  if (input.apiKey !== undefined) {
    row.apiKey = input.apiKey
    row.apiKeyFingerprint = apiKeyFingerprint(input.apiKey)
    return
  }
  if (input.apiKeyFingerprint !== undefined) {
    row.apiKeyFingerprint = input.apiKeyFingerprint
  }
}
