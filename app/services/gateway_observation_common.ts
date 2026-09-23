import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { DateTime } from 'luxon'
import { createHash } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'

/**
 * Shared pieces of the observation channel's ingest (docs/gateway/
 * observation.md): input cleaning, the per-collector memory of what was last
 * written for each part (bounded), and the `gateway_observations` row writes.
 */

/**
 * Collectors whose last writes are remembered; the least recently written is
 * evicted first (CLAUDE.md: every in-process cache needs a bound).
 */
export const MAX_REMEMBERED_OBSERVATIONS = 256
/** An unchanged report refreshes `observed_at` at most this often. */
export const OBSERVED_AT_REFRESH_MS = 60_000
/** Longest string any part keeps (a DNS name). */
export const MAX_TEXT = 253
/** Entries looked at per list, junk included, so no report can make the server loop. */
export const MAX_SCANNED = 8192

const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A cleaned string (control characters removed, trimmed), or null when empty, `*` or too long. */
export function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(CONTROL_CHARS, '').trim()
  if (!cleaned || cleaned === '*' || cleaned.length > max) return null
  return cleaned
}

export function normalizeMac(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let cleaned = value.trim().toLowerCase().replace(/-/g, ':')
  if (/^[0-9a-f]{12}$/.test(cleaned)) cleaned = cleaned.match(/../g)!.join(':')
  return MAC_REGEX.test(cleaned) ? cleaned : null
}

/** A MAC a real device can have: not all-zero, not broadcast or multicast. */
export function isUnicastMac(mac: string): boolean {
  if (mac === '00:00:00:00:00:00') return false
  return (Number.parseInt(mac.slice(0, 2), 16) & 1) === 0
}

export function ipv4(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return isIPv4(trimmed) ? trimmed : null
}

export function ipv6(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return isIPv6(trimmed) ? trimmed : null
}

export function ipAny(value: unknown): string | null {
  return ipv4(value) ?? ipv6(value)
}

/** `address/prefix` with a valid address and prefix, lowercased. */
export function cidr(value: unknown, family: 4 | 6): string | null {
  if (typeof value !== 'string') return null
  const [address, prefix, ...rest] = value.trim().toLowerCase().split('/')
  if (rest.length > 0) return null
  const ok = family === 4 ? isIPv4(address) : isIPv6(address)
  if (!ok) return null
  if (prefix === undefined) return `${address}/${family === 4 ? 32 : 128}`
  const bits = Number(prefix)
  if (!/^\d{1,3}$/.test(prefix) || bits > (family === 4 ? 32 : 128)) return null
  return `${address}/${bits}`
}

export function unixSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 40
    ? value
    : null
}

/** A non-negative integer up to `max`, or null. */
export function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : null
}

export function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_SCANNED) : []
}

export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** IPv4 address inside `a.b.c.d/n`. */
export function ipv4InCidr(ip: string, network: string): boolean {
  const [base, prefix] = network.split('/')
  if (!isIPv4(ip) || !isIPv4(base)) return false
  const bits = Number(prefix)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const toInt = (a: string) => a.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0)
  // Bitwise ops are signed 32-bit in JS: compare the network parts by division.
  const block = 2 ** (32 - bits)
  return Math.floor(toInt(ip) / block) === Math.floor(toInt(base) / block)
}

// ── database helpers ───────────────────────────────────────────────────────

export type Client = typeof db | TransactionClientContract

const SQL_DATETIME = 'yyyy-MM-dd HH:mm:ss'

export function sqlTime(value: DateTime): string {
  return value.toUTC().toFormat(SQL_DATETIME)
}

export function rawRows<T>(result: unknown): T[] {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as T[]
  return []
}

export function parseJsonArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : []
  } catch {
    return []
  }
}

export function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Upserts the `gateway_observations` row of one part. */
export async function writeObservationRow(
  client: Client,
  collectorId: number,
  kind: string,
  payload: unknown,
  fingerprint: string,
  now: DateTime
): Promise<void> {
  const stamp = sqlTime(now)
  await client.rawQuery(
    `INSERT INTO gateway_observations
       (collector_id, kind, payload, fingerprint, observed_at, changed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE payload = VALUES(payload), fingerprint = VALUES(fingerprint),
       observed_at = VALUES(observed_at), changed_at = VALUES(changed_at)`,
    [collectorId, kind, JSON.stringify(payload), fingerprint, stamp, stamp]
  )
}

export async function touchObservationRow(
  client: Client,
  collectorId: number,
  kind: string,
  now: DateTime
): Promise<void> {
  await client.rawQuery(
    'UPDATE gateway_observations SET observed_at = ? WHERE collector_id = ? AND kind = ?',
    [sqlTime(now), collectorId, kind]
  )
}

// ── what was last written, per collector and part ──────────────────────────

export type Remembered = {
  fingerprint: string
  /** Epoch ms `observed_at` was last written; 0 = loaded from the table since start. */
  observedWrittenAt: number
}

/**
 * Bounded memory: at most `MAX_REMEMBERED_OBSERVATIONS` collectors (each with
 * one entry per part, a handful), least recently written evicted first.
 */
const remembered = new Map<number, Map<string, Remembered>>()

export function recall(collectorId: number, kind: string): Remembered | undefined {
  return remembered.get(collectorId)?.get(kind)
}

export function remember(collectorId: number, kind: string, entry: Remembered): void {
  const kinds = remembered.get(collectorId) ?? new Map<string, Remembered>()
  kinds.set(kind, entry)
  remembered.delete(collectorId)
  remembered.set(collectorId, kinds)
  while (remembered.size > MAX_REMEMBERED_OBSERVATIONS) {
    const oldest = remembered.keys().next().value
    if (oldest === undefined) break
    remembered.delete(oldest)
  }
}

/** Number of collectors remembered (tests check the bound). */
export function rememberedCollectorCount(): number {
  return remembered.size
}

export function forgetObservations(collectorId?: number): void {
  if (collectorId === undefined) remembered.clear()
  else remembered.delete(collectorId)
}

/**
 * The remembered entry, or the one in `gateway_observations` after a restart
 * (then `observedWrittenAt` is 0, so the next unchanged report refreshes
 * `observed_at` right away).
 */
export async function lastWritten(
  collectorId: number,
  kind: string
): Promise<Remembered | undefined> {
  const known = recall(collectorId, kind)
  if (known) return known
  const rows = rawRows<{ fingerprint: string }>(
    await db.rawQuery(
      'SELECT fingerprint FROM gateway_observations WHERE collector_id = ? AND kind = ?',
      [collectorId, kind]
    )
  )
  return rows[0] ? { fingerprint: rows[0].fingerprint, observedWrittenAt: 0 } : undefined
}

/**
 * For an unchanged report: refreshes `observed_at` when it is due. Returns
 * true when it wrote.
 */
export async function refreshObservedAt(
  collectorId: number,
  kind: string,
  last: Remembered,
  now: DateTime
): Promise<boolean> {
  const nowMs = now.toMillis()
  if (nowMs - last.observedWrittenAt < OBSERVED_AT_REFRESH_MS) return false
  await touchObservationRow(db, collectorId, kind, now)
  remember(collectorId, kind, { fingerprint: last.fingerprint, observedWrittenAt: nowMs })
  return true
}
