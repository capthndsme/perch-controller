import { appKey } from '#config/app'
import {
  type PortalGatewayKeys,
  deriveGatewayKeys,
  deriveLookupKey,
  offlineVoucherVerifier,
  voucherCodeHash,
} from '#services/portal/crypto'
import { normalizeVoucherCode } from '#services/portal/codes'

/**
 * The portal's keys bound to this controller's APP_KEY (scheme:
 * `portal/crypto.ts`). Derived once per process: HKDF is cheap, but the
 * lookup key is used on every redemption. The derived keys never leave the
 * process except a gateway's own `gatewayKey`, in its `portal.configure`.
 */

let lookupKey: Buffer | null = null
const gatewayKeys = new Map<string, PortalGatewayKeys>()
/** Bounded like every in-process cache (CLAUDE.md): one entry per gateway and epoch. */
const MAX_GATEWAY_KEYS = 256

function appKeyMaterial(): string {
  return appKey.release()
}

/** `vouchers.code_hash` of typed input, or null when the input is not a code. */
export function hashVoucherCode(input: string): string | null {
  const code = normalizeVoucherCode(input)
  if (!code) return null
  lookupKey ??= deriveLookupKey(appKeyMaterial())
  return voucherCodeHash(lookupKey, code)
}

export function portalGatewayKeys(gatewayId: number, epoch: number): PortalGatewayKeys {
  const cacheKey = `${gatewayId}:${epoch}`
  let keys = gatewayKeys.get(cacheKey)
  if (!keys) {
    keys = deriveGatewayKeys(appKeyMaterial(), gatewayId, epoch)
    if (gatewayKeys.size >= MAX_GATEWAY_KEYS) gatewayKeys.clear()
    gatewayKeys.set(cacheKey, keys)
  }
  return keys
}

/** Offline verifier of a stored code for one gateway, or null when it is not a code. */
export function voucherVerifierFor(
  gatewayId: number,
  epoch: number,
  code: string | null
): string | null {
  const normalized = code ? normalizeVoucherCode(code) : null
  if (!normalized) return null
  return offlineVoucherVerifier(portalGatewayKeys(gatewayId, epoch), normalized)
}
