import { createHmac, randomBytes } from 'node:crypto'
import type {
  SecretSlot,
  SectionContent,
  UciOptions,
  WireValue,
} from '#services/gateway_config/types'

/**
 * Secret redaction and references (docs/gateway/config-plane.md sections
 * 3.1 and 11, README 3.2).
 *
 * Secret options never leave the router in the clear: the agent removes
 * them from every read and reports `hmac:<hex16>` fingerprints instead,
 * `hex16` being the first 16 hex digits of
 * HMAC-SHA256(api_key, "<config>.<section>.<option>=<value>") keyed with the
 * collector's api_key. The controller computes the same fingerprint for a
 * value an admin sets, so both sides compare without the value ever being
 * read back. Values the controller sets live in `gateway_secrets` under a
 * `ref`; an apply carries `{"$secret": ref}` and the value travels only in
 * the apply's `secrets` map over a secure session.
 */

/** The kit's secret option names (section 3.1); domains may add `type.option` names. */
export const DEFAULT_SECRET_OPTIONS: readonly string[] = Object.freeze([
  'key',
  'password',
  'secret',
  'psk',
  'private_key',
  'preshared_key',
  'auth_secret',
  'sae_password',
])

export const FINGERPRINT_PREFIX = 'hmac:'
const FINGERPRINT_PATTERN = /^hmac:[0-9a-f]{16}$/

/** The `hmac:` fingerprint of one secret value (must match the agent's). */
export function secretFingerprint(
  apiKey: string,
  where: { config: string; section: string; option: string },
  value: string
): string {
  const digest = createHmac('sha256', apiKey)
    .update(`${where.config}.${where.section}.${where.option}=${value}`)
    .digest('hex')
  return `${FINGERPRINT_PREFIX}${digest.slice(0, 16)}`
}

export function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value)
}

/**
 * Whether an option is a secret: a kit name, or a domain's `type.option`
 * (or bare option) name in `extra`.
 */
export function isSecretOption(type: string, option: string, extra: readonly string[] = []) {
  return (
    DEFAULT_SECRET_OPTIONS.includes(option) ||
    extra.includes(option) ||
    extra.includes(`${type}.${option}`)
  )
}

/**
 * What the agent does to a section on read: secret options move out of
 * `options` into `secrets` as fingerprints. Exposed for fixtures and tests
 * (the controller itself never sees a router secret).
 */
export function redactOptions(
  apiKey: string,
  where: { config: string; section: string; type: string },
  options: UciOptions,
  extra: readonly string[] = []
): { options: UciOptions; secrets: Record<string, string> } {
  const kept: UciOptions = {}
  const secrets: Record<string, string> = {}
  for (const [option, value] of Object.entries(options)) {
    if (isSecretOption(where.type, option, extra)) {
      const text = Array.isArray(value) ? value.join('\n') : value
      secrets[option] = secretFingerprint(apiKey, { ...where, option }, text)
    } else {
      kept[option] = value
    }
  }
  return { options: kept, secrets }
}

/** A fresh `gateway_secrets.ref` (48 chars max; 's' + 20 base32 digits). */
export function newSecretRef(random: (size: number) => Buffer = randomBytes): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const bytes = random(20)
  let out = 's'
  for (const byte of bytes) out += alphabet[byte % 32]
  return out
}

/**
 * The slot a section stores for a secret the controller sets: the ref to
 * resolve at apply time and the fingerprint to compare with the router's.
 */
export function controllerSecretSlot(
  apiKey: string,
  where: { config: string; section: string; option: string },
  ref: string,
  value: string
): SecretSlot {
  return { ref, fingerprint: secretFingerprint(apiKey, where, value) }
}

/**
 * The options of a `put` op for a desired content: plain values as they
 * are, controller secrets as `{"$secret": ref}`, router-owned secrets as
 * `{"$keep": true}`. Also returns the refs the apply must carry.
 */
export function wireOptions(content: SectionContent): {
  options: Record<string, WireValue>
  refs: string[]
} {
  const options: Record<string, WireValue> = {}
  const refs: string[] = []
  for (const [name, value] of Object.entries(content.options)) {
    options[name] = Array.isArray(value) ? [...value] : value
  }
  for (const [name, slot] of Object.entries(content.secrets ?? {})) {
    if (slot.ref) {
      options[name] = { $secret: slot.ref }
      refs.push(slot.ref)
    } else {
      options[name] = { $keep: true }
    }
  }
  return { options, refs }
}

/** Router-read secrets (`{option: "hmac:…"}`) as slots without a ref. */
export function routerSecretSlots(
  secrets: Record<string, string> | undefined
): Record<string, SecretSlot> | undefined {
  if (!secrets) return undefined
  const entries = Object.entries(secrets).filter(([, fp]) => typeof fp === 'string')
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries.map(([name, fingerprint]) => [name, { fingerprint }]))
}
