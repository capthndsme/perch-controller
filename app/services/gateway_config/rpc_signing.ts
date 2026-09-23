import { createHash, createHmac, randomBytes } from 'node:crypto'

/**
 * Signed config RPCs over an unverified transport (README 7.1, plan 2 P12).
 *
 * When the controller and the router both opted in to writes over plain HTTP
 * (setting `allowInsecureTransport`, UCI `config_allow_insecure '1'`), the
 * write methods (`gateway.config.apply`, `.confirm`, `.rollback`, `.ack`)
 * travel in an envelope the agent verifies (perch-collector
 * `internal/gwconfig/sign.go`):
 *
 * ```json
 * {"payload":"<the method's params as a JSON string>",
 *  "sig":{"v":1,"ts":<unix seconds>,"nonce":"<16-128 of [A-Za-z0-9_-]>",
 *         "challenge":"<the session's challenge from the hello>",
 *         "mac":"<hex HMAC-SHA256>"}}
 * ```
 *
 * mac = HMAC-SHA256(key, "perch-config-sig-v1\n" + method + "\n" +
 * challenge + "\n" + ts + "\n" + nonce + "\n" + hex(SHA-256(payload))). The
 * payload is a string, so both ends MAC the same bytes. Integrity and
 * replay protection (method, session, time window, one-time nonce), not
 * confidentiality: secrets are never sent this way.
 */

export const SIGNATURE_VERSION = 1
const SIG_LABEL = 'perch-config-sig-v1'

/** The hello's (and capabilities') `signing` block. */
export type AgentSigning = {
  required: boolean
  challenge?: string
  /**
   * Which key the router verifies with: `paired` (the pairing's derived key,
   * owner decision 29; `keyId` names it), `config_sign_key` (a router-only
   * key the admin enters), or `api_key`, which the controller never signs
   * with (it is the connection's bearer token, visible on plain HTTP).
   */
  key: string
  keyId?: string
  windowSeconds?: number
}

export function signatureMessage(
  method: string,
  challenge: string,
  ts: number,
  nonce: string,
  payload: string
): string {
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex')
  return `${SIG_LABEL}\n${method}\n${challenge}\n${ts}\n${nonce}\n${digest}`
}

export type SignedEnvelope = {
  payload: string
  sig: { v: number; ts: number; nonce: string; challenge: string; mac: string }
}

/** Wraps `params` in the signed envelope. */
export function signParams(
  key: string | Buffer,
  method: string,
  challenge: string,
  params: Record<string, unknown>,
  options: { ts?: number; nonce?: string } = {}
): SignedEnvelope {
  const payload = JSON.stringify(params)
  const ts = options.ts ?? Math.floor(Date.now() / 1000)
  const nonce = options.nonce ?? randomBytes(16).toString('hex')
  const mac = createHmac('sha256', key)
    .update(signatureMessage(method, challenge, ts, nonce, payload), 'utf8')
    .digest('hex')
  return { payload, sig: { v: SIGNATURE_VERSION, ts, nonce, challenge, mac } }
}

/** Parses a hello/capabilities `signing` block; null when absent or malformed. */
export function parseSigning(value: unknown): AgentSigning | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.required !== 'boolean') return null
  return {
    required: v.required,
    challenge: typeof v.challenge === 'string' ? v.challenge.slice(0, 256) : undefined,
    key: typeof v.key === 'string' ? v.key.slice(0, 32) : 'api_key',
    keyId: typeof v.keyId === 'string' ? v.keyId.slice(0, 32) : undefined,
    windowSeconds: typeof v.windowSeconds === 'number' ? v.windowSeconds : undefined,
  }
}
