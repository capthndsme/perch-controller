import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, Broadcast, HardDrives, MapPin } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { BandwidthChart } from '@/components/charts/bandwidth-chart'
import { SignalChart } from '@/components/charts/signal-chart'
import { ScopeToggle } from '@/components/dashboard/scope-toggle'
import { TimePicker } from '@/components/dashboard/time-picker'
import { DeviceDestinationsTable } from '@/components/destinations/device-destinations-table'
import { DeviceLabelCard } from '@/components/devices/device-label-editor'
import { PeersPanel } from '@/components/devices/peers-panel'
import { ProtocolsSection } from '@/components/devices/protocols-section'
import { PageHeader } from '@/components/layout/page-header'
import { TopDestinations } from '@/components/peers/top-destinations'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { KpiTile } from '@/components/ui/kpi-tile'
import { Panel } from '@/components/ui/panel'
import { ShareBar } from '@/components/ui/share-bar'
import { useDashboardScope, useDashboardTime } from '@/hooks/use-dashboard-time'
import { useDeviceLabel } from '@/hooks/use-device-labels'
import { useDeviceOverview, useDevicePresence, useDeviceProtocols, useDeviceTraffic } from '@/hooks/use-devices'
import { useDeviceDestinations } from '@/hooks/use-destinations'
import { useDevicePeerHistory } from '@/hooks/use-peers'
import { useDeviceServices } from '@/hooks/use-services'
import { useWifiClient, useWifiClientSignal } from '@/hooks/use-wifi'
import { infraNodePath, uplinkLine } from '@/lib/attachment'
import { formatLastSeen } from '@/lib/collectors'
import { deviceDisplayName, deviceTypeMeta } from '@/lib/device-labels'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import { connectionLabel, presenceDotClass, presenceLabel } from '@/lib/presence'
import { formatProtocolLabel } from '@/lib/protocols'
import { DEFAULT_DEVICE_WINDOW } from '@/lib/time-window'
import { bucketsToChartPoints, macFromPath } from '@/lib/traffic'
import { formatSignal, formatWifiBand, wifiSignalQualityDotClass, wifiSignalQualityLabel } from '@/lib/wifi'
import type { DevicePresenceResponse, PeerScope, WifiClientSummary } from '@/types/api'

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const ts = Date.parse(value)
  if (Number.isNaN(ts)) return value
  return new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' }).format(ts)
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-[12.5px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  )
}

/**
 * The Location tile follows the device's presence: the AP it is on, or the one it was last on
 * after it left Wi-Fi; "Ethernet" when marked so or cabled on the network map (then with where the
 * cable goes, A4); "Wired / unknown" for everything else. A dash until presence loads.
 */
function locationTile(
  presence: DevicePresenceResponse | undefined,
  latestWifi: WifiClientSummary | undefined,
  collectorId: number | undefined,
): { value: string; sub?: string; onWifi: boolean } {
  if (!presence) return { value: '—', onWifi: false }
  const cable = presence.via !== 'wifi' ? uplinkLine(presence.attachment) : null
  if (cable) {
    return {
      value: connectionLabel(presence.via),
      sub:
        presence.status === 'disconnected' && presence.lastSeenAt
          ? `${cable} · last seen ${formatLastSeen(presence.lastSeenAt)}`
          : cable,
      onWifi: false,
    }
  }
  if (presence.via !== 'wifi') {
    return {
      value: connectionLabel(presence.via),
      sub:
        presence.status === 'disconnected'
          ? presenceLabel(false, presence.lastSeenAt)
          : collectorId
            ? `Seen by collector #${collectorId}`
            : 'No WiFi association',
      onWifi: false,
    }
  }
  return {
    value: latestWifi?.ap ?? '—',
    sub:
      presence.status === 'disconnected'
        ? presenceLabel(false, presence.lastSeenAt)
        : latestWifi
          ? `${latestWifi.ssid ?? 'Unknown SSID'} · ${formatWifiBand(latestWifi.band)} · ${formatSignal(latestWifi.signalDbm)}`
          : undefined,
    onWifi: true,
  }
}

export function DevicePage() {
  const { mac: macParam } = useParams()
  const mac = macParam ? macFromPath(macParam) : undefined
  const queryClient = useQueryClient()
  const {
    window,
    resolutionMode,
    resolution,
    refreshInterval,
    setWindow,
    setResolutionMode,
    setRefreshInterval,
  } = useDashboardTime(DEFAULT_DEVICE_WINDOW)
  const { scope, apiScope, isOverlay, setScope } = useDashboardScope()
  const [peerScope, setPeerScope] = useState<PeerScope>('wan')
  const [showWifiPhyOverlay, setShowWifiPhyOverlay] = useState(false)

  const overview = useDeviceOverview(mac, { window, resolution, scope: apiScope, refreshInterval })
  const protocols = useDeviceProtocols(mac, { window, resolution, refreshInterval })
  const peerHistory = useDevicePeerHistory(mac, { window, scope: peerScope, limit: 25, refreshInterval })
  const services = useDeviceServices(mac, { window, limit: 25, refreshInterval })
  const destinations = useDeviceDestinations(mac, { window, limit: 25, refreshInterval })
  const wifi = useWifiClient(mac)
  const devicePresence = useDevicePresence(mac)
  const deviceLabel = useDeviceLabel(mac)
  const wifiSignal = useWifiClientSignal(wifi.data?.latest ? mac : undefined, { window, resolution, refreshInterval })
  const overlayTraffic = useDeviceTraffic(mac, {
    window,
    resolution,
    scope: 'lan',
    refreshInterval,
    enabled: isOverlay,
  })

  const chartData = useMemo(
    () =>
      overview.data
        ? bucketsToChartPoints(
            overview.data.traffic.buckets,
            isOverlay ? overlayTraffic.data?.buckets : undefined,
            wifiSignal.data?.buckets,
          )
        : [],
    [overview.data, overlayTraffic.data, isOverlay, wifiSignal.data],
  )
  const hasWifiOverlay = chartData.some((p) => p.wifiDownload !== undefined || p.wifiUpload !== undefined)

  const totals = useMemo(() => {
    const buckets = overview.data?.traffic.buckets ?? []
    const closed = buckets.length > 1 ? buckets[buckets.length - 2] : buckets[buckets.length - 1]
    return {
      bytesIn: buckets.reduce((sum, b) => sum + b.bytesIn, 0),
      bytesOut: buckets.reduce((sum, b) => sum + b.bytesOut, 0),
      mbpsIn: closed?.mbpsIn ?? 0,
      mbpsOut: closed?.mbpsOut ?? 0,
    }
  }, [overview.data])

  const signalChartData = useMemo(
    () =>
      (wifiSignal.data?.buckets ?? [])
        .map((bucket) => {
          const ts = Date.parse(bucket.bucketStart)
          if (Number.isNaN(ts) || bucket.signalDbm === null) return null
          return { ts, signalDbm: bucket.signalDbm, snrDb: bucket.snrDb }
        })
        .filter((point): point is NonNullable<typeof point> => point !== null),
    [wifiSignal.data],
  )

  const identity = overview.data?.identity[0]
  const latestWifi = wifi.data?.latest
  const presence = devicePresence.data
  const location = locationTile(presence, latestWifi, identity?.collectorId)
  const mapNodeId = presence?.attachment?.nodeId ?? null
  const label = deviceLabel.data?.label ?? null
  // The label query is authoritative (and refetches on save); the overview's
  // copy of the same fields keeps the title right on first paint.
  const displayName = deviceDisplayName(
    { ...identity, customName: label?.name ?? identity?.customName, mac },
    'Unknown device',
  )
  const typeMeta = deviceTypeMeta(label?.deviceType ?? identity?.deviceType)
  const servicesData = services.data

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Devices', to: '/devices' }, { label: displayName }]}
        title={
          typeMeta ? (
            <span className="inline-flex items-center gap-2">
              <typeMeta.Icon className="size-4 text-muted-foreground" weight="duotone" />
              {displayName}
            </span>
          ) : (
            displayName
          )
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">
              {mac}
              {identity?.ips.length ? ` · ${identity.ips.join(', ')}` : ''}
            </span>
            {presence ? (
              <Badge variant="outline" className="rounded text-[10px]">
                <span
                  aria-hidden
                  className={`inline-block size-1.5 rounded-full ${presenceDotClass(presence.status === 'connected')}`}
                />
                {presenceLabel(presence.status === 'connected', presence.lastSeenAt)}
              </Badge>
            ) : null}
            {(label?.tags ?? []).map((tag) => (
              <Badge key={tag} variant="outline" className="rounded text-[10px]">
                {tag}
              </Badge>
            ))}
          </span>
        }
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

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiTile
          label="Download now"
          value={formatMbps(totals.mbpsIn)}
          sub={`${formatBytes(totals.bytesIn)} in window`}
          icon={<ArrowDown className="size-4" />}
        />
        <KpiTile
          label="Upload now"
          value={formatMbps(totals.mbpsOut)}
          sub={`${formatBytes(totals.bytesOut)} in window`}
          icon={<ArrowUp className="size-4" />}
        />
        <KpiTile
          label="Location"
          value={<span className="text-lg">{location.value}</span>}
          sub={
            mapNodeId !== null ? (
              <span className="flex min-w-0 items-center gap-2" data-location-sub>
                {location.sub ? <span className="min-w-0 truncate">{location.sub}</span> : null}
                <Link to={infraNodePath(mapNodeId)} className="shrink-0 text-brand underline-offset-2 hover:underline">
                  Show on the map
                </Link>
              </span>
            ) : (
              location.sub
            )
          }
          icon={location.onWifi ? <Broadcast className="size-4" /> : <MapPin className="size-4" />}
        />
        <KpiTile
          label="Served"
          value={formatBytes(servicesData?.totalBytesServed ?? 0)}
          sub={servicesData?.services.length ? `${servicesData.services.length} server names` : 'not acting as a server'}
          icon={<HardDrives className="size-4" />}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel
          title="Bandwidth"
          description="Mbps over the selected window. Drag to zoom."
          updating={overview.isPlaceholderData}
          actions={
            hasWifiOverlay ? (
              <Button
                type="button"
                size="sm"
                variant={showWifiPhyOverlay ? 'secondary' : 'outline'}
                className="h-6 px-2 text-xs"
                onClick={() => setShowWifiPhyOverlay((v) => !v)}
              >
                WiFi PHY {showWifiPhyOverlay ? 'on' : 'off'}
              </Button>
            ) : null
          }
        >
          {overview.isPending ? (
            <p className="text-xs text-muted-foreground">Loading traffic…</p>
          ) : overview.error ? (
            <p className="text-xs text-destructive">{overview.error.message}</p>
          ) : chartData.length === 0 ? (
            <EmptyState title="No buckets in this window" />
          ) : (
            <BandwidthChart
              data={chartData}
              range={overview.data?.traffic}
              showOverlay={isOverlay}
              showWifiOverlay={hasWifiOverlay && showWifiPhyOverlay}
              className="h-[300px] w-full"
              onZoom={setWindow}
              onResetZoom={() => setWindow(DEFAULT_DEVICE_WINDOW)}
              canResetZoom={window.kind === 'absolute'}
            />
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          <DeviceLabelCard
            mac={mac ?? ''}
            label={label}
            hostname={identity?.hostname}
            hostnameSource={identity?.hostnameSource}
          />

          <Panel title="Identity">
            <div className="divide-y divide-border/70">
              <Row label="MAC">
                <span className="font-mono">{mac}</span>
              </Row>
              <Row label="IPs">
                <span className="flex flex-wrap justify-end gap-1">
                  {identity?.ips.length ? (
                    identity.ips.map((ip) => (
                      <Badge key={ip} variant="outline" className="rounded font-mono text-[11px]">
                        {ip}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </span>
              </Row>
              <Row label="First seen">{formatDate(identity?.firstSeenAt)}</Row>
              <Row label="Last seen">{formatDate(identity?.lastSeenAt)}</Row>
              <Row label="Collector">{identity ? `#${identity.collectorId}` : '—'}</Row>
            </div>
          </Panel>

          <Panel
            title="WiFi"
            description={latestWifi ? undefined : 'Not seen on any access point.'}
            actions={
              latestWifi ? (
                <Button asChild size="sm" variant="ghost" className="h-6 px-2 text-xs">
                  <Link to={`/wifi/clients/${encodeURIComponent(mac ?? '')}`}>Client detail</Link>
                </Button>
              ) : null
            }
          >
            {latestWifi ? (
              <div className="divide-y divide-border/70">
                <Row label="Status">
                  <span
                    aria-hidden
                    className={`mr-1.5 inline-block size-2 rounded-full ${presenceDotClass(latestWifi.active)}`}
                  />
                  {presenceLabel(latestWifi.active, latestWifi.lastSeenAt)}
                </Row>
                <Row label={latestWifi.active ? 'Access point' : 'Last access point'}>{latestWifi.ap}</Row>
                <Row label="SSID">{latestWifi.ssid ?? 'Unknown'}</Row>
                <Row label="Band">{formatWifiBand(latestWifi.band)}</Row>
                <Row label={latestWifi.active ? 'Signal' : 'Last signal'}>
                  <span
                    aria-hidden
                    className={`mr-1.5 inline-block size-2 rounded-full ${wifiSignalQualityDotClass(latestWifi.signalQuality)}`}
                  />
                  {formatSignal(latestWifi.signalDbm)} · {wifiSignalQualityLabel(latestWifi.signalQuality)}
                </Row>
                <Row label={latestWifi.active ? 'PHY rate' : 'Last PHY rate'}>
                  <span className="font-mono">
                    {(latestWifi.txRateKbps ?? 0) / 1000} / {(latestWifi.rxRateKbps ?? 0) / 1000} Mbps
                  </span>
                </Row>
                {(wifi.data?.roamingEvents ?? []).length > 0 ? (
                  <div className="pt-2">
                    <p className="section-label mb-1">Recent roams</p>
                    <ul className="space-y-1 text-[12px]">
                      {(wifi.data?.roamingEvents ?? []).slice(0, 4).map((event) => (
                        <li key={event.id} className="flex justify-between gap-2">
                          <span className="truncate">
                            {event.from.apName ?? '?'} → {event.to.apName ?? '?'}
                            {event.eventType === 'band_steer'
                              ? ` (${formatWifiBand(event.from.band)} → ${formatWifiBand(event.to.band)})`
                              : ''}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {formatDate(event.detectedAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
          </Panel>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Who it talks to"
          description="Peers over the window, from the hourly peer history."
          updating={peerHistory.isPlaceholderData}
          flush
          actions={
            <div className="flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Peer scope">
              {(['wan', 'lan'] as PeerScope[]).map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={peerScope === option}
                  variant={peerScope === option ? 'secondary' : 'ghost'}
                  className="h-6 px-2 text-xs uppercase"
                  onClick={() => setPeerScope(option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          }
        >
          <TopDestinations
            data={peerHistory.data}
            scope={peerScope}
            isPending={peerHistory.isPending}
            error={peerHistory.error}
            compact
          />
          {peerHistory.data && peerHistory.data.peers.length === 0 ? (
            <div className="border-t border-border/70 px-4 py-3">
              <p className="section-label mb-2">Live peers (latest heap)</p>
              <PeersPanel
                peers={overview.data?.peers[peerScope] ?? []}
                scope={peerScope}
                isPending={overview.isPending}
                error={overview.error}
                compact
                initialLimit={5}
              />
            </div>
          ) : null}
        </Panel>

        <ProtocolsSection
          title="Protocol mix"
          description="Bytes in/out by detected protocol. Drag the chart to zoom."
          data={protocols.data}
          isPending={protocols.isPending}
          isPlaceholderData={protocols.isPlaceholderData}
          error={protocols.error}
          onZoom={setWindow}
          onResetZoom={() => setWindow(DEFAULT_DEVICE_WINDOW)}
          canResetZoom={window.kind === 'absolute'}
          allowGroupBy
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Destinations"
          description="Where this device's WAN bytes went, by site. Click a name for its history."
          updating={destinations.isPlaceholderData}
          flush
        >
          <DeviceDestinationsTable
            data={destinations.data}
            isPending={destinations.isPending}
            error={destinations.error}
            window={window}
          />
          {destinations.data && destinations.data.destinations.length > 0 ? (
            <div className="border-t border-border/70 px-4 py-2 text-right">
              <Link to="/traffic" className="text-xs text-brand hover:underline">
                Network-wide destinations →
              </Link>
            </div>
          ) : null}
        </Panel>

        <Panel
          title="Served by this device"
          description="Bytes pushed to clients, by server name."
          updating={services.isPlaceholderData}
          flush
        >
          {services.isPending ? (
            <p className="px-4 pb-4 text-xs text-muted-foreground">Loading…</p>
          ) : !servicesData || servicesData.services.length === 0 ? (
            <div className="px-4 pb-4">
              <EmptyState
                title="Not acting as a server in this window"
                description={
                  servicesData === null
                    ? 'Server-name accounting needs the collector update.'
                    : 'Names appear when this device serves TLS/HTTP traffic the collector can label.'
                }
              />
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Server name</th>
                  <th>Protocol</th>
                  <th className="text-right">Served</th>
                  <th className="text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {servicesData.services.map((service) => (
                  <tr key={`${service.serverName}|${service.protocol}`}>
                    <td className="font-mono text-[12px]">{service.serverName}</td>
                    <td className="text-[12px]">{formatProtocolLabel(service.protocol)}</td>
                    <td className="text-right font-mono font-medium tabular-nums">{formatBytes(service.bytesServed)}</td>
                    <td>
                      <ShareBar percentage={service.percentage} color="var(--chart-served)" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {servicesData && servicesData.services.length > 0 ? (
            <div className="border-t border-border/70 px-4 py-2 text-right">
              <Link to="/servers" className="text-xs text-brand hover:underline">
                All servers →
              </Link>
            </div>
          ) : null}
        </Panel>

        {latestWifi ? (
          <Panel title="Signal history" description="Average signal per bucket over the window." updating={wifiSignal.isPlaceholderData}>
            {wifiSignal.isPending ? (
              <p className="text-xs text-muted-foreground">Loading signal…</p>
            ) : signalChartData.length === 0 ? (
              <EmptyState title="No signal samples in this window" />
            ) : (
              <SignalChart
                data={signalChartData}
                className="h-[220px] w-full"
                onZoom={setWindow}
                onResetZoom={() => setWindow(DEFAULT_DEVICE_WINDOW)}
                canResetZoom={window.kind === 'absolute'}
              />
            )}
          </Panel>
        ) : (
          <Panel title="Top networks" description="WAN peers grouped by ASN (latest heap).">
            {(overview.data?.topAsns ?? []).length === 0 ? (
              <EmptyState title="No WAN ASN data yet" />
            ) : (
              <ul className="divide-y divide-border/70">
                {(overview.data?.topAsns ?? []).slice(0, 8).map((asn) => (
                  <li key={`${asn.asn ?? 'unknown'}-${asn.org}`} className="flex items-center justify-between gap-3 py-1.5 text-[12.5px]">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{asn.org}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {asn.asn ? `AS${asn.asn}` : 'no ASN'} · {asn.peers.length} addresses
                      </span>
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">{formatBytes(asn.totalBytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </div>
    </div>
  )
}
