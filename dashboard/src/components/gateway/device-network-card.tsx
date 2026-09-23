import { Link } from 'react-router-dom'
import { FactRow } from '@/components/gateway/observation-bits'
import { Panel } from '@/components/ui/panel'
import { useDeviceNetwork } from '@/hooks/use-gateway-observation'
import { ApiError } from '@/lib/api'
import { formatLastSeen } from '@/lib/collectors'
import { formatDateTime, formatLeaseExpiry, formatRelative } from '@/lib/gateway-observation'
import { cn } from '@/lib/utils'

/**
 * Device page: what the gateway knows of this device, from the observation
 * channel (`/devices/:mac/network`): its DHCP lease, neighbour entry,
 * network, last gateway sighting and the ports it opened with UPnP.
 * The reservation has its own card (config plane); the WAN block shows here
 * when the gateway's config plane is on.
 */
export function DeviceNetworkCard({ mac }: { mac: string | undefined }) {
  const query = useDeviceNetwork(mac)
  const data = query.data
  const gatewayLink = data?.gatewayId ? `/gateway?gateway=${data.gatewayId}` : '/gateway'
  // The gateway knows the device (its collector listed it); `gatewayId` is
  // the config plane's row and may be missing while `collectorId` is set.
  const known = data ? (data.collectorId ?? data.gatewayId) !== null : false
  // A controller without the observation channel answers 404 on this route.
  const unsupported = query.error instanceof ApiError && query.error.status === 404

  return (
    <Panel
      title="Network"
      description={
        known ? 'What the gateway reports for this device.' : undefined
      }
      actions={
        known && data?.gatewayId ? (
          <Link to={gatewayLink} className="text-xs text-brand hover:underline">
            Gateway →
          </Link>
        ) : null
      }
    >
      {query.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : unsupported ? (
        <p className="text-xs text-muted-foreground">This controller does not read the gateway's state yet.</p>
      ) : query.error ? (
        <p className="text-xs text-destructive">{query.error.message}</p>
      ) : !data || !known ? (
        <p className="text-xs text-muted-foreground">
          The gateway lists no lease or neighbour entry for this device. A device on a network the
          router does not serve, or a Gateway agent that does not report leases and neighbours yet,
          reads like this.
        </p>
      ) : (
        <div className="divide-y divide-border/70">
          <FactRow label="Network">{data.network ?? '—'}</FactRow>
          <FactRow label="DHCP lease">
            {data.lease ? (
              <>
                <span className="font-mono">{data.lease.ip}</span>
                <span className="block text-[11px] text-muted-foreground" title={formatDateTime(data.lease.expiresAt)}>
                  {data.lease.infinite ? 'never expires' : `expires ${formatLeaseExpiry(data.lease)}`}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">none (static address or not from this router)</span>
            )}
          </FactRow>
          {data.lease?.staticName || data.lease?.hostname ? (
            <FactRow label="Router's name">
              {data.lease.staticName ?? data.lease.hostname}
              {data.lease.staticName ? <span className="block text-[11px] text-muted-foreground">static host</span> : null}
            </FactRow>
          ) : null}
          <FactRow label="Reservation">
            <span className="text-muted-foreground">
              {data.lease?.staticName ? 'static host on the router' : 'none'}
              <span className="block text-[11px]">A managed gateway's reservation is on the Reservation card.</span>
            </span>
          </FactRow>
          {data.wanBlocked ? (
            <FactRow label="Internet access">
              {data.wanBlocked.blocked ? (
                <span className="text-status-serious">
                  blocked
                  <span className="block text-[11px] text-muted-foreground">
                    {data.wanBlocked.ruleEnabled === false
                      ? 'block rule disabled on the router'
                      : data.wanBlocked.applied
                        ? data.wanBlocked.since
                          ? `since ${formatLastSeen(data.wanBlocked.since)}`
                          : 'on the router'
                        : 'waiting for the apply'}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">{data.wanBlocked.applied ? 'allowed' : 'unblocking…'}</span>
              )}
            </FactRow>
          ) : null}
          <FactRow label="Neighbour entry">
            {data.neighbor ? (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cn(
                      'inline-block size-1.5 rounded-full',
                      data.neighbor.reachable ? 'bg-status-good' : 'bg-muted-foreground/40',
                    )}
                  />
                  {data.neighbor.reachable ? 'reachable' : 'stale'}
                  {data.neighbor.ifname ? <span className="font-mono text-[12px]"> on {data.neighbor.ifname}</span> : null}
                </span>
                {[data.neighbor.ipv4, ...data.neighbor.ipv6].filter(Boolean).length > 0 ? (
                  <span className="block font-mono text-[11px] text-muted-foreground">
                    {[data.neighbor.ipv4, ...data.neighbor.ipv6].filter(Boolean).join(', ')}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">not in the router's table</span>
            )}
          </FactRow>
          <FactRow label="Last gateway sighting">
            <span title={formatDateTime(data.seenAt)}>{data.seenAt ? formatLastSeen(data.seenAt) : '—'}</span>
          </FactRow>
          <div className="py-1.5 text-[12.5px]">
            <p className="text-muted-foreground">UPnP mappings</p>
            {data.upnp.length === 0 ? (
              <p className="mt-0.5 text-[12px] text-muted-foreground">None: this device opened no ports on the router.</p>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {data.upnp.map((m) => (
                  <li key={`${m.proto}-${m.externalPort}`} className="flex justify-between gap-2 font-mono text-[12px]">
                    <span>
                      {m.proto} {m.externalPort} → {m.internalPort}
                    </span>
                    <span className="truncate font-sans text-[11px] text-muted-foreground">
                      {m.description ?? ''}
                      {m.expiresAt ? ` · ${formatRelative(m.expiresAt)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  )
}
