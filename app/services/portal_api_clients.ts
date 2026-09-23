import Portal from '#models/portal'
import PortalApiClient, { type PortalApiScope } from '#models/portal_api_client'
import { PortalError, apiClientNotFound, portalNotFound } from '#services/portal_errors'
import { apiClientView } from '#transformers/portal'
import { firstOf } from '#services/portal_params'
import db from '@adonisjs/lucid/services/db'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { DateTime } from 'luxon'

/**
 * Integration tokens of the authorize API (docs/gateway/portal.md section
 * 11.6): paid-hotspot integrations such as coin-operated vending boxes, and
 * other systems that grant guests
 * access. A token is `perch_pa_` + 32 base64url characters (192 random bits);
 * only its SHA-256 is stored, it is shown once (create, rotate). A client is
 * scoped to its portals, its scopes, per-call caps and a cap on its live
 * grants. Only admins manage clients; a client can never manage anything.
 */

export const PORTAL_API_TOKEN_PREFIX = 'perch_pa_'
const TOKEN_RANDOM_BYTES = 24
const TOKEN_REGEX = /^perch_pa_[A-Za-z0-9_-]{32}$/
/** `perch_pa_` + 4 characters: enough to recognize a token in a list, useless to guess it. */
const DISPLAY_PREFIX_LENGTH = PORTAL_API_TOKEN_PREFIX.length + 4

export function generatePortalApiToken(): string {
  return PORTAL_API_TOKEN_PREFIX + randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')
}

export function portalApiTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function isPortalApiToken(value: string): boolean {
  return value.startsWith(PORTAL_API_TOKEN_PREFIX)
}

/**
 * The active client a token belongs to, or null (malformed, unknown,
 * revoked). The lookup is by hash (unique index), then compared in constant
 * time.
 */
export async function authenticatePortalApiToken(token: string): Promise<PortalApiClient | null> {
  if (!TOKEN_REGEX.test(token)) return null
  const hash = portalApiTokenHash(token)
  const client = await PortalApiClient.query().where('token_hash', hash).first()
  if (!client || client.revokedAt) return null
  const stored = Buffer.from(client.tokenHash, 'hex')
  const presented = Buffer.from(hash, 'hex')
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) return null
  return client
}

export type ApiClientInput = {
  name: string
  portalIds: number[]
  scopes: PortalApiScope[]
  maxMinutesPerCall?: number
  maxBytesPerCall?: number
  maxActiveGrants?: number
}

async function checkPortals(portalIds: number[]): Promise<number[]> {
  const ids = [...new Set(portalIds)].sort((a, b) => a - b)
  const found = await Portal.query().whereIn('id', ids).whereNull('deleted_at').select('id')
  const known = new Set(found.map((p) => p.id))
  const missing = ids.find((id) => !known.has(id))
  if (missing !== undefined) throw portalNotFound(missing)
  return ids
}

async function activeGrantCounts(clientIds: number[]): Promise<Map<number, number>> {
  if (!clientIds.length) return new Map()
  const rows = (await db
    .from('portal_grants')
    .whereIn('api_client_id', clientIds)
    .whereNot('state', 'ended')
    .groupBy('api_client_id')
    .select('api_client_id')
    .count('* as n')) as Array<{ api_client_id: number; n: number | string }>
  return new Map(rows.map((r) => [r.api_client_id, Number(r.n)]))
}

export async function apiClientViews(clients: PortalApiClient[]) {
  const counts = await activeGrantCounts(clients.map((c) => c.id))
  return clients.map((c) => apiClientView(c, counts.get(c.id) ?? 0))
}

export async function listApiClients() {
  return apiClientViews(await PortalApiClient.query().orderBy('id'))
}

async function findClient(id: number): Promise<PortalApiClient> {
  const client = await PortalApiClient.find(id)
  if (!client) throw apiClientNotFound(id)
  return client
}

export async function createApiClient(input: ApiClientInput, createdByUserId: number | null) {
  const portalIds = await checkPortals(input.portalIds)
  const token = generatePortalApiToken()
  const client = await PortalApiClient.create({
    name: input.name,
    tokenHash: portalApiTokenHash(token),
    tokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
    scopes: [...new Set(input.scopes)].sort(),
    portalIds,
    maxMinutesPerCall: input.maxMinutesPerCall ?? 1440,
    maxBytesPerCall: input.maxBytesPerCall ?? 10_000_000_000,
    maxActiveGrants: input.maxActiveGrants ?? 500,
    createdByUserId,
    lastUsedAt: null,
    revokedAt: null,
  })
  return { client: await firstOf(apiClientViews([client])), token }
}

export async function updateApiClient(id: number, input: Partial<ApiClientInput>) {
  const client = await findClient(id)
  if (client.revokedAt) {
    throw new PortalError(409, 'api_client_revoked', `API client ${id} is revoked.`)
  }
  if (input.name !== undefined) client.name = input.name
  if (input.portalIds !== undefined) client.portalIds = await checkPortals(input.portalIds)
  if (input.scopes !== undefined) client.scopes = [...new Set(input.scopes)].sort()
  if (input.maxMinutesPerCall !== undefined) client.maxMinutesPerCall = input.maxMinutesPerCall
  if (input.maxBytesPerCall !== undefined) client.maxBytesPerCall = input.maxBytesPerCall
  if (input.maxActiveGrants !== undefined) client.maxActiveGrants = input.maxActiveGrants
  await client.save()
  return await firstOf(apiClientViews([client]))
}

/** A new token for the same client; the old one stops working at once. */
export async function rotateApiClient(id: number) {
  const client = await findClient(id)
  if (client.revokedAt) {
    throw new PortalError(409, 'api_client_revoked', `API client ${id} is revoked.`)
  }
  const token = generatePortalApiToken()
  client.tokenHash = portalApiTokenHash(token)
  client.tokenPrefix = token.slice(0, DISPLAY_PREFIX_LENGTH)
  await client.save()
  return { client: await firstOf(apiClientViews([client])), token }
}

/**
 * Revokes the client: its token stops working at once. The grants it made
 * stay (a guest keeps the time that was paid for); end them from the grants
 * list if needed.
 */
export async function revokeApiClient(id: number): Promise<void> {
  const client = await findClient(id)
  if (client.revokedAt) return
  client.revokedAt = DateTime.utc()
  await client.save()
}
