import type { ChartConfig } from '@/components/ui/chart'
import type { ProtocolBreakdown, ProtocolTimeSeriesPoint } from '@/types/api'

/**
 * nDPI application categories ("where is the traffic going", one level up
 * from protocols). Slugs are lowercase-dash as the collector exports them;
 * anything unknown falls back to a title-cased slug and a hashed colour, so
 * a newer nDPI build never breaks the UI.
 */

export const OTHER_CATEGORY = 'other'

const CATEGORY_LABELS: Record<string, string> = {
  web: 'Web',
  media: 'Media',
  video: 'Video',
  music: 'Music',
  streaming: 'Streaming',
  'social-network': 'Social',
  download: 'Downloads',
  'file-sharing': 'File sharing',
  'data-transfer': 'Data transfer',
  cloud: 'Cloud',
  network: 'Network',
  email: 'Email',
  mail: 'Email',
  chat: 'Chat',
  voip: 'Calls & meetings',
  collaborative: 'Collaboration',
  productivity: 'Productivity',
  game: 'Gaming',
  vpn: 'VPN',
  'remote-access': 'Remote access',
  database: 'Database',
  rpc: 'RPC',
  system: 'System',
  'software-update': 'Software updates',
  shopping: 'Shopping',
  'conn-check': 'Connectivity checks',
  'iot-scada': 'IoT',
  'virt-assistant': 'Voice assistants',
  cybersecurity: 'Security',
  'adult-content': 'Adult content',
  mining: 'Crypto mining',
  malware: 'Malware',
  advertisement: 'Ads & tracking',
  'banned-site': 'Banned site',
  'site-unavailable': 'Site unavailable',
  'allowed-site': 'Allowed site',
  antimalware: 'Anti-malware',
  'crypto-currency': 'Crypto currency',
  gambling: 'Gambling',
  other: 'Other',
}

/**
 * Categories worth a second look. They wear status colours instead of the
 * categorical series so they read as "flag" wherever they appear.
 */
const FLAGGED: Record<string, string> = {
  malware: 'var(--status-critical)',
  mining: 'var(--status-critical)',
  'banned-site': 'var(--status-critical)',
  gambling: 'var(--status-critical)',
  'adult-content': 'var(--status-serious)',
  'crypto-currency': 'var(--status-serious)',
  advertisement: 'var(--status-warning)',
}

const SERIES_SLOTS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
] as const

/**
 * Pinned slots so a category keeps its colour whichever window you look at.
 * Families share a hue (media / video / music / streaming; download /
 * file-sharing / data-transfer; vpn / remote-access) — they rarely show
 * together at the top, and when they do the label disambiguates.
 */
const PINNED_SLOTS: Record<string, number> = {
  web: 0,
  media: 1,
  streaming: 1,
  video: 3,
  music: 4,
  network: 2,
  system: 2,
  rpc: 2,
  'conn-check': 2,
  'iot-scada': 2,
  'software-update': 3,
  'social-network': 4,
  chat: 4,
  shopping: 4,
  download: 5,
  'file-sharing': 5,
  'data-transfer': 5,
  game: 5,
  cloud: 6,
  voip: 6,
  collaborative: 6,
  productivity: 6,
  'virt-assistant': 6,
  vpn: 7,
  'remote-access': 7,
  database: 7,
  email: 2,
  mail: 2,
  cybersecurity: 7,
  antimalware: 7,
}

export function categoryLabel(category: string | null | undefined): string {
  const slug = category || OTHER_CATEGORY
  return (
    CATEGORY_LABELS[slug] ??
    slug
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  )
}

/** A category's own colour slot, if it has one. */
export function categoryPinnedSlot(category: string): number | undefined {
  return PINNED_SLOTS[category]
}

/** Colours that are not series slots: flagged categories and `other`. */
export function categoryFixedColor(category: string): string | undefined {
  if (category === OTHER_CATEGORY) return 'var(--series-other)'
  return FLAGGED[category]
}

export function categoryColor(category: string | null | undefined): string {
  const slug = category || OTHER_CATEGORY
  if (slug === OTHER_CATEGORY) return 'var(--series-other)'
  const flagged = FLAGGED[slug]
  if (flagged) return flagged
  const pinned = PINNED_SLOTS[slug]
  if (pinned !== undefined) return SERIES_SLOTS[pinned]
  let hash = 0
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0
  }
  return SERIES_SLOTS[hash % SERIES_SLOTS.length]
}

/** True for the categories that deserve a warning treatment in the UI. */
export function isFlaggedCategory(category: string | null | undefined): boolean {
  return Boolean(category && FLAGGED[category])
}

/**
 * Fold a protocol breakdown into one entry per category. The result reuses
 * the `ProtocolBreakdown` shape (with the category slug in `protocol`) so
 * the existing breakdown panel and stack chart can render it unchanged.
 */
export function groupProtocolsByCategory(protocols: ProtocolBreakdown[]): ProtocolBreakdown[] {
  const groups = new Map<string, ProtocolBreakdown>()
  for (const entry of protocols) {
    const key = entry.category || OTHER_CATEGORY
    const group =
      groups.get(key) ??
      ({ protocol: key, category: key, bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsOut: 0, percentage: 0 } satisfies ProtocolBreakdown)
    group.bytesIn += entry.bytesIn
    group.bytesOut += entry.bytesOut
    group.packetsIn = (group.packetsIn ?? 0) + (entry.packetsIn ?? 0)
    group.packetsOut = (group.packetsOut ?? 0) + (entry.packetsOut ?? 0)
    groups.set(key, group)
  }
  const total = [...groups.values()].reduce((sum, g) => sum + g.bytesIn + g.bytesOut, 0)
  return [...groups.values()]
    .map((g) => ({
      ...g,
      percentage: total > 0 ? Math.round(((g.bytesIn + g.bytesOut) / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.bytesIn + b.bytesOut - (a.bytesIn + a.bytesOut))
}

/**
 * Fold a protocol time series into a category time series using the
 * category each protocol reports in the breakdown. Protocols missing from
 * the breakdown land in "other".
 */
export function foldTimeSeriesByCategory(
  timeSeries: ProtocolTimeSeriesPoint[],
  protocols: ProtocolBreakdown[],
): ProtocolTimeSeriesPoint[] {
  const categoryOf = new Map<string, string>()
  for (const entry of protocols) categoryOf.set(entry.protocol, entry.category || OTHER_CATEGORY)

  return timeSeries.map((bucket) => {
    const folded: Record<string, { bytesIn: number; bytesOut: number }> = {}
    for (const [protocol, stats] of Object.entries(bucket.protocols)) {
      const key = categoryOf.get(protocol) ?? OTHER_CATEGORY
      const current = folded[key] ?? { bytesIn: 0, bytesOut: 0 }
      current.bytesIn += stats.bytesIn
      current.bytesOut += stats.bytesOut
      folded[key] = current
    }
    return { ...bucket, protocols: folded }
  })
}

export function buildCategoryChartConfig(categories: string[]): ChartConfig {
  const config: ChartConfig = {}
  for (const category of categories) {
    config[category] = { label: categoryLabel(category), color: categoryColor(category) }
  }
  return config
}
