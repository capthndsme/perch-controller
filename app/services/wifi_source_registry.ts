import WifiAccessPoint, { type WifiAccessPointStatus } from '#models/wifi_access_point'
import hub, { AgentOfflineError, AgentTimeoutError, CLOSE_CODES } from '#services/ap_agent_hub'
import { sendAgentConfigure } from '#services/ap_agent_metrics'
import { recordSystemInfo, type SystemInfoResult } from '#services/ap_agent_registry'
import { probeWifiAccessPoint } from '#services/wifi_access_point_probe'
import { DateTime } from 'luxon'

export type WifiSourceInput = {
  name: string
  friendlyName?: string | null
  metricsUrl: string
  pollIntervalSeconds?: number
  enabled?: boolean
  enableTwoWayCommands?: boolean
  sshHost?: string | null
  sshPort?: number
  sshUsername?: string | null
  sshPrivateKey?: string | null
}

export type WifiSourceUpdateInput = Partial<WifiSourceInput>

/**
 * Returns registered WiFi sources sorted by display name.
 */
export async function listWifiAccessPoints(options: { includeDisabled?: boolean } = {}) {
  const query = WifiAccessPoint.query().orderByRaw('COALESCE(friendly_name, name) ASC')
  if (!options.includeDisabled) {
    query.where('enabled', true)
  }
  return query
}

/**
 * Creates a WiFi source and persists the first probe outcome immediately so
 * operators can see "saved but unreachable" vs "saved and healthy".
 */
export async function createWifiAccessPoint(input: WifiSourceInput): Promise<{
  source: WifiAccessPoint
  probe: Awaited<ReturnType<typeof probeWifiAccessPoint>>
}> {
  const probe = await probeWifiAccessPoint(input.metricsUrl)
  const source = await WifiAccessPoint.create({
    name: input.name,
    friendlyName: input.friendlyName ?? null,
    metricsUrl: input.metricsUrl,
    pollIntervalSeconds: input.pollIntervalSeconds ?? 15,
    enabled: input.enabled ?? true,
    enableTwoWayCommands: input.enableTwoWayCommands ?? false,
    sshHost: input.sshHost ?? null,
    sshPort: input.sshPort ?? 22,
    sshUsername: input.sshUsername ?? null,
    sshPrivateKey: input.sshPrivateKey ?? null,
    model: probe.model ?? null,
    openwrtRelease: probe.openwrtRelease ?? null,
    nodename: probe.nodename ?? null,
    lastSeenAt: probe.ok ? DateTime.fromISO(probe.checkedAt, { zone: 'utc' }) : null,
    lastStatus: probe,
  })

  return { source, probe }
}

/**
 * Updates WiFi source configuration. Callers can request an immediate probe
 * to validate new connectivity details.
 */
export async function updateWifiAccessPoint(
  source: WifiAccessPoint,
  input: WifiSourceUpdateInput,
  options: { probeAfterUpdate?: boolean } = {}
): Promise<{
  source: WifiAccessPoint
  probe: Awaited<ReturnType<typeof probeWifiAccessPoint>> | null
}> {
  // An agent's push schedule follows these two; it is re-sent below.
  const scheduleChanged =
    (input.pollIntervalSeconds !== undefined &&
      input.pollIntervalSeconds !== source.pollIntervalSeconds) ||
    (input.enabled !== undefined && input.enabled !== Boolean(source.enabled))

  if (input.name !== undefined) source.name = input.name
  if (input.friendlyName !== undefined) source.friendlyName = input.friendlyName
  if (input.metricsUrl !== undefined) source.metricsUrl = input.metricsUrl
  if (input.pollIntervalSeconds !== undefined)
    source.pollIntervalSeconds = input.pollIntervalSeconds
  if (input.enabled !== undefined) source.enabled = input.enabled
  if (input.enableTwoWayCommands !== undefined) {
    source.enableTwoWayCommands = input.enableTwoWayCommands
  }
  if (input.sshHost !== undefined) source.sshHost = input.sshHost
  if (input.sshPort !== undefined) source.sshPort = input.sshPort
  if (input.sshUsername !== undefined) source.sshUsername = input.sshUsername
  if (input.sshPrivateKey !== undefined) source.sshPrivateKey = input.sshPrivateKey

  let probe: WifiAccessPointStatus | null = null
  if (options.probeAfterUpdate ?? true) {
    probe = await probeSource(source)
    source.lastStatus = probe
    if (probe.ok) {
      source.lastSeenAt = DateTime.fromISO(probe.checkedAt, { zone: 'utc' })
      source.model = probe.model ?? source.model
      source.openwrtRelease = probe.openwrtRelease ?? source.openwrtRelease
      source.nodename = probe.nodename ?? source.nodename
    }
  }

  await source.save()
  if (scheduleChanged && source.transport === 'agent') sendAgentConfigure(source)
  return { source, probe }
}

/**
 * Runs an explicit probe on an existing source and stores the result.
 */
export async function probeWifiAccessPointById(source: WifiAccessPoint) {
  const probe = await probeSource(source)
  source.lastStatus = probe
  if (probe.ok) {
    source.lastSeenAt = DateTime.fromISO(probe.checkedAt, { zone: 'utc' })
    source.model = probe.model ?? source.model
    source.openwrtRelease = probe.openwrtRelease ?? source.openwrtRelease
    source.nodename = probe.nodename ?? source.nodename
  }
  await source.save()
  return probe
}

/**
 * Deletes a source; cascades remove historical WiFi rows for that AP. An
 * agent session on it is closed first (4001: its credentials die with it).
 */
export async function deleteWifiAccessPoint(source: WifiAccessPoint): Promise<void> {
  hub.disconnect(source.id, CLOSE_CODES.REVOKED, 'access point deleted')
  await source.delete()
}

/**
 * Probe through whatever the row polls: the metrics URL for scrape rows, the
 * agent (`system.info`, which also refreshes the stored identity) for agent
 * rows.
 */
async function probeSource(source: WifiAccessPoint): Promise<WifiAccessPointStatus> {
  if (source.transport === 'agent') return probeAgentAccessPoint(source)
  if (!source.metricsUrl) {
    return { ok: false, checkedAt: DateTime.utc().toISO()!, error: 'no metrics URL configured' }
  }
  return probeWifiAccessPoint(source.metricsUrl)
}

async function probeAgentAccessPoint(source: WifiAccessPoint): Promise<WifiAccessPointStatus> {
  const checkedAt = DateTime.utc().toISO()!
  const start = performance.now()
  try {
    const info = await hub.request<SystemInfoResult>(
      source.id,
      'system.info',
      {},
      { timeoutMs: 5000 }
    )
    const latencyMs = Math.round(performance.now() - start)
    // Stored on a fresh instance so an update in flight on `source` keeps
    // its pending edits; only the agent fields are copied across.
    const stored =
      info && typeof info === 'object' && !Array.isArray(info)
        ? await recordSystemInfo(source.id, info, source.agentId)
        : null
    if (stored) {
      source.agentInfo = stored.agentInfo
      source.agentVersion = stored.agentVersion
    }
    const identity = stored ?? source
    return {
      ok: true,
      checkedAt,
      latencyMs,
      model: identity.model ?? undefined,
      nodename: identity.nodename ?? undefined,
      openwrtRelease: identity.openwrtRelease ?? undefined,
    }
  } catch (error) {
    const latencyMs = Math.round(performance.now() - start)
    const message =
      error instanceof AgentOfflineError
        ? 'agent offline'
        : error instanceof AgentTimeoutError
          ? error.message
          : error instanceof Error
            ? `agent error: ${error.message}`
            : String(error)
    return { ok: false, checkedAt, latencyMs, error: message }
  }
}
