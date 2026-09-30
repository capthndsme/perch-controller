import { getDeviceLabels } from '#services/device_labels'
import { queryDevicePresences, queryLatestWifiContext } from '#services/device_presence_query'
import { getHostnameMatches } from '#services/hostname_enrichment'
import { loadDeviceAttachments } from '#services/infra_topology'
import { getPresenceSettings } from '#services/presence_settings'
import type { DeviceOnMap, DevicePresence } from '#services/wifi_presence'
import type { ConditionInput, DetectorContext, ParamValue } from '#services/alerts/model'
import { registerDetector } from '#services/alerts/registry'
import { watchedMacs } from '#services/alerts/watches'
import {
  ISO_FORMAT,
  liveAlerts,
  loadApLiveness,
  loadCollectorLiveness,
  monitoredAps,
  monitoredCollectors,
  parseJsonObject,
  rawRows,
} from '#services/alerts/detectors/liveness'
import db from '@adonisjs/lucid/services/db'

/**
 * Detector `devices` (WP-A5a, events.md section 3.5), every 60 s:
 *
 * - `device.new`: a MAC first seen within the last `minPresenceMinutes` + 60
 *   minutes and around for at least `minPresenceMinutes`, minus the ones the
 *   admin already knows (labelled, in a device group, on the map, an agent's
 *   own MAC) and the excluded networks. One alert per MAC ever.
 * - `device.offline` / `device.arrived`: watched devices only
 *   (`alert_watches`), through `queryDevicePresences`, the rule every device
 *   view uses.
 *
 * `device_identities.mac` and the other tables' `mac` columns have different
 * collations: every exclusion is joined here, in JS (CLAUDE.md).
 */

export const NEW_TYPE = 'device.new'
export const OFFLINE_TYPE = 'device.offline'
export const ARRIVED_TYPE = 'device.arrived'
/** Agent alerts that make every device behind them look gone (events.md section 3.5). */
export const AGENT_ALERT_TYPES = ['collector.offline', 'ap.offline', 'system.agents_unreachable']

export const MAX_NEW_PER_SCAN = 50
/** Bound on the arrival memory (one entry per watched MAC). */
export const MAX_WATCHED = 1000

export const deviceKey = (type: string, mac: string) => `${type}:device:${mac}`

// ── device.new ─────────────────────────────────────────────────────────────

export type NewDeviceParams = {
  minPresenceMinutes: number
  ignoreRandomizedMacs: boolean
  excludePortalNetworks: boolean
  excludeNetworks: string[]
}

export const NEW_DEVICE_DEFAULTS: NewDeviceParams = {
  minPresenceMinutes: 10,
  ignoreRandomizedMacs: false,
  excludePortalNetworks: true,
  excludeNetworks: [],
}

/** Rule params as stored (already clamped by the settings layer); wrong types read as the default. */
export function newDeviceParams(params: Record<string, ParamValue> | undefined): NewDeviceParams {
  const p = params ?? {}
  const int = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
  return {
    minPresenceMinutes: int(p.minPresenceMinutes, NEW_DEVICE_DEFAULTS.minPresenceMinutes),
    ignoreRandomizedMacs:
      typeof p.ignoreRandomizedMacs === 'boolean'
        ? p.ignoreRandomizedMacs
        : NEW_DEVICE_DEFAULTS.ignoreRandomizedMacs,
    excludePortalNetworks:
      typeof p.excludePortalNetworks === 'boolean'
        ? p.excludePortalNetworks
        : NEW_DEVICE_DEFAULTS.excludePortalNetworks,
    excludeNetworks: Array.isArray(p.excludeNetworks)
      ? p.excludeNetworks.filter((n): n is string => typeof n === 'string')
      : [],
  }
}

/** Locally administered (the second-least-significant bit of the first octet): a randomised MAC. */
export function isRandomizedMac(mac: string): boolean {
  const first = Number.parseInt(mac.slice(0, 2), 16)
  return Number.isFinite(first) && (first & 0x02) !== 0
}

export type NewDeviceCandidate = {
  mac: string
  firstSeenAt: string
  /** Its `device_network_latest.network` (any gateway), null when unknown. */
  network: string | null
}

export type NewDeviceExclusions = {
  /** Labelled, group members, map boxes and the agents' own MACs, lowercase. */
  known: ReadonlySet<string>
  /** UCI names of the networks that host a live portal. */
  portalNetworks: ReadonlySet<string>
  /** MACs that already had a `device.new` alert (any state). */
  alerted: ReadonlySet<string>
}

/**
 * Which candidates become alerts this scan, oldest first. At most `cap`;
 * the rest stay candidates for the next scan (their first sighting is still
 * in the window for another hour), which rate-limits a flood of invented MACs
 * to one batch a minute.
 */
export function selectNewDevices(
  candidates: NewDeviceCandidate[],
  exclusions: NewDeviceExclusions,
  params: NewDeviceParams,
  cap = MAX_NEW_PER_SCAN
): { chosen: NewDeviceCandidate[]; deferred: number } {
  const excluded = new Set(params.excludeNetworks)
  const eligible = candidates
    .filter((c) => {
      if (exclusions.alerted.has(c.mac) || exclusions.known.has(c.mac)) return false
      if (params.ignoreRandomizedMacs && isRandomizedMac(c.mac)) return false
      if (c.network !== null && excluded.has(c.network)) return false
      if (
        params.excludePortalNetworks &&
        c.network !== null &&
        exclusions.portalNetworks.has(c.network)
      ) {
        return false
      }
      return true
    })
    .sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : 0))
  return { chosen: eligible.slice(0, cap), deferred: Math.max(0, eligible.length - cap) }
}

async function newDeviceCandidates(minPresenceMinutes: number): Promise<NewDeviceCandidate[]> {
  const rows = rawRows<{ mac: string; firstSeen: string }>(
    await db.rawQuery(
      `SELECT mac,
              DATE_FORMAT(MIN(first_seen_at), ${ISO_FORMAT}) AS firstSeen,
              MIN(first_seen_at) AS first_seen,
              MAX(last_seen_at) AS last_seen
         FROM device_identities
        GROUP BY mac
       HAVING first_seen >= UTC_TIMESTAMP() - INTERVAL ? MINUTE
          AND TIMESTAMPDIFF(MINUTE, first_seen, last_seen) >= ?`,
      [minPresenceMinutes + 60, minPresenceMinutes]
    )
  )
  if (rows.length === 0) return []
  const macs = [...new Set(rows.map((row) => row.mac.toLowerCase()))]
  const networks = (await db
    .from('device_network_latest')
    .whereIn('mac', macs)
    .orderBy('seen_at', 'desc')
    .select('mac', 'network')) as Array<{ mac: string; network: string }>
  const networkByMac = new Map<string, string>()
  for (const row of networks) {
    const mac = row.mac.toLowerCase()
    if (!networkByMac.has(mac)) networkByMac.set(mac, row.network)
  }
  return rows.map((row) => ({
    mac: row.mac.toLowerCase(),
    firstSeenAt: row.firstSeen,
    network: networkByMac.get(row.mac.toLowerCase()) ?? null,
  }))
}

/** MACs the admin already knows: labelled, in a device group, on the map, an agent's own. */
async function knownMacs(): Promise<Set<string>> {
  const [labels, members, boxes, aps] = await Promise.all([
    db.from('device_labels').select('mac') as Promise<Array<{ mac: string }>>,
    db.from('device_group_members').select('mac') as Promise<Array<{ mac: string }>>,
    db.from('infra_nodes').whereNotNull('device_mac').select('device_mac as mac') as Promise<
      Array<{ mac: string }>
    >,
    db.from('wifi_access_points').select('agent_info') as Promise<Array<{ agent_info: unknown }>>,
  ])
  const known = new Set<string>()
  for (const row of [...labels, ...members, ...boxes]) known.add(String(row.mac).toLowerCase())
  for (const ap of aps) {
    const macs = parseJsonObject(ap.agent_info)?.macs
    if (!Array.isArray(macs)) continue
    for (const mac of macs) if (typeof mac === 'string') known.add(mac.toLowerCase())
  }
  return known
}

/** UCI names of the networks a live portal runs on (portal → gateway network by Perch id). */
async function portalNetworkNames(): Promise<Set<string>> {
  const rows = rawRows<{ network: string | null }>(
    await db.rawQuery(
      `SELECT gn.network
         FROM portals p
         JOIN gateway_networks gn
           ON gn.gateway_id = p.gateway_id AND gn.interface_perch_id = p.network_perch_id
        WHERE p.deleted_at IS NULL`
    )
  )
  return new Set(rows.flatMap((row) => (row.network ? [row.network] : [])))
}

async function alreadyAlerted(macs: string[]): Promise<Set<string>> {
  if (macs.length === 0) return new Set()
  const rows = (await db
    .from('alerts')
    .where('type', NEW_TYPE)
    .whereIn(
      'dedupe_key',
      macs.map((mac) => deviceKey(NEW_TYPE, mac))
    )
    .select('dedupe_key')) as Array<{ dedupe_key: string }>
  return new Set(rows.map((row) => row.dedupe_key.slice(deviceKey(NEW_TYPE, '').length)))
}

async function newDevicePayloads(chosen: NewDeviceCandidate[]) {
  const macs = chosen.map((c) => c.mac)
  const presence = await getPresenceSettings()
  const [ips, wifi] = await Promise.all([
    db
      .from('device_identities')
      .whereIn('mac', macs)
      .whereNotNull('primary_ip')
      .orderBy('last_seen_at', 'desc')
      .select('mac', 'primary_ip') as Promise<Array<{ mac: string; primary_ip: string }>>,
    queryLatestWifiContext(macs, presence),
  ])
  const ipByMac = new Map<string, string>()
  for (const row of ips) {
    const mac = row.mac.toLowerCase()
    if (!ipByMac.has(mac)) ipByMac.set(mac, row.primary_ip)
  }
  const names = await getHostnameMatches(
    macs.map((mac) => ({ mac, primaryIp: ipByMac.get(mac) ?? null, ips: [] }))
  )
  return chosen.map((c, i) => {
    const station = wifi.get(c.mac)
    return {
      mac: c.mac,
      name: names[i]?.hostname ?? null,
      ip: ipByMac.get(c.mac) ?? null,
      network: c.network,
      via: station ? 'wifi' : 'lan',
      apName: station?.apName ?? null,
      ssid: station?.ssid ?? null,
      firstSeenAt: c.firstSeenAt,
      randomized: isRandomizedMac(c.mac),
    }
  })
}

export async function runNewDevices(ctx: DetectorContext): Promise<number> {
  const rule = ctx.rule(NEW_TYPE)
  // Disabled: nothing is recorded, so "one per MAC ever" could not hold back a repeat.
  if (!rule.enabled) return 0
  const params = newDeviceParams(rule.params)
  const candidates = await newDeviceCandidates(params.minPresenceMinutes)
  if (candidates.length === 0) return 0
  const [known, portalNetworks, alerted] = await Promise.all([
    knownMacs(),
    params.excludePortalNetworks ? portalNetworkNames() : Promise.resolve(new Set<string>()),
    alreadyAlerted(candidates.map((c) => c.mac)),
  ])
  const { chosen } = selectNewDevices(candidates, { known, portalNetworks, alerted }, params)
  if (chosen.length === 0) return 0
  for (const payload of await newDevicePayloads(chosen)) {
    ctx.emit({
      type: NEW_TYPE,
      phase: 'instant',
      subject: { kind: 'device', mac: payload.mac },
      dedupeKey: deviceKey(NEW_TYPE, payload.mac),
      source: 'detector:devices',
      payload,
    })
  }
  return chosen.length
}

// ── watched devices ────────────────────────────────────────────────────────

export type Watch = { mac: string; offline: boolean; arrival: boolean }
export type WatchStatus = 'connected' | 'disconnected'

export type WatchVerdict = {
  /** Watched-for-offline MACs whose `device.offline` holds (raised when new, kept when live). */
  offline: string[]
  /** Watched-for-arrival MACs that went `disconnected → connected` since the last scan. */
  arrivals: string[]
  /** The status to remember per arrival-watched MAC. */
  remember: Record<string, WatchStatus>
}

/**
 * The decision, free of I/O. While an agent is in trouble (a live agent
 * alert, or one silent right now) every device behind it looks gone: no new
 * `device.offline` is raised, a pending one is dropped (it resolves as a
 * blip), an active one stays; the arrival memory is frozen so the agent's
 * return does not read as everyone arriving. Recoveries always go through.
 */
export function evaluateWatches(input: {
  watches: Watch[]
  presence: ReadonlyMap<string, DevicePresence>
  live: ReadonlyMap<string, 'pending' | 'active'>
  previous: Readonly<Record<string, WatchStatus>>
  agentTrouble: boolean
}): WatchVerdict {
  const offline: string[] = []
  const arrivals: string[] = []
  const remember: Record<string, WatchStatus> = {}
  for (const watch of input.watches) {
    const status = input.presence.get(watch.mac)?.status ?? 'disconnected'
    if (watch.offline && status === 'disconnected') {
      const state = input.live.get(deviceKey(OFFLINE_TYPE, watch.mac))
      if (!input.agentTrouble || state === 'active') offline.push(watch.mac)
    }
    if (watch.arrival) {
      const before = input.previous[watch.mac]
      if (input.agentTrouble) {
        if (before !== undefined) remember[watch.mac] = before
        continue
      }
      if (before === 'disconnected' && status === 'connected') arrivals.push(watch.mac)
      remember[watch.mac] = status
    }
  }
  return { offline, arrivals, remember }
}

async function loadWatches(): Promise<Watch[]> {
  const [offline, arrival] = await Promise.all([watchedMacs('offline'), watchedMacs('arrival')])
  const byMac = new Map<string, Watch>()
  const watch = (mac: string) => {
    const key = mac.toLowerCase()
    const entry = byMac.get(key) ?? { mac: key, offline: false, arrival: false }
    byMac.set(key, entry)
    return entry
  }
  for (const mac of offline) watch(mac).offline = true
  for (const mac of arrival) watch(mac).arrival = true
  return [...byMac.values()].slice(0, MAX_WATCHED)
}

/** Is any agent silent now, or any agent alert live? Devices behind it look gone. */
async function agentTrouble(): Promise<boolean> {
  const presence = await getPresenceSettings()
  const [collectors, aps, live] = await Promise.all([
    loadCollectorLiveness(),
    loadApLiveness(presence),
    liveAlerts(AGENT_ALERT_TYPES),
  ])
  return (
    live.size > 0 ||
    monitoredCollectors(collectors).some((c) => c.silent) ||
    monitoredAps(aps).some((a) => a.silent)
  )
}

/** Display names: device label → gateway host name → MAC. */
async function deviceNames(macs: string[]): Promise<Map<string, string>> {
  const [labels, hosts] = await Promise.all([
    getDeviceLabels(macs),
    getHostnameMatches(macs.map((mac) => ({ mac, primaryIp: null, ips: [] }))),
  ])
  return new Map(
    macs.map((mac, i) => [mac, labels.get(mac)?.name || hosts[i]?.hostname || mac] as const)
  )
}

const WATCH_STATE_KEY = 'watch-status'

export async function runWatchedDevices(ctx: DetectorContext): Promise<WatchVerdict> {
  const watches = await loadWatches()
  const live = await liveAlerts([OFFLINE_TYPE])
  if (watches.length === 0) {
    if (live.size > 0) await ctx.reconcile([OFFLINE_TYPE], [])
    return { offline: [], arrivals: [], remember: {} }
  }
  const macs = watches.map((w) => w.mac)
  const presenceSettings = await getPresenceSettings()
  const placements = await loadDeviceAttachments(macs, presenceSettings)
  const onMap = new Map<string, DeviceOnMap>()
  for (const [mac, placement] of placements) onMap.set(mac, placement.onMap)
  const [presence, trouble, previous] = await Promise.all([
    queryDevicePresences(macs, presenceSettings, onMap),
    agentTrouble(),
    ctx.state.get<Record<string, WatchStatus>>(WATCH_STATE_KEY),
  ])

  const verdict = evaluateWatches({
    watches,
    presence,
    live,
    previous: previous ?? {},
    agentTrouble: trouble,
  })

  const needNames = [
    ...verdict.offline.filter((mac) => !live.has(deviceKey(OFFLINE_TYPE, mac))),
    ...verdict.arrivals,
  ]
  const names = needNames.length > 0 ? await deviceNames(needNames) : new Map<string, string>()
  const current: ConditionInput[] = verdict.offline.map((mac) => {
    const raising = !live.has(deviceKey(OFFLINE_TYPE, mac))
    const p = presence.get(mac)
    return {
      type: OFFLINE_TYPE,
      subject: { kind: 'device', mac },
      dedupeKey: deviceKey(OFFLINE_TYPE, mac),
      source: 'detector:devices',
      ...(raising && {
        payload: {
          mac,
          name: names.get(mac) ?? mac,
          via: p?.via ?? null,
          lastSeenAt: p?.lastSeenAt ?? null,
        },
      }),
    }
  })
  await ctx.reconcile([OFFLINE_TYPE], current)

  if (verdict.arrivals.length > 0) {
    const wifi = await queryLatestWifiContext(verdict.arrivals, presenceSettings)
    for (const mac of verdict.arrivals) {
      const p = presence.get(mac)
      const station = wifi.get(mac)
      ctx.emit({
        type: ARRIVED_TYPE,
        phase: 'instant',
        subject: { kind: 'device', mac },
        dedupeKey: deviceKey(ARRIVED_TYPE, mac),
        source: 'detector:devices',
        payload: {
          mac,
          name: names.get(mac) ?? mac,
          via: p?.via ?? null,
          apName: station?.connected ? station.apName : null,
          ssid: station?.connected ? station.ssid : null,
          at: ctx.now.toUTC().toISO(),
        },
      })
    }
  }
  if (JSON.stringify(verdict.remember) !== JSON.stringify(previous ?? {})) {
    await ctx.state.set(WATCH_STATE_KEY, verdict.remember)
  }
  return verdict
}

registerDetector({
  id: 'devices',
  everySeconds: 60,
  types: [NEW_TYPE, OFFLINE_TYPE, ARRIVED_TYPE],
  async run(ctx) {
    await runNewDevices(ctx)
    await runWatchedDevices(ctx)
  },
})
