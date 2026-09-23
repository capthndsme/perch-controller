import { useMemo, useState } from 'react'
import { HostCell, NotReported, ObservedLine, ShowMore, TableScroll } from '@/components/gateway/observation-bits'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { formatLastSeen } from '@/lib/collectors'
import { formatDateTime, formatLeaseExpiry, hostDisplayName } from '@/lib/gateway-observation'
import type { DhcpLease, GatewayLeasesResponse } from '@/types/api'

const PAGE = 50
const ALL = '__all__'
/** A lease that runs this long reads as "long leases", not as a problem. */
const LONG_LEASE_DAYS = 30

type GatewayLeasesPanelProps = {
  data: GatewayLeasesResponse | undefined
  isPending: boolean
  isPlaceholderData?: boolean
  error: Error | null
  reported: boolean
}

function searchText(lease: DhcpLease): string {
  return [lease.ip, lease.mac, lease.hostname, lease.staticName, lease.device?.name, lease.network]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/** Days until the longest-running IPv4 lease ends (none when every lease is short or infinite). */
function longestLeaseDays(leases: DhcpLease[], now = Date.now()): number | null {
  let most: number | null = null
  for (const lease of leases) {
    if (lease.family !== 4 || lease.infinite || !lease.expiresAt) continue
    const days = (Date.parse(lease.expiresAt) - now) / 86_400_000
    if (Number.isFinite(days) && (most === null || days > most)) most = days
  }
  return most
}

/**
 * DHCP leases as the router holds them: IPv4 by address, then one row per
 * DHCPv6 address. The name is Perch's device name, else the router's static
 * host name, else the lease's hostname. Long leases (hundreds of days) are a
 * normal setup; presence then leans on the neighbour table, not renewals.
 */
export function GatewayLeasesPanel({ data, isPending, isPlaceholderData = false, error, reported }: GatewayLeasesPanelProps) {
  const [network, setNetwork] = useState<string>(ALL)
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(PAGE)

  const leases = useMemo(() => data?.leases ?? [], [data])
  const networks = useMemo(
    () => [...new Set(leases.map((l) => l.network).filter((n): n is string => n !== null))].sort(),
    [leases],
  )
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return leases.filter(
      (lease) =>
        (network === ALL || lease.network === network) && (needle === '' || searchText(lease).includes(needle)),
    )
  }, [leases, network, search])
  const longest = longestLeaseDays(leases)
  const v4 = leases.filter((l) => l.family === 4).length

  return (
    <Panel
      title="DHCP leases"
      description={
        data ? (
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <span>
              {v4} IPv4{leases.length > v4 ? `, ${leases.length - v4} IPv6` : ''} ·
            </span>
            <ObservedLine observedAt={data.observedAt} stale={data.observedAt !== null && data.stale} />
          </span>
        ) : (
          'The router’s current leases.'
        )
      }
      actions={
        leases.length > 0 ? (
          <Input
            type="search"
            placeholder="Name, IP or MAC"
            aria-label="Filter leases"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setLimit(PAGE)
            }}
            className="h-7 w-44 rounded-md text-xs"
          />
        ) : null
      }
      updating={isPlaceholderData}
      flush
    >
      {isPending ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Loading leases…</p>
      ) : error ? (
        <p className="px-4 pb-4 text-xs text-destructive">{error.message}</p>
      ) : !reported ? (
        <div className="px-4 pb-4">
          <NotReported what="DHCP leases" />
        </div>
      ) : leases.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState
            title="No leases"
            description="The router holds no DHCP lease right now (or another box serves DHCP on this network)."
          />
        </div>
      ) : (
        <>
          {networks.length > 1 || (longest !== null && longest > LONG_LEASE_DAYS) ? (
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-3">
              {networks.length > 1 ? (
                <Segmented
                  size="xs"
                  ariaLabel="Network"
                  value={network}
                  onChange={(next) => {
                    setNetwork(next)
                    setLimit(PAGE)
                  }}
                  options={[{ id: ALL, label: 'All' }, ...networks.map((n) => ({ id: n, label: n }))]}
                  className="max-w-full overflow-x-auto"
                />
              ) : (
                <span />
              )}
              {longest !== null && longest > LONG_LEASE_DAYS ? (
                <p className="text-[11px] text-muted-foreground">
                  Long leases (up to {Math.round(longest)} d) are fine: devices rarely renew, so presence
                  uses the neighbour table and traffic.
                </p>
              ) : null}
            </div>
          ) : null}
          {filtered.length === 0 ? (
            <div className="px-4 pb-4">
              <EmptyState title="No lease matches" />
            </div>
          ) : (
            <TableScroll>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>IP</th>
                    <th>Network</th>
                    <th>Expires</th>
                    <th>Last sighting</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, limit).map((lease) => (
                    <tr key={`${lease.family}-${lease.ip}-${lease.mac ?? ''}`}>
                      <td>
                        <HostCell
                          mac={lease.mac}
                          device={lease.device}
                          routerName={hostDisplayName(null, lease.staticName, lease.hostname)}
                        />
                        {lease.staticName ? (
                          <Badge variant="outline" className="mt-1 rounded text-[10px] text-muted-foreground">
                            static host {lease.staticName}
                          </Badge>
                        ) : null}
                      </td>
                      <td className="font-mono text-[12px]">
                        {lease.ip}
                        {lease.family === 6 ? (
                          <Badge variant="outline" className="ml-1.5 rounded text-[10px]">
                            v6
                          </Badge>
                        ) : null}
                      </td>
                      <td>{lease.network ?? '—'}</td>
                      <td className="whitespace-nowrap" title={formatDateTime(lease.expiresAt)}>
                        {formatLeaseExpiry(lease)}
                      </td>
                      <td className="whitespace-nowrap text-muted-foreground" title={formatDateTime(lease.seenAt)}>
                        {lease.seenAt ? formatLastSeen(lease.seenAt) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
          <ShowMore shown={limit} total={filtered.length} onShowAll={() => setLimit(filtered.length)} />
        </>
      )}
    </Panel>
  )
}
