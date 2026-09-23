import { GatewayHostSchema } from '#database/schema'
import { column } from '@adonisjs/lucid/orm'

/**
 * One MAC the router knows, as the Gateway agent last reported it
 * (docs/gateway/observation.md): from its DHCP leases and static hosts
 * (`dhcp` part, `gateway_dhcp.ts`) and its neighbour table (`neighbors`
 * part, `gateway_neighbors.ts`), with the sightings presence reads
 * (`dhcp_seen_at`, `neighbor_seen_at`). A runtime mirror; rows no report
 * lists any more are dropped by the retention task.
 */
export default class GatewayHost extends GatewayHostSchema {
  // Named explicitly: the snake-case naming strategy maps `ipv4` to `ipv_4`.
  @column({ columnName: 'ipv4' })
  declare ipv4: string | null

  @column({ columnName: 'ipv6' })
  declare ipv6: string | null
}
