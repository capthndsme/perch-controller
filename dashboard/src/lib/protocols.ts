import type { ChartConfig } from '@/components/ui/chart'
import type { ProtocolBreakdown, ProtocolTimeSeriesPoint } from '@/types/api'

export type ProtocolStackPoint = {
  /** Epoch ms of the bucket start — used as the X-axis numeric key. */
  ts: number
  /** Total bytes (in + out) per protocol for tooltip display. */
  bytesByProtocol: Record<string, number>
  [protocol: string]: number | Record<string, number>
}

const PROTOCOL_LABELS: Record<string, string> = {
  http: 'HTTP',
  https: 'HTTPS',
  'http-alt': 'HTTP (alt)',
  'https-alt': 'HTTPS (alt)',
  quic: 'QUIC',
  dns: 'DNS',
  dot: 'DNS over TLS',
  doq: 'DNS over QUIC',
  mdns: 'mDNS',
  ntp: 'NTP',
  dhcp: 'DHCP',
  snmp: 'SNMP',
  syslog: 'Syslog',
  smtp: 'SMTP',
  smtps: 'SMTPS',
  submission: 'SMTP submission',
  pop3: 'POP3',
  pop3s: 'POP3S',
  imap: 'IMAP',
  imaps: 'IMAPS',
  ssh: 'SSH',
  telnet: 'Telnet',
  rdp: 'RDP',
  vnc: 'VNC',
  smb: 'SMB',
  netbios: 'NetBIOS',
  nfs: 'NFS',
  ftp: 'FTP',
  iscsi: 'iSCSI',
  plex: 'Plex',
  jellyfin: 'Jellyfin',
  'jellyfin-tls': 'Jellyfin (TLS)',
  openvpn: 'OpenVPN',
  wireguard: 'WireGuard',
  ipsec: 'IPsec',
  l2tp: 'L2TP',
  pptp: 'PPTP',
  mqtt: 'MQTT',
  mqtts: 'MQTTS',
  coap: 'CoAP',
  bittorrent: 'BitTorrent',
  'xbox-live': 'Xbox Live',
  stun: 'STUN',
  minecraft: 'Minecraft',
  'minecraft-bedrock': 'Minecraft Bedrock',
  steam: 'Steam',
  netflix: 'Netflix',
  youtube: 'YouTube',
  whatsapp: 'WhatsApp',
  discord: 'Discord',
  spotify: 'Spotify',
  tiktok: 'TikTok',
  twitch: 'Twitch',
  facebook: 'Facebook',
  instagram: 'Instagram',
  google: 'Google',
  apple: 'Apple',
  applepush: 'Apple Push',
  microsoft: 'Microsoft',
  'microsoft-365': 'Microsoft 365',
  'windows-update': 'Windows Update',
  signal: 'Signal',
  zoom: 'Zoom',
  teams: 'Teams',
  skypecall: 'Skype',
  imo: 'IMO',
  // CDN / hosting / network infra labels nDPI surfaces alongside app labels.
  cloudflare: 'Cloudflare',
  akamai: 'Akamai',
  fastly: 'Fastly',
  amazon: 'Amazon',
  aws: 'AWS',
  // Streaming and media transport that nDPI promotes out of tcp/udp-other.
  rtsp: 'RTSP',
  rtmp: 'RTMP',
  websocket: 'WebSocket',
  // Privacy / VPN / DNS over things — nDPI sees them where ports lie.
  tor: 'Tor',
  tls: 'TLS',
  // DevOps / IoT extras that round out the long tail.
  git: 'Git',
  ssdp: 'SSDP',
  bgp: 'BGP',
  'ftp-data': 'FTP (data)',
  'tcp-other': 'TCP (other)',
  'udp-other': 'UDP (other)',
  other: 'Other',
}

/**
 * Eight validated categorical slots (see `--series-*` in index.css). The
 * order is the CVD-safety mechanism; slots are never generated past eight —
 * the long tail folds into "other", which wears the neutral slot.
 */
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
 * Well-known protocols keep a fixed slot so a chart's colors follow the
 * entity, never its rank: HTTPS is always blue whichever window you look at.
 */
const PINNED_SLOTS: Record<string, number> = {
  https: 0,
  tls: 0,
  quic: 1,
  http: 2,
  dns: 3,
  smb: 4,
  ssh: 5,
  bittorrent: 6,
  youtube: 7,
}

export function formatProtocolLabel(protocol: string): string {
  return (
    PROTOCOL_LABELS[protocol] ??
    protocol
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  )
}

export function protocolTotalBytes(entry: Pick<ProtocolBreakdown, 'bytesIn' | 'bytesOut'>): number {
  return entry.bytesIn + entry.bytesOut
}

export function topProtocols(
  protocols: ProtocolBreakdown[],
  limit = 8,
): ProtocolBreakdown[] {
  return [...protocols]
    .sort((a, b) => protocolTotalBytes(b) - protocolTotalBytes(a))
    .slice(0, limit)
}

export function protocolColor(protocol: string): string {
  if (protocol === 'other') return 'var(--series-other)'
  const pinned = PINNED_SLOTS[protocol]
  if (pinned !== undefined) return SERIES_SLOTS[pinned]
  // Stable hash → slot for the long tail (entity-stable across windows).
  let hash = 0
  for (let i = 0; i < protocol.length; i++) {
    hash = (hash * 31 + protocol.charCodeAt(i)) >>> 0
  }
  return SERIES_SLOTS[hash % SERIES_SLOTS.length]
}

export function buildProtocolChartConfig(protocols: string[]): ChartConfig {
  const config: ChartConfig = {}
  for (const protocol of protocols) {
    config[protocol] = {
      label: formatProtocolLabel(protocol),
      color: protocolColor(protocol),
    }
  }
  return config
}

/**
 * Fold protocol time-series buckets into stacked chart points. Shows the
 * top N protocols individually; everything else rolls into `other`.
 *
 * Each point keeps `ts` as the epoch ms of the bucket so the chart can
 * use a true numeric/time X-axis (needed for drag-to-zoom math and for
 * a consistent tick formatter across short and long windows).
 */
export function protocolTimeSeriesToChartPoints(
  timeSeries: ProtocolTimeSeriesPoint[],
  topProtocolNames: string[],
  resolutionSeconds: number,
): ProtocolStackPoint[] {
  const top = new Set(topProtocolNames)

  return timeSeries
    .map((bucket) => {
      const ts = Date.parse(bucket.bucketStart)
      if (Number.isNaN(ts)) return null

      const bytesByProtocol: Record<string, number> = {}
      let otherBytes = 0

      for (const [protocol, stats] of Object.entries(bucket.protocols)) {
        const total = stats.bytesIn + stats.bytesOut
        if (top.has(protocol)) {
          bytesByProtocol[protocol] = total
        } else {
          otherBytes += total
        }
      }

      if (otherBytes > 0) {
        bytesByProtocol.other = otherBytes
      }

      const point: ProtocolStackPoint = {
        ts,
        bytesByProtocol,
      }

      for (const [protocol, bytes] of Object.entries(bytesByProtocol)) {
        point[protocol] = (bytes * 8) / resolutionSeconds / 1_000_000
      }

      return point
    })
    .filter((p): p is ProtocolStackPoint => p !== null)
}

export function chartProtocolsFromBreakdown(
  protocols: ProtocolBreakdown[],
  limit = 8,
): string[] {
  const top = topProtocols(protocols, limit)
  const names = top.map((entry) => entry.protocol)
  const accounted = top.reduce((sum, entry) => sum + protocolTotalBytes(entry), 0)
  const total = protocols.reduce((sum, entry) => sum + protocolTotalBytes(entry), 0)

  if (total > accounted) {
    return [...names, 'other']
  }

  return names
}
