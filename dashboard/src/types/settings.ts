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

/** Settings → Presence: the thresholds behind "connected right now", all whole numbers. */
export type PresenceThresholds = {
  lanQuietMinutes: number
  wifiTrailingTrafficMinutes: number
  apStaleIntervals: number
  apStaleMinSeconds: number
  nowRateIntervals: number
}

export type PresenceLimits = Record<keyof PresenceThresholds, { min: number; max: number }>

/** `GET` / `PATCH /api/v1/settings/presence`. */
export type PresenceSettingsView = {
  /** The values in force. */
  settings: PresenceThresholds
  defaults: PresenceThresholds
  limits: PresenceLimits
  /** Idle time after which a client its AP still lists stops counting. Fixed, not a setting. */
  wifiIdleSeconds: number
}
