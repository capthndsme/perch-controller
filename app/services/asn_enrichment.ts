import db from '@adonisjs/lucid/services/db'
import dns from 'node:dns/promises'
import net from 'node:net'
import { DateTime } from 'luxon'

export type AsnInfo = {
  ip: string
  asn: number | null
  org: string
  prefix: string | null
}

export const UNKNOWN_ORG = 'Unknown'
const PRIVATE_ORG = 'Private / LAN'
const LOOKUP_TIMEOUT_MS = 1500
/** A failed lookup (timeout, prefix missing from the feed) is retried after this long. */
const ERROR_RETRY_MS = 24 * 3600 * 1000

function isPrivateIp(ip: string): boolean {
  if (net.isIP(ip) === 0) return true

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number)
    const [a, b] = parts
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 ||
      (a === 169 && b === 254)
    )
  }

  const lower = ip.toLowerCase()
  return (
    lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')
  )
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
    }),
  ])
}

function cymruName(ip: string): string | null {
  if (!net.isIPv4(ip)) return null
  return `${ip.split('.').reverse().join('.')}.origin.asn.cymru.com`
}

/**
 * Parse the Team Cymru *origin* TXT record. The reply format is:
 *
 *   "ASN | BGP Prefix | CC | Registry | Allocated"
 *
 * `ASN` may be a space-separated multi-origin list (e.g. `"12345 67890"`),
 * in which case we keep the first one. **Importantly** this record does
 * NOT contain the AS name — that requires a second `AS<n>.asn.cymru.com`
 * lookup. An earlier version of this service used `parts[4]` (the
 * allocation date) as the org, which is what caused dates like
 * `1998-06-15` to show up where the AS name should be.
 */
export function parseCymruOrigin(line: string): { asn: number | null; prefix: string | null } {
  const parts = line.split('|').map((part) => part.trim())
  // `Number('')` is `0` (not `NaN`), so guard explicitly that the first
  // field has at least one digit before parsing.
  const firstField = parts[0]?.split(/\s+/)[0] ?? ''
  const asn = /^\d+$/.test(firstField) ? Number(firstField) : null
  return {
    asn,
    prefix: parts[1] || null,
  }
}

/**
 * Parse the Team Cymru *AS info* TXT record. The reply format is:
 *
 *   "ASN | CC | Registry | Allocated | AS Name"
 *
 * `parts[4]` is what we actually want for `org` — values look like
 * `"GOOGLE - Google LLC, US"` or `"CLOUDFLARENET - Cloudflare, Inc., US"`.
 *
 * Defensive check: if `parts[4]` is shaped like a `YYYY-MM-DD` we treat
 * it as missing. This guards against the historical bug where an origin
 * response (whose `parts[4]` is the allocation date) was mistakenly fed
 * into the org slot.
 */
export function parseCymruAsInfo(line: string): string | null {
  const parts = line.split('|').map((part) => part.trim())
  const candidate = parts[4]
  if (!candidate) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null
  return candidate
}

async function resolveTxtSingle(name: string): Promise<string | null> {
  const records = await withTimeout(dns.resolveTxt(name), LOOKUP_TIMEOUT_MS)
  return records[0]?.join(' ') ?? null
}

async function lookupCymru(ip: string): Promise<AsnInfo> {
  const originName = cymruName(ip)
  if (!originName) return { ip, asn: null, org: UNKNOWN_ORG, prefix: null }

  const originLine = await resolveTxtSingle(originName)
  if (!originLine) return { ip, asn: null, org: UNKNOWN_ORG, prefix: null }

  const { asn, prefix } = parseCymruOrigin(originLine)
  if (asn === null || asn === undefined) {
    return { ip, asn: null, org: UNKNOWN_ORG, prefix }
  }

  // Second hop: resolve the human-readable AS name. If this fails we fall
  // back to the bare `AS<n>` token rather than throwing — a missing name
  // is annoying but the ASN itself is still useful information for the
  // dashboard.
  let org = `AS${asn}`
  try {
    const asInfoLine = await resolveTxtSingle(`AS${asn}.asn.cymru.com`)
    if (asInfoLine) {
      const name = parseCymruAsInfo(asInfoLine)
      if (name) org = name
    }
  } catch {
    // Swallow — see above.
  }

  return { ip, asn, org, prefix }
}

async function cached(ip: string): Promise<AsnInfo | null> {
  const row = await db.from('asn_cache').where('ip_address', ip).first()
  if (!row) return null
  // A cached failure is not an answer forever: let it be looked up again
  // once it is a day old, so a transient timeout doesn't pin an address to
  // "Unknown" for the life of the cache.
  if (row.error && isStale(row.checked_at)) return null

  return {
    ip,
    asn: row.asn === null || row.asn === undefined ? null : Number(row.asn),
    org: row.org ?? UNKNOWN_ORG,
    prefix: row.prefix ?? null,
  }
}

function isStale(checkedAt: Date | string | null | undefined): boolean {
  if (!checkedAt) return true
  const at =
    checkedAt instanceof Date
      ? DateTime.fromJSDate(checkedAt, { zone: 'utc' })
      : DateTime.fromSQL(String(checkedAt), { zone: 'utc' })
  if (!at.isValid) return true
  return DateTime.utc().toMillis() - at.toMillis() > ERROR_RETRY_MS
}

async function persist(info: AsnInfo, error: string | null = null) {
  const nowSql = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')

  await db
    .insertQuery()
    .table('asn_cache')
    .insert({
      ip_address: info.ip,
      asn: info.asn,
      org: info.org,
      prefix: info.prefix,
      error,
      checked_at: nowSql,
      created_at: nowSql,
      updated_at: nowSql,
    })
    .onConflict(['ip_address'])
    .merge({
      asn: db.raw('VALUES(??)', ['asn']),
      org: db.raw('VALUES(??)', ['org']),
      prefix: db.raw('VALUES(??)', ['prefix']),
      error: db.raw('VALUES(??)', ['error']),
      checked_at: nowSql,
      updated_at: nowSql,
    })
}

export async function enrichIp(ip: string): Promise<AsnInfo> {
  if (isPrivateIp(ip)) {
    return { ip, asn: null, org: PRIVATE_ORG, prefix: null }
  }

  const hit = await cached(ip)
  if (hit) return hit

  try {
    const info = await lookupCymru(ip)
    await persist(info)
    return info
  } catch (error) {
    const fallback = { ip, asn: null, org: UNKNOWN_ORG, prefix: null }
    await persist(fallback, error instanceof Error ? error.message : String(error))
    return fallback
  }
}
