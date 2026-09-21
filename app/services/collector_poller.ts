import type Collector from '#models/collector'
import type { CollectorStatus } from '#models/collector'
import {
  writeBuckets,
  writeDestinationBuckets,
  writePeerBuckets,
  writeProtocolBuckets,
  writeServiceBuckets,
  writeTopPeersBatch,
  type BucketDelta,
  type PeerBucketDelta,
  type PeerEntry,
  type PeerGroup,
  type DestinationBucketDelta,
  type PeerScope,
  type ProtocolBucketDelta,
  type ServiceBucketDelta,
} from '#services/bucket_writer'
import { upsertDeviceIdentities, type DeviceIdentityInput } from '#services/device_identity_writer'
import { upsertProtocolCategories, type ProtocolCategoryInput } from '#services/protocol_categories'
import { recordGatewaySample, type GatewayReport } from '#services/router_metrics'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * Shape of `GET /api/v1/devices` on the collector. Kept loose
 * (everything we don't use stays `unknown`-ish) so a minor field rename in
 * the collector doesn't take the poller down with a parse error — the
 * critical fields are the ones we actually destructure.
 */
type CollectorPeer = { ip: string; bytes_in: number; bytes_out: number }

type CollectorDevice = {
  mac: string
  ips?: string[]
  bytes_in: number
  bytes_out: number
  packets_in: number
  packets_out: number
  /**
   * Per-scope splits added in the LAN-split release. Older collectors omit
   * these — the poller falls back to leaving the WAN/LAN bucket columns at
   * 0, which keeps the totals authoritative even though scope queries
   * underreport.
   */
  bytes_in_wan?: number
  bytes_out_wan?: number
  packets_in_wan?: number
  packets_out_wan?: number
  bytes_in_lan?: number
  bytes_out_lan?: number
  packets_in_lan?: number
  packets_out_lan?: number
  first_seen?: string
  last_seen?: string
  top_peers?: CollectorPeer[]
  top_lan_peers?: CollectorPeer[]
  protocols?: Array<{
    protocol: string
    bytes_in: number
    bytes_out: number
    packets_in: number
    packets_out: number
  }>
  /**
   * Per-server-name counters, present when the device acted as a server
   * (added in the services release; older collectors omit it).
   */
  services?: Array<{
    server_name: string
    protocol: string
    bytes_served: number
    bytes_received: number
    packets_served: number
    packets_received: number
  }>
  /**
   * Per-destination counters, present when the device acted as a WAN client
   * (added in the destinations release; older collectors omit it). An empty
   * `server_name` is the per-protocol pool of unnamed flows.
   */
  destinations?: Array<{
    server_name: string
    /** Set on unnamed TLS/HTTP/QUIC rows keyed by address (destinations v2). */
    peer_ip?: string
    protocol: string
    category?: string
    bytes_in: number
    bytes_out: number
    packets_in: number
    packets_out: number
  }>
}

type ProtocolsResponse = {
  protocols?: ProtocolCategoryInput[]
}

type DevicesResponse = {
  devices: CollectorDevice[]
}

type SummaryResponse = {
  summary: { started_at: string; total_devices?: number }
  meta?: { capture_interface?: string; version?: string }
  /** Gateway stats, when the collector runs on the router (docs/collector-agent.md 4.1). */
  gateway?: GatewayReport | null
}

/**
 * One collector reading: what a poll fetches from `/api/v1/summary` +
 * `/api/v1/devices`, and what a socket push carries in one `collector.push`
 * (docs/collector-agent.md section 3.2). Both go through
 * `ingestCollectorSnapshot`, so a push is diffed exactly like a poll.
 */
export type CollectorSnapshot = {
  summary: Partial<SummaryResponse['summary']> | null | undefined
  meta?: SummaryResponse['meta'] | null
  devices: CollectorDevice[] | null | undefined
  gateway?: GatewayReport | null
}

/**
 * In-memory snapshot from the previous tick, used to compute deltas. Lost
 * on process restart by design: the first tick after a restart records the
 * current counters as a fresh baseline and skips the bucket write. We
 * accept losing at most one bucket per (collector × restart) in exchange
 * for not having to persist + reload snapshot state on every poll.
 */
type ProtoCounters = {
  bytesIn: number
  bytesOut: number
  packetsIn: number
  packetsOut: number
}

type PeerCounters = { bytesIn: number; bytesOut: number }

type ServiceCounters = {
  serverName: string
  protocol: string
  bytesServed: number
  bytesReceived: number
  packetsServed: number
  packetsReceived: number
}

type DestinationCounters = {
  serverName: string
  peerIp: string
  protocol: string
  category: string
  bytesIn: number
  bytesOut: number
  packetsIn: number
  packetsOut: number
}

type DeviceCounters = {
  bytesIn: number
  bytesOut: number
  packetsIn: number
  packetsOut: number
  bytesInWan: number
  bytesOutWan: number
  packetsInWan: number
  packetsOutWan: number
  bytesInLan: number
  bytesOutLan: number
  packetsInLan: number
  packetsOutLan: number
  protocols: Map<string, ProtoCounters>
  /** Cumulative per-peer counters from the collector's bounded heaps. */
  peers: Record<PeerScope, Map<string, PeerCounters>>
  /** Cumulative per-(server name, protocol) counters, keyed `name|protocol`. */
  services: Map<string, ServiceCounters>
  /** Cumulative per-(destination name, protocol) counters, keyed `name|protocol`. */
  destinations: Map<string, DestinationCounters>
}

type Snapshot = {
  summaryStartedAt: string
  devices: Map<string, DeviceCounters>
  lastPollAt: number // epoch ms; used by the scheduler's dispatch check
}

/**
 * Module-level state. The poller is a singleton inside a single Node
 * process; if we ever scale out to multiple workers polling the same
 * collector, this map needs to migrate to Redis (or every worker needs a
 * disjoint collector partition).
 */
const state = new Map<number, Snapshot>()

/**
 * When each collector's protocol → category table was last pulled (epoch
 * ms). The table only changes with a collector build, so once an hour is
 * plenty; a failed pull (older collector without the endpoint) also waits
 * an hour before trying again.
 */
const categorySyncAt = new Map<number, number>()
const CATEGORY_SYNC_INTERVAL_MS = 60 * 60_000
/** After a failed pull (collector down, or older build without the endpoint). */
const CATEGORY_SYNC_RETRY_MS = 5 * 60_000

/**
 * When each collector may next be dispatched (epoch ms). Written on EVERY
 * outcome, unlike the snapshot map, so a collector that is down backs off
 * instead of being retried on every 5 s tick.
 *
 * The snapshot's `lastPollAt` is only written on the success path (it is the
 * baseline for the next delta), which is why the dispatcher cannot use it:
 * for an unreachable collector it never moves, so the due test was true on
 * every tick regardless of `poll_interval_seconds`.
 */
const nextAttemptAt = new Map<number, number>()

/** Consecutive failures per collector; drives the backoff and last_status.failures. */
const failureCount = new Map<number, number>()

/**
 * Backoff ladder, indexed by consecutive-failure count (so the first failure
 * waits 10 s, the fifth and beyond 60 s). Never shorter than the collector's
 * own poll interval.
 */
const FAILURE_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000]

/**
 * Slack subtracted from the next success-path attempt so a 5 s collector on
 * a 5 s tick is not pushed out to 10 s by a few milliseconds of jitter.
 */
const DISPATCH_SLACK_MS = 1500

/**
 * Test-only escape hatch. Wipes the in-memory snapshot map so each test
 * starts from the "first tick after a restart" branch instead of
 * inheriting whatever the previous test recorded.
 */
export function _resetPollerState() {
  state.clear()
  categorySyncAt.clear()
  nextAttemptAt.clear()
  failureCount.clear()
  ingestChains.clear()
}

/**
 * Ingests of one collector, one after the other. A poll in flight and the
 * first push of a collector that just switched to the socket must never diff
 * against the same snapshot at the same time (the second would re-add what
 * the first wrote), so the chain lives here rather than in either caller.
 */
const ingestChains = new Map<number, Promise<unknown>>()

function serialised<T>(collectorId: number, task: () => Promise<T>): Promise<T> {
  const previous = ingestChains.get(collectorId) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  ingestChains.set(collectorId, tail)
  void tail.then(() => {
    if (ingestChains.get(collectorId) === tail) ingestChains.delete(collectorId)
  })
  return run
}

/**
 * Epoch ms from which `collectorId` may be polled again, or 0 when it has
 * never been attempted. The scheduler task uses this — not `lastPollAtFor` —
 * to decide what is due.
 */
export function nextAttemptAtFor(collectorId: number): number {
  return nextAttemptAt.get(collectorId) ?? 0
}

/**
 * Returns the epoch-ms timestamp of the last successful poll for
 * `collectorId`, or 0 if we've never polled it. The scheduler task uses
 * this to throttle per-collector polling against each row's configured
 * `poll_interval_seconds` without needing a DB roundtrip on every tick.
 */
export function lastPollAtFor(collectorId: number): number {
  return state.get(collectorId)?.lastPollAt ?? 0
}

export type PollOutcome =
  | { status: 'baseline'; reason: 'first_tick' | 'collector_reset'; deviceCount: number }
  | {
      status: 'wrote'
      bucketsWritten: number
      protocolBucketsWritten: number
      peerBucketsWritten: number
      serviceBucketsWritten: number
      destinationBucketsWritten: number
      peersWritten: number
      deviceCount: number
      activeDevices: number
    }
  | { status: 'failed'; error: string }

function parseProtocolCounters(
  protocols: CollectorDevice['protocols']
): Map<string, ProtoCounters> {
  const out = new Map<string, ProtoCounters>()
  for (const p of protocols ?? []) {
    if (!p.protocol) continue
    out.set(p.protocol, {
      bytesIn: Number(p.bytes_in ?? 0),
      bytesOut: Number(p.bytes_out ?? 0),
      packetsIn: Number(p.packets_in ?? 0),
      packetsOut: Number(p.packets_out ?? 0),
    })
  }
  return out
}

function parseServices(services: CollectorDevice['services']): Map<string, ServiceCounters> {
  const out = new Map<string, ServiceCounters>()
  for (const s of services ?? []) {
    if (!s.server_name) continue
    const protocol = s.protocol || 'other'
    out.set(`${s.server_name}|${protocol}`, {
      serverName: s.server_name,
      protocol,
      bytesServed: Number(s.bytes_served ?? 0),
      bytesReceived: Number(s.bytes_received ?? 0),
      packetsServed: Number(s.packets_served ?? 0),
      packetsReceived: Number(s.packets_received ?? 0),
    })
  }
  return out
}

function parseDestinations(
  destinations: CollectorDevice['destinations']
): Map<string, DestinationCounters> {
  const out = new Map<string, DestinationCounters>()
  for (const d of destinations ?? []) {
    const serverName = d.server_name ?? ''
    const peerIp = d.peer_ip ?? ''
    const protocol = d.protocol || 'other'
    out.set(`${serverName}|${peerIp}|${protocol}`, {
      serverName,
      peerIp,
      protocol,
      category: d.category ?? '',
      bytesIn: Number(d.bytes_in ?? 0),
      bytesOut: Number(d.bytes_out ?? 0),
      packetsIn: Number(d.packets_in ?? 0),
      packetsOut: Number(d.packets_out ?? 0),
    })
  }
  return out
}

function parsePeers(peers: CollectorPeer[] | undefined): Map<string, PeerCounters> {
  const out = new Map<string, PeerCounters>()
  for (const p of peers ?? []) {
    if (!p.ip) continue
    out.set(p.ip, { bytesIn: Number(p.bytes_in ?? 0), bytesOut: Number(p.bytes_out ?? 0) })
  }
  return out
}

function toPeerEntries(peers: Map<string, PeerCounters>): PeerEntry[] {
  return [...peers.entries()].map(([peerIp, c]) => ({
    peerIp,
    bytesIn: c.bytesIn,
    bytesOut: c.bytesOut,
  }))
}

/** True when both maps hold exactly the same peer IPs (counters may differ). */
function samePeerSet(a: Map<string, PeerCounters>, b: Map<string, PeerCounters>): boolean {
  if (a.size !== b.size) return false
  for (const ip of a.keys()) if (!b.has(ip)) return false
  return true
}

const PEER_SCOPES: PeerScope[] = ['wan', 'lan']

export type PollOptions = {
  fetcher?: typeof fetch
  /** Override "now" for deterministic tests. */
  now?: () => DateTime
}

/**
 * Fetches `${baseUrl}${path}` with optional Bearer auth, parses JSON.
 * Mirrors the conventions in `collector_probe.ts` (same Bearer header,
 * same Accept hint, same fetcher injection seam) so a future refactor can
 * collapse them into one helper.
 */
async function fetchJson<T>(
  baseUrl: string,
  path: string,
  apiKey: string | null,
  fetcher: typeof fetch,
  timeoutMs = 5000
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const res = await fetcher(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      headers,
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim())
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * GET /summary (cheap; gives us started_at for reset detection) and GET
 * /devices (the actual payload) from a polled collector. Throws on any HTTP
 * or network error.
 */
export async function fetchCollectorSnapshot(
  baseUrl: string,
  apiKey: string | null,
  fetcher: typeof fetch = fetch
): Promise<CollectorSnapshot> {
  const [summary, devicesResp] = await Promise.all([
    fetchJson<SummaryResponse>(baseUrl, '/api/v1/summary', apiKey, fetcher),
    fetchJson<DevicesResponse>(baseUrl, '/api/v1/devices', apiKey, fetcher),
  ])
  return {
    summary: summary.summary,
    meta: summary.meta,
    devices: devicesResp.devices,
    gateway: summary.gateway ?? null,
  }
}

/**
 * One full poll cycle for one polled collector: fetch, keep the protocol
 * category table fresh, ingest (`ingestCollectorSnapshot`).
 *
 * Always resolves (never throws); fatal errors are returned in the
 * outcome so the scheduler's Promise.allSettled wrapper has nothing to
 * filter and the next tick will just retry.
 */
export async function pollOnce(
  collector: Collector,
  options: PollOptions = {}
): Promise<PollOutcome> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now?.() ?? DateTime.utc()

  if (!collector.baseUrl) {
    return persistFailure(collector, now, 'no address to poll')
  }
  let snapshot: CollectorSnapshot
  try {
    snapshot = await fetchCollectorSnapshot(collector.baseUrl, collector.apiKey, fetcher)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return persistFailure(collector, now, message)
  }

  if (snapshot.summary?.started_at) {
    await syncProtocolCategories(collector, collector.baseUrl, now, fetcher)
  }
  return ingestCollectorSnapshot(collector, snapshot, { now })
}

export type IngestOptions = {
  /** Bucket time: poll time, or the server receive time of a push. */
  now?: DateTime
}

/**
 * Turns one reading into rows:
 *   1. Diff against the previous snapshot — traffic, protocols AND peers
 *   2. Write native bucket rows + hourly peer deltas (skipped on first
 *      tick / after a reset)
 *   3. Refresh identities + the latest-peer mirror for devices that were
 *      active this tick (or are new); idle devices are skipped entirely —
 *      their counters, IPs and peer heaps cannot have changed
 *   4. Record the gateway sample, when the reading carries one
 *   5. Persist `last_seen_at` + `last_status` on the collector row
 *
 * Serialised per collector (poll and push share the chain). Never throws.
 */
export function ingestCollectorSnapshot(
  collector: Collector,
  snapshot: CollectorSnapshot,
  options: IngestOptions = {}
): Promise<PollOutcome> {
  const now = options.now ?? DateTime.utc()
  return serialised(collector.id, () => ingest(collector, snapshot, now))
}

async function ingest(
  collector: Collector,
  snapshot: CollectorSnapshot,
  now: DateTime
): Promise<PollOutcome> {
  try {
    const startedAt = snapshot.summary?.started_at
    if (!startedAt) {
      return persistFailure(collector, now, 'missing started_at in summary')
    }

    const previous = state.get(collector.id)
    const reset = !previous || previous.summaryStartedAt !== startedAt
    const newDevices = new Map<string, DeviceCounters>()
    const deltas: BucketDelta[] = []
    const protocolDeltas: ProtocolBucketDelta[] = []
    const peerDeltas: PeerBucketDelta[] = []
    const serviceDeltas: ServiceBucketDelta[] = []
    const destinationDeltas: DestinationBucketDelta[] = []
    const peerGroups: PeerGroup[] = []
    const identityInputs: DeviceIdentityInput[] = []
    const devices = snapshot.devices ?? []
    let activeDevices = 0

    for (const dev of devices) {
      const current: DeviceCounters = {
        bytesIn: Number(dev.bytes_in ?? 0),
        bytesOut: Number(dev.bytes_out ?? 0),
        packetsIn: Number(dev.packets_in ?? 0),
        packetsOut: Number(dev.packets_out ?? 0),
        bytesInWan: Number(dev.bytes_in_wan ?? 0),
        bytesOutWan: Number(dev.bytes_out_wan ?? 0),
        packetsInWan: Number(dev.packets_in_wan ?? 0),
        packetsOutWan: Number(dev.packets_out_wan ?? 0),
        bytesInLan: Number(dev.bytes_in_lan ?? 0),
        bytesOutLan: Number(dev.bytes_out_lan ?? 0),
        packetsInLan: Number(dev.packets_in_lan ?? 0),
        packetsOutLan: Number(dev.packets_out_lan ?? 0),
        protocols: parseProtocolCounters(dev.protocols),
        peers: { wan: parsePeers(dev.top_peers), lan: parsePeers(dev.top_lan_peers) },
        services: parseServices(dev.services),
        destinations: parseDestinations(dev.destinations),
      }
      newDevices.set(dev.mac, current)

      const identity: DeviceIdentityInput = {
        mac: dev.mac,
        ips: dev.ips ?? [],
        firstSeen: dev.first_seen,
        lastSeen: dev.last_seen,
      }

      const prev = reset ? undefined : previous!.devices.get(dev.mac)
      if (!prev) {
        // First time we've seen this MAC since the snapshot (or the whole
        // collector was reset): treat its current counters as baseline
        // rather than inflating the bucket with what is really historical
        // traffic. Its identity and latest peer heaps are still refreshed —
        // they are point-in-time state, not deltas.
        identityInputs.push(identity)
        for (const scope of PEER_SCOPES) {
          peerGroups.push({
            mac: dev.mac,
            scope,
            peers: toPeerEntries(current.peers[scope]),
            replace: true,
          })
        }
        continue
      }

      const delta: BucketDelta = {
        mac: dev.mac,
        bytesIn: current.bytesIn - prev.bytesIn,
        bytesOut: current.bytesOut - prev.bytesOut,
        packetsIn: current.packetsIn - prev.packetsIn,
        packetsOut: current.packetsOut - prev.packetsOut,
        bytesInWan: current.bytesInWan - prev.bytesInWan,
        bytesOutWan: current.bytesOutWan - prev.bytesOutWan,
        packetsInWan: current.packetsInWan - prev.packetsInWan,
        packetsOutWan: current.packetsOutWan - prev.packetsOutWan,
        bytesInLan: current.bytesInLan - prev.bytesInLan,
        bytesOutLan: current.bytesOutLan - prev.bytesOutLan,
        packetsInLan: current.packetsInLan - prev.packetsInLan,
        packetsOutLan: current.packetsOutLan - prev.packetsOutLan,
      }
      if (delta.bytesIn < 0 || delta.bytesOut < 0 || delta.packetsIn < 0 || delta.packetsOut < 0) {
        // Negative delta without a reset means the collector reset its
        // counters between polls but kept the same started_at — shouldn't
        // happen, but if it does we'd rather skip the bucket than write
        // junk. Log loudly so the underlying bug doesn't hide. The device
        // re-baselines: latest peers are refreshed, no deltas are written.
        logger.warn(
          { collectorId: collector.id, mac: dev.mac, delta },
          'collector_poller: negative delta without reset; skipping bucket'
        )
        for (const scope of PEER_SCOPES) {
          peerGroups.push({
            mac: dev.mac,
            scope,
            peers: toPeerEntries(current.peers[scope]),
            replace: true,
          })
        }
        continue
      }

      const active =
        delta.bytesIn > 0 || delta.bytesOut > 0 || delta.packetsIn > 0 || delta.packetsOut > 0
      if (!active) {
        // Idle since the last tick: no bytes means no protocol or peer
        // counter can have moved and last_seen is unchanged. Nothing to write.
        continue
      }
      activeDevices += 1
      deltas.push(delta)
      identityInputs.push(identity)

      for (const [proto, curr] of current.protocols) {
        const prevProto = prev.protocols.get(proto)
        if (!prevProto) continue
        const protoDelta: ProtocolBucketDelta = {
          mac: dev.mac,
          protocol: proto,
          bytesIn: curr.bytesIn - prevProto.bytesIn,
          bytesOut: curr.bytesOut - prevProto.bytesOut,
          packetsIn: curr.packetsIn - prevProto.packetsIn,
          packetsOut: curr.packetsOut - prevProto.packetsOut,
        }
        if (protoDelta.bytesIn < 0 || protoDelta.bytesOut < 0) {
          logger.warn(
            { collectorId: collector.id, mac: dev.mac, protocol: proto, protoDelta },
            'collector_poller: negative protocol delta without reset; skipping'
          )
          continue
        }
        protocolDeltas.push(protoDelta)
      }

      for (const [key, curr] of current.services) {
        const before = prev.services.get(key)
        // New name since the last snapshot: baseline, like a new device.
        if (!before) continue
        if (curr.bytesServed < before.bytesServed || curr.bytesReceived < before.bytesReceived) {
          logger.warn(
            { collectorId: collector.id, mac: dev.mac, service: key },
            'collector_poller: negative service delta without reset; skipping'
          )
          continue
        }
        serviceDeltas.push({
          mac: dev.mac,
          serverName: curr.serverName,
          protocol: curr.protocol,
          bytesServed: curr.bytesServed - before.bytesServed,
          bytesReceived: curr.bytesReceived - before.bytesReceived,
          packetsServed: Math.max(0, curr.packetsServed - before.packetsServed),
          packetsReceived: Math.max(0, curr.packetsReceived - before.packetsReceived),
        })
      }

      for (const [key, curr] of current.destinations) {
        const before = prev.destinations.get(key)
        // New destination since the last snapshot: baseline, like a new device.
        if (!before) continue
        if (curr.bytesIn < before.bytesIn || curr.bytesOut < before.bytesOut) {
          logger.warn(
            { collectorId: collector.id, mac: dev.mac, destination: key },
            'collector_poller: negative destination delta without reset; skipping'
          )
          continue
        }
        destinationDeltas.push({
          mac: dev.mac,
          serverName: curr.serverName,
          peerIp: curr.peerIp,
          protocol: curr.protocol,
          category: curr.category,
          bytesIn: curr.bytesIn - before.bytesIn,
          bytesOut: curr.bytesOut - before.bytesOut,
          packetsIn: Math.max(0, curr.packetsIn - before.packetsIn),
          packetsOut: Math.max(0, curr.packetsOut - before.packetsOut),
        })
      }

      for (const scope of PEER_SCOPES) {
        const currPeers = current.peers[scope]
        const prevPeers = prev.peers[scope]
        peerGroups.push({
          mac: dev.mac,
          scope,
          peers: toPeerEntries(currPeers),
          // Only ask for the DELETE-not-in pass when an IP actually left or
          // joined the heap; the common tick is a pure counter refresh.
          replace: !samePeerSet(currPeers, prevPeers),
        })
        for (const [ip, curr] of currPeers) {
          const before = prevPeers.get(ip)
          // A peer that was not in the previous heap (new, or evicted and
          // re-admitted with fresh counters) is baselined, like a new device.
          if (!before) continue
          if (curr.bytesIn < before.bytesIn || curr.bytesOut < before.bytesOut) continue
          const bytesIn = curr.bytesIn - before.bytesIn
          const bytesOut = curr.bytesOut - before.bytesOut
          if (bytesIn > 0 || bytesOut > 0) {
            peerDeltas.push({ mac: dev.mac, scope, peerIp: ip, bytesIn, bytesOut })
          }
        }
      }
    }

    let bucketsWritten = 0
    let protocolBucketsWritten = 0
    let peerBucketsWritten = 0
    let serviceBucketsWritten = 0
    let destinationBucketsWritten = 0
    if (!reset) {
      bucketsWritten = await writeBuckets(collector.id, collector.pollIntervalSeconds, now, deltas)
      protocolBucketsWritten = await writeProtocolBuckets(
        collector.id,
        collector.pollIntervalSeconds,
        now,
        protocolDeltas
      )
      peerBucketsWritten = await writePeerBuckets(collector.id, now, peerDeltas)
      serviceBucketsWritten = await writeServiceBuckets(collector.id, now, serviceDeltas)
      destinationBucketsWritten = await writeDestinationBuckets(
        collector.id,
        now,
        destinationDeltas
      )
    }

    // ── Critical: update the in-memory snapshot BEFORE the latest-state writes ──
    // Bucket writes above already committed. If we crash or the peer
    // upsert deadlocks below, the snapshot must still advance so the
    // next tick's delta is computed from the correct baseline — otherwise
    // already-written traffic gets re-added (the "haircomb" bug).
    state.set(collector.id, {
      summaryStartedAt: startedAt,
      devices: newDevices,
      lastPollAt: now.toMillis(),
    })

    await upsertDeviceIdentities(collector.id, identityInputs, now)

    // ── Latest-peer mirror is non-fatal ──
    // It is a point-in-time snapshot, not cumulative. A failed upsert just
    // means stale peer data until the next successful tick — far better
    // than letting it prevent the collector status save.
    let peersWritten = 0
    try {
      peersWritten = await writeTopPeersBatch(collector.id, peerGroups, now)
    } catch (peerErr) {
      logger.warn(
        { collectorId: collector.id, groups: peerGroups.length, error: String(peerErr) },
        'collector_poller: peer upsert failed (non-fatal); will retry next tick'
      )
    }

    failureCount.delete(collector.id)
    nextAttemptAt.set(
      collector.id,
      now.toMillis() + collector.pollIntervalSeconds * 1000 - DISPATCH_SLACK_MS
    )

    // Non-fatal like the peer mirror: a failed gateway insert costs one
    // 30 s sample, never the traffic write above.
    let gateway: CollectorStatus['gateway']
    if (snapshot.gateway) {
      try {
        gateway = await recordGatewaySample(collector.id, snapshot.gateway, now)
      } catch (gatewayErr) {
        logger.warn(
          { collectorId: collector.id, error: String(gatewayErr) },
          'collector_poller: gateway sample failed (non-fatal)'
        )
        gateway = collector.lastStatus?.gateway
      }
    }

    collector.lastSeenAt = now
    collector.lastStatus = {
      ok: true,
      checkedAt: now.toISO()!,
      totalDevices: snapshot.summary?.total_devices ?? devices.length,
      captureInterface: snapshot.meta?.capture_interface,
      ...(gateway ? { gateway } : {}),
    }
    // Mirrored into its own column so the settings list can still show the
    // interface while the collector is down.
    if (snapshot.meta?.capture_interface) {
      collector.captureInterface = snapshot.meta.capture_interface
    }
    await collector.save()

    if (reset) {
      return {
        status: 'baseline',
        reason: previous ? 'collector_reset' : 'first_tick',
        deviceCount: devices.length,
      }
    }
    return {
      status: 'wrote',
      bucketsWritten,
      protocolBucketsWritten,
      peerBucketsWritten,
      serviceBucketsWritten,
      destinationBucketsWritten,
      peersWritten,
      deviceCount: devices.length,
      activeDevices,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return persistFailure(collector, now, message)
  }
}

/**
 * Pull the collector's protocol → category table at most once an hour and
 * upsert it. Never throws: a collector without the endpoint (pre-categories
 * build) or a transient error just logs and waits for the next hour.
 */
async function syncProtocolCategories(
  collector: Collector,
  baseUrl: string,
  now: DateTime,
  fetcher: typeof fetch
): Promise<void> {
  const last = categorySyncAt.get(collector.id) ?? 0
  if (now.toMillis() - last < CATEGORY_SYNC_INTERVAL_MS) return
  categorySyncAt.set(collector.id, now.toMillis())
  try {
    const res = await fetchJson<ProtocolsResponse>(
      baseUrl,
      '/api/v1/protocols',
      collector.apiKey,
      fetcher
    )
    const written = await upsertProtocolCategories(res.protocols ?? [])
    if (written > 0) {
      logger.info(
        { collectorId: collector.id, written },
        'collector_poller: refreshed protocol categories'
      )
    }
  } catch (err) {
    categorySyncAt.set(
      collector.id,
      now.toMillis() - CATEGORY_SYNC_INTERVAL_MS + CATEGORY_SYNC_RETRY_MS
    )
    logger.debug(
      { collectorId: collector.id, error: err instanceof Error ? err.message : String(err) },
      'collector_poller: protocol categories unavailable from collector'
    )
  }
}

/**
 * Mirror a probe failure into `last_status` so the operator UI can show
 * "last poll: failed (reason)" without us needing a separate alerts
 * table. We deliberately do NOT update the in-memory snapshot here — the
 * next successful poll will detect a no-op or a fresh baseline and either
 * resume or treat it as a reset.
 *
 * It DOES move `nextAttemptAt`, so a collector that is unplugged backs off
 * along `FAILURE_BACKOFF_MS` instead of being retried twice every 5 s
 * forever, and records the streak in `last_status.failures` so the UI can
 * say "down for 12 polls".
 */
async function persistFailure(
  collector: Collector,
  now: DateTime,
  message: string
): Promise<PollOutcome> {
  const failures = (failureCount.get(collector.id) ?? 0) + 1
  failureCount.set(collector.id, failures)
  nextAttemptAt.set(
    collector.id,
    now.toMillis() +
      Math.max(
        collector.pollIntervalSeconds * 1000,
        FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length - 1)]
      )
  )

  // The gateway block names the Gateway page's source; a failure streak
  // keeps it (the page says whether the source is online).
  const gateway = collector.lastStatus?.gateway
  collector.lastStatus = {
    ok: false,
    checkedAt: now.toISO()!,
    error: message,
    failures,
    ...(gateway ? { gateway } : {}),
  }
  try {
    await collector.save()
  } catch (saveErr) {
    logger.error(
      { collectorId: collector.id, err: saveErr },
      'collector_poller: failed to persist failure status'
    )
  }
  return { status: 'failed', error: message }
}
