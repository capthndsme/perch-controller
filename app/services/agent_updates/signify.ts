import { createPublicKey, verify, type KeyObject } from 'node:crypto'

/**
 * signify / usign Ed25519 signatures (agent-updates protocol.md 1.2).
 *
 * Public key file and signature file, two lines each:
 *
 *   untrusted comment: <anything>
 *   <base64 of "Ed" || keynum[8] || ed25519 public key[32]>          42 bytes
 *
 *   untrusted comment: <anything>
 *   <base64 of "Ed" || keynum[8] || ed25519 signature[64]>           74 bytes
 *
 * The signature is plain Ed25519 over the exact manifest bytes (signify's
 * default mode; usign is compatible). `keyId` everywhere is the lowercase hex
 * of keynum, what `usign -F -p key.pub` prints. Nothing else is parsed.
 *
 * On the controller the check is advisory (it decides what to offer and what
 * to store); the device's own check against its pinned keys is the boundary.
 */

export class SignifyError extends Error {
  constructor(
    readonly code: 'key_invalid' | 'signature_invalid',
    message: string
  ) {
    super(message)
    this.name = 'SignifyError'
  }
}

export type SignifyPublicKey = {
  keyId: string
  /** The base64 key line (`RW…`), as it appears in a `.pub` file and in UCI `update_key`. */
  line: string
  comment: string | null
  key: KeyObject
}

export type SignifySignature = {
  keyId: string
  signature: Buffer
  comment: string
}

const COMMENT_PREFIX = 'untrusted comment: '
const MAX_COMMENT_BYTES = 1024
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/

function decodeLine(line: string, bytes: number): Buffer | null {
  if (!BASE64_LINE.test(line) || line.length % 4 !== 0) return null
  const raw = Buffer.from(line, 'base64')
  if (raw.length !== bytes) return null
  if (raw[0] !== 0x45 || raw[1] !== 0x64) return null // "Ed"
  return raw
}

function splitLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
}

/**
 * A public key from a `.pub` file (two lines) or its key line alone (`RW…`,
 * as in UCI `update_key` and the `extraTrustedKeys` setting).
 */
export function parsePublicKey(text: string): SignifyPublicKey {
  const lines = splitLines(text.trim())
  let comment: string | null = null
  let line: string
  if (lines.length === 1) {
    line = lines[0]
  } else if (lines.length === 2 && lines[0].startsWith(COMMENT_PREFIX)) {
    comment = lines[0].slice(COMMENT_PREFIX.length)
    line = lines[1]
  } else {
    throw new SignifyError('key_invalid', 'expected a signify public key (RW…)')
  }
  const raw = decodeLine(line.trim(), 42)
  if (!raw) throw new SignifyError('key_invalid', 'not an Ed25519 signify public key')
  const keyId = raw.subarray(2, 10).toString('hex')
  const publicKey = raw.subarray(10, 42)
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: publicKey.toString('base64url') },
    format: 'jwk',
  })
  return { keyId, line: line.trim(), comment, key }
}

/** A detached signature file (`perch-manifest.json.sig`). */
export function parseSignature(text: string): SignifySignature {
  if (typeof text !== 'string' || text.length > 4096) {
    throw new SignifyError('signature_invalid', 'signature file too large')
  }
  const lines = splitLines(text)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length !== 2 || !lines[0].startsWith(COMMENT_PREFIX)) {
    throw new SignifyError('signature_invalid', 'expected two lines: comment and signature')
  }
  if (Buffer.byteLength(lines[0], 'utf8') > MAX_COMMENT_BYTES) {
    throw new SignifyError('signature_invalid', 'comment line too long')
  }
  const raw = decodeLine(lines[1], 74)
  if (!raw) throw new SignifyError('signature_invalid', 'not an Ed25519 signify signature')
  return {
    keyId: raw.subarray(2, 10).toString('hex'),
    signature: Buffer.from(raw.subarray(10, 74)),
    comment: lines[0].slice(COMMENT_PREFIX.length),
  }
}

export type VerifyOutcome =
  | { ok: true; keyId: string }
  | { ok: false; error: 'unknown_key' | 'bad_signature'; keyId: string | null }

/**
 * Checks `signatureText` over `message` against `keys`. Order of the checks as
 * on the device (protocol.md 1.3 rule 1): a malformed signature or a valid one
 * that does not verify is `bad_signature`; a key id not in `keys` is
 * `unknown_key`.
 */
export function verifySignature(
  message: Buffer,
  signatureText: string,
  keys: SignifyPublicKey[]
): VerifyOutcome {
  let parsed: SignifySignature
  try {
    parsed = parseSignature(signatureText)
  } catch {
    return { ok: false, error: 'bad_signature', keyId: null }
  }
  const key = keys.find((candidate) => candidate.keyId === parsed.keyId)
  if (!key) return { ok: false, error: 'unknown_key', keyId: parsed.keyId }
  const valid = verify(null, message, key.key, parsed.signature)
  return valid
    ? { ok: true, keyId: parsed.keyId }
    : { ok: false, error: 'bad_signature', keyId: parsed.keyId }
}
