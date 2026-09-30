import { WifiNetworkSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import { column } from '@adonisjs/lucid/orm'
import type {
  Advanced,
  ApScope,
  NetworkOrigin,
  Roaming,
  WifiBand,
  WifiBinding,
  WifiSecurity,
} from '#services/wifi_config/types'

/**
 * A fleet Wi-Fi network (docs/design/wifi controller.md sections 2 and 5.1).
 * The SSID is stored as bytes (`varbinary(32)`, exact comparison) and read
 * as a UTF-8 string, which is what UCI and the agent carry.
 */
export default class WifiNetwork extends WifiNetworkSchema {
  declare security: WifiSecurity
  declare apScope: ApScope
  declare origin: NetworkOrigin

  @column({
    columnName: 'ssid',
    prepare: (value: string | null) => (value === null ? null : Buffer.from(value, 'utf8')),
    consume: (value: Buffer | string | null) => {
      if (value === null || value === undefined) return null
      return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
    },
  })
  declare ssid: string

  @jsonColumn('binding')
  declare binding: WifiBinding

  @jsonColumn('bands')
  declare bands: WifiBand[]

  @jsonColumn('roaming')
  declare roaming: Roaming

  @jsonColumn('advanced')
  declare advanced: Advanced
}
