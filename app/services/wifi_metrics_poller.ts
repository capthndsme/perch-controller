import type WifiAccessPoint from '#models/wifi_access_point'
import {
  mapSamplesByMetric,
  parsePrometheusText,
  type PrometheusMetricMap,
} from '#services/prometheus_text_parser'
import {
  upsertWifiLatest,
  writeWifiInterfaceBuckets,
  type WifiInterfaceDelta,
} from '#services/wifi_bucket_writer'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

type NetworkSnapshot = {
  ifname: string
  ssid: string
  bssid: string
  radio: string
  channel: number | null
  frequencyMhz: number | null
  band: string | null
  quality: number | null
  signalDbm: number | null
  noiseDbm: number | null
  bitrateKbps: number | null
}

type StationSnapshot = {
  mac: string
  ifname: string
  ssid: string | null
  radio: string | null
  channel: number | null
  frequencyMhz: number | null
  band: string | null
  signalDbm: number | null
  snrDb: number | null
  txRateKbps: number | null
  rxRateKbps: number | null
  expectedThroughputKbps: number | null
  inactiveMs: number | null
  txBytes: number | null
  rxBytes: number | null
  txPackets: number | null
  rxPackets: number | null
}

type InterfaceCounters = {
  ifname: string
  ssid: string | null
  radio: string | null
  band: string | null
  bytesIn: number
  bytesOut: number
  packetsIn: number
  packetsOut: number
  errsIn: number
  errsOut: number
  dropsIn: number
  dropsOut: number
}

type SystemSnapshot = {
  load1: number | null
  load5: number | null
  load15: number | null
  memTotal: number | null
  memAvailable: number | null
  conntrackEntries: number | null
  conntrackLimit: number | null
  bootTimeSeconds: number | null
  uptimeSeconds: number | null
}

type PollState = {
  interfaceCounters: Map<string, InterfaceCounters>
  bootTimeSeconds: number | null
  lastPollAt: number
}

type StationLocation = {
  apId: number
  ifname: string
  ssid: string | null
  band: string | null
  /** When that AP last heard the station, epoch ms: its report time minus the idle time it reported. */
  heardAt: number
}

type RoamingEventRow = Record<string, string | number | null>

/**
 * In-memory baseline for counter deltas. A process restart clears this map,
 * which means one baseline tick per AP and at most one lost interval of
 * interface-bucket writes.
 */
const state = new Map<number, PollState>()

/**
 * Where each station is, by MAC: which AP (and interface) owns it. It decides
 * the roaming events and which AP's listing feeds `wifi_station_latest`. A
 * client that leaves an AP stays in that AP's station list, idle, until
 * hostapd drops it minutes later, so two APs can list it at once; the AP that
 * heard it last owns it (`resolveStationOwners`). A restart forgets the map:
 * the first report afterwards sets the owner, and a fresher report corrects a
 * stale one.
 */
const locationByMac = new Map<string, StationLocation>()

/** Another AP takes a station over only when it heard it this much more recently. */
const ROAM_HYSTERESIS_MS = 2000
/** Bound on `locationByMac` (CLAUDE.md: every in-process cache has one). */
const MAX_TRACKED_STATIONS = 4096
/** Stations nobody has heard for this long go first when the bound is reached. */
const TRACKED_STATION_MAX_AGE_MS = 24 * 3600 * 1000

export type WifiPollOutcome =
  | {
      status: 'baseline'
      reason: 'first_tick' | 'ap_reset'
      networkSnapshots: number
      stationSnapshots: number
    }
  | {
      status: 'wrote'
      networkSnapshots: number
      stationSnapshots: number
      interfaceBucketsWritten: number
      roamingEvents: number
    }
  | { status: 'failed'; error: string }

export type WifiPollOptions = {
  fetcher?: typeof fetch
  timeoutMs?: number
  now?: () => DateTime
}

export type WifiIngestOptions = {
  /** Server time the snapshot is recorded at (buckets are aligned to it). */
  now?: DateTime
  /** Stored in `last_status.latencyMs`: fetch round trip, or the agent's collection time. */
  latencyMs?: number
}

/**
 * Test reset hook for module-level polling and roaming state.
 */
export function _resetWifiPollerState() {
  state.clear()
  locationByMac.clear()
}

/** Test-only: how many stations the roaming map tracks. */
export function _trackedStationCount(): number {
  return locationByMac.size
}

/**
 * Scheduler helper for per-AP interval dispatching.
 */
export function lastWifiPollAtFor(apId: number): number {
  return state.get(apId)?.lastPollAt ?? 0
}

/** HTTP `/metrics` of a scrape row. */
async function fetchScrapedMetricsText(
  ap: WifiAccessPoint,
  fetcher: typeof fetch,
  timeoutMs: number
): Promise<{ text: string; latencyMs: number }> {
  if (!ap.metricsUrl) throw new Error('no metrics URL configured')
  return fetchMetricsText(ap.metricsUrl, fetcher, timeoutMs)
}

async function fetchMetricsText(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number
): Promise<{ text: string; latencyMs: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = performance.now()
  try {
    const response = await fetcher(url, {
      headers: { Accept: 'text/plain' },
      signal: controller.signal,
    })
    const latencyMs = Math.round(performance.now() - start)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
    }
    return { text: await response.text(), latencyMs }
  } finally {
    clearTimeout(timer)
  }
}

function toInteger(value: number | undefined): number | null {
  if (value === undefined || Number.isNaN(value) || !Number.isFinite(value)) return null
  return Math.trunc(value)
}

function normalizeMac(mac: string | undefined): string | null {
  if (!mac) return null
  const normalized = mac.trim().toLowerCase().replace(/-/g, ':')
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalized) ? normalized : null
}

function inferBand(frequencyMhz: number | null): string | null {
  if (frequencyMhz === null) return null
  if (frequencyMhz >= 5900) return '6'
  if (frequencyMhz >= 3000) return '5'
  return '2.4'
}

function parseNetworkSnapshots(metrics: PrometheusMetricMap): Map<string, NetworkSnapshot> {
  const byIfname = new Map<string, NetworkSnapshot>()

  const upsert = (
    metric: string,
    apply: (row: NetworkSnapshot, value: number, labels: Record<string, string>) => void
  ) => {
    for (const sample of metrics.get(metric) ?? []) {
      const ifname = sample.labels.ifname
      if (!ifname) continue

      const frequencyMhz = toInteger(Number(sample.labels.frequency))
      const row = byIfname.get(ifname) ?? {
        ifname,
        ssid: sample.labels.ssid ?? ifname,
        bssid: sample.labels.bssid ?? '00:00:00:00:00:00',
        radio: sample.labels.device ?? 'unknown',
        channel: toInteger(Number(sample.labels.channel)),
        frequencyMhz,
        band: inferBand(frequencyMhz),
        quality: null,
        signalDbm: null,
        noiseDbm: null,
        bitrateKbps: null,
      }

      row.ssid = sample.labels.ssid ?? row.ssid
      row.bssid = sample.labels.bssid ?? row.bssid
      row.radio = sample.labels.device ?? row.radio
      row.channel = toInteger(Number(sample.labels.channel)) ?? row.channel
      row.frequencyMhz = frequencyMhz ?? row.frequencyMhz
      row.band = inferBand(row.frequencyMhz)

      apply(row, sample.value, sample.labels)
      byIfname.set(ifname, row)
    }
  }

  upsert('wifi_network_quality', (row, value) => {
    row.quality = toInteger(value)
  })
  upsert('wifi_network_signal_dbm', (row, value) => {
    row.signalDbm = toInteger(value)
  })
  upsert('wifi_network_noise_dbm', (row, value) => {
    row.noiseDbm = toInteger(value)
  })
  upsert('wifi_network_bitrate', (row, value) => {
    row.bitrateKbps = toInteger(value)
  })

  return byIfname
}

function parseStationSnapshots(
  metrics: PrometheusMetricMap,
  networksByIfname: Map<string, NetworkSnapshot>
): Map<string, StationSnapshot> {
  const byKey = new Map<string, StationSnapshot>()

  const upsert = (metric: string, apply: (row: StationSnapshot, value: number) => void) => {
    for (const sample of metrics.get(metric) ?? []) {
      const mac = normalizeMac(sample.labels.mac)
      const ifname = sample.labels.ifname
      if (!mac || !ifname) continue
      const key = `${mac}|${ifname}`

      const network = networksByIfname.get(ifname)
      const row = byKey.get(key) ?? {
        mac,
        ifname,
        ssid: network?.ssid ?? null,
        radio: network?.radio ?? null,
        channel: network?.channel ?? null,
        frequencyMhz: network?.frequencyMhz ?? null,
        band: network?.band ?? null,
        signalDbm: null,
        snrDb: null,
        txRateKbps: null,
        rxRateKbps: null,
        expectedThroughputKbps: null,
        inactiveMs: null,
        txBytes: null,
        rxBytes: null,
        txPackets: null,
        rxPackets: null,
      }

      apply(row, sample.value)
      byKey.set(key, row)
    }
  }

  upsert('wifi_station_signal_dbm', (row, value) => {
    row.signalDbm = toInteger(value)
  })
  upsert('wifi_station_inactive_milliseconds', (row, value) => {
    row.inactiveMs = toInteger(value)
  })
  upsert('wifi_station_transmit_kilobits_per_second', (row, value) => {
    row.txRateKbps = toInteger(value)
  })
  upsert('wifi_station_receive_kilobits_per_second', (row, value) => {
    row.rxRateKbps = toInteger(value)
  })
  upsert('wifi_station_expected_throughput_kilobits_per_second', (row, value) => {
    row.expectedThroughputKbps = toInteger(value)
  })
  upsert('wifi_station_transmit_bytes_total', (row, value) => {
    row.txBytes = toInteger(value)
  })
  upsert('wifi_station_receive_bytes_total', (row, value) => {
    row.rxBytes = toInteger(value)
  })
  upsert('wifi_station_transmit_packets_total', (row, value) => {
    row.txPackets = toInteger(value)
  })
  upsert('wifi_station_receive_packets_total', (row, value) => {
    row.rxPackets = toInteger(value)
  })

  for (const row of byKey.values()) {
    const network = networksByIfname.get(row.ifname)
    if (!network) continue
    row.ssid = network.ssid
    row.radio = network.radio
    row.channel = network.channel
    row.frequencyMhz = network.frequencyMhz
    row.band = network.band
    row.snrDb =
      row.signalDbm !== null && network.noiseDbm !== null ? row.signalDbm - network.noiseDbm : null
  }

  return byKey
}

function parseInterfaceCounters(
  metrics: PrometheusMetricMap,
  networksByIfname: Map<string, NetworkSnapshot>,
  stationsByKey: Map<string, StationSnapshot>
): Map<string, InterfaceCounters> {
  const ifnames = new Set<string>([...networksByIfname.keys()])
  for (const station of stationsByKey.values()) {
    ifnames.add(station.ifname)
  }
  const counters = new Map<string, InterfaceCounters>()

  const upsert = (metric: string, setter: (row: InterfaceCounters, value: number) => void) => {
    for (const sample of metrics.get(metric) ?? []) {
      const ifname = sample.labels.device
      if (!ifname || !ifnames.has(ifname)) continue
      const network = networksByIfname.get(ifname)
      const row = counters.get(ifname) ?? {
        ifname,
        ssid: network?.ssid ?? null,
        radio: network?.radio ?? null,
        band: network?.band ?? null,
        bytesIn: 0,
        bytesOut: 0,
        packetsIn: 0,
        packetsOut: 0,
        errsIn: 0,
        errsOut: 0,
        dropsIn: 0,
        dropsOut: 0,
      }
      setter(row, sample.value)
      counters.set(ifname, row)
    }
  }

  upsert('node_network_receive_bytes_total', (row, value) => {
    row.bytesIn = Math.trunc(Math.max(0, value))
  })
  upsert('node_network_transmit_bytes_total', (row, value) => {
    row.bytesOut = Math.trunc(Math.max(0, value))
  })
  upsert('node_network_receive_packets_total', (row, value) => {
    row.packetsIn = Math.trunc(Math.max(0, value))
  })
  upsert('node_network_transmit_packets_total', (row, value) => {
    row.packetsOut = Math.trunc(Math.max(0, value))
  })
  upsert('node_network_receive_errs_total', (row, value) => {
    row.errsIn = Math.trunc(Math.max(0, value))
  })
  upsert('node_network_transmit_errs_total', (row, value) => {
    row.errsOut = Math.trunc(Math.max(0, value))
  })
  upsert('node_network_receive_drop_total', (row, value) => {
    row.dropsIn = Math.trunc(Math.max(0, value))
  })
  upsert('node_network_transmit_drop_total', (row, value) => {
    row.dropsOut = Math.trunc(Math.max(0, value))
  })

  return counters
}

function scalarMetric(metrics: PrometheusMetricMap, name: string): number | null {
  const value = metrics.get(name)?.[0]?.value
  if (value === undefined || Number.isNaN(value) || !Number.isFinite(value)) return null
  return value
}

function parseSystemSnapshot(metrics: PrometheusMetricMap, now: DateTime): SystemSnapshot {
  const bootTimeSeconds = toInteger(scalarMetric(metrics, 'node_boot_time_seconds') ?? undefined)
  const nowSeconds = Math.floor(now.toSeconds())
  return {
    load1: scalarMetric(metrics, 'node_load1'),
    load5: scalarMetric(metrics, 'node_load5'),
    load15: scalarMetric(metrics, 'node_load15'),
    memTotal: toInteger(scalarMetric(metrics, 'node_memory_MemTotal_bytes') ?? undefined),
    memAvailable: toInteger(scalarMetric(metrics, 'node_memory_MemAvailable_bytes') ?? undefined),
    conntrackEntries: toInteger(scalarMetric(metrics, 'node_nf_conntrack_entries') ?? undefined),
    conntrackLimit: toInteger(
      scalarMetric(metrics, 'node_nf_conntrack_entries_limit') ?? undefined
    ),
    bootTimeSeconds,
    uptimeSeconds: bootTimeSeconds === null ? null : Math.max(0, nowSeconds - bootTimeSeconds),
  }
}

async function insertNetworkSnapshots(
  apId: number,
  nowSql: string,
  snapshots: NetworkSnapshot[]
): Promise<number> {
  if (snapshots.length === 0) return 0
  await db
    .insertQuery()
    .table('wifi_network_snapshots')
    .multiInsert(
      snapshots.map((snapshot) => ({
        ap_id: apId,
        ifname: snapshot.ifname,
        ssid: snapshot.ssid,
        bssid: snapshot.bssid,
        radio: snapshot.radio,
        channel: snapshot.channel,
        frequency_mhz: snapshot.frequencyMhz,
        band: snapshot.band,
        quality: snapshot.quality,
        signal_dbm: snapshot.signalDbm,
        noise_dbm: snapshot.noiseDbm,
        bitrate_kbps: snapshot.bitrateKbps,
        recorded_at: nowSql,
      }))
    )
  return snapshots.length
}

async function insertStationSnapshots(
  apId: number,
  nowSql: string,
  snapshots: StationSnapshot[]
): Promise<number> {
  if (snapshots.length === 0) return 0
  await db
    .insertQuery()
    .table('wifi_station_snapshots')
    .multiInsert(
      snapshots.map((snapshot) => ({
        ap_id: apId,
        mac: snapshot.mac,
        ifname: snapshot.ifname,
        ssid: snapshot.ssid,
        radio: snapshot.radio,
        channel: snapshot.channel,
        frequency_mhz: snapshot.frequencyMhz,
        band: snapshot.band,
        signal_dbm: snapshot.signalDbm,
        snr_db: snapshot.snrDb,
        tx_rate_kbps: snapshot.txRateKbps,
        rx_rate_kbps: snapshot.rxRateKbps,
        expected_throughput_kbps: snapshot.expectedThroughputKbps,
        inactive_ms: snapshot.inactiveMs,
        tx_bytes: snapshot.txBytes,
        rx_bytes: snapshot.rxBytes,
        tx_packets: snapshot.txPackets,
        rx_packets: snapshot.rxPackets,
        recorded_at: nowSql,
      }))
    )
  return snapshots.length
}

async function insertSystemSnapshot(
  apId: number,
  nowSql: string,
  snapshot: SystemSnapshot
): Promise<void> {
  await db.insertQuery().table('ap_system_snapshots').insert({
    ap_id: apId,
    load_1: snapshot.load1,
    load_5: snapshot.load5,
    load_15: snapshot.load15,
    mem_total: snapshot.memTotal,
    mem_available: snapshot.memAvailable,
    conntrack_entries: snapshot.conntrackEntries,
    conntrack_limit: snapshot.conntrackLimit,
    uptime_seconds: snapshot.uptimeSeconds,
    recorded_at: nowSql,
  })
}

/**
 * Decides, for one AP's report, which of its stations it owns and which moves
 * are real roams. Synchronous, so the reports of different APs never
 * interleave inside it.
 *
 * - A MAC listed twice in one report (two radios) counts once, by its fresher
 *   entry.
 * - The owner AP's own report is authoritative for that AP: a station it now
 *   lists on another interface moved (band steer or interface switch).
 * - Another AP takes a station over only when it heard it more than
 *   `ROAM_HYSTERESIS_MS` after the owner did. A client that left stays listed
 *   on its old AP with a growing idle time, so that stale listing never wins
 *   it back: one roam, not one per report.
 */
export function resolveStationOwners(
  apId: number,
  nowMs: number,
  stations: StationSnapshot[],
  detectedAtSql: string
): { owned: StationSnapshot[]; events: RoamingEventRow[] } {
  const freshest = new Map<string, StationSnapshot>()
  for (const station of stations) {
    const mac = normalizeMac(station.mac)
    if (!mac) continue
    const seen = freshest.get(mac)
    if (!seen || (station.inactiveMs ?? 0) < (seen.inactiveMs ?? 0)) freshest.set(mac, station)
  }

  const owned: StationSnapshot[] = []
  const events: RoamingEventRow[] = []
  for (const [mac, station] of freshest) {
    const current: StationLocation = {
      apId,
      ifname: station.ifname,
      ssid: station.ssid,
      band: station.band,
      heardAt: nowMs - Math.max(0, station.inactiveMs ?? 0),
    }
    const previous = locationByMac.get(mac)
    if (
      previous &&
      previous.apId !== apId &&
      current.heardAt <= previous.heardAt + ROAM_HYSTERESIS_MS
    ) {
      continue // listed here, but another AP heard it more recently: a stale listing
    }
    if (previous && (previous.apId !== apId || previous.ifname !== current.ifname)) {
      events.push(roamingEventRow(mac, previous, current, detectedAtSql))
    }
    locationByMac.set(mac, current)
    owned.push(station)
  }

  pruneStationLocations(nowMs)
  return { owned, events }
}

function roamingEventRow(
  mac: string,
  previous: StationLocation,
  current: StationLocation,
  detectedAtSql: string
): RoamingEventRow {
  const eventType =
    previous.apId !== current.apId
      ? 'ap_roam'
      : previous.band !== current.band
        ? 'band_steer'
        : 'interface_switch'
  return {
    mac,
    from_ap_id: previous.apId,
    to_ap_id: current.apId,
    from_ifname: previous.ifname,
    to_ifname: current.ifname,
    from_ssid: previous.ssid,
    to_ssid: current.ssid,
    from_band: previous.band,
    to_band: current.band,
    event_type: eventType,
    detected_at: detectedAtSql,
  }
}

/** The stations of `stations` that `apId` still owns (another AP may have taken one since). */
function stillOwnedBy(apId: number, stations: StationSnapshot[]): StationSnapshot[] {
  return stations.filter((station) => {
    const mac = normalizeMac(station.mac)
    const location = mac ? locationByMac.get(mac) : undefined
    return location?.apId === apId && location.ifname === station.ifname
  })
}

/** Keeps `locationByMac` bounded: day-old entries first, then the least recently heard. */
function pruneStationLocations(nowMs: number) {
  if (locationByMac.size <= MAX_TRACKED_STATIONS) return
  for (const [mac, location] of locationByMac) {
    if (nowMs - location.heardAt > TRACKED_STATION_MAX_AGE_MS) locationByMac.delete(mac)
  }
  if (locationByMac.size <= MAX_TRACKED_STATIONS) return
  // Down to 90 % so a busy network does not sort on every report.
  const excess = locationByMac.size - Math.floor(MAX_TRACKED_STATIONS * 0.9)
  const oldest = [...locationByMac].sort((a, b) => a[1].heardAt - b[1].heardAt).slice(0, excess)
  for (const [mac] of oldest) locationByMac.delete(mac)
}

async function insertRoamingEvents(events: RoamingEventRow[]): Promise<number> {
  if (events.length > 0) {
    await db.insertQuery().table('wifi_roaming_events').multiInsert(events)
  }
  return events.length
}

function computeInterfaceDeltas(
  apId: number,
  current: Map<string, InterfaceCounters>,
  previous: Map<string, InterfaceCounters>
): WifiInterfaceDelta[] {
  const deltas: WifiInterfaceDelta[] = []

  for (const [ifname, curr] of current) {
    const prev = previous.get(ifname)
    if (!prev) continue

    const delta: WifiInterfaceDelta = {
      ifname,
      ssid: curr.ssid,
      radio: curr.radio,
      band: curr.band,
      bytesIn: curr.bytesIn - prev.bytesIn,
      bytesOut: curr.bytesOut - prev.bytesOut,
      packetsIn: curr.packetsIn - prev.packetsIn,
      packetsOut: curr.packetsOut - prev.packetsOut,
      errsIn: curr.errsIn - prev.errsIn,
      errsOut: curr.errsOut - prev.errsOut,
      dropsIn: curr.dropsIn - prev.dropsIn,
      dropsOut: curr.dropsOut - prev.dropsOut,
    }

    if (
      delta.bytesIn < 0 ||
      delta.bytesOut < 0 ||
      delta.packetsIn < 0 ||
      delta.packetsOut < 0 ||
      delta.errsIn < 0 ||
      delta.errsOut < 0 ||
      delta.dropsIn < 0 ||
      delta.dropsOut < 0
    ) {
      logger.warn(
        { apId, ifname, delta },
        'wifi_metrics_poller: negative interface delta without reset; skipping'
      )
      continue
    }

    deltas.push(delta)
  }

  return deltas
}

async function persistFailure(
  ap: WifiAccessPoint,
  now: DateTime,
  message: string
): Promise<WifiPollOutcome> {
  ap.lastStatus = {
    ok: false,
    checkedAt: now.toISO()!,
    error: message,
  }
  try {
    await ap.save()
  } catch (error) {
    logger.error(
      { apId: ap.id, err: error },
      'wifi_metrics_poller: failed to persist failure status'
    )
  }
  return { status: 'failed', error: message }
}

/**
 * Polls one OpenWrt AP's HTTP `/metrics` and ingests it. Agent rows
 * (`transport = 'agent'`) are never polled: their Perch AP Daemon pushes the
 * same text over its session (`ap_agent_metrics.ts`), into `ingestWifiMetrics`.
 */
export async function pollWifiOnce(
  ap: WifiAccessPoint,
  options: WifiPollOptions = {}
): Promise<WifiPollOutcome> {
  const now = options.now?.() ?? DateTime.utc()
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? 5000

  if (ap.transport === 'agent') {
    return { status: 'failed', error: 'metrics of agent rows are pushed, not polled' }
  }

  let fetched: { text: string; latencyMs: number }
  try {
    fetched = await fetchScrapedMetricsText(ap, fetcher, timeoutMs)
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? `timeout after ${timeoutMs}ms`
          : error.message
        : String(error)
    return persistFailure(ap, now, message)
  }
  return ingestWifiMetrics(ap, fetched.text, { now, latencyMs: fetched.latencyMs })
}

/**
 * Everything after the fetch: parse one Prometheus exposition of an AP,
 * write snapshots and the latest-state mirror, compute interface deltas
 * against the previous one, emit roaming events, refresh identity and
 * `last_status`. The scrape poller and the Perch AP Daemon push path share it,
 * so both feed identical rows.
 */
export async function ingestWifiMetrics(
  ap: WifiAccessPoint,
  text: string,
  options: WifiIngestOptions = {}
): Promise<WifiPollOutcome> {
  const now = options.now ?? DateTime.utc()
  const latencyMs = options.latencyMs
  const nowSql = now.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')

  try {
    const samples = parsePrometheusText(text)
    const metrics = mapSamplesByMetric(samples)
    const networks = parseNetworkSnapshots(metrics)
    const stations = parseStationSnapshots(metrics, networks)
    const interfaces = parseInterfaceCounters(metrics, networks, stations)
    const system = parseSystemSnapshot(metrics, now)

    const previous = state.get(ap.id)
    const reset =
      previous !== undefined &&
      previous.bootTimeSeconds !== null &&
      system.bootTimeSeconds !== null &&
      previous.bootTimeSeconds !== system.bootTimeSeconds

    const networkRows = [...networks.values()]
    const stationRows = [...stations.values()]
    const { owned, events } = resolveStationOwners(ap.id, now.toMillis(), stationRows, nowSql)

    const [networkSnapshots, stationSnapshots, roamingEvents] = await Promise.all([
      insertNetworkSnapshots(ap.id, nowSql, networkRows),
      insertStationSnapshots(ap.id, nowSql, stationRows),
      insertRoamingEvents(events),
      insertSystemSnapshot(ap.id, nowSql, system),
    ])

    // Point-in-time mirror the WiFi pages read instead of deriving "latest
    // per key" from the append-only snapshot history. Only the stations this
    // AP owns: a client that just left is still listed here, idle, and must not
    // pull its row back from the AP it is on now. Checked again after the
    // awaits above, in case another AP's report took a station over meanwhile.
    await upsertWifiLatest(ap.id, now, {
      networks: networkRows,
      stations: stillOwnedBy(ap.id, owned),
      system,
    })

    let interfaceBucketsWritten = 0
    if (previous && !reset) {
      const deltas = computeInterfaceDeltas(ap.id, interfaces, previous.interfaceCounters)
      interfaceBucketsWritten = await writeWifiInterfaceBuckets(
        ap.id,
        ap.pollIntervalSeconds,
        now,
        deltas
      )
    }

    state.set(ap.id, {
      interfaceCounters: interfaces,
      bootTimeSeconds: system.bootTimeSeconds,
      lastPollAt: now.toMillis(),
    })

    const openwrtInfo = metrics.get('node_openwrt_info')?.[0]
    const unameInfo = metrics.get('node_uname_info')?.[0]
    ap.lastSeenAt = now
    ap.model = openwrtInfo?.labels.model ?? ap.model
    ap.openwrtRelease = openwrtInfo?.labels.release ?? ap.openwrtRelease
    ap.nodename = unameInfo?.labels.nodename ?? ap.nodename
    ap.lastStatus = {
      ok: true,
      checkedAt: now.toISO()!,
      latencyMs,
      metricFamilies: metrics.size,
      networksSeen: networkSnapshots,
      stationsSeen: stationSnapshots,
      interfaceBucketsWritten,
      model: ap.model ?? undefined,
      nodename: ap.nodename ?? undefined,
      openwrtRelease: ap.openwrtRelease ?? undefined,
    }
    await ap.save()

    if (!previous || reset) {
      return {
        status: 'baseline',
        reason: previous ? 'ap_reset' : 'first_tick',
        networkSnapshots,
        stationSnapshots,
      }
    }

    return {
      status: 'wrote',
      networkSnapshots,
      stationSnapshots,
      interfaceBucketsWritten,
      roamingEvents,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return persistFailure(ap, now, message)
  }
}
