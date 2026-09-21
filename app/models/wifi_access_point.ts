import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import encryption from '@adonisjs/core/services/encryption'

export type WifiAccessPointStatus = {
  ok: boolean
  checkedAt: string
  latencyMs?: number
  error?: string
  metricFamilies?: number
  networksSeen?: number
  stationsSeen?: number
  interfaceBucketsWritten?: number
  model?: string
  nodename?: string
  openwrtRelease?: string
}

/**
 * Where an AP's metrics come from: `scrape` = HTTP `/metrics` (node_exporter
 * or the agent's optional listener), `agent` = the Perch AP Daemon's
 * WebSocket session (docs/ap-controller.md).
 */
export const WIFI_TRANSPORTS = ['scrape', 'agent'] as const
export type WifiTransport = (typeof WIFI_TRANSPORTS)[number]

/**
 * What the agent told us about the device: the join body, merged with every
 * `system.info` answer (perch-apd PROTOCOL.md section 2.2).
 */
export type ApAgentInfo = {
  hostname?: string | null
  model?: string | null
  boardName?: string | null
  system?: string | null
  release?: string | null
  revision?: string | null
  target?: string | null
  arch?: string | null
  kernel?: string | null
  protocol?: number | null
  uptimeSeconds?: number | null
  macs?: string[]
  capabilities?: string[]
  radios?: unknown[]
  interfaces?: unknown[]
}

/**
 * Registered OpenWrt WiFi source. Metrics come from a Prometheus `/metrics`
 * poll (`transport = 'scrape'`) or from a Perch AP Daemon session
 * (`transport = 'agent'`). SSH credentials are optional and only used for
 * two-way commands on scrape rows; agent rows get their commands over the
 * agent session.
 */
export default class WifiAccessPoint extends BaseModel {
  static table = 'wifi_access_points'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column()
  declare friendlyName: string | null

  @column()
  declare metricsUrl: string | null

  @column()
  declare transport: WifiTransport

  @column()
  declare pollIntervalSeconds: number

  @column()
  declare enabled: boolean

  @column()
  declare enableTwoWayCommands: boolean

  @column()
  declare sshHost: string | null

  @column()
  declare sshPort: number

  @column()
  declare sshUsername: string | null

  @column({
    columnName: 'ssh_private_key',
    serializeAs: null,
    prepare: (value: string | null) => (value ? encryption.encrypt(value) : null),
    consume: (value: string | null) => {
      if (!value) return null
      try {
        return encryption.decrypt<string>(value) ?? null
      } catch {
        return null
      }
    },
  })
  declare sshPrivateKey: string | null

  @column()
  declare model: string | null

  @column()
  declare openwrtRelease: string | null

  @column()
  declare nodename: string | null

  @column.dateTime()
  declare lastSeenAt: DateTime | null

  @column({
    columnName: 'last_status',
    prepare: (value: WifiAccessPointStatus | null) => (value ? JSON.stringify(value) : null),
    consume: (value: string | null) => {
      if (!value) return null
      try {
        return JSON.parse(value) as WifiAccessPointStatus
      } catch {
        return null
      }
    },
  })
  declare lastStatus: WifiAccessPointStatus | null

  @column()
  declare agentId: string | null

  @column({ serializeAs: null })
  declare agentSecretHash: string | null

  @column()
  declare agentVersion: string | null

  @column({
    columnName: 'agent_info',
    prepare: (value: ApAgentInfo | null) => (value ? JSON.stringify(value) : null),
    consume: (value: string | null) => {
      if (!value) return null
      try {
        return JSON.parse(value) as ApAgentInfo
      } catch {
        return null
      }
    },
  })
  declare agentInfo: ApAgentInfo | null

  @column.dateTime()
  declare agentJoinedAt: DateTime | null

  @column.dateTime()
  declare agentConnectedAt: DateTime | null

  @column.dateTime()
  declare agentDisconnectedAt: DateTime | null

  @column()
  declare agentLastAddress: string | null

  @column()
  declare joinTokenId: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
