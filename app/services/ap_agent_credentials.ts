import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Secrets of the ap-controller flow (docs/ap-controller.md section 1).
 *
 * - Join token: `mlap_` + 32 base64url chars (24 random bytes). Stored as a
 *   SHA-256 hex digest plus an APP_KEY-encrypted copy.
 * - Agent credentials: a 32-hex-char id and a 43-char base64url secret
 *   (32 random bytes). Only the secret's SHA-256 is stored. The agent
 *   presents both as `Authorization: Bearer <agentId>.<agentSecret>`.
 *
 * Deliberately free of app imports so the unit suite can exercise it without
 * booting anything.
 */

export const JOIN_TOKEN_PREFIX = 'mlap_'

/** `mlap_` + 4 random chars: enough to tell tokens apart in a list. */
const DISPLAY_PREFIX_LENGTH = JOIN_TOKEN_PREFIX.length + 4

const AGENT_ID_REGEX = /^[0-9a-f]{32}$/
const AGENT_SECRET_REGEX = /^[A-Za-z0-9_-]{32,128}$/

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function generateJoinToken(): string {
  return JOIN_TOKEN_PREFIX + randomBytes(24).toString('base64url')
}

export function joinTokenDisplayPrefix(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_LENGTH)
}

export type AgentCredentials = {
  agentId: string
  agentSecret: string
  secretHash: string
}

export function generateAgentCredentials(): AgentCredentials {
  const agentId = randomBytes(16).toString('hex')
  const agentSecret = randomBytes(32).toString('base64url')
  return { agentId, agentSecret, secretHash: sha256Hex(agentSecret) }
}

/**
 * `Bearer <agentId>.<agentSecret>` → its parts, or null when the header is
 * absent or malformed. The id is always 32 lowercase hex chars; the secret
 * is base64url.
 */
export function parseAgentBearer(
  header: string | string[] | undefined | null
): { agentId: string; agentSecret: string } | null {
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string') return null
  const match = /^Bearer\s+([^\s.]+)\.(\S+)$/i.exec(value.trim())
  if (!match) return null
  const [, agentId, agentSecret] = match
  if (!AGENT_ID_REGEX.test(agentId) || !AGENT_SECRET_REGEX.test(agentSecret)) return null
  return { agentId, agentSecret }
}

/**
 * Constant-time check of a presented secret against the stored SHA-256 hex.
 * Both sides are 32-byte digests, so the comparison never leaks length.
 */
export function agentSecretMatches(storedHash: string | null | undefined, secret: string): boolean {
  if (typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false
  const expected = Buffer.from(storedHash, 'hex')
  const presented = createHash('sha256').update(secret, 'utf8').digest()
  return timingSafeEqual(expected, presented)
}
