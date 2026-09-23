export const HOSTNAME_ENRICHMENT_MODE = 'command_execution' as const

export type HostnameEnrichmentTransport = 'lxc' | 'ssh'

type HostnameEnrichmentBase = {
  enabled: boolean
  mode: typeof HOSTNAME_ENRICHMENT_MODE
  transport: HostnameEnrichmentTransport
  leaseFilePath: string
  refreshSeconds: number
  timeoutMs: number
}

export type HostnameEnrichmentSettings =
  | (HostnameEnrichmentBase & {
      transport: 'lxc'
      lxc: {
        containerName: string
      }
    })
  | (HostnameEnrichmentBase & {
      transport: 'ssh'
      ssh: {
        host: string
        port: number
        username: string
        privateKeyPath?: string
      }
    })

/** `GET /api/v1/settings/hostname-enrichment/sources`: where device names come from right now. */
export type HostnameEnrichmentSources = {
  /** Device names come from a gateway agent right now. */
  agentActive: boolean
  /** The lxc/ssh command path: disabled, standing by behind an agent, or running. */
  commandPath: 'off' | 'standby' | 'active'
  agents: Array<{
    collectorId: number
    name: string
    /** Adopted, enabled, reported within 2 h. */
    active: boolean
    online: boolean
    reportedAt: string
    changedAt: string
    leases4: number
    leases6: number
    staticHosts: number
    namedDevices: number
  }>
}

/** Settings → Presence: the thresholds behind "connected right now", all whole numbers. */
export type PresenceThresholds = {
  lanQuietMinutes: number
  wifiTrailingTrafficMinutes: number
  apStaleIntervals: number
  apStaleMinSeconds: number
  nowRateIntervals: number
}

/**
 * The thresholds plus the switches a newer controller adds. `gatewaySightings`
 * (0/1): the gateway's DHCP and neighbour sightings count as traffic
 * (docs/gateway/observation.md §5). Absent on a controller without the
 * gateway observation channel: the form then neither shows nor sends it.
 */
export type PresenceSettings = PresenceThresholds & { gatewaySightings?: number }

export type PresenceLimits = Record<keyof PresenceThresholds, { min: number; max: number }> & {
  gatewaySightings?: { min: number; max: number }
}

/** `GET` / `PATCH /api/v1/settings/presence`. */
export type PresenceSettingsView = {
  /** The values in force. */
  settings: PresenceSettings
  defaults: PresenceSettings
  limits: PresenceLimits
  /** Idle time after which a client its AP still lists stops counting. Fixed, not a setting. */
  wifiIdleSeconds: number
}

/** Settings → Charts: bucket floor and point cap of the per-name traffic series. */
export type ChartSettings = {
  minBucketSeconds: number
  maxPoints: number
}

export type ChartLimits = Record<keyof ChartSettings, { min: number; max: number }>

/** `GET` / `PATCH /api/v1/settings/charts`. */
export type ChartSettingsView = {
  settings: ChartSettings
  defaults: ChartSettings
  limits: ChartLimits
  /** How long the per-poll rows the floor applies to are kept. */
  nativeRetentionDays: number
}

/** Settings → Gateway observation: what the observation channel keeps (docs/gateway/observation.md §6). */
export type GatewayObservationSettings = {
  hostRetentionDays: number
  upnpEventRetentionDays: number
  backupsKept: number
}

/** `GET` / `PATCH /api/v1/settings/gateway-observations`. */
export type GatewayObservationSettingsView = {
  settings: GatewayObservationSettings
  defaults: GatewayObservationSettings
  limits: Record<keyof GatewayObservationSettings, { min: number; max: number }>
}
