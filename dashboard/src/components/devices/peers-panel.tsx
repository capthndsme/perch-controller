import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/format-bytes'
import type { DevicePeer } from '@/types/api'

type PeersPanelProps = {
  peers: DevicePeer[]
  scope: 'wan' | 'lan'
  isPending: boolean
  error: Error | null
  compact?: boolean
  /**
   * Cap the visible row count and surface the rest behind a "Show more"
   * button. Set to `Infinity` (or omit and pass via prop) when the caller
   * wants the legacy "render everything" behavior — e.g. the device
   * detail page where vertical space is cheap.
   */
  initialLimit?: number
}

export function PeersPanel({
  peers,
  scope,
  isPending,
  error,
  compact = false,
  initialLimit = 5,
}: PeersPanelProps) {
  const [expanded, setExpanded] = useState(false)

  if (isPending) {
    return <p className="text-sm text-muted-foreground">Loading {scope.toUpperCase()} peers…</p>
  }

  if (error) {
    return <p className="text-sm text-destructive">{error.message}</p>
  }

  if (peers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No {scope.toUpperCase()} peers recorded for this device yet.
      </p>
    )
  }

  const visibleCount = expanded ? peers.length : Math.min(initialLimit, peers.length)
  const hidden = peers.length - visibleCount
  const visiblePeers = peers.slice(0, visibleCount)

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-xs">
          <thead className="border-b bg-muted/30 text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Peer</th>
              {scope === 'wan' ? <th className="px-4 py-2 font-medium">Service</th> : null}
              <th className="px-4 py-2 font-medium text-right">Download</th>
              {!compact ? <th className="px-4 py-2 font-medium text-right">Upload</th> : null}
              <th className="px-4 py-2 font-medium text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {visiblePeers.map((peer) => {
              const total = peer.bytesIn + peer.bytesOut
              return (
                <tr key={`${peer.collectorId}-${peer.peerIp}`} className="border-b last:border-0">
                  <td className="px-4 py-3 font-mono">{peer.peerIp}</td>
                  {scope === 'wan' ? (
                    <td className="px-4 py-3">
                      {peer.service ? (
                        <Badge variant="secondary" className="rounded-md font-sans">
                          {peer.service}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  ) : null}
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatBytes(peer.bytesIn)}
                  </td>
                  {!compact ? (
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatBytes(peer.bytesOut)}
                    </td>
                  ) : null}
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {formatBytes(total)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {peers.length > initialLimit ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Show less' : `Show ${hidden} more`}
        </Button>
      ) : null}
    </div>
  )
}
