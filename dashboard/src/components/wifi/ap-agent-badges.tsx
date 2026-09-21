import { Badge } from '@/components/ui/badge'
import type { WifiApControls, WifiTransport } from '@/types/api'

function Dot({ className }: { className: string }) {
  return <span aria-hidden className={`mr-1 inline-block size-2 rounded-full ${className}`} />
}

/** Connection state of a Perch AP Daemon. */
export function AgentStatusBadge({ online, prefix = 'Agent' }: { online: boolean; prefix?: string }) {
  return (
    <Badge variant="outline">
      <Dot className={online ? 'bg-status-good' : 'bg-status-critical'} />
      {prefix} {online ? 'online' : 'offline'}
    </Badge>
  )
}

/** Where an AP's metrics come from. */
export function TransportBadge({ transport }: { transport: WifiTransport }) {
  return transport === 'agent' ? (
    <Badge variant="outline" title="Metrics and commands over the Perch AP Daemon's WebSocket">
      perch-apd
    </Badge>
  ) : (
    <Badge variant="outline" title="Scraped from the AP's Prometheus /metrics endpoint">
      node_exporter (HTTP)
    </Badge>
  )
}

/** AP page header: how this dashboard reaches the AP, and whether it can right now. */
export function ApChannelBadges({
  transport,
  controls,
}: {
  transport: WifiTransport
  controls: WifiApControls
}) {
  if (transport === 'agent' || controls.via === 'agent') {
    return <AgentStatusBadge online={controls.online} prefix="perch-apd" />
  }
  return (
    <>
      <TransportBadge transport={transport} />
      <Badge variant="outline" className={controls.via === 'ssh' ? undefined : 'text-muted-foreground'}>
        {controls.via === 'ssh' ? 'SSH commands' : 'No command channel'}
      </Badge>
    </>
  )
}
