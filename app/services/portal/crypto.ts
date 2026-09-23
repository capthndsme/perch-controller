import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DurationMode, StartMode } from '#services/portal/types'
import { GROUP_KEY_REGEX } from '#services/portal/types'

/**
 * Keys, voucher hashes and signatures of the guest portal
 * (docs/gateway/portal.md §6, "HMAC scheme v1"). Pure: APP_KEY comes in as an
 * argument (`portal_keys.ts` binds it to the app), so the unit suite needs no
 * booted app and the collector's Go side can be tested against the vectors in
 * `tests/unit/services/portal/crypto.spec.ts`.
 *
 * Nothing here ever uses APP_KEY itself as an HMAC key. Every key is an
 * HKDF-SHA256 expansion of it with its own `info`, so a key handed to a router
 * reveals neither APP_KEY nor any other key.
 *
 *   lookupKey        = HKDF(APP_KEY, salt, "voucher-lookup")        controller only
 *   gatewayKey(g, e) = HKDF(APP_KEY, salt, "gateway:<g>:<e>")       sent to gateway g once per epoch e
 *   voucherKey       = HMAC(gatewayKey, "perch-portal-voucher-v1")  derived on both sides
 *   signKey          = HMAC(gatewayKey, "perch-portal-sign-v1")     derived on both sides
 *
 *   codeHash  = hex(HMAC(lookupKey, code))                         vouchers.code_hash
 *   verifier  = hex(HMAC(voucherKey, "v1\n<g>\n<code>"))           offline redemption on gateway g
 *   signature = base64url(HMAC(signKey, canonical record))         grants, groups, vouchers, envelopes
 *
 * (salt = "perch-portal-v1"; code = the normalized code; HMAC = HMAC-SHA256;
 * base64url without padding.)
 */

export const PORTAL_KDF_SALT = 'perch-portal-v1'
const LOOKUP_INFO = 'voucher-lookup'
const VOUCHER_SUBKEY_LABEL = 'perch-portal-voucher-v1'
const SIGN_SUBKEY_LABEL = 'perch-portal-sign-v1'
const KEY_BYTES = 32

export type PortalGatewayKeys = {
  gatewayId: number
  epoch: number
  /** The key the router receives (base64url in `portal.configure`). */
  gatewayKey: Buffer
  voucherKey: Buffer
  signKey: Buffer
}

function hkdf(appKey: string | Buffer, info: string): Buffer {
  const ikm = typeof appKey === 'string' ? Buffer.from(appKey, 'utf8') : appKey
  if (ikm.length < 16) throw new Error('APP_KEY is too short to derive portal keys from')
  return Buffer.from(hkdfSync('sha256', ikm, PORTAL_KDF_SALT, info, KEY_BYTES))
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name} ${value}`)
}

/** The controller-only key `vouchers.code_hash` is computed with. */
export function deriveLookupKey(appKey: string | Buffer): Buffer {
  return hkdf(appKey, LOOKUP_INFO)
}

/** `vouchers.code_hash` for a normalized code (64 hex chars). */
export function voucherCodeHash(lookupKey: Buffer, normalizedCode: string): string {
  return hmac(lookupKey, normalizedCode).toString('hex')
}

/**
 * Keys of one gateway at one epoch. Bumping the epoch (stored per gateway in
 * `portal_gateway_states.key_epoch`) rotates them: the router gets the new
 * `gatewayKey` in its next `portal.configure` and every signature and
 * verifier it holds is recomputed.
 */
export function deriveGatewayKeys(
  appKey: string | Buffer,
  gatewayId: number,
  epoch: number
): PortalGatewayKeys {
  assertPositiveInt(gatewayId, 'gateway id')
  assertPositiveInt(epoch, 'key epoch')
  const gatewayKey = hkdf(appKey, `gateway:${gatewayId}:${epoch}`)
  return gatewayKeysFrom(gatewayKey, gatewayId, epoch)
}

/** What the router does with the `gatewayKey` it was handed. */
export function gatewayKeysFrom(
  gatewayKey: Buffer,
  gatewayId: number,
  epoch: number
): PortalGatewayKeys {
  if (gatewayKey.length !== KEY_BYTES) throw new Error('gateway key must be 32 bytes')
  return {
    gatewayId,
    epoch,
    gatewayKey,
    voucherKey: hmac(gatewayKey, VOUCHER_SUBKEY_LABEL),
    signKey: hmac(gatewayKey, SIGN_SUBKEY_LABEL),
  }
}

/**
 * Offline-redemption verifier of a code on one gateway (64 hex chars). The
 * router computes it from what the guest typed (normalized the same way) and
 * looks it up among the vouchers it holds. Bound to the gateway id so a
 * verifier list copied to another gateway matches nothing there.
 */
export function offlineVoucherVerifier(keys: PortalGatewayKeys, normalizedCode: string): string {
  return hmac(keys.voucherKey, `v1\n${keys.gatewayId}\n${normalizedCode}`).toString('hex')
}

// ---------------------------------------------------------------------------
// Canonical records
//
// A record is signed as its lines joined with "\n" (no trailing newline):
//   line 0  the record tag, e.g. "perch-portal-grant-v1"
//   line 1  gateway id
//   line 2  key epoch
//   line 3… the fields in the order the record type lists them
// Field encoding: integers in decimal (no sign, no leading zeros, no
// exponent); null as the empty string; booleans "1"/"0"; strings verbatim,
// restricted to charsets without "\n"; integer lists sorted ascending and
// comma-joined. Times are Unix epoch milliseconds.
// ---------------------------------------------------------------------------

type Field = number | string | boolean | null | readonly number[]

const TOKEN_REGEX = /^[A-Za-z0-9._:-]{0,64}$/
const MAC_FIELD_REGEX = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/
const HEX64_REGEX = /^[0-9a-f]{64}$/

function encodeField(value: Field, name: string): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name}: ${value} is not a non-negative integer`)
    }
    return String(value)
  }
  if (typeof value === 'string') {
    if (!TOKEN_REGEX.test(value)) throw new Error(`${name}: not a canonical token`)
    return value
  }
  const list = [...value]
  for (const item of list) encodeField(item, name)
  return list.sort((a, b) => a - b).join(',')
}

function canonical(
  tag: string,
  keys: PortalGatewayKeys,
  fields: ReadonlyArray<readonly [string, Field]>
): string {
  const lines = [tag, String(keys.gatewayId), String(keys.epoch)]
  for (const [name, value] of fields) lines.push(encodeField(value, name))
  return lines.join('\n')
}

function sign(keys: PortalGatewayKeys, text: string): string {
  return hmac(keys.signKey, text).toString('base64url')
}

/** Constant-time check of a presented base64url signature. */
export function signatureMatches(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(presented, 'utf8'))
}

/** Constant-time comparison of two hex digests. */
export function hexDigestMatches(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || !HEX64_REGEX.test(presented)) return false
  if (!HEX64_REGEX.test(expected)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(presented, 'hex'))
}

/** Wire group (`portal.authorize` `groups[]`), unsigned. */
export type WireGroup = {
  groupKey: string
  durationMode: DurationMode
  expiresAt: number | null
  durationSeconds: number | null
  quotaBytes: number | null
  /** Usage of the group's grants that are not live on this router. */
  baseTimeUsedSeconds: number
  baseBytesUsed: number
  downKbps: number | null
  upKbps: number | null
  maxDevices: number
  revision: number
}

export const GROUP_RECORD_TAG = 'perch-portal-group-v1'

export function canonicalGroup(keys: PortalGatewayKeys, g: WireGroup): string {
  if (!GROUP_KEY_REGEX.test(g.groupKey)) throw new Error(`groupKey: invalid ${g.groupKey}`)
  return canonical(GROUP_RECORD_TAG, keys, [
    ['groupKey', g.groupKey],
    ['durationMode', g.durationMode],
    ['expiresAt', g.expiresAt],
    ['durationSeconds', g.durationSeconds],
    ['quotaBytes', g.quotaBytes],
    ['baseTimeUsedSeconds', g.baseTimeUsedSeconds],
    ['baseBytesUsed', g.baseBytesUsed],
    ['downKbps', g.downKbps],
    ['upKbps', g.upKbps],
    ['maxDevices', g.maxDevices],
    ['revision', g.revision],
  ])
}

export function signGroup(keys: PortalGatewayKeys, g: WireGroup): string {
  return sign(keys, canonicalGroup(keys, g))
}

/**
 * Wire grant (`portal.authorize` `grants[]`), unsigned. A grant the router
 * created offline and the controller has not answered yet is sent with
 * `grantId: null` and its `localRef`; the answer carries both, which is how the
 * router learns the id.
 */
export type WireGrant = {
  grantId: number | null
  localRef: string | null
  portalId: number
  groupKey: string
  mac: string
  /** Grant-level deadline (portal-user logins, API grants), on top of the group's. */
  expiresAt: number | null
  revision: number
}

export const GRANT_RECORD_TAG = 'perch-portal-grant-v1'

export function canonicalGrant(keys: PortalGatewayKeys, g: WireGrant): string {
  if (g.grantId === null && !g.localRef) throw new Error('grant needs a grantId or a localRef')
  if (!MAC_FIELD_REGEX.test(g.mac)) throw new Error(`mac: invalid ${g.mac}`)
  if (!GROUP_KEY_REGEX.test(g.groupKey)) throw new Error(`groupKey: invalid ${g.groupKey}`)
  return canonical(GRANT_RECORD_TAG, keys, [
    ['grantId', g.grantId],
    ['localRef', g.localRef],
    ['portalId', g.portalId],
    ['groupKey', g.groupKey],
    ['mac', g.mac],
    ['expiresAt', g.expiresAt],
    ['revision', g.revision],
  ])
}

export function signGrant(keys: PortalGatewayKeys, g: WireGrant): string {
  return sign(keys, canonicalGrant(keys, g))
}

/**
 * A voucher the router may redeem while the controller is unreachable
 * (owner decision 20). `portalIds`: the portals of this gateway it is valid
 * on (its bound portal, or its batch's). `timeUsedSeconds`/`bytesUsed`: usage
 * so far (a started voucher can move to a new device offline, decision 23).
 */
export type WireOfflineVoucher = {
  voucherId: number
  verifier: string
  portalIds: readonly number[]
  groupKey: string
  durationMode: DurationMode
  startMode: StartMode
  durationSeconds: number | null
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
  maxDevices: number
  /** Unused vouchers die then (null = never). */
  redeemBy: number | null
  /** Set once the clock started (wall_clock). */
  expiresAt: number | null
  timeUsedSeconds: number
  bytesUsed: number
  revision: number
}

export const VOUCHER_RECORD_TAG = 'perch-portal-voucher-v1'

export function canonicalOfflineVoucher(keys: PortalGatewayKeys, v: WireOfflineVoucher): string {
  if (!HEX64_REGEX.test(v.verifier)) throw new Error('verifier: not 64 hex chars')
  if (!GROUP_KEY_REGEX.test(v.groupKey)) throw new Error(`groupKey: invalid ${v.groupKey}`)
  if (v.portalIds.length === 0) throw new Error('portalIds: empty')
  return canonical(VOUCHER_RECORD_TAG, keys, [
    ['voucherId', v.voucherId],
    ['verifier', v.verifier],
    ['portalIds', v.portalIds],
    ['groupKey', v.groupKey],
    ['durationMode', v.durationMode],
    ['startMode', v.startMode],
    ['durationSeconds', v.durationSeconds],
    ['quotaBytes', v.quotaBytes],
    ['downKbps', v.downKbps],
    ['upKbps', v.upKbps],
    ['maxDevices', v.maxDevices],
    ['redeemBy', v.redeemBy],
    ['expiresAt', v.expiresAt],
    ['timeUsedSeconds', v.timeUsedSeconds],
    ['bytesUsed', v.bytesUsed],
    ['revision', v.revision],
  ])
}

export function signOfflineVoucher(keys: PortalGatewayKeys, v: WireOfflineVoucher): string {
  return sign(keys, canonicalOfflineVoucher(keys, v))
}

/**
 * Envelopes bind a whole message: the item signatures in the order they are
 * sent, the externals to revert, `serverNow`, the journal position and a
 * random `nonce`, so a set cannot be trimmed, reordered into another message
 * or replayed. The router rejects a nonce it has seen (bounded memory of the
 * last 256) and an envelope whose `serverNow` is more than 10 minutes older
 * than the newest it accepted.
 *
 * Canonical form: the record lines (tag `perch-portal-<kind>-v1`, gateway id,
 * epoch, then full, serverNow, nonce, ackedEventSeq, grantIds, reason,
 * itemCount, externalCount), then one line per item signature, then one line
 * `ext:<portalId>:<mac>` per external (portalId empty when unknown).
 */
export type EnvelopeKind = 'authorize' | 'deauthorize' | 'vouchers'

export type Envelope = {
  kind: EnvelopeKind
  full: boolean
  serverNow: number
  nonce: string
  /** authorize/vouchers: the item signatures in wire order. deauthorize: none. */
  itemSignatures: readonly string[]
  /** authorize: the journal position the set reflects (else 0). */
  ackedEventSeq?: number
  /** deauthorize: the grant ids (sorted in the canonical form). */
  grantIds?: readonly number[]
  /** deauthorize: why. */
  reason?: string | null
  /** authorize: outside authorizations the router must undo, in wire order. */
  externals?: ReadonlyArray<{ portalId: number | null; mac: string }>
}

const SIG_REGEX = /^[A-Za-z0-9_-]{43}$/

export function canonicalEnvelope(keys: PortalGatewayKeys, e: Envelope): string {
  for (const s of e.itemSignatures) {
    if (!SIG_REGEX.test(s)) throw new Error('itemSignatures: not a signature')
  }
  if (!/^[A-Za-z0-9_-]{22}$/.test(e.nonce)) throw new Error('nonce: expected 16 bytes base64url')
  const externals = e.externals ?? []
  const extLines = externals.map((x) => {
    if (!MAC_FIELD_REGEX.test(x.mac)) throw new Error(`externals: invalid mac ${x.mac}`)
    return `ext:${encodeField(x.portalId, 'externals.portalId')}:${x.mac}`
  })
  const head = canonical(`perch-portal-${e.kind}-v1`, keys, [
    ['full', e.full],
    ['serverNow', e.serverNow],
    ['nonce', e.nonce],
    ['ackedEventSeq', e.ackedEventSeq ?? 0],
    ['grantIds', e.grantIds ?? []],
    ['reason', e.reason ?? null],
    ['itemCount', e.itemSignatures.length],
    ['externalCount', externals.length],
  ])
  // Signatures are 43 base64url chars and ext lines are fixed-format: neither contains "\n".
  return [head, ...e.itemSignatures, ...extLines].join('\n')
}

export function signEnvelope(keys: PortalGatewayKeys, e: Envelope): string {
  return sign(keys, canonicalEnvelope(keys, e))
}

export function newNonce(): string {
  return randomBytes(16).toString('base64url')
}

/** The `keys` object of `portal.configure` (sent when the router's epoch differs). */
export function gatewayKeyForWire(keys: PortalGatewayKeys): {
  epoch: number
  gatewayKey: string
} {
  return { epoch: keys.epoch, gatewayKey: keys.gatewayKey.toString('base64url') }
}
