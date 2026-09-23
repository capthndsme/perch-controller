import Portal from '#models/portal'
import type PortalApiClient from '#models/portal_api_client'
import type { PortalApiScope } from '#models/portal_api_client'
import PortalAuthorization from '#models/portal_authorization'
import PortalGrant from '#models/portal_grant'
import type User from '#models/user'
import { type PortalDelivery, sendPortalPushes } from '#services/portal_agent_sender'
import { PortalError, portalNotFound } from '#services/portal_errors'
import { applyGrantExtension, grantCovers, grantViews } from '#services/portal_grant_admin'
import {
  deviceCurrent,
  emptyPushes,
  endGrants,
  grantGroupLimits,
  grantPushList,
  num,
  transition,
  utc,
} from '#services/portal_grants'
import { runInPortalQueue } from '#services/portal_queue'
import { placeBehindCurrent } from '#services/portal/groups'
import { newGrantLifecycle } from '#services/portal/grant_lifecycle'
import {
  type DurationMode,
  LIVE_GRANT_STATES,
  isLiveState,
  normalizeMac,
} from '#services/portal/types'
import type { GrantView } from '#transformers/portal'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { createHash } from 'node:crypto'

/**
 * The per-MAC authorize API (docs/gateway/portal.md section 11.6): what a
 * paid-hotspot integration such as a coin-operated vending box (or any integration, or an admin for their own
 * devices) calls to put a device online. Shared by `POST
 * /portal/authorizations` and the router relay (decision 22; the socket side
 * calls these functions with `via: 'relay'` and the relaying gateway).
 *
 * Every call is checked against its principal: an API client only acts on
 * its portals, within its scopes and per-call caps, only on grants it made,
 * and never beyond `maxActiveGrants`. An admin token acts on any portal.
 */

export type PortalPrincipal =
  | { kind: 'client'; key: string; client: PortalApiClient }
  | { kind: 'user'; key: string; user: User }

export function clientPrincipal(client: PortalApiClient): PortalPrincipal {
  return { kind: 'client', key: `c:${client.id}`, client }
}

export function userPrincipal(user: User): PortalPrincipal {
  return { kind: 'user', key: `u:${user.id}`, user }
}

export type AuthorizeCallContext = {
  via: 'http' | 'relay'
  /** Caller's address (HTTP) or the guest-side address the router saw (relay). */
  address: string | null
  /** Relay only: the gateway the request came through; other gateways' portals are refused. */
  gatewayId?: number
}

export type AuthorizeInput = {
  portalId: number
  mac: string
  minutes?: number | null
  bytes?: number | null
  durationMode?: DurationMode
  downKbps?: number | null
  upKbps?: number | null
  mode?: 'extend' | 'replace'
  externalRef?: string | null
  note?: string | null
}

export type AuthorizeResult = {
  status: 200 | 201
  grant: GrantView | null
  delivery: PortalDelivery
  outcome: 'created' | 'extended' | 'replayed'
}

export function requireScope(principal: PortalPrincipal, scope: PortalApiScope): void {
  if (principal.kind === 'user') return
  if (!(principal.client.scopes ?? []).includes(scope)) {
    throw new PortalError(403, 'scope_required', `This API client lacks the "${scope}" scope.`, {
      scope,
    })
  }
}

/** The portal, when the principal may act on it (403 before 404: ids are not probed). */
async function accessiblePortal(
  principal: PortalPrincipal,
  portalId: number,
  context: AuthorizeCallContext
): Promise<Portal> {
  if (principal.kind === 'client' && !(principal.client.portalIds ?? []).includes(portalId)) {
    throw notAllowed(portalId)
  }
  const portal = await Portal.query().where('id', portalId).whereNull('deleted_at').first()
  if (!portal) throw portalNotFound(portalId)
  if (context.gatewayId !== undefined && portal.gatewayId !== context.gatewayId) {
    throw notAllowed(portalId)
  }
  return portal
}

function notAllowed(portalId: number): PortalError {
  return new PortalError(
    403,
    'portal_not_allowed',
    `This token may not act on portal ${portalId}.`,
    {
      portalId,
    }
  )
}

function parseMac(input: string): string {
  const mac = normalizeMac(input)
  if (!mac) throw new PortalError(422, 'invalid_mac', `"${input}" is not a device MAC address.`)
  return mac
}

/** SHA-256 of the fields that make two calls "the same call" for idempotency. */
export function authorizeRequestSha(input: AuthorizeInput, mac: string): string {
  const canonical = JSON.stringify([
    input.portalId,
    mac,
    input.minutes ?? null,
    input.bytes ?? null,
    input.durationMode ?? 'wall_clock',
    input.downKbps ?? null,
    input.upKbps ?? null,
    input.mode ?? 'extend',
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * The principal's own non-ended API/admin grants for the device on the
 * portal. A client owns the grants it made; an admin owns every API or admin
 * grant.
 */
async function ownGrants(
  trx: TransactionClientContract,
  principal: PortalPrincipal,
  portalId: number,
  mac: string
): Promise<PortalGrant[]> {
  const query = PortalGrant.query({ client: trx })
    .where('portal_id', portalId)
    .where('mac', mac)
    .whereNot('state', 'ended')
    .whereIn('source', ['api', 'admin'])
    .forUpdate()
  if (principal.kind === 'client') query.where('api_client_id', principal.client.id)
  return query
}

function checkCaps(principal: PortalPrincipal, input: AuthorizeInput): void {
  if (!input.minutes && !input.bytes) {
    throw new PortalError(422, 'no_limit', 'An authorization needs `minutes`, `bytes`, or both.')
  }
  if (principal.kind !== 'client') return
  const c = principal.client
  if (input.minutes && input.minutes > c.maxMinutesPerCall) {
    throw new PortalError(
      422,
      'limit_exceeded',
      `At most ${c.maxMinutesPerCall} minutes per call for this client.`,
      { field: 'minutes', max: c.maxMinutesPerCall }
    )
  }
  if (input.bytes && input.bytes > num(c.maxBytesPerCall)) {
    throw new PortalError(
      422,
      'limit_exceeded',
      `At most ${num(c.maxBytesPerCall)} bytes per call for this client.`,
      { field: 'bytes', max: num(c.maxBytesPerCall) }
    )
  }
}

type Ledger = { grantId: number | null; requestSha: string }

async function findLedger(
  principal: PortalPrincipal,
  externalRef: string,
  client?: TransactionClientContract
): Promise<Ledger | null> {
  const row = await PortalAuthorization.query({ client })
    .where('principal', principal.key)
    .where('external_ref', externalRef)
    .first()
  return row
    ? { grantId: row.grantId === null ? null : num(row.grantId), requestSha: row.requestSha }
    : null
}

async function replay(ledger: Ledger, sha: string): Promise<AuthorizeResult> {
  if (ledger.requestSha !== sha) {
    throw new PortalError(
      409,
      'idempotency_conflict',
      'This externalRef was already used for a different request.'
    )
  }
  const grant = ledger.grantId === null ? null : await PortalGrant.find(ledger.grantId)
  const [view] = grant ? await grantViews([grant]) : [null]
  return {
    status: 200,
    grant: view,
    delivery: grant?.delivery === 'pending' ? 'pending' : 'applied',
    outcome: 'replayed',
  }
}

/**
 * `POST /portal/authorizations`. `mode: 'extend'` (default) grows the
 * principal's own grant for the device when it has the limits the call adds
 * (time to a timed grant of the same duration mode, bytes to a quota);
 * otherwise, and with `mode: 'replace'` (which first ends the principal's own
 * grants for the device, `replaced`), a new grant is made. A new grant runs
 * at once when the device has nothing current on the portal; else it stacks
 * by decision 23 (time before data buckets), and a queued wall clock only
 * starts when its turn comes, so paid time never runs down unused.
 */
export async function authorizeDevice(
  principal: PortalPrincipal,
  input: AuthorizeInput,
  context: AuthorizeCallContext
): Promise<AuthorizeResult> {
  requireScope(principal, 'authorize')
  const portal = await accessiblePortal(principal, input.portalId, context)
  const mac = parseMac(input.mac)
  checkCaps(principal, input)
  const sha = authorizeRequestSha(input, mac)
  const externalRef = input.externalRef ?? null

  return runInPortalQueue(portal.gatewayId, async () => {
    if (externalRef) {
      const ledger = await findLedger(principal, externalRef)
      if (ledger) return replay(ledger, sha)
    }
    const now = Date.now()
    const pushes = emptyPushes()
    let result: { grant: PortalGrant; outcome: 'created' | 'extended' }
    try {
      result = await db.transaction(async (trx) => {
        const out = await applyAuthorization(trx, principal, portal, mac, input, now, pushes)
        await PortalAuthorization.create(
          {
            principal: principal.key,
            apiClientId: principal.kind === 'client' ? principal.client.id : null,
            createdByUserId: principal.kind === 'user' ? principal.user.id : null,
            externalRef,
            portalId: portal.id,
            grantId: num(out.grant.id),
            mac,
            outcome: out.outcome,
            minutes: input.minutes ?? null,
            bytes: input.bytes ?? null,
            requestSha: sha,
            via: context.via,
            address: context.address?.slice(0, 45) ?? null,
          },
          { client: trx }
        )
        if (principal.kind === 'client') {
          await trx
            .from('portal_api_clients')
            .where('id', principal.client.id)
            .update({ last_used_at: utc(now).toSQL({ includeOffset: false }) })
        }
        return out
      })
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY' && externalRef) {
        // The same ref raced in through another gateway's queue.
        const ledger = await findLedger(principal, externalRef)
        if (ledger) return replay(ledger, sha)
        throw new PortalError(
          409,
          'idempotency_conflict',
          'This externalRef was already used for a different request.'
        )
      }
      throw error
    }
    const delivery = await sendPortalPushes(portal.gatewayId, grantPushList(pushes))
    const [view] = await grantViews([result.grant], now)
    return {
      status: result.outcome === 'created' ? 201 : 200,
      grant: view,
      delivery,
      outcome: result.outcome,
    }
  })
}

async function applyAuthorization(
  trx: TransactionClientContract,
  principal: PortalPrincipal,
  portal: Portal,
  mac: string,
  input: AuthorizeInput,
  now: number,
  pushes: ReturnType<typeof emptyPushes>
): Promise<{ grant: PortalGrant; outcome: 'created' | 'extended' }> {
  const durationMode = input.durationMode ?? 'wall_clock'
  let own = await ownGrants(trx, principal, portal.id, mac)
  if (input.mode === 'replace' && own.length) {
    await endGrants(trx, own, 'replaced', now, pushes, { promote: false })
    own = []
  }

  if (input.mode !== 'replace') {
    const target = own
      .filter((g) => grantCovers(g, { ...input, durationMode }))
      .sort(
        (a, b) =>
          Number(isLiveState(b.state)) - Number(isLiveState(a.state)) || num(b.id) - num(a.id)
      )[0]
    if (target) {
      applyGrantExtension(target, input, now)
      if (input.downKbps !== undefined && input.downKbps !== null) target.downKbps = input.downKbps
      if (input.upKbps !== undefined && input.upKbps !== null) target.upKbps = input.upKbps
      if (input.note) target.note = input.note
      await transition(trx, target, { type: 'extend' }, now, pushes)
      target.useTransaction(trx)
      await target.save()
      return { grant: target, outcome: 'extended' }
    }
  }

  if (principal.kind === 'client') {
    const [row] = await trx
      .from('portal_grants')
      .where('api_client_id', principal.client.id)
      .whereNot('state', 'ended')
      .count('* as n')
    if (Number((row as { n: number | string }).n) >= principal.client.maxActiveGrants) {
      throw new PortalError(
        422,
        'too_many_active_grants',
        `This client already holds ${principal.client.maxActiveGrants} live grants.`,
        { max: principal.client.maxActiveGrants }
      )
    }
  }

  const grant = new PortalGrant()
  grant.fill({
    portalId: portal.id,
    mac,
    ip: null,
    hostname: null,
    source: principal.kind === 'client' ? 'api' : 'admin',
    groupKey: 'g:0',
    voucherId: null,
    portalUserId: null,
    apiClientId: principal.kind === 'client' ? principal.client.id : null,
    createdByUserId: principal.kind === 'user' ? principal.user.id : null,
    externalRef: input.externalRef ?? null,
    localRef: null,
    durationMode,
    startedAt: null,
    expiresAt: null,
    timeBudgetSeconds: input.minutes ? input.minutes * 60 : null,
    timeUsedSeconds: 0,
    quotaBytes: input.bytes ?? null,
    bytesUp: 0,
    bytesDown: 0,
    downKbps: input.downKbps ?? null,
    upKbps: input.upKbps ?? null,
    lastSeenAt: null,
    endedAt: null,
    endReason: null,
    note: input.note ?? null,
  })

  const current = await deviceCurrent(trx, portal.id, mac)
  let placement: 'current' | 'queue' | 'swap' = 'current'
  if (current) {
    placement = placeBehindCurrent(current.entitlement, {
      grantId: Number.MAX_SAFE_INTEGER,
      limits: grantGroupLimits(grant),
      createdAt: now,
    })
  }
  const lifecycle = newGrantLifecycle(placement === 'queue')
  grant.state = lifecycle.state
  grant.delivery = lifecycle.delivery
  grant.revision = lifecycle.revision
  if (placement !== 'queue' && durationMode === 'wall_clock' && input.minutes) {
    grant.expiresAt = utc(now + input.minutes * 60_000)
  }
  grant.useTransaction(trx)
  await grant.save()
  grant.groupKey = `g:${num(grant.id)}`
  await grant.save()

  if (placement === 'swap' && current) {
    await transition(trx, current.grant, { type: 'queue' }, now, pushes)
  }
  if (placement !== 'queue') pushes.authorize.add(num(grant.id))
  return { grant, outcome: 'created' }
}

/** `GET /portal/authorizations/:mac?portalId=`: the device's current grant (a client sees only its own). */
export async function deviceAuthorization(
  principal: PortalPrincipal,
  portalId: number,
  macInput: string,
  context: AuthorizeCallContext
): Promise<{ grant: GrantView | null }> {
  requireScope(principal, 'read')
  await accessiblePortal(principal, portalId, context)
  const mac = parseMac(macInput)
  const query = PortalGrant.query()
    .where('portal_id', portalId)
    .where('mac', mac)
    .whereNot('state', 'ended')
  if (principal.kind === 'client') query.where('api_client_id', principal.client.id)
  const grants = await query
  const pick =
    grants
      .filter((g) => (LIVE_GRANT_STATES as readonly string[]).includes(g.state))
      .sort((a, b) => num(a.id) - num(b.id))[0] ??
    grants.sort((a, b) => num(a.id) - num(b.id))[0] ??
    null
  if (!pick) return { grant: null }
  const [view] = await grantViews([pick])
  return { grant: view }
}

/**
 * `DELETE /portal/authorizations/:mac?portalId=`: ends the device's grants
 * (`revoked`): a client's own, or with an admin token every grant of the
 * device on the portal. Answers the grant that was live.
 */
export async function deauthorizeDevice(
  principal: PortalPrincipal,
  portalId: number,
  macInput: string,
  context: AuthorizeCallContext
): Promise<{ grant: GrantView; delivery: PortalDelivery }> {
  requireScope(principal, 'authorize')
  const portal = await accessiblePortal(principal, portalId, context)
  const mac = parseMac(macInput)
  return runInPortalQueue(portal.gatewayId, async () => {
    const now = Date.now()
    const pushes = emptyPushes()
    const ended = await db.transaction(async (trx) => {
      const query = PortalGrant.query({ client: trx })
        .where('portal_id', portalId)
        .where('mac', mac)
        .whereNot('state', 'ended')
        .forUpdate()
      if (principal.kind === 'client') query.where('api_client_id', principal.client.id)
      const grants = await query
      if (!grants.length) {
        throw new PortalError(404, 'no_active_grant', `Device ${mac} has no grant to end here.`)
      }
      const shown =
        grants.find((g) => isLiveState(g.state)) ?? grants.sort((a, b) => num(a.id) - num(b.id))[0]
      await endGrants(trx, grants, 'revoked', now, pushes)
      return shown
    })
    const delivery = await sendPortalPushes(portal.gatewayId, grantPushList(pushes))
    const [view] = await grantViews([ended], now)
    return { grant: view, delivery }
  })
}
