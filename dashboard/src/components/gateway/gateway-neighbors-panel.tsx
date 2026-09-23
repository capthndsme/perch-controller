import { useMemo, useState } from 'react'
import { HostCell, NotReported, ObservedLine, ShowMore, TableScroll } from '@/components/gateway/observation-bits'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { formatLastSeen } from '@/lib/collectors'
import { formatDateTime } from '@/lib/gateway-observation'
import { cn } from '@/lib/utils'
import type { GatewayNeighbor, GatewayNeighborsResponse } from '@/types/api'

const PAGE = 50

type GatewayNeighborsPanelProps = {
  data: GatewayNeighborsResponse | undefined
  isPending: boolean
  error: Error | null
  reported: boolean
}

function searchText(n: GatewayNeighbor): string {
  return [n.ipv4, ...n.ipv6, n.mac, n.hostname, n.device?.name, n.network, n.ifname]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/**
 * The router's neighbour table (ARP / NDP): every host it has talked to on
 * its own networks lately. A reachable entry is a sighting: with Settings →
 * Presence → gateway sightings on, it keeps a quiet device Connected.
 */
export function GatewayNeighborsPanel({ data, isPending, error, reported }: GatewayNeighborsPanelProps) {
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const neighbors = useMemo(() => data?.neighbors ?? [], [data])
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return needle === '' ? neighbors : neighbors.filter((n) => searchText(n).includes(needle))
  }, [neighbors, search])
  const reachable = neighbors.filter((n) => n.reachable).length

  return (
    <Panel
      title="Neighbours"
      description={
        data ? (
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <span>
              {reachable} of {neighbors.length} reachable ·
            </span>
            <ObservedLine observedAt={data.observedAt} stale={data.observedAt !== null && data.stale} />
          </span>
        ) : (
          'The router’s ARP / NDP table.'
        )
      }
      actions={
        neighbors.length > 0 ? (
          <Input
            type="search"
            placeholder="Name, IP or MAC"
            aria-label="Filter neighbours"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setLimit(PAGE)
            }}
            className="h-7 w-44 rounded-md text-xs"
          />
        ) : null
      }
      flush
    >
      {isPending ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Loading neighbours…</p>
      ) : error ? (
        <p className="px-4 pb-4 text-xs text-destructive">{error.message}</p>
      ) : !reported ? (
        <div className="px-4 pb-4">
          <NotReported what="neighbour table" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState title={neighbors.length === 0 ? 'No neighbours' : 'No neighbour matches'} />
        </div>
      ) : (
        <>
          <TableScroll>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Address</th>
                  <th>Interface</th>
                  <th>State</th>
                  <th>Last reachable</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, limit).map((n) => (
                  <tr key={n.mac}>
                    <td>
                      <HostCell mac={n.mac} device={n.device} routerName={n.hostname} />
                    </td>
                    <td className="font-mono text-[12px]">
                      {n.ipv4 ?? n.ipv6[0] ?? '—'}
                      {n.ipv6.length > (n.ipv4 ? 0 : 1) ? (
                        <span className="block text-[11px] text-muted-foreground" title={n.ipv6.join('\n')}>
                          +{n.ipv6.length - (n.ipv4 ? 0 : 1)} IPv6
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <span className="whitespace-nowrap font-mono text-[12px]">{n.ifname ?? '—'}</span>
                      {n.network ? <span className="block text-[11px] text-muted-foreground">{n.network}</span> : null}
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span
                          aria-hidden
                          className={cn('inline-block size-1.5 rounded-full', n.reachable ? 'bg-status-good' : 'bg-muted-foreground/40')}
                        />
                        {n.reachable ? 'reachable' : 'stale'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground" title={formatDateTime(n.seenAt)}>
                      {n.seenAt ? formatLastSeen(n.seenAt) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <ShowMore shown={limit} total={filtered.length} onShowAll={() => setLimit(filtered.length)} />
        </>
      )}
    </Panel>
  )
}
