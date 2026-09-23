import Portal from '#models/portal'
import PortalGrant from '#models/portal_grant'
import PortalUser from '#models/portal_user'
import Voucher from '#models/voucher'
import VoucherBatch from '#models/voucher_batch'
import { AgentRpcError, RPC_ERRORS } from '#services/agent_hub'
import {
  type GrantPushes,
  deviceCurrent,
  emptyPushes,
  endGrants,
  ms,
  num,
  transition,
  userGroupLimits,
  utc,
} from '#services/portal_grants'
import { hashVoucherCode } from '#services/portal_keys'
import { getPortalSettings } from '#services/portal_settings'
import { voucherFacts } from '#services/portal_vouchers'
import { type SlotHolder, evictionsForNewDevice, placeBehindCurrent } from '#services/portal/groups'
import { newGrantLifecycle } from '#services/portal/grant_lifecycle'
import { planUserLogin, planVoucherRedemption } from '#services/portal/redemption'
import { groupKey, isLiveState, normalizeMac } from '#services/portal/types'
import hash from '@adonisjs/core/services/hash'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

/**
 * Guest sign-in through the controller (docs/gateway/portal.md section 13.5):
 * the router's `portal.redeem` (a voucher code typed on the portal page) and
 * `portal.login` (a portal user). Both run inside the gateway's portal queue
 * (the caller's job), change the database in one transaction and return the
 * grant the router applies at once, plus the pushes for the other devices
 * they touched (slot evictions, a data bucket put back in the queue, the
 * offline voucher list), which the caller sends after answering.
 *
 * Refusals are `AgentRpcError(-32000)` with `data.error` from the design's
 * list (`invalid_code | invalid_credentials | expired | exhausted | revoked |
 * disabled | device_limit | wrong_portal | rate_limited`), which the router
 * shows the guest as a message code.
 *
 * Brute force (design section 8): only failures count, per device and portal
 * (`controllerFailuresPerDevicePer15Minutes`) and, for logins, per username
 * on that portal (`controllerFailuresPerUsernamePer15Minutes`), so one guest
 * cannot lock a portal user out of the other portals. Bounded in-process maps.
 */

export const GUEST_ERRORS = [
  'invalid_code',
  'invalid_credentials',
  'expired',
  'exhausted',
  'revoked',
  'disabled',
  'device_limit',
  'already_authorized',
  'wrong_portal',
  'rate_limited',
  'bad_request',
  'controller_unreachable',
] as const
export type GuestError = (typeof GUEST_ERRORS)[number]

const MESSAGES: Record<GuestError, string> = {
  invalid_code: 'That code is not valid.',
  invalid_credentials: 'Wrong username or password.',
  expired: 'That code has expired.',
  exhausted: 'That code is used up.',
  revoked: 'That code was withdrawn.',
  disabled: 'This sign-in method is not available here.',
  device_limit: 'This account is already in use on too many devices.',
  already_authorized: 'This device is already signed in.',
  wrong_portal: 'That code is not valid on this network.',
  rate_limited: 'Too many attempts. Try again later.',
  bad_request: 'The request was malformed.',
  controller_unreachable: 'The controller is busy. Try again in a moment.',
}

export function guestRefusal(code: GuestError, extra: Record<string, unknown> = {}): AgentRpcError {
  return new AgentRpcError(RPC_ERRORS.COMMAND_FAILED, MESSAGES[code], { error: code, ...extra })
}

// ---------------------------------------------------------------------------
// Failure limiter
// ---------------------------------------------------------------------------

const FAILURE_WINDOW_MS = 15 * 60_000
const MAX_TRACKED = 4096
const failures = new Map<string, { count: number; startedAt: number }>()

function failureCount(key: string, now: number): number {
  const w = failures.get(key)
  if (!w) return 0
  if (now - w.startedAt >= FAILURE_WINDOW_MS) {
    failures.delete(key)
    return 0
  }
  return w.count
}

function chargeFailure(key: string, now: number): void {
  const w = failures.get(key)
  if (w && now - w.startedAt < FAILURE_WINDOW_MS) {
    w.count += 1
    failures.delete(key)
    failures.set(key, w)
    return
  }
  failures.delete(key)
  failures.set(key, { count: 1, startedAt: now })
  while (failures.size > MAX_TRACKED) {
    const oldest = failures.keys().next().value
    if (oldest === undefined) break
    failures.delete(oldest)
  }
}

/** Test-only. */
export function _resetPortalGuestLimits(): void {
  failures.clear()
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export type GuestClient = {
  portalId: number
  mac: string
  ip: string | null
  hostname: string | null
  replace: boolean
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function parseClient(params: unknown): { client: GuestClient; raw: Record<string, unknown> } {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw guestRefusal('bad_request')
  }
  const raw = params as Record<string, unknown>
  const portalId = raw.portalId
  const mac = normalizeMac(raw.mac)
  if (typeof portalId !== 'number' || !Number.isSafeInteger(portalId) || portalId < 1 || !mac) {
    throw guestRefusal('bad_request')
  }
  const hostname = str(raw.hostname, 64)
  return {
    client: {
      portalId,
      mac,
      ip: str(raw.ip, 45),
      hostname: hostname && /^[\x20-\x7e]+$/.test(hostname) ? hostname : null,
      replace: raw.replace === true,
    },
    raw,
  }
}

export type GuestSignIn = {
  gatewayId: number
  /** The grant to hand the router, or null when it waits in the queue. */
  grantId: number | null
  queued: boolean
  /** Pushes for everything else the sign-in changed; send after answering. */
  pushes: GrantPushes
}

async function guestPortal(gatewayId: number, portalId: number): Promise<Portal> {
  const portal = await Portal.query()
    .where('id', portalId)
    .where('gateway_id', gatewayId)
    .whereNull('deleted_at')
    .first()
  if (!portal) throw guestRefusal('wrong_portal')
  return portal
}

function newGrant(
  fields: Partial<PortalGrant> & Pick<PortalGrant, 'portalId' | 'mac' | 'source' | 'groupKey'>
): PortalGrant {
  const grant = new PortalGrant()
  grant.fill({
    ip: null,
    hostname: null,
    voucherId: null,
    portalUserId: null,
    apiClientId: null,
    createdByUserId: null,
    externalRef: null,
    localRef: null,
    durationMode: 'wall_clock',
    startedAt: null,
    expiresAt: null,
    timeBudgetSeconds: null,
    timeUsedSeconds: 0,
    quotaBytes: null,
    bytesUp: 0,
    bytesDown: 0,
    downKbps: null,
    upKbps: null,
    lastSeenAt: null,
    endedAt: null,
    endReason: null,
    note: null,
    ...fields,
  })
  return grant
}

function holderOf(g: PortalGrant): SlotHolder & { queued: boolean } {
  return {
    grantId: num(g.id),
    mac: g.mac,
    startedAt: ms(g.startedAt) ?? ms(g.createdAt)!,
    lastSeenAt: ms(g.lastSeenAt),
    queued: g.state === 'queued',
  }
}

/**
 * Places a new grant for the device (decision 23): it runs at once when the
 * device holds nothing live of another group on the portal; a time or open
 * entitlement over a running data bucket swaps with it; anything else queues.
 */
async function placeNewGrant(
  trx: TransactionClientContract,
  grant: PortalGrant,
  now: number,
  pushes: GrantPushes,
  limits: Parameters<typeof placeBehindCurrent>[1]['limits'],
  groupOf: string
): Promise<'current' | 'queue' | 'swap'> {
  const current = await deviceCurrent(trx, grant.portalId, grant.mac)
  let placement: 'current' | 'queue' | 'swap' = 'current'
  if (current && current.grant.groupKey !== groupOf) {
    placement = placeBehindCurrent(current.entitlement, {
      grantId: Number.MAX_SAFE_INTEGER,
      limits,
      createdAt: now,
    })
  }
  const lifecycle = newGrantLifecycle(placement === 'queue')
  grant.state = lifecycle.state
  grant.delivery = lifecycle.delivery
  grant.revision = lifecycle.revision
  grant.useTransaction(trx)
  await grant.save()
  if (placement === 'swap' && current) {
    await transition(trx, current.grant, { type: 'queue' }, now, pushes)
  }
  return placement
}

// ---------------------------------------------------------------------------
// portal.redeem
// ---------------------------------------------------------------------------

export async function redeemVoucherOnline(
  gatewayId: number,
  params: unknown,
  now: number = Date.now()
): Promise<GuestSignIn> {
  const { client, raw } = parseClient(params)
  const code = str(raw.code, 64)
  if (!code) throw guestRefusal('invalid_code')
  const portal = await guestPortal(gatewayId, client.portalId)
  if (!portal.methods?.voucher) throw guestRefusal('disabled')

  const settings = await getPortalSettings()
  const deviceKey = `d:${portal.id}|${client.mac}`
  if (failureCount(deviceKey, now) >= settings.controllerFailuresPerDevicePer15Minutes) {
    throw guestRefusal('rate_limited')
  }
  const codeHash = hashVoucherCode(code)
  const found = codeHash ? await Voucher.findBy('codeHash', codeHash) : null
  if (!found) {
    chargeFailure(deviceKey, now)
    throw guestRefusal('invalid_code')
  }

  const pushes = emptyPushes()
  return db.transaction(async (trx) => {
    const voucher = await Voucher.query({ client: trx }).where('id', found.id).forUpdate().first()
    if (!voucher) throw guestRefusal('invalid_code')
    const batch = await VoucherBatch.findOrFail(voucher.batchId, { client: trx })
    const key = groupKey('voucher', voucher.id)
    const holders = await PortalGrant.query({ client: trx })
      .where('group_key', key)
      .whereNot('state', 'ended')
      .forUpdate()
    const current = await deviceCurrent(trx, portal.id, client.mac)
    const plan = planVoucherRedemption({
      now,
      portalId: portal.id,
      mac: client.mac,
      voucher: voucherFacts(voucher, batch),
      holders: holders.map(holderOf),
      deviceCurrent: current && current.grant.groupKey !== key ? current.entitlement : null,
    })
    if (!plan.ok) {
      if (plan.error === 'already_authorized' && plan.grantId !== undefined) {
        // A retry (the router timed out on the first answer, or the guest
        // submitted twice): hand the same grant back.
        const mine = holders.find((h) => num(h.id) === plan.grantId)!
        return {
          gatewayId,
          grantId: isLiveState(mine.state) ? num(mine.id) : null,
          queued: mine.state === 'queued',
          pushes,
        }
      }
      throw guestRefusal(plan.error)
    }

    const evicted = holders.filter((h) => plan.evictGrantIds.includes(num(h.id)))
    await endGrants(trx, evicted, 'moved', now, pushes)

    let voucherChanged = false
    if (plan.bindPortalId !== null && voucher.boundPortalId === null) {
      voucher.boundPortalId = plan.bindPortalId
      voucherChanged = true
    }
    if (plan.firstUse && voucher.firstUsedAt === null) {
      voucher.firstUsedAt = utc(now)
      voucherChanged = true
    }
    if (plan.clock && voucher.expiresAt === null) {
      voucher.startsAt = utc(plan.clock.startsAt)
      voucher.expiresAt = utc(plan.clock.expiresAt)
      voucherChanged = true
    }
    if (voucherChanged) {
      voucher.revision += 1
      voucher.useTransaction(trx)
      await voucher.save()
      pushes.vouchers = true
    }

    const grant = newGrant({
      portalId: portal.id,
      mac: client.mac,
      ip: client.ip,
      hostname: client.hostname,
      source: 'voucher',
      groupKey: key,
      voucherId: voucher.id,
      durationMode: batch.durationMode,
    })
    const limits = voucherFacts(voucher, batch).limits
    const placement = await placeNewGrant(
      trx,
      grant,
      now,
      pushes,
      {
        durationMode: limits.durationMode,
        expiresAt: limits.durationMode === 'wall_clock' ? limits.expiresAt : null,
        durationSeconds: limits.durationSeconds,
        quotaBytes: limits.quotaBytes,
        downKbps: limits.downKbps,
        upKbps: limits.upKbps,
        maxDevices: limits.maxDevices,
      },
      key
    )
    return {
      gatewayId,
      grantId: placement === 'queue' ? null : num(grant.id),
      queued: placement === 'queue',
      pushes,
    }
  })
}

// ---------------------------------------------------------------------------
// portal.login
// ---------------------------------------------------------------------------

let dummyHash: Promise<string> | null = null

/** Spends the same work on an unknown username as on a wrong password. */
async function burnVerify(password: string): Promise<void> {
  dummyHash ??= hash.make('perch-portal-not-a-user')
  await hash.verify(await dummyHash, password)
}

export async function loginPortalUser(
  gatewayId: number,
  params: unknown,
  now: number = Date.now()
): Promise<GuestSignIn> {
  const { client, raw } = parseClient(params)
  const username = str(raw.username, 64)?.trim().toLowerCase() ?? null
  const password = str(raw.password, 128)
  if (!username || !password) throw guestRefusal('invalid_credentials')
  const portal = await guestPortal(gatewayId, client.portalId)
  if (!portal.methods?.password) throw guestRefusal('disabled')

  const settings = await getPortalSettings()
  const deviceKey = `d:${portal.id}|${client.mac}`
  const userKey = `n:${portal.id}|${username}`
  if (
    failureCount(deviceKey, now) >= settings.controllerFailuresPerDevicePer15Minutes ||
    failureCount(userKey, now) >= settings.controllerFailuresPerUsernamePer15Minutes
  ) {
    throw guestRefusal('rate_limited')
  }
  const user = await PortalUser.findBy('username', username)
  const valid = user ? await user.verifyPassword(password) : (await burnVerify(password), false)
  if (!user || !valid) {
    chargeFailure(deviceKey, now)
    chargeFailure(userKey, now)
    throw guestRefusal('invalid_credentials')
  }

  const pushes = emptyPushes()
  return db.transaction(async (trx) => {
    const key = groupKey('user', user.id)
    const holders = await PortalGrant.query({ client: trx })
      .where('group_key', key)
      .whereNot('state', 'ended')
      .forUpdate()
    let plan = planUserLogin({
      now,
      portalId: portal.id,
      mac: client.mac,
      user: {
        enabled: Boolean(user.enabled),
        portalIds: user.portalIds,
        maxDevices: user.maxDevices,
        sessionMinutes: user.sessionMinutes,
      },
      holders: holders.map(holderOf),
      unseenMinutes: settings.deviceUnseenEvictMinutes,
    })
    if (!plan.ok && plan.error === 'device_limit' && client.replace) {
      // The guest confirmed "sign the other device out": the device that
      // joined first leaves, however recently it was seen.
      const evict =
        evictionsForNewDevice(holders.map(holderOf), user.maxDevices, 'oldest', now, 0) ?? []
      plan = {
        ok: true,
        evictGrantIds: evict,
        expiresAt: user.sessionMinutes === null ? null : now + user.sessionMinutes * 60_000,
      }
    }
    if (!plan.ok) {
      if (plan.error === 'already_authorized' && plan.grantId !== undefined) {
        const mine = holders.find((h) => num(h.id) === plan.grantId)!
        return {
          gatewayId,
          grantId: isLiveState(mine.state) ? num(mine.id) : null,
          queued: mine.state === 'queued',
          pushes,
        }
      }
      throw guestRefusal(plan.error === 'wrong_portal' ? 'wrong_portal' : plan.error)
    }
    const evictIds = plan.evictGrantIds
    await endGrants(
      trx,
      holders.filter((h) => evictIds.includes(num(h.id))),
      'replaced',
      now,
      pushes
    )

    const grant = newGrant({
      portalId: portal.id,
      mac: client.mac,
      ip: client.ip,
      hostname: client.hostname,
      source: 'user',
      groupKey: key,
      portalUserId: user.id,
      expiresAt: plan.expiresAt === null ? null : utc(plan.expiresAt),
    })
    const limits = userGroupLimits(user)
    const placement = await placeNewGrant(
      trx,
      grant,
      now,
      pushes,
      { ...limits, expiresAt: plan.expiresAt },
      key
    )
    await trx
      .from('portal_users')
      .where('id', user.id)
      .update({ last_login_at: utc(now).toSQL({ includeOffset: false }) })
    return {
      gatewayId,
      grantId: placement === 'queue' ? null : num(grant.id),
      queued: placement === 'queue',
      pushes,
    }
  })
}
