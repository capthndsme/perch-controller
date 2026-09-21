import type { ChartConfig } from '@/components/ui/chart'
import type { ServiceTrafficPoint } from '@/lib/services'
import { windowSpanSeconds, type TimeWindow } from '@/lib/time-window'
import { formatProtocolLabel } from '@/lib/protocols'
import type { DestinationDomainGroup, DestinationName, DestinationTrafficBucket } from '@/types/api'

/**
 * The service traffic chart read from the client's side: `served` carries
 * bytes the device uploaded to a destination (green), `received` what it
 * downloaded from it (red).
 */
export const DESTINATION_SERIES_CONFIG = {
  served: { label: 'Uploaded', color: 'var(--chart-upload)' },
  received: { label: 'Downloaded', color: 'var(--chart-download)' },
} satisfies ChartConfig

/** Hourly up to two weeks, daily beyond — the two grains the API stores. */
export function destinationResolutionFor(window: TimeWindow): '1h' | '1d' {
  return windowSpanSeconds(window) > 14 * 86400 ? '1d' : '1h'
}

/** Destination buckets onto the service chart's two keys (see above). */
export function destinationBucketsToPoints(
  buckets: DestinationTrafficBucket[],
  fallbackSeconds = 3600,
): ServiceTrafficPoint[] {
  return buckets
    .map((bucket) => {
      if (!bucket.bucketStart) return null
      const ts = Date.parse(bucket.bucketStart)
      if (Number.isNaN(ts)) return null
      const end = bucket.bucketEnd ? Date.parse(bucket.bucketEnd) : Number.NaN
      const seconds = Number.isNaN(end) || end <= ts ? fallbackSeconds : (end - ts) / 1000
      return { ts, served: bucket.bytesOut, received: bucket.bytesIn, seconds }
    })
    .filter((point): point is ServiceTrafficPoint => point !== null)
    .sort((a, b) => a.ts - b.ts)
}

/** Group kinds: named domain, network of unnamed addresses, per-protocol pool. */
export function destinationGroupKind(group: DestinationDomainGroup): 'domain' | 'network' | 'pool' {
  if (group.domain) return 'domain'
  if (group.key.startsWith('a:') || group.org || group.asn) return 'network'
  return 'pool'
}

/** Title of a group row: the domain, the network's organisation, or "<Protocol> (unnamed)". */
export function destinationGroupTitle(group: DestinationDomainGroup): string {
  switch (destinationGroupKind(group)) {
    case 'domain':
      return group.domain!
    case 'network':
      return group.org ?? (group.asn ? `AS${group.asn}` : group.names[0]?.peerIp ?? 'Unknown network')
    default:
      return `${formatProtocolLabel(group.protocol ?? 'other')} (unnamed)`
  }
}

/** Muted sub-line under a group title. */
export function destinationGroupSubtitle(group: DestinationDomainGroup): string {
  switch (destinationGroupKind(group)) {
    case 'domain':
      return `${group.nameCount} ${group.nameCount === 1 ? 'name' : 'names'}`
    case 'network':
      return `network${group.asn ? ` · AS${group.asn}` : ''} · ${group.nameCount} ${group.nameCount === 1 ? 'address' : 'addresses'}`
    default:
      return 'labelled by nDPI without a hostname'
  }
}

/** Label of a member row: its name, else its address, else "<Protocol> (unnamed)". */
export function destinationNameLabel(name: Pick<DestinationName, 'serverName' | 'peerIp' | 'protocol'>): string {
  return name.serverName ?? name.peerIp ?? `${formatProtocolLabel(name.protocol)} (unnamed)`
}
