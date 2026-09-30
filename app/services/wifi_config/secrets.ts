import WifiNetwork from '#models/wifi_network'
import WifiSecret from '#models/wifi_secret'
import { FINGERPRINT_PREFIX, newSecretRef } from '#services/gateway_config/secrets'
import type { UciValue } from '#services/gateway_config/types'
import { passphraseDigest } from '#services/wifi_config/fleet/security'
import { getWifiFingerprintKey } from '#services/wifi_config/settings'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { createHmac } from 'node:crypto'

/**
 * Wi-Fi secrets (docs/design/wifi controller.md section 4.4).
 *
 * - The fleet fingerprint key: one controller-wide 32-byte key the agents
 *   fingerprint every Wi-Fi secret with (`agent.configure.wifiConfig.
 *   fingerprintKey`, 64 hex), so one passphrase fingerprints the same on
 *   every section and AP (protocol.md 3.2).
 * - `wifiFingerprint`: the core's formula (`gateway_config/secrets.ts`) with
 *   section `*` and the RAW key bytes as the HMAC key (not the hex text).
 *   Vector (shared with the kit): key 32 × 0x44, `wireless.*.key=correct
 *   horse battery` → `hmac:ac349a3eb980336c`.
 * - `wifi_secrets`: a network's passphrase once, APP_KEY-encrypted, with its
 *   unbound fingerprint and the SHA-256 digest the PSK guard compares.
 */

/** The unbound `hmac:` fingerprint of one secret value (protocol.md 3.2). */
export function wifiFingerprint(
  key: Buffer,
  option: string,
  value: UciValue,
  config = 'wireless'
): string {
  const tail = Array.isArray(value) ? `[]=${value.join('\n')}` : `=${value}`
  const digest = createHmac('sha256', key).update(`${config}.*.${option}${tail}`).digest('hex')
  return `${FINGERPRINT_PREFIX}${digest.slice(0, 16)}`
}

let cachedKey: Buffer | null = null

/** The fleet key (cached per process: it only changes when APP_KEY does). */
export async function fleetKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey
  cachedKey = await getWifiFingerprintKey()
  return cachedKey
}

/** The key as `agent.configure` carries it (64 hex), when already loaded. */
export function fleetKeyHexCached(): string | null {
  return cachedKey ? cachedKey.toString('hex') : null
}

/** Tests: forget the cached key (a truncated settings table makes a new one). */
export function _resetFleetKeyCache(): void {
  cachedKey = null
}

/** The fingerprint a passphrase has on every AP (`key` of `wireless`). */
export async function passphraseFingerprint(passphrase: string): Promise<string> {
  return wifiFingerprint(await fleetKey(), 'key', passphrase)
}

/** Stores a passphrase; returns its row (a fresh `ref`). */
export async function storeWifiSecret(
  passphrase: string,
  userId: number | null,
  trx?: TransactionClientContract
): Promise<WifiSecret> {
  const row = new WifiSecret()
  if (trx) row.useTransaction(trx)
  row.ref = newSecretRef()
  row.value = passphrase
  row.fingerprint = await passphraseFingerprint(passphrase)
  row.digest = passphraseDigest(passphrase)
  row.createdByUserId = userId
  await row.save()
  return row
}

/** Fingerprints of known passphrases by ref (what render and reconcile compare). */
export async function secretFingerprints(
  refs?: Iterable<string>
): Promise<Record<string, { fingerprint: string }>> {
  const query = WifiSecret.query().select('ref', 'fingerprint')
  if (refs) {
    const list = [...new Set(refs)]
    if (list.length === 0) return {}
    query.whereIn('ref', list)
  }
  const rows = await query
  return Object.fromEntries(rows.map((r) => [r.ref, { fingerprint: r.fingerprint }]))
}

/** Decrypted values by ref, for an apply's `secrets` (verified TLS only). */
export async function secretValues(refs: string[]): Promise<Record<string, string>> {
  if (refs.length === 0) return {}
  const rows = await WifiSecret.query().whereIn('ref', [...new Set(refs)])
  const out: Record<string, string> = {}
  for (const row of rows) if (row.value !== null) out[row.ref] = row.value
  return out
}

/**
 * Drops a secret nothing references any more (controller.md 5.5: a changed
 * passphrase's old row goes once no slot uses it): no network names it and
 * no section's desired content carries its ref (an AP that has not had the
 * new passphrase rendered yet, or a draft restored from a revision).
 */
export async function dropSecretIfUnused(ref: string | null): Promise<boolean> {
  if (!ref || !/^[a-z0-9]{1,48}$/.test(ref)) return false
  const networks = await WifiNetwork.query().where('passphrase_ref', ref).count('* as total')
  if (Number(networks[0].$extras.total) > 0) return false
  const rows = await db
    .from('ap_config_sections')
    .where('desired_content', 'like', `%"ref":"${ref}"%`)
    .count('* as total')
  if (Number(rows[0].total) > 0) return false
  await WifiSecret.query().where('ref', ref).delete()
  return true
}

/** The retention sweep: every stored secret nothing references. */
export async function dropUnusedSecrets(): Promise<number> {
  let dropped = 0
  for (const row of await WifiSecret.query().select('ref')) {
    if (await dropSecretIfUnused(row.ref)) dropped++
  }
  return dropped
}
