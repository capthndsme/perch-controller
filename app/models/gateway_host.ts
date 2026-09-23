import { GatewayHostSchema } from '#database/schema'
import { column } from '@adonisjs/lucid/orm'

/**
 * One MAC the router's DHCP knows, as the Gateway agent last reported it
 * (`observe.dhcp`, docs/collector-agent.md section 4.3): the lease's hostname
 * and addresses and the name of a static `host` section. A runtime mirror,
 * replaced by every changed report; written by `app/services/gateway_dhcp.ts`.
 */
export default class GatewayHost extends GatewayHostSchema {
  // Named explicitly: the snake-case naming strategy maps `ipv4` to `ipv_4`.
  @column({ columnName: 'ipv4' })
  declare ipv4: string | null

  @column({ columnName: 'ipv6' })
  declare ipv6: string | null
}
