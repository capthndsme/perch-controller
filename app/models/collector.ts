import { CollectorSchema } from '#database/schema'
import { column } from '@adonisjs/lucid/orm'
import encryption from '@adonisjs/core/services/encryption'

/**
 * Who put this collector row in the table. Kept as a plain string column
 * (house style for enum-ish columns, see `users.role`) with the union
 * enforced in the app layer.
 */
export const COLLECTOR_SOURCES = ['manual', 'env', 'announced'] as const
export type CollectorSource = (typeof COLLECTOR_SOURCES)[number]

/**
 * Where the row sits in the adoption flow. There is deliberately no
 * `disabled` value — `enabled = false` already is "disabled", and the same
 * state in two columns is guaranteed to drift. "Disabled" in the UI means
 * `lifecycle = 'adopted' AND enabled = false`; `dismissed` exists because a
 * dismissed collector keeps announcing and must not pop back into the
 * pending list.
 */
export const COLLECTOR_LIFECYCLES = ['pending', 'adopted', 'dismissed'] as const
export type CollectorLifecycle = (typeof COLLECTOR_LIFECYCLES)[number]

/**
 * How the collector's data reaches the server (docs/collector-agent.md):
 * `poll` is the HTTP pull, `agent` the WebSocket session the daemon dials
 * and pushes over. Whatever the daemon last introduced itself with wins: an
 * HTTP announce sets `poll`, a socket hello sets `agent`.
 */
export const COLLECTOR_TRANSPORTS = ['poll', 'agent'] as const
export type CollectorTransport = (typeof COLLECTOR_TRANSPORTS)[number]

/** Where the WAN interfaces of a gateway report came from. */
export type GatewayWanSource = 'configured' | 'default-route'

/**
 * The collector's last gateway report (docs/collector-agent.md section 4.2),
 * kept on the row so the Gateway page can name its source after a restart.
 */
export type CollectorGatewayStatus = {
  reportedAt: string
  wanInterfaces: string[]
  wanSource: GatewayWanSource
}

/**
 * Structured result of the most recent probe against this collector. Stored
 * in the DB as JSON text; surfaced to API consumers as the parsed object.
 */
export type CollectorStatus = {
  ok: boolean
  checkedAt: string // ISO timestamp from the prober
  latencyMs?: number
  totalDevices?: number
  captureInterface?: string
  /** Collector build, from `meta.version` on the probed summary. */
  version?: string
  error?: string
  /** Consecutive failed polls. Absent/0 when the last poll succeeded. */
  failures?: number
  /**
   * Set while the collector reports gateway stats (it runs on the router).
   * Carried over from the previous status by every poll or push.
   */
  gateway?: CollectorGatewayStatus
}

/**
 * A registered collector: polled over HTTP, or pushing over its socket.
 * The `api_key` column is AES-encrypted at rest using Adonis encryption
 * (`APP_KEY`); the `last_status` column is JSON-serialised. Both columns
 * are intentionally excluded from automatic schema generation (see
 * `database/schema_rules.ts`) so this model owns their shape.
 */
export default class Collector extends CollectorSchema {
  @column({
    columnName: 'api_key',
    serializeAs: null,
    prepare: (value: string | null) => (value ? encryption.encrypt(value) : null),
    consume: (value: string | null) => {
      if (!value) return null
      try {
        return encryption.decrypt<string>(value) ?? null
      } catch {
        // Tampered or pre-APP_KEY-rotation ciphertext: hide rather than crash.
        return null
      }
    },
  })
  declare apiKey: string | null

  @column({
    columnName: 'last_status',
    prepare: (value: CollectorStatus | null) => (value ? JSON.stringify(value) : null),
    consume: (value: string | null) => {
      if (!value) return null
      try {
        return JSON.parse(value) as CollectorStatus
      } catch {
        return null
      }
    },
  })
  declare lastStatus: CollectorStatus | null
}
