import SystemSetting from '#models/system_setting'
import { sqlTime } from '#services/alerts/clock'
import encryption from '@adonisjs/core/services/encryption'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { createHash } from 'node:crypto'
import webpush from 'web-push'

/**
 * VAPID keys (docs/design/alerts/delivery.md §1.2): one P-256 pair per
 * controller in `system_settings` key `alerts_vapid`, the private half
 * encrypted with APP_KEY. Made at boot, or by the first `GET
 * /alerts/push/config`, whichever comes first; concurrent first calls end
 * with one pair (insert-if-absent, then re-read). Rotation replaces the pair
 * and marks every subscription `gone`: each browser subscribes again with the
 * new key the next time the dashboard opens there.
 */

export const VAPID_SETTING_KEY = 'alerts_vapid'

export type StoredVapid = {
  keyId: string
  publicKey: string
  privateKeyEncrypted: string
  createdAt: string
}

/** The pair in clear; `privateKey` is null when APP_KEY cannot read it (changed since). */
export type VapidKeys = {
  keyId: string
  publicKey: string
  privateKey: string | null
  createdAt: string
}

/** `v1-` + the first 8 hex digits of sha256(publicKey). */
export function vapidKeyId(publicKey: string): string {
  return `v1-${createHash('sha256').update(publicKey).digest('hex').slice(0, 8)}`
}

function newStoredPair(): StoredVapid {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys()
  return {
    keyId: vapidKeyId(publicKey),
    publicKey,
    privateKeyEncrypted: encryption.encrypt(privateKey),
    createdAt: DateTime.utc().toISO()!,
  }
}

function parseStored(value: unknown): StoredVapid | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.publicKey !== 'string' || typeof v.privateKeyEncrypted !== 'string') return null
  return {
    keyId: typeof v.keyId === 'string' ? v.keyId : vapidKeyId(v.publicKey),
    publicKey: v.publicKey,
    privateKeyEncrypted: v.privateKeyEncrypted,
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : DateTime.utc().toISO()!,
  }
}

async function readStored(): Promise<StoredVapid | null> {
  return parseStored(await SystemSetting.get(VAPID_SETTING_KEY))
}

function decryptPrivate(stored: StoredVapid): string | null {
  try {
    return encryption.decrypt<string>(stored.privateKeyEncrypted) ?? null
  } catch {
    return null
  }
}

/** The stored pair, created when missing (one pair even under concurrent first calls). */
export async function ensureVapidKeys(): Promise<StoredVapid> {
  const existing = await readStored()
  if (existing) return existing
  await db
    .table('system_settings')
    .insert({
      key: VAPID_SETTING_KEY,
      value: JSON.stringify(newStoredPair()),
      updated_at: sqlTime(DateTime.utc()),
    })
    .onConflict('key')
    .ignore()
  const stored = await readStored()
  if (!stored) throw new Error('VAPID keys could not be stored')
  return stored
}

/** The current pair in clear (created when missing). */
export async function vapidKeys(): Promise<VapidKeys> {
  const stored = await ensureVapidKeys()
  return {
    keyId: stored.keyId,
    publicKey: stored.publicKey,
    privateKey: decryptPrivate(stored),
    createdAt: stored.createdAt,
  }
}

/**
 * A new pair. Every subscription becomes `gone` (`last_error: "VAPID key
 * rotated"`): push services refuse a push signed with a key the subscription
 * was not made with. Returns the new pair and how many rows it invalidated.
 */
export async function rotateVapidKeys(): Promise<{ stored: StoredVapid; invalidated: number }> {
  const stored = newStoredPair()
  let invalidated = 0
  await db.transaction(async (trx) => {
    await SystemSetting.updateOrCreate(
      { key: VAPID_SETTING_KEY },
      { value: stored },
      { client: trx }
    )
    const affected = await trx
      .from('alert_push_subscriptions')
      .whereNot('state', 'gone')
      .update({
        state: 'gone',
        last_error: 'VAPID key rotated',
        updated_at: sqlTime(DateTime.utc()),
      })
    invalidated = Number(affected) || 0
  })
  return { stored, invalidated }
}
