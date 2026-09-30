import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

/**
 * Pairing for signed config RPCs over plain HTTP (owner decision 29,
 * docs/gateway/config-plane.md section 4.4): an X25519 key agreement over
 * the collector socket with Bluetooth-style numeric comparison. Pure
 * functions; the state machine is `pairing.ts`.
 *
 * Wire encoding: public keys and nonces are lowercase hex (32 bytes each).
 *
 * 1. begin: the controller sends `controllerPub`; the router answers
 *    `routerPub` and `commitment = HMAC-SHA256(key = routerNonce,
 *    "perch-pair-commit-v1" ‖ routerPub ‖ controllerPub)`, committing to its
 *    nonce before it sees the controller's.
 * 2. reveal: the controller sends `controllerNonce`; the router answers
 *    `routerNonce`; the controller checks the commitment.
 * 3. Both derive `key = HKDF-SHA256(ikm = X25519(priv, peerPub), salt =
 *    controllerNonce ‖ routerNonce, info = "perch-config-sign-v1:<subject>",
 *    32 bytes)` and the 6-digit SAS = big-endian uint32 of the first 4 bytes
 *    of SHA-256("perch-pair-sas-v1" ‖ controllerPub ‖ routerPub ‖
 *    controllerNonce ‖ routerNonce ‖ "<subject>") mod 1 000 000.
 *
 * The subject names the device the key is for: a gateway id in decimal (the
 * original `gatewayId`, so the pinned gateway vector is unchanged), or a
 * string such as `"ap:4"` for an access point's Wi-Fi plane (wifi design
 * W0), so a key paired for AP 4 can never verify for gateway 4.
 *
 * Why the commitment (a refinement of the owner's sketch): without it, a
 * man in the middle runs one exchange with each side and grinds its own
 * nonce until both SAS values agree (10^6 tries). With it, each side's nonce
 * is fixed before the other one is known, so an attacker gets one guess
 * (1 in 10^6), as in Bluetooth numeric comparison.
 */

export const PAIRING_KEY_BYTES = 32
const COMMIT_LABEL = 'perch-pair-commit-v1'
const SAS_LABEL = 'perch-pair-sas-v1'
const INFO_PREFIX = 'perch-config-sign-v1:'
const KEY_ID_LABEL = 'perch-pair-keyid-v1'

const HEX32 = /^[0-9a-f]{64}$/

export function isHex32(value: unknown): value is string {
  return typeof value === 'string' && HEX32.test(value)
}

/** DER prefixes of raw X25519 keys (RFC 8410): PKCS#8 private, SPKI public. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

function privateKeyObject(privateKeyHex: string) {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(privateKeyHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  })
}

function publicKeyObject(publicKeyHex: string) {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
    format: 'der',
    type: 'spki',
  })
}

function rawPublic(key: ReturnType<typeof createPublicKey>): string {
  const der = key.export({ format: 'der', type: 'spki' })
  return der.subarray(der.length - 32).toString('hex')
}

export type X25519KeyPair = { privateKey: string; publicKey: string }

/** A fresh X25519 key pair, both halves as 32-byte lowercase hex. */
export function generatePairingKeyPair(): X25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' })
  return {
    privateKey: der.subarray(der.length - 32).toString('hex'),
    publicKey: rawPublic(publicKey),
  }
}

/** The public key of a raw X25519 private key (hex). */
export function x25519PublicKey(privateKeyHex: string): string {
  return rawPublic(createPublicKey(privateKeyObject(privateKeyHex)))
}

/** X25519(priv, peerPub); refuses the all-zero result of a low-order peer key. */
export function x25519Shared(privateKeyHex: string, peerPublicKeyHex: string): Buffer {
  const shared = diffieHellman({
    privateKey: privateKeyObject(privateKeyHex),
    publicKey: publicKeyObject(peerPublicKeyHex),
  })
  if (shared.every((b) => b === 0)) throw new Error('low-order peer key')
  return shared
}

export function newPairingNonce(): string {
  return randomBytes(32).toString('hex')
}

/** The router's commitment to its nonce (step 1). */
export function pairingCommitment(
  routerNonceHex: string,
  routerPubHex: string,
  controllerPubHex: string
): string {
  return createHmac('sha256', Buffer.from(routerNonceHex, 'hex'))
    .update(
      Buffer.concat([
        Buffer.from(COMMIT_LABEL, 'utf8'),
        Buffer.from(routerPubHex, 'hex'),
        Buffer.from(controllerPubHex, 'hex'),
      ])
    )
    .digest('hex')
}

export function commitmentMatches(
  commitmentHex: string,
  routerNonceHex: string,
  routerPubHex: string,
  controllerPubHex: string
): boolean {
  if (!isHex32(commitmentHex)) return false
  const expected = Buffer.from(
    pairingCommitment(routerNonceHex, routerPubHex, controllerPubHex),
    'hex'
  )
  return timingSafeEqual(expected, Buffer.from(commitmentHex, 'hex'))
}

/**
 * Who a pairing key is for: a gateway id (a number, formatted in decimal as
 * it always was) or a string subject (`"ap:<apId>"` for an access point).
 */
export type PairingSubject = number | string

type PairingTranscriptBase = {
  controllerPub: string
  routerPub: string
  controllerNonce: string
  routerNonce: string
}

/**
 * The public values both sides feed into the key and the SAS. Exactly one
 * of `gatewayId` (the gateway plane, unchanged) or `subject` names who the
 * key is for.
 */
export type PairingTranscript = PairingTranscriptBase &
  ({ gatewayId: number; subject?: undefined } | { subject: PairingSubject; gatewayId?: undefined })

/** The subject text a transcript binds (`"7"` for gateway 7, `"ap:4"` for AP 4). */
export function pairingSubject(t: PairingTranscript): string {
  const subject = t.subject ?? t.gatewayId
  if (typeof subject === 'number') return String(subject)
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new Error('pairing transcript without a subject')
  }
  return subject
}

/** The signing key both sides derive (32 bytes). */
export function derivePairingKey(shared: Buffer, t: PairingTranscript): Buffer {
  const salt = Buffer.concat([
    Buffer.from(t.controllerNonce, 'hex'),
    Buffer.from(t.routerNonce, 'hex'),
  ])
  const info = Buffer.from(`${INFO_PREFIX}${pairingSubject(t)}`, 'utf8')
  return Buffer.from(hkdfSync('sha256', shared, salt, info, PAIRING_KEY_BYTES))
}

/** The 6-digit short authentication string both sides display. */
export function pairingSas(t: PairingTranscript): string {
  const digest = createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from(SAS_LABEL, 'utf8'),
        Buffer.from(t.controllerPub, 'hex'),
        Buffer.from(t.routerPub, 'hex'),
        Buffer.from(t.controllerNonce, 'hex'),
        Buffer.from(t.routerNonce, 'hex'),
        Buffer.from(pairingSubject(t), 'utf8'),
      ])
    )
    .digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

/** A short public id of a key, so both sides can tell which key is meant (16 hex). */
export function pairingKeyId(key: Buffer): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(KEY_ID_LABEL, 'utf8'), key]))
    .digest('hex')
    .slice(0, 16)
}
