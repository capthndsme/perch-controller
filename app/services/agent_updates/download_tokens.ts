import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

/**
 * Short-lived signed download URLs for artefacts (agent-updates protocol.md
 * section 2). Stateless:
 *
 *   K   = HKDF-SHA256(APP_KEY, salt "perch", info "agent-artefact-url-v1", 32 bytes)
 *   sig = hex(HMAC-SHA256(K, "perch-artefact-v1\n" + artefactId + "\n" + file + "\n"
 *                            + deviceKey + "\n" + exp))
 *
 * `deviceKey` is `ap-<id>` / `collector-<id>` (URL-safe; the REST API's
 * `ap:4` form is not). APP_KEY rotation invalidates every URL handed out.
 * Pure: APP_KEY comes in as an argument; `downloadKey()` binds it.
 */

export const ARTEFACT_URL_SALT = 'perch'
export const ARTEFACT_URL_INFO = 'agent-artefact-url-v1'
const LABEL = 'perch-artefact-v1'
const DEVICE_KEY_REGEX = /^(ap|collector)-[1-9]\d{0,9}$/

export function deriveDownloadKey(appKey: string | Buffer): Buffer {
  const ikm = typeof appKey === 'string' ? Buffer.from(appKey, 'utf8') : appKey
  if (ikm.length < 16) throw new Error('APP_KEY is too short to derive the artefact URL key from')
  return Buffer.from(hkdfSync('sha256', ikm, ARTEFACT_URL_SALT, ARTEFACT_URL_INFO, 32))
}

/** The URL form of a device (`ap-4`). */
export function wireDeviceKey(kind: 'ap' | 'collector', id: number): string {
  return `${kind}-${id}`
}

export function isWireDeviceKey(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_KEY_REGEX.test(value)
}

export function signArtefactUrl(
  key: Buffer,
  parts: { artefactId: number; file: string; deviceKey: string; exp: number }
): string {
  return createHmac('sha256', key)
    .update(
      `${LABEL}\n${parts.artefactId}\n${parts.file}\n${parts.deviceKey}\n${parts.exp}`,
      'utf8'
    )
    .digest('hex')
}

/** The path (never an absolute URL) an agent joins to its controller base URL. */
export function artefactPath(
  key: Buffer,
  parts: { artefactId: number; file: string; deviceKey: string; exp: number }
): string {
  const sig = signArtefactUrl(key, parts)
  const query = new URLSearchParams({ d: parts.deviceKey, exp: String(parts.exp), sig })
  return `/api/v1/agent-updates/files/${parts.artefactId}/${encodeURIComponent(parts.file)}?${query}`
}

export type TokenCheck = { ok: true } | { ok: false; error: 'bad_signature' | 'expired' }

/**
 * Checks a request's `d`, `exp` and `sig`. A malformed or wrong signature is
 * `bad_signature`; a good one past `exp` is `expired`.
 */
export function checkArtefactToken(
  key: Buffer,
  input: { artefactId: number; file: string; d: unknown; exp: unknown; sig: unknown },
  nowSeconds: number = Math.floor(Date.now() / 1000)
): TokenCheck {
  if (!isWireDeviceKey(input.d)) return { ok: false, error: 'bad_signature' }
  if (typeof input.exp !== 'string' || !/^\d{1,12}$/.test(input.exp)) {
    return { ok: false, error: 'bad_signature' }
  }
  if (typeof input.sig !== 'string' || !/^[0-9a-f]{64}$/.test(input.sig)) {
    return { ok: false, error: 'bad_signature' }
  }
  const exp = Number(input.exp)
  const expected = Buffer.from(
    signArtefactUrl(key, {
      artefactId: input.artefactId,
      file: input.file,
      deviceKey: input.d,
      exp,
    }),
    'hex'
  )
  if (!timingSafeEqual(expected, Buffer.from(input.sig, 'hex'))) {
    return { ok: false, error: 'bad_signature' }
  }
  if (exp < nowSeconds) return { ok: false, error: 'expired' }
  return { ok: true }
}

let boundKey: Buffer | null = null

/** The key bound to this controller's APP_KEY (derived once per process). */
export async function downloadKey(): Promise<Buffer> {
  if (boundKey) return boundKey
  const { appKey } = await import('#config/app')
  boundKey = deriveDownloadKey(appKey.release())
  return boundKey
}
