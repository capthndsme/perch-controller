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
  sig: string
}

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

export function buildAuthorizeParams(
  desired: DesiredPortalState,
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
  desired: DesiredPortalState,
  keys: PortalGatewayKeys,
  nonce: string = newNonce()
): PortalVouchersParams {
  const enabled = desired.offlineVouchers !== null
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
  })
  return { enabled, serverNow: desired.serverNow, nonce, keyEpoch: keys.epoch, vouchers, sig }
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
