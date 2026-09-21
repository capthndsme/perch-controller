import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ScopeToggle } from '@/components/dashboard/scope-toggle'
import { TimePicker } from '@/components/dashboard/time-picker'
import { CategoriesPanel } from '@/components/destinations/categories-panel'
import { DestinationsTable } from '@/components/destinations/destinations-table'
import { GatewayPanel } from '@/components/gateway/gateway-panel'
import { ProtocolsSection } from '@/components/devices/protocols-section'
import { PageHeader } from '@/components/layout/page-header'
import { TopDestinations } from '@/components/peers/top-destinations'
import { Button } from '@/components/ui/button'
import { KpiTile } from '@/components/ui/kpi-tile'
import { Panel } from '@/components/ui/panel'
import { useDashboardScope, useDashboardTime } from '@/hooks/use-dashboard-time'
import { useDestinations } from '@/hooks/use-destinations'
import { useAggregateProtocols, useAggregateTraffic } from '@/hooks/use-devices'
import { useTopPeers } from '@/hooks/use-peers'
import { useRouter } from '@/hooks/use-router'
import { categoryLabel } from '@/lib/categories'
import { destinationGroupTitle } from '@/lib/destinations'
import { formatBytes } from '@/lib/format-bytes'
import type { TimeWindow } from '@/lib/time-window'

const DEFAULT_TRAFFIC_WINDOW: TimeWindow = { kind: 'relative', range: '24h' }

type DestinationView = 'sites' | 'networks'
const DESTINATION_VIEWS: Array<{ id: DestinationView; label: string; title: string }> = [
  { id: 'sites', label: 'Sites', title: 'Destinations by domain (TLS SNI / HTTP host), expandable to hostnames' },
  { id: 'networks', label: 'Networks', title: 'WAN peers grouped by autonomous system, expandable to addresses' },
]

/** "Where the traffic goes": destinations by site and network, applications, protocols, LAN peers. */
export function TrafficPage() {
  const queryClient = useQueryClient()
  const {
    window,
    resolutionMode,
    resolution,
    refreshInterval,
    setWindow,
    setResolutionMode,
    setRefreshInterval,
  } = useDashboardTime(DEFAULT_TRAFFIC_WINDOW)
  const { scope, apiScope, setScope } = useDashboardScope()

  const [destinationView, setDestinationView] = useState<DestinationView>('sites')

  const traffic = useAggregateTraffic({ window, resolution, scope: apiScope, refreshInterval })
  const wan = useTopPeers({ window, scope: 'wan', limit: 50, refreshInterval })
  const lan = useTopPeers({ window, scope: 'lan', limit: 30, refreshInterval })
  const protocols = useAggregateProtocols({ window, resolution, refreshInterval })
  const destinations = useDestinations({ window, limit: 50, refreshInterval })
  const gateway = useRouter({ window, refreshInterval })

  const topAsn = wan.data?.asns[0]
  const topProtocol = protocols.data?.protocols[0]
  const topSite = destinations.data?.domains[0]
  const topCategory = destinations.data?.categories[0]

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Traffic"
        description="Where the traffic goes: sites, applications, networks, protocols and LAN peers over the window."
        actions={
          <>
            <ScopeToggle value={scope} onChange={setScope} />
            <TimePicker
              window={window}
              resolutionMode={resolutionMode}
              refreshInterval={refreshInterval}
              onWindowChange={setWindow}
              onResolutionModeChange={setResolutionMode}
              onRefreshIntervalChange={setRefreshInterval}
              onRefreshNow={() => queryClient.invalidateQueries()}
            />
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Downloaded" value={formatBytes(traffic.data?.summary.bytesIn ?? 0)} sub="in window" />
        <KpiTile label="Uploaded" value={formatBytes(traffic.data?.summary.bytesOut ?? 0)} sub="in window" />
        <KpiTile
          label="Top site"
          value={<span className="text-lg">{topSite ? destinationGroupTitle(topSite) : '—'}</span>}
          sub={topSite ? `${formatBytes(topSite.totalBytes)} · ${topSite.percentage}% of WAN bytes` : 'no destination history yet'}
        />
        <KpiTile
          label="Top application"
          value={<span className="text-lg">{topCategory ? categoryLabel(topCategory.category) : '—'}</span>}
          sub={topCategory ? `${formatBytes(topCategory.totalBytes)} · ${topCategory.percentage}%` : 'no destination history yet'}
        />
        <KpiTile
          label="Top network"
          value={<span className="text-lg">{topAsn?.org ?? '—'}</span>}
          sub={topAsn ? `${formatBytes(topAsn.totalBytes)} · ${topAsn.asn ? `AS${topAsn.asn}` : 'no ASN'}` : 'no peer history yet'}
        />
        <KpiTile
          label="Top protocol"
          value={<span className="text-lg">{topProtocol?.protocol ?? '—'}</span>}
          sub={topProtocol ? `${topProtocol.percentage}% of bytes` : 'no protocol data yet'}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel
          title="Top destinations"
          description={
            destinationView === 'sites'
              ? 'Where WAN bytes went, by site. Expand a domain for its hostnames, then a hostname for its history.'
              : 'WAN peers grouped by autonomous system. Expand a network to see its addresses.'
          }
          updating={destinationView === 'sites' ? destinations.isPlaceholderData : wan.isPlaceholderData}
          flush
          actions={
            <div className="flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Destination view">
              {DESTINATION_VIEWS.map((opt) => (
                <Button
                  key={opt.id}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={destinationView === opt.id}
                  variant={destinationView === opt.id ? 'secondary' : 'ghost'}
                  className="h-6 px-2 text-xs"
                  title={opt.title}
                  onClick={() => setDestinationView(opt.id)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          }
        >
          {destinationView === 'sites' ? (
            <>
              <DestinationsTable
                data={destinations.data}
                isPending={destinations.isPending}
                error={destinations.error}
                window={window}
              />
              <p className="border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
                Names from TLS SNI / HTTP Host; unnamed flows grouped by network (ASN).
              </p>
            </>
          ) : (
            <TopDestinations data={wan.data} scope="wan" isPending={wan.isPending} error={wan.error} />
          )}
        </Panel>

        <Panel
          title="Applications"
          description="WAN bytes by nDPI application category."
          updating={destinations.isPlaceholderData}
          flush
        >
          <CategoriesPanel
            categories={destinations.data?.categories}
            isPending={destinations.isPending}
            error={destinations.error}
            limit={12}
          />
        </Panel>
      </div>

      <GatewayPanel
        data={gateway.data}
        isPending={gateway.isPending}
        isPlaceholderData={gateway.isPlaceholderData}
        error={gateway.error}
      />

      <ProtocolsSection
        title="Protocol mix"
        description="Traffic by detected protocol across all devices. Expand a protocol for its top devices, or group by application category."
        data={protocols.data}
        isPending={protocols.isPending}
        isPlaceholderData={protocols.isPlaceholderData}
        error={protocols.error}
        onZoom={setWindow}
        onResetZoom={() => setWindow(DEFAULT_TRAFFIC_WINDOW)}
        canResetZoom={window.kind === 'absolute'}
        topDevices={{ window, refreshInterval }}
        allowGroupBy
      />

      <Panel
        title="LAN peers"
        description="Who talks to whom inside the network (NAS, cameras, printers)."
        updating={lan.isPlaceholderData}
        flush
      >
        <TopDestinations data={lan.data} scope="lan" isPending={lan.isPending} error={lan.error} />
      </Panel>
    </div>
  )
}
