import { PortalApiClientSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import { column } from '@adonisjs/lucid/orm'

export const PORTAL_API_SCOPES = ['authorize', 'read'] as const
export type PortalApiScope = (typeof PORTAL_API_SCOPES)[number]

/**
 * An integration token for the authorize API (docs/gateway/portal.md
 * section 5). Only the token's SHA-256 is stored.
 */
export default class PortalApiClient extends PortalApiClientSchema {
  @column({ serializeAs: null })
  declare tokenHash: string

  @jsonColumn('scopes')
  declare scopes: PortalApiScope[]

  @jsonColumn('portal_ids')
  declare portalIds: number[]
}
