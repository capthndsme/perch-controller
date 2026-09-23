import {
  type PortalGatewayKeys,
  type WireGrant,
  type WireGroup,
  type WireOfflineVoucher,
  newNonce,
  signEnvelope,
  signGrant,
  signGroup,
  signOfflineVoucher,
} from '#services/portal/crypto'
import type { DesiredPortalState } from '#services/portal/reconcile'

/**
 * Signed wire messages built from a `DesiredPortalState`
 * (docs/gateway/portal.md §6.3). The socket layer (WP3) sends them as the
 * params of `portal.authorize` and `portal.vouchers`.
 */

export type Signed<T> = T & { sig: string }

export type PortalAuthorizeParams = {
  full: boolean
  serverNow: number
  ackedEventSeq: number
  nonce: string
  keyEpoch: number
  groups: Signed<WireGroup>[]
  grants: Signed<WireGrant>[]
  revertExternals: { portalId: number | null; mac: string }[]
  /** Envelope signature over the item signatures (groups, then grants) in order. */
  sig: string
}

export type PortalVouchersParams = {
  /** false = offline redemption is off: the router drops every voucher it holds. */
  enabled: boolean
  serverNow: number
  nonce: string
  keyEpoch: number
  vouchers: Signed<WireOfflineVoucher>[]
  /**
   * The list is sent in parts of at most `VOUCHERS_PER_MESSAGE` (the kit's
   * frame is 4 MiB). Part 1 replaces the router's list, later parts add to
   * it (`append`, signed as the envelope's `reason: 'append'`). `part` /
   * `parts` are informational (1-based).
   */
  append: boolean
  part: number
  parts: number
  sig: string
}

/** A signed offline voucher is ~0.6 KB of JSON: 4000 stay well under 4 MiB. */
export const VOUCHERS_PER_MESSAGE = 4000

export type PortalDeauthorizeParams = {
  grantIds: number[]
  reason: string
  serverNow: number
  nonce: string
  keyEpoch: number
  sig: string
}

/**
 * Fills in the ids of grants inserted for offline redemptions (by their
 * `localRef`) once `applyPortalDbChanges` has written them. The router then
 * learns the id with the next message.
 */
export function bindInsertedGrantIds(
  desired: DesiredPortalState,
  idsByLocalRef: ReadonlyMap<string, number>
): DesiredPortalState {
  return {
    ...desired,
    grants: desired.grants.map((g) =>
      g.grantId === null && g.localRef && idsByLocalRef.has(g.localRef)
        ? { ...g, grantId: idsByLocalRef.get(g.localRef)! }
        : g
    ),
  }
}

/** What `portal.authorize` carries: a full desired set, or a delta (`full: false`). */
export type AuthorizeSet = Pick<
  DesiredPortalState,
  'gatewayId' | 'serverNow' | 'ackedEventSeq' | 'groups' | 'grants' | 'revertExternals'
> & { full: boolean }

export function buildAuthorizeParams(
  desired: AuthorizeSet,
  keys: PortalGatewayKeys,
  nonce: string = newNonce()
): PortalAuthorizeParams {
  if (desired.gatewayId !== keys.gatewayId) throw new Error('keys belong to another gateway')
  const groups = desired.groups.map((g) => ({ ...g, sig: signGroup(keys, g) }))
  const grants = desired.grants.map((g) => ({ ...g, sig: signGrant(keys, g) }))
  const sig = signEnvelope(keys, {
    kind: 'authorize',
    full: desired.full,
    serverNow: desired.serverNow,
    nonce,
    itemSignatures: [...groups.map((g) => g.sig), ...grants.map((g) => g.sig)],
    ackedEventSeq: desired.ackedEventSeq,
    externals: desired.revertExternals,
  })
  return {
    full: desired.full,
    serverNow: desired.serverNow,
    ackedEventSeq: desired.ackedEventSeq,
    nonce,
    keyEpoch: keys.epoch,
    groups,
    grants,
    revertExternals: desired.revertExternals,
    sig,
  }
}

export function buildVouchersParams(
  desired: Pick<DesiredPortalState, 'serverNow' | 'offlineVouchers'>,
  keys: PortalGatewayKeys,
  nonce: string = newNonce(),
  chunk: { part: number; parts: number } = { part: 1, parts: 1 }
): PortalVouchersParams {
  const enabled = desired.offlineVouchers !== null
  const append = chunk.part > 1
  const vouchers = (desired.offlineVouchers ?? []).map((v) => ({
    ...v,
    sig: signOfflineVoucher(keys, v),
  }))
  const sig = signEnvelope(keys, {
    kind: 'vouchers',
    full: enabled,
    serverNow: desired.serverNow,
    nonce,
    itemSignatures: vouchers.map((v) => v.sig),
    reason: append ? 'append' : null,
  })
  return {
    enabled,
    serverNow: desired.serverNow,
    nonce,
    keyEpoch: keys.epoch,
    vouchers,
    append,
    part: chunk.part,
    parts: chunk.parts,
    sig,
  }
}

/**
 * The offline list as `portal.vouchers` messages of at most `perMessage`
 * vouchers each (at least one message: an empty or disabled list still
 * replaces what the router holds). Send them in order; a failed part leaves
 * the router with the parts before it (the most important vouchers: active
 * first, newest batches first), and the next sync sends the whole list.
 */
export function buildVouchersMessages(
  desired: Pick<DesiredPortalState, 'serverNow' | 'offlineVouchers'>,
  keys: PortalGatewayKeys,
  perMessage: number = VOUCHERS_PER_MESSAGE
): PortalVouchersParams[] {
  const list = desired.offlineVouchers
  if (list === null || list.length <= perMessage) return [buildVouchersParams(desired, keys)]
  const parts = Math.ceil(list.length / perMessage)
  const out: PortalVouchersParams[] = []
  for (let i = 0; i < parts; i++) {
    out.push(
      buildVouchersParams(
        {
          serverNow: desired.serverNow,
          offlineVouchers: list.slice(i * perMessage, (i + 1) * perMessage),
        },
        keys,
        newNonce(),
        { part: i + 1, parts }
      )
    )
  }
  return out
}

export function buildDeauthorizeParams(
  grantIds: readonly number[],
  reason: string,
  keys: PortalGatewayKeys,
  serverNow: number,
  nonce: string = newNonce()
): PortalDeauthorizeParams {
  const ids = [...new Set(grantIds)].sort((a, b) => a - b)
  const sig = signEnvelope(keys, {
    kind: 'deauthorize',
    full: false,
    serverNow,
    nonce,
    itemSignatures: [],
    grantIds: ids,
    reason,
  })
  return { grantIds: ids, reason, serverNow, nonce, keyEpoch: keys.epoch, sig }
}
