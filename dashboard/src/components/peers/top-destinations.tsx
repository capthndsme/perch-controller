import { Fragment, useMemo, useState } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { EmptyState } from '@/components/ui/empty-state'
import { ShareBar } from '@/components/ui/share-bar'
import { formatBytes } from '@/lib/format-bytes'
import type { PeerHistoryEntry, PeerScope, TopPeersResponse } from '@/types/api'

type TopDestinationsProps = {
  data: TopPeersResponse | undefined
  scope: PeerScope
  isPending: boolean
  error: Error | null
  /** Group WAN peers under their ASN (default); LAN peers are always flat. */
  groupByAsn?: boolean
  /** Compact mode hides the per-peer breakdown and the in/out columns. */
  compact?: boolean
  limit?: number
}

type AsnGroup = {
  key: string
  org: string
  asn: number | null
  totalBytes: number
  bytesIn: number
  bytesOut: number
  deviceCount: number
  peers: PeerHistoryEntry[]
}

function groupPeers(peers: PeerHistoryEntry[]): AsnGroup[] {
  const groups = new Map<string, AsnGroup>()
  for (const peer of peers) {
    const key = `${peer.asn ?? 'unknown'}:${peer.org ?? ''}`
    const group =
      groups.get(key) ??
      ({
        key,
        org: peer.org ?? 'Unknown network',
        asn: peer.asn,
        totalBytes: 0,
        bytesIn: 0,
        bytesOut: 0,
        deviceCount: 0,
        peers: [],
      } satisfies AsnGroup)
    group.totalBytes += peer.totalBytes
    group.bytesIn += peer.bytesIn
    group.bytesOut += peer.bytesOut
    group.deviceCount = Math.max(group.deviceCount, peer.deviceCount)
    group.peers.push(peer)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.totalBytes - a.totalBytes)
}

/**
 * "Where is the traffic going": peer IPs from the hourly peer history,
 * grouped by ASN for WAN so the table reads as organisations, not addresses.
 * Bytes are from the device's point of view: in = downloaded from the peer,
 * out = uploaded to it.
 */
export function TopDestinations({
  data,
  scope,
  isPending,
  error,
  groupByAsn = true,
  compact = false,
  limit,
}: TopDestinationsProps) {
  const [open, setOpen] = useState<string | null>(null)
  const peers = useMemo(() => (limit ? (data?.peers ?? []).slice(0, limit) : data?.peers ?? []), [data, limit])
  const groups = useMemo(() => (scope === 'wan' && groupByAsn ? groupPeers(peers) : null), [peers, scope, groupByAsn])
  const total = data?.totalBytes ?? 0

  if (isPending && !data) {
    return <p className="px-4 pb-4 text-xs text-muted-foreground">Loading destinations…</p>
  }
  if (error) {
    return <p className="px-4 pb-4 text-xs text-destructive">{error.message}</p>
  }
  if (peers.length === 0) {
    return (
      <div className="px-4 pb-4">
        <EmptyState
          title="No peer history in this window"
          description="Peer history accumulates hourly from the collector. Widen the window or wait for the next hour to close."
        />
      </div>
    )
  }

  if (groups) {
    return (
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-6" />
              <th>Network</th>
              <th className="text-right">Share</th>
              {!compact ? <th className="text-right">Down</th> : null}
              {!compact ? <th className="text-right">Up</th> : null}
              <th className="text-right">Total</th>
              {!compact ? <th className="text-right">Devices</th> : null}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const isOpen = open === group.key
              const pct = total > 0 ? (group.totalBytes / total) * 100 : 0
              return (
                <Fragment key={group.key}>
                  <tr
                    data-clickable="true"
                    onClick={() => setOpen(isOpen ? null : group.key)}
                    aria-expanded={isOpen}
                  >
                    <td className="pr-0 text-muted-foreground">
                      {isOpen ? <CaretDown className="size-3.5" /> : <CaretRight className="size-3.5" />}
                    </td>
                    <td>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{group.org}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {group.asn ? `AS${group.asn}` : 'no ASN'} · {group.peers.length}{' '}
                          {group.peers.length === 1 ? 'address' : 'addresses'}
                        </p>
                      </div>
                    </td>
                    <td>
                      <ShareBar percentage={pct} />
                    </td>
                    {!compact ? (
                      <td className="text-right font-mono tabular-nums">{formatBytes(group.bytesIn)}</td>
                    ) : null}
                    {!compact ? (
                      <td className="text-right font-mono tabular-nums">{formatBytes(group.bytesOut)}</td>
                    ) : null}
                    <td className="text-right font-mono font-medium tabular-nums">
                      {formatBytes(group.totalBytes)}
                    </td>
                    {!compact ? (
                      <td className="text-right font-mono tabular-nums text-muted-foreground">
                        {group.deviceCount}
                      </td>
                    ) : null}
                  </tr>
                  {isOpen
                    ? group.peers.map((peer) => (
                        <tr key={peer.peerIp} className="bg-muted/20">
                          <td />
                          <td className="font-mono text-[12px]">
                            {peer.peerIp}
                            {peer.prefix ? (
                              <span className="ml-2 text-muted-foreground">{peer.prefix}</span>
                            ) : null}
                          </td>
                          <td>
                            <ShareBar percentage={peer.percentage} color="var(--series-other)" />
                          </td>
                          {!compact ? (
                            <td className="text-right font-mono tabular-nums">{formatBytes(peer.bytesIn)}</td>
                          ) : null}
                          {!compact ? (
                            <td className="text-right font-mono tabular-nums">{formatBytes(peer.bytesOut)}</td>
                          ) : null}
                          <td className="text-right font-mono tabular-nums">{formatBytes(peer.totalBytes)}</td>
                          {!compact ? (
                            <td className="text-right font-mono tabular-nums text-muted-foreground">
                              {peer.deviceCount}
                            </td>
                          ) : null}
                        </tr>
                      ))
                    : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Peer</th>
            <th className="text-right">Share</th>
            {!compact ? <th className="text-right">Down</th> : null}
            {!compact ? <th className="text-right">Up</th> : null}
            <th className="text-right">Total</th>
            {!compact ? <th className="text-right">Devices</th> : null}
          </tr>
        </thead>
        <tbody>
          {peers.map((peer) => (
            <tr key={peer.peerIp}>
              <td>
                <p className="font-mono text-[12px]">{peer.peerIp}</p>
                {scope === 'wan' && peer.org ? (
                  <p className="text-[11px] text-muted-foreground">{peer.org}</p>
                ) : null}
              </td>
              <td>
                <ShareBar percentage={peer.percentage} />
              </td>
              {!compact ? <td className="text-right font-mono tabular-nums">{formatBytes(peer.bytesIn)}</td> : null}
              {!compact ? <td className="text-right font-mono tabular-nums">{formatBytes(peer.bytesOut)}</td> : null}
              <td className="text-right font-mono font-medium tabular-nums">{formatBytes(peer.totalBytes)}</td>
              {!compact ? (
                <td className="text-right font-mono tabular-nums text-muted-foreground">{peer.deviceCount}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
