import Collector, {
  type CollectorGatewayStatus,
  type CollectorTransport,
  type GatewayWanSource,
} from '#models/collector'
import collectorHub from '#services/collector_agent_hub'
import { cacheKey, cachedQuery, windowCache } from '#services/query_cache'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Edge-router health: conntrack table fill (the "how many connections is
 * the house holding open" number), established TCP, load, memory and the
 * WAN interface rate as the router itself sees it. The collector that runs
 * on the router reads these from `/proc` and reports them with its traffic
 * data (docs/collector-agent.md section 4), over the socket or in the
 * polled `/api/v1/summary`; `recordGatewaySample` turns a report into a
 * `router_samples` row at most every 30 s per collector.
 */

/** One WAN interface's counters in a gateway report. */
export type GatewayWanCounters = { name: string; rxBytes: number; txBytes: number }

/**
 * The `gateway` object of a push or a polled summary (section 4.1). Every
 * field may be missing or null: the collector reports what it could read.
 */
export type GatewayReport = {
  collectedAt?: string | null
  conntrack?: { entries?: number | null; limit?: number | null } | null
  tcpEstablished?: number | null
  load?: { load1?: number | null; load5?: number | null; load15?: number | null } | null
  memory?: { totalBytes?: number | null; availableBytes?: number | null } | null
  wan?: GatewayWanCounters[] | null
  wanSource?: string | null
  /**
   * The router's Ethernet ports (perch-collector with the ports feature,
   * docs/infrastructure-view.md 4.3); absent from older collectors. Read by
   * `infra_ports.ts`, not here.
   */
  ports?: unknown
}

export type ParsedRouterMetrics = {
  conntrackEntries: number | null
  conntrackLimit: number | null
  tcpEstablished: number | null
  load1: number | null
  memTotal: number | null
  memAvailable: number | null
  wanIfaces: string[]
  wanRxBytes: number | null
  wanTxBytes: number | null
}

export type RouterSample = ParsedRouterMetrics & {
  recordedAt: string
  wanRxBps: number | null
  wanTxBps: number | null
}

export type RouterSeriesBucket = {
  bucketStart: string
  ts: number
  conntrackEntries: number | null
  conntrackMax: number | null
  tcpEstablished: number | null
  load1: number | null
  wanRxMbps: number | null
  wanTxMbps: number | null
}

export type RouterResolutionSeconds = 60 | 300 | 900 | 3600

/** The collector the Gateway page reads from (`GET /api/v1/router` `source`). */
export type GatewaySource = {
  collectorId: number
  name: string
  transport: CollectorTransport
  online: boolean
  wanInterfaces: string[]
  wanSource: GatewayWanSource
  reportedAt: string
}

/** One row per collector per this many ms, at most. */
export const GATEWAY_SAMPLE_INTERVAL_MS = 30_000
/** Pushes arrive a little early or late; the 5 s poll grid must still yield 30 s rows. */
const GATEWAY_SAMPLE_SLACK_MS = 1500
/** Bounds on what a report may carry (a report is one router, not a switch stack). */
const MAX_WAN_INTERFACES = 64
const MAX_INTERFACE_NAME = 64

type WrittenSample = { at: number; wan: Map<string, { rx: number; tx: number }> }

/**
 * The last sample written per collector: the 30 s throttle and the baseline
 * of the next WAN rate. Lost on restart (the first sample after a restart
 * has no rate), like the poller's counter snapshots.
 */
const lastWritten = new Map<number, WrittenSample>()

export function _resetRouterState() {
  lastWritten.clear()
}

function count(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

function wanCounters(report: GatewayReport): GatewayWanCounters[] {
  if (!Array.isArray(report.wan)) return []
  const out: GatewayWanCounters[] = []
  const seen = new Set<string>()
  for (const entry of report.wan.slice(0, MAX_WAN_INTERFACES)) {
    if (!entry || typeof entry.name !== 'string') continue
    const name = entry.name.trim().slice(0, MAX_INTERFACE_NAME)
    const rx = count(entry.rxBytes)
    const tx = count(entry.txBytes)
    if (!name || rx === null || tx === null || seen.has(name)) continue
    seen.add(name)
    out.push({ name, rxBytes: rx, txBytes: tx })
  }
  return out
}

function wanSourceOf(report: GatewayReport): GatewayWanSource {
  return report.wanSource === 'configured' ? 'configured' : 'default-route'
}

/**
 * WAN rate between two samples: per-interface deltas over the interfaces
 * both samples have, so an interface appearing or disappearing never makes
 * a spike. Any counter that went backwards (a reboot) voids the sample's rate.
 */
function wanRate(
  previous: WrittenSample | undefined,
  current: GatewayWanCounters[],
  at: number
): { rx: number | null; tx: number | null } {
  if (!previous || at <= previous.at) return { rx: null, tx: null }
  let rx = 0
  let tx = 0
  let shared = 0
  for (const iface of current) {
    const before = previous.wan.get(iface.name)
    if (!before) continue
    if (iface.rxBytes < before.rx || iface.txBytes < before.tx) return { rx: null, tx: null }
    rx += iface.rxBytes - before.rx
    tx += iface.txBytes - before.tx
    shared += 1
  }
  if (shared === 0) return { rx: null, tx: null }
  const seconds = (at - previous.at) / 1000
  return { rx: Math.round((rx * 8) / seconds), tx: Math.round((tx * 8) / seconds) }
}

/**
 * Records one gateway report (docs/collector-agent.md section 4.2): a
 * `router_samples` row unless this collector wrote one in the last 30 s.
 * Returns the `last_status.gateway` block for the caller to persist with the
 * rest of the collector's status. Throws only on a database error.
 */
export async function recordGatewaySample(
  collectorId: number,
  report: GatewayReport,
  receivedAt: DateTime
): Promise<CollectorGatewayStatus> {
  const wan = wanCounters(report)
  const status: CollectorGatewayStatus = {
    reportedAt: receivedAt.toUTC().toISO()!,
    wanInterfaces: wan.map((iface) => iface.name).sort(),
    wanSource: wanSourceOf(report),
  }

  const at = receivedAt.toMillis()
  const previous = lastWritten.get(collectorId)
  if (previous && at - previous.at < GATEWAY_SAMPLE_INTERVAL_MS - GATEWAY_SAMPLE_SLACK_MS) {
    return status
  }

  const rate = wanRate(previous, wan, at)
  const sum = (pick: (iface: GatewayWanCounters) => number) =>
    wan.length === 0 ? null : wan.reduce((acc, iface) => acc + pick(iface), 0)

  lastWritten.set(collectorId, {
    at,
    wan: new Map(wan.map((iface) => [iface.name, { rx: iface.rxBytes, tx: iface.txBytes }])),
  })

  const load1 = count(report.load?.load1)
  await db
    .insertQuery()
    .table('router_samples')
    .insert({
      recorded_at: receivedAt.toUTC().startOf('second').toFormat('yyyy-MM-dd HH:mm:ss'),
      conntrack_entries: count(report.conntrack?.entries),
      conntrack_limit: count(report.conntrack?.limit),
      tcp_established: count(report.tcpEstablished),
      load1: load1 === null ? null : Math.round(load1 * 100) / 100,
      mem_total: count(report.memory?.totalBytes),
      mem_available: count(report.memory?.availableBytes),
      wan_rx_bytes: sum((iface) => iface.rxBytes),
      wan_tx_bytes: sum((iface) => iface.txBytes),
      wan_rx_bps: rate.rx,
      wan_tx_bps: rate.tx,
      scrape_ms: null,
    })
    .onConflict('recorded_at')
    .ignore()

  return status
}

/**
 * The collector the Gateway page names: among adopted collectors, the most
 * recent gateway reporter (`last_status.gateway`). Null when none reports.
 */
export async function gatewaySource(): Promise<GatewaySource | null> {
  const rows = await Collector.query().where('lifecycle', 'adopted')
  let best: GatewaySource | null = null
  for (const row of rows) {
    const gateway = row.lastStatus?.gateway
    if (!gateway || typeof gateway.reportedAt !== 'string') continue
    if (best && best.reportedAt >= gateway.reportedAt) continue
    const transport: CollectorTransport = row.transport === 'agent' ? 'agent' : 'poll'
    best = {
      collectorId: row.id,
      name: row.name,
      transport,
      // Enabled and currently delivering: a disabled socket collector may
      // still be connected, but it has been told to stop pushing.
      online:
        Boolean(row.enabled) &&
        (transport === 'agent' ? collectorHub.isOnline(row.id) : row.lastStatus?.ok === true),
      wanInterfaces: Array.isArray(gateway.wanInterfaces) ? gateway.wanInterfaces : [],
      wanSource: gateway.wanSource === 'configured' ? 'configured' : 'default-route',
      reportedAt: gateway.reportedAt,
    }
  }
  return best
}

type SampleRow = {
  recorded_at: Date | string
  conntrack_entries: number | null
  conntrack_limit: number | null
  tcp_established: number | null
  load1: string | number | null
  mem_total: number | string | null
  mem_available: number | string | null
  wan_rx_bytes: number | string | null
  wan_tx_bytes: number | string | null
  wan_rx_bps: number | string | null
  wan_tx_bps: number | string | null
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const parsed = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(parsed) ? parsed : null
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' }).toISO()!
  const parsed = DateTime.fromSQL(value, { zone: 'utc' })
  return parsed.isValid ? parsed.toISO()! : String(value)
}

export async function latestRouterSample(wanIfaces: string[] = []): Promise<RouterSample | null> {
  const row = (await db.from('router_samples').orderBy('recorded_at', 'desc').first()) as
    | SampleRow
    | undefined
  if (!row) return null
  return {
    recordedAt: toIso(row.recorded_at),
    conntrackEntries: num(row.conntrack_entries),
    conntrackLimit: num(row.conntrack_limit),
    tcpEstablished: num(row.tcp_established),
    load1: num(row.load1),
    memTotal: num(row.mem_total),
    memAvailable: num(row.mem_available),
    wanIfaces,
    wanRxBytes: num(row.wan_rx_bytes),
    wanTxBytes: num(row.wan_tx_bytes),
    wanRxBps: num(row.wan_rx_bps),
    wanTxBps: num(row.wan_tx_bps),
  }
}

/** ~200 points at most: 1 m ≤ 3 h, 5 m ≤ 24 h, 15 m ≤ 3 d, else hourly. */
export function pickRouterResolution(
  requested: 'auto' | '1m' | '5m' | '15m' | '1h' | undefined,
  since: DateTime,
  until: DateTime
): RouterResolutionSeconds {
  if (requested === '1m') return 60
  if (requested === '5m') return 300
  if (requested === '15m') return 900
  if (requested === '1h') return 3600
  const hours = until.diff(since, 'hours').hours
  if (hours <= 3) return 60
  if (hours <= 24) return 300
  if (hours <= 72) return 900
  return 3600
}

export async function queryRouterSeries(opts: {
  since: DateTime
  until: DateTime
  resolutionSeconds: RouterResolutionSeconds
}): Promise<RouterSeriesBucket[]> {
  const { ttlMs, segment } = windowCache(
    `${opts.resolutionSeconds}s`,
    opts.since,
    opts.until,
    Date.now()
  )
  return cachedQuery(
    cacheKey(['router:series', segment, opts.resolutionSeconds]),
    ttlMs,
    async () => {
      const rows = rawRows<{
        bucketStart: Date | string
        conntrackEntries: string | number | null
        conntrackMax: string | number | null
        tcpEstablished: string | number | null
        load1: string | number | null
        wanRxBps: string | number | null
        wanTxBps: string | number | null
      }>(
        await db.rawQuery(
          `
          SELECT
            FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / ?) * ?) AS bucketStart,
            AVG(conntrack_entries) AS conntrackEntries,
            MAX(conntrack_entries) AS conntrackMax,
            AVG(tcp_established)   AS tcpEstablished,
            AVG(load1)             AS load1,
            AVG(wan_rx_bps)        AS wanRxBps,
            AVG(wan_tx_bps)        AS wanTxBps
          FROM router_samples
          WHERE recorded_at >= ? AND recorded_at < ?
          GROUP BY bucketStart
          ORDER BY bucketStart ASC
        `,
          [
            opts.resolutionSeconds,
            opts.resolutionSeconds,
            opts.since.toUTC().toFormat('yyyy-MM-dd HH:mm:ss'),
            opts.until.toUTC().toFormat('yyyy-MM-dd HH:mm:ss'),
          ]
        )
      )
      const mbps = (v: string | number | null) => {
        const bps = num(v)
        return bps === null ? null : Math.round((bps / 1e6) * 100) / 100
      }
      return rows.map((r) => {
        const iso = toIso(r.bucketStart)
        return {
          bucketStart: iso,
          ts: DateTime.fromISO(iso).toMillis(),
          conntrackEntries: round1(num(r.conntrackEntries)),
          conntrackMax: num(r.conntrackMax),
          tcpEstablished: round1(num(r.tcpEstablished)),
          load1: round1(num(r.load1)),
          wanRxMbps: mbps(r.wanRxBps),
          wanTxMbps: mbps(r.wanTxBps),
        }
      })
    }
  )
}

function rawRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result[0] : result) as T[]
}

function round1(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10
}
