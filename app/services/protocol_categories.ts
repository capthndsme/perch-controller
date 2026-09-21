import { cachedQuery } from '#services/query_cache'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Protocol label → nDPI application category lookup (`protocol_categories`).
 * The poller refreshes it from each collector's `GET /api/v1/protocols`; the
 * read side folds it onto protocol breakdowns so "application level" grouping
 * works for the whole existing protocol history at once.
 */

/** Category reported when neither the collector nor the fallback knows one. */
export const UNKNOWN_CATEGORY = 'other'

/**
 * Categories for labels the port-based classifier emits and nDPI never lists
 * under that exact name. Kept tiny on purpose: anything an nDPI collector
 * reports overrides this.
 */
const FALLBACK_CATEGORIES: Record<string, string> = {
  'tcp-other': UNKNOWN_CATEGORY,
  'udp-other': UNKNOWN_CATEGORY,
  'other': UNKNOWN_CATEGORY,
  'quic': 'web',
  'https': 'web',
  'http': 'web',
  'dns': 'network',
  'ntp': 'network',
  'dhcp': 'network',
  'mdns': 'network',
  'ssdp': 'network',
  'snmp': 'network',
  'ssh': 'remote-access',
  'rdp': 'remote-access',
  'vnc': 'remote-access',
  'smb': 'data-transfer',
  'nfs': 'data-transfer',
  'ftp': 'download',
  'ftp-data': 'download',
  'bittorrent': 'download',
  'smtp': 'email',
  'smtps': 'email',
  'imap': 'email',
  'imaps': 'email',
  'pop3': 'email',
  'pop3s': 'email',
  'openvpn': 'vpn',
  'wireguard': 'vpn',
  'tor': 'vpn',
}

export type ProtocolCategoryInput = { protocol: string; category: string }

const CACHE_KEY = 'protocol_categories:map'
const CACHE_TTL_MS = 5 * 60_000
const MAX_PROTOCOL_LENGTH = 30
const MAX_CATEGORY_LENGTH = 40

/**
 * Upsert the collector-reported table. Returns the number of rows written.
 * Labels are normalised to lowercase; empty categories are skipped so a
 * collector that knows nothing never blanks a mapping another one reported.
 */
export async function upsertProtocolCategories(list: ProtocolCategoryInput[]): Promise<number> {
  const nowSql = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
  const byProtocol = new Map<string, string>()
  for (const entry of list) {
    const protocol = String(entry.protocol ?? '')
      .trim()
      .toLowerCase()
      .slice(0, MAX_PROTOCOL_LENGTH)
    const category = String(entry.category ?? '')
      .trim()
      .toLowerCase()
      .slice(0, MAX_CATEGORY_LENGTH)
    if (!protocol || !category) continue
    byProtocol.set(protocol, category)
  }
  if (byProtocol.size === 0) return 0

  const rows = [...byProtocol.entries()].map(([protocol, category]) => ({
    protocol,
    category,
    updated_at: nowSql,
  }))
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insertQuery()
      .table('protocol_categories')
      .multiInsert(rows.slice(i, i + 500))
      .onConflict('protocol')
      .merge(['category', 'updated_at'])
  }
  return rows.length
}

/** The full lookup, cached for a few minutes (it changes about hourly). */
export async function getProtocolCategoryMap(): Promise<Map<string, string>> {
  return cachedQuery(CACHE_KEY, CACHE_TTL_MS, async () => {
    const rows = (await db.from('protocol_categories').select('protocol', 'category')) as Array<{
      protocol: string
      category: string
    }>
    const map = new Map<string, string>(Object.entries(FALLBACK_CATEGORIES))
    for (const row of rows) map.set(row.protocol, row.category)
    return map
  })
}

/** Category for one label, `other` when nobody knows. */
export function categoryFor(map: Map<string, string>, protocol: string): string {
  return map.get(protocol) ?? map.get(protocol.toLowerCase()) ?? UNKNOWN_CATEGORY
}
