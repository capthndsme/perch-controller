import Gateway, { type GatewayPairing } from '#models/gateway'
import type User from '#models/user'
import collectorHub from '#services/collector_agent_hub'
import { planeError } from '#services/gateway_config/errors'
import { recordGatewayEvent } from '#services/gateway_config/events'
import { agentErrorCode, gatewayRequest } from '#services/gateway_config/gateway_agent'
import { getGatewayConfigSettings } from '#services/gateway_config/gateway_config_settings'
import {
  gatewaySession,
  updateSessionSigning,
  writeAccess,
} from '#services/gateway_config/gateway_registry'
import {
  commitmentMatches,
  derivePairingKey,
  generatePairingKeyPair,
  isHex32,
  newPairingNonce,
  pairingKeyId,
  pairingSas,
  x25519Shared,
} from '#services/gateway_config/pairing_crypto'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import hash from '@adonisjs/core/services/hash'
import logger from '@adonisjs/core/services/logger'
import { randomBytes } from 'node:crypto'
import { DateTime } from 'luxon'

/**
 * Pairing for writes over plain HTTP (owner decision 29,
 * docs/gateway/config-plane.md section 4.4). The controller and the router
 * agree on a signing key over the collector socket (X25519, commitment,
 * HKDF); both show a 6-digit code; the admin types the router's code on the
 * controller and confirms on the router (`perch-collector pair confirm
 * <code>`). The derived key then signs the write RPCs instead of the
 * api_key, which is never used for signing. TLS gateways need no pairing.
 *
 *   none ─POST /pairing─► awaiting_confirmation ─admin code ok─► awaiting_router ─router confirms─► paired
 *                           │  router confirms first ──────────────────────────► (admin code) ────► paired
 *                           └ 10 min ► expired        3 wrong codes ► failed     reset/rejoin ► lost
 */

export const PAIRING_TTL_MINUTES = 10
export const PAIRING_MAX_ATTEMPTS = 3
const RPC_TIMEOUT_MS = 10_000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `GatewayPairing` for the API (no key; the code only until paired). */
export function pairingView(gateway: Pick<Gateway, 'pairing'>) {
  const p = currentPairing(gateway)
  if (!p) return null
  return {
    state: p.state,
    pairingId: p.pairingId,
    keyId: p.keyId,
    sas: p.state === 'awaiting_confirmation' || p.state === 'awaiting_router' ? p.sas : null,
    startedAt: p.startedAt,
    expiresAt: p.expiresAt,
    adminConfirmedAt: p.adminConfirmedAt,
    routerConfirmedAt: p.routerConfirmedAt,
    pairedAt: p.pairedAt,
    attemptsLeft: Math.max(0, PAIRING_MAX_ATTEMPTS - p.attempts),
    reason: p.reason ?? null,
  }
}

/** The stored pairing with a pending one past its window read as expired. */
export function currentPairing(gateway: Pick<Gateway, 'pairing'>): GatewayPairing | null {
  const p = gateway.pairing
  if (!p) return null
  const pending = p.state === 'awaiting_confirmation' || p.state === 'awaiting_router'
  if (pending && Date.parse(p.expiresAt) < Date.now()) return { ...p, state: 'expired', sas: null }
  return p
}

/** The paired key (32 bytes) and its id when the pairing is live, for signing. */
export function activePairingKey(
  gateway: Pick<Gateway, 'pairing' | 'pairingKey'>
): { key: Buffer; keyId: string } | null {
  const p = currentPairing(gateway)
  if (!p || p.state !== 'paired' || !gateway.pairingKey) return null
  return { key: Buffer.from(gateway.pairingKey, 'hex'), keyId: p.keyId }
}

async function stepUp(user: User, password: string | undefined) {
  if (!password || !(await hash.verify(user.password, password))) {
    throw planeError(403, 'invalid_password', 'Confirm with your current password.')
  }
}

/**
 * `POST /gateways/:id/pairing`: runs begin + reveal with the router and
 * returns the code to compare. Needs the agent online with write access,
 * the controller's `allowInsecureTransport`, and a transport that is not
 * verified TLS already.
 */
export async function startPairing(gatewayId: number, user: User, password: string | undefined) {
  await stepUp(user, password)
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await Gateway.find(gatewayId)
    if (!gateway) throw planeError(404, 'gateway_not_found', `No gateway with id ${gatewayId}.`)
    const session = gatewaySession(gateway.collectorId)
    if (!session) throw planeError(409, 'agent_offline', 'The gateway agent is not connected.')
    if ((session.hello.access ?? gateway.agentAccess) !== 'write') {
      throw planeError(
        409,
        'router_access_insufficient',
        "The router's config_access is not write."
      )
    }
    const settings = await getGatewayConfigSettings()
    if (session.secure === true && session.hello.transportOk === true) {
      throw planeError(409, 'pairing_not_needed', 'This gateway talks over verified TLS.')
    }
    if (!settings.allowInsecureTransport) {
      throw planeError(
        409,
        'insecure_transport',
        'Allow writes over plain HTTP in Settings → Gateway first.'
      )
    }

    if (currentPairing(gateway)?.state === 'paired') {
      throw planeError(409, 'already_paired', 'Unpair first to pair again.')
    }
    const pairingId = randomBytes(8).toString('hex')
    const mine = generatePairingKeyPair()
    let begin: unknown
    try {
      begin = await gatewayRequest(
        gateway,
        'gateway.pair.begin',
        { pairingId, gatewayId: gateway.id, controllerPub: mine.publicKey },
        { timeoutMs: RPC_TIMEOUT_MS }
      )
    } catch (error) {
      throw pairingRefusal(error)
    }
    if (!isObject(begin) || !isHex32(begin.routerPub) || !isHex32(begin.commitment)) {
      throw planeError(502, 'pairing_malformed', 'The router answered pair.begin oddly.')
    }
    const controllerNonce = newPairingNonce()
    let reveal: unknown
    try {
      reveal = await gatewayRequest(
        gateway,
        'gateway.pair.reveal',
        { pairingId, controllerNonce },
        { timeoutMs: RPC_TIMEOUT_MS }
      )
    } catch (error) {
      throw pairingRefusal(error)
    }
    if (!isObject(reveal) || !isHex32(reveal.routerNonce)) {
      throw planeError(502, 'pairing_malformed', 'The router answered pair.reveal oddly.')
    }
    const routerPub = begin.routerPub as string
    const routerNonce = reveal.routerNonce as string
    if (!commitmentMatches(begin.commitment as string, routerNonce, routerPub, mine.publicKey)) {
      await cancelOnRouter(gateway, pairingId)
      await recordGatewayEvent(gateway.id, 'pairing_failed', {
        userId: user.id,
        detail: { reason: 'commitment_mismatch' },
      })
      throw planeError(502, 'pairing_commitment_mismatch', 'The router broke its commitment.')
    }
    let shared: Buffer
    try {
      shared = x25519Shared(mine.privateKey, routerPub)
    } catch {
      throw planeError(502, 'pairing_malformed', 'The router sent an unusable key.')
    }
    const transcript = {
      gatewayId: gateway.id,
      controllerPub: mine.publicKey,
      routerPub,
      controllerNonce,
      routerNonce,
    }
    const key = derivePairingKey(shared, transcript)
    const now = DateTime.utc()
    gateway.pairingKey = key.toString('hex')
    gateway.pairing = {
      state: 'awaiting_confirmation',
      pairingId,
      keyId: pairingKeyId(key),
      sas: pairingSas(transcript),
      startedAt: now.toISO()!,
      expiresAt: now.plus({ minutes: PAIRING_TTL_MINUTES }).toISO()!,
      adminConfirmedAt: null,
      routerConfirmedAt: null,
      pairedAt: null,
      byUserId: user.id,
      attempts: 0,
    }
    await gateway.save()
    await recordGatewayEvent(gateway.id, 'pairing_started', {
      userId: user.id,
      detail: { pairingId, keyId: gateway.pairing.keyId },
    })
    return pairingView(gateway)!
  })
}

function pairingRefusal(error: unknown) {
  const code = agentErrorCode(error)
  if (code) return planeError(409, code, (error as Error).message)
  return error
}

async function cancelOnRouter(gateway: Gateway, pairingId: string) {
  try {
    await gatewayRequest(
      gateway,
      'gateway.pair.cancel',
      { pairingId },
      { timeoutMs: RPC_TIMEOUT_MS }
    )
  } catch {
    // the router's own window expires it
  }
}

/**
 * `POST /gateways/:id/pairing/confirm {code}`: the admin types the code the
 * router shows. A wrong code counts as an attempt (a mismatch means a typo
 * or a man in the middle); three end the pairing.
 */
export async function confirmPairing(gatewayId: number, user: User, code: string) {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await Gateway.find(gatewayId)
    if (!gateway) throw planeError(404, 'gateway_not_found', `No gateway with id ${gatewayId}.`)
    const p = currentPairing(gateway)
    if (!p || (p.state !== 'awaiting_confirmation' && p.state !== 'awaiting_router')) {
      throw planeError(409, 'no_pairing', 'No pairing is waiting for a code.', {
        state: p?.state ?? null,
      })
    }
    if (p.state === 'awaiting_router') return pairingView(gateway)!
    if (code !== p.sas) {
      const attempts = p.attempts + 1
      const failed = attempts >= PAIRING_MAX_ATTEMPTS
      gateway.pairing = {
        ...p,
        attempts,
        ...(failed ? { state: 'failed' as const, sas: null, reason: 'code_mismatch' } : {}),
      }
      if (failed) {
        gateway.pairingKey = null
        await cancelOnRouter(gateway, p.pairingId)
      }
      await gateway.save()
      await recordGatewayEvent(gateway.id, failed ? 'pairing_failed' : 'pairing_code_rejected', {
        userId: user.id,
        detail: { attempts },
      })
      throw planeError(422, 'pairing_code_mismatch', 'The code does not match.', {
        attemptsLeft: Math.max(0, PAIRING_MAX_ATTEMPTS - attempts),
      })
    }
    const now = DateTime.utc().toISO()!
    let next: GatewayPairing = { ...p, adminConfirmedAt: now }
    // The router may have been confirmed locally already.
    if (!next.routerConfirmedAt) {
      try {
        const status = await gatewayRequest(
          gateway,
          'gateway.pair.status',
          { pairingId: p.pairingId },
          { timeoutMs: RPC_TIMEOUT_MS }
        )
        if (isObject(status) && status.state === 'paired' && status.keyId === p.keyId) {
          next.routerConfirmedAt = now
          updateSessionSigning(gateway.collectorId, { key: 'paired', keyId: p.keyId })
        }
      } catch (error) {
        logger.debug({ gatewayId, error: (error as Error).message }, 'pairing: status unavailable')
      }
    }
    next = settle(next)
    gateway.pairing = next
    await gateway.save()
    await recordGatewayEvent(
      gateway.id,
      next.state === 'paired' ? 'paired' : 'pairing_code_accepted',
      { userId: user.id, detail: { keyId: next.keyId } }
    )
    return pairingView(gateway)!
  })
}

function settle(p: GatewayPairing): GatewayPairing {
  if (p.adminConfirmedAt && p.routerConfirmedAt) {
    return { ...p, state: 'paired', sas: null, pairedAt: DateTime.utc().toISO()! }
  }
  if (p.adminConfirmedAt) return { ...p, state: 'awaiting_router' }
  return p
}

/**
 * `gateway.pair.state` from the agent (the router confirmed, refused or
 * expired the pairing locally), and the hello's `signing` block: a router
 * that signs with our key is paired; one that lost it (reset) is `lost`.
 */
export async function onPairState(collectorId: number, params: unknown): Promise<void> {
  if (!isObject(params) || typeof params.pairingId !== 'string') return
  const gateway = await Gateway.query().where('collector_id', collectorId).first()
  if (!gateway) return
  await gatewayQueue.run(gateway.id, async () => {
    await gateway.refresh()
    const p = currentPairing(gateway)
    if (!p || p.pairingId !== params.pairingId) return
    if (params.state === 'paired' && params.keyId === p.keyId) {
      updateSessionSigning(gateway.collectorId, { key: 'paired', keyId: p.keyId })
      if (p.state === 'paired') return
      const next = settle({ ...p, routerConfirmedAt: DateTime.utc().toISO()! })
      gateway.pairing = next
      await gateway.save()
      await recordGatewayEvent(
        gateway.id,
        next.state === 'paired' ? 'paired' : 'pairing_router_confirmed',
        {
          detail: { keyId: p.keyId },
        }
      )
      return
    }
    if (params.state === 'rejected' || params.state === 'expired' || params.state === 'cancelled') {
      gateway.pairing = { ...p, state: 'failed', sas: null, reason: `router_${params.state}` }
      gateway.pairingKey = null
      await gateway.save()
      await recordGatewayEvent(gateway.id, 'pairing_failed', {
        detail: { reason: `router_${params.state}` },
      })
    }
  })
}

/** Checks the hello's `signing` block against the stored pairing (inside the queue). */
export async function reconcilePairingWithHello(gateway: Gateway): Promise<void> {
  const session = gatewaySession(gateway.collectorId)
  const p = currentPairing(gateway)
  if (!session || !p) return
  const signing = session.hello.signing
  const routerHasKey = signing?.key === 'paired' && signing.keyId === p.keyId
  if (p.state === 'paired' && !routerHasKey) {
    gateway.pairing = { ...p, state: 'lost', reason: 'router_lost_key' }
    gateway.pairingKey = null
    await gateway.save()
    await recordGatewayEvent(gateway.id, 'pairing_lost', { detail: { keyId: p.keyId } })
    return
  }
  if ((p.state === 'awaiting_confirmation' || p.state === 'awaiting_router') && routerHasKey) {
    const next = settle({ ...p, routerConfirmedAt: p.routerConfirmedAt ?? DateTime.utc().toISO()! })
    if (next.state !== p.state || !p.routerConfirmedAt) {
      gateway.pairing = next
      await gateway.save()
      if (next.state === 'paired') {
        await recordGatewayEvent(gateway.id, 'paired', { detail: { keyId: p.keyId } })
      }
    }
  }
}

/**
 * `DELETE /gateways/:id/pairing`: forgets the key here and, when the
 * router is reachable and paired, asks it to forget it too (signed with
 * that key, so only the paired controller can unpair).
 */
export async function unpair(gatewayId: number, user: User) {
  return gatewayQueue.run(gatewayId, async () => {
    const gateway = await Gateway.find(gatewayId)
    if (!gateway) throw planeError(404, 'gateway_not_found', `No gateway with id ${gatewayId}.`)
    const p = currentPairing(gateway)
    if (!p) return null
    if (collectorHub.isOnline(gateway.collectorId ?? 0)) {
      const settings = await getGatewayConfigSettings()
      const access = writeAccess(gateway, settings)
      try {
        if (p.state === 'paired') {
          await gatewayRequest(
            gateway,
            'gateway.pair.forget',
            { keyId: p.keyId },
            { timeoutMs: RPC_TIMEOUT_MS, access: access.writable ? access : undefined }
          )
        } else {
          await cancelOnRouter(gateway, p.pairingId)
        }
      } catch (error) {
        logger.info(
          { gatewayId, error: (error as Error).message },
          'pairing: router did not forget'
        )
      }
    }
    gateway.pairing = null
    gateway.pairingKey = null
    await gateway.save()
    updateSessionSigning(gateway.collectorId, { key: 'api_key' })
    await recordGatewayEvent(gateway.id, 'unpaired', {
      userId: user.id,
      detail: { keyId: p.keyId },
    })
    return null
  })
}

/** A rebound gateway (README 3.7) starts unpaired. */
export function clearPairing(gateway: Gateway) {
  gateway.pairing = null
  gateway.pairingKey = null
}
