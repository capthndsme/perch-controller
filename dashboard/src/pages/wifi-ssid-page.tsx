import { Link, useParams } from 'react-router-dom'
import { useMemo } from 'react'
import { ArrowLeft } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { BandwidthChart } from '@/components/charts/bandwidth-chart'
import { DashboardToolbar } from '@/components/dashboard/dashboard-toolbar'
import { TimePicker } from '@/components/dashboard/time-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useDashboardTime } from '@/hooks/use-dashboard-time'
import { useWifiSsidClients, useWifiSsidThroughput, useWifiSsids } from '@/hooks/use-wifi'
import { formatBytes } from '@/lib/format-bytes'
import { DEFAULT_DEVICE_WINDOW } from '@/lib/time-window'
import { macPath } from '@/lib/traffic'
import { formatSignal, formatWifiBand, wifiSignalQualityDotClass, wifiSignalQualityLabel } from '@/lib/wifi'

export function WifiSsidPage() {
  const { ssid: ssidParam } = useParams()
  const ssid = ssidParam ? decodeURIComponent(ssidParam) : undefined
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
  const clients = useWifiSsidClients(ssid)
  const summaries = useWifiSsids({ window })
  const throughput = useWifiSsidThroughput(ssid, { window, resolution, refreshInterval })
  const summary = summaries.data?.ssids.find((entry) => entry.ssid === ssid)
  const chartData = useMemo(
    () =>
      (throughput.data?.buckets ?? [])
        .map((bucket) => {
          const ts = Date.parse(bucket.bucketStart)
          if (Number.isNaN(ts)) return null
          // AP-side counters: the AP *transmits* what clients download.
          return {
            ts,
            download: bucket.mbpsOut,
            upload: bucket.mbpsIn,
            downloadBytes: bucket.bytesOut,
            uploadBytes: bucket.bytesIn,
          }
        })
        .filter((point): point is NonNullable<typeof point> => point !== null),
    [throughput.data]
  )

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link to="/wifi">
            <ArrowLeft className="size-3.5" />
            WiFi
          </Link>
        </Button>
      </div>

      <DashboardToolbar>
        <TimePicker
          window={window}
          resolutionMode={resolutionMode}
          refreshInterval={refreshInterval}
          onWindowChange={setWindow}
          onResolutionModeChange={setResolutionMode}
          onRefreshIntervalChange={setRefreshInterval}
          onRefreshNow={() => queryClient.invalidateQueries()}
        />
      </DashboardToolbar>

      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{ssid ?? 'SSID'}</h1>
        {summary ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{summary.clientCount} clients</Badge>
            <Badge variant="outline">{formatSignal(summary.averageSignalDbm)}</Badge>
            <Badge variant="outline">{formatBytes(summary.bytesOut)} down</Badge>
            <Badge variant="outline">{formatBytes(summary.bytesIn)} up</Badge>
          </div>
        ) : null}
      </div>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Throughput history</h2>
          <p className="text-xs text-muted-foreground">
            Download/upload rate derived from interface bucket deltas.
          </p>
        </div>
        {throughput.isPending ? (
          <p className="text-sm text-muted-foreground">Loading throughput…</p>
        ) : throughput.error ? (
          <p className="text-sm text-destructive">{throughput.error.message}</p>
        ) : chartData.length > 0 ? (
          <BandwidthChart
            data={chartData}
            range={throughput.data}
            className="h-[300px] w-full"
            onZoom={setWindow}
            onResetZoom={() => setWindow(DEFAULT_DEVICE_WINDOW)}
            canResetZoom={window.kind === 'absolute'}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No throughput buckets in this range.</p>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Connected clients</h2>
          <p className="text-xs text-muted-foreground">
            Latest per-MAC snapshot on this SSID.
          </p>
        </div>
        {clients.isPending ? (
          <p className="text-sm text-muted-foreground">Loading clients…</p>
        ) : clients.error ? (
          <p className="text-sm text-destructive">{clients.error.message}</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="grid grid-cols-[1fr_1fr_0.8fr_0.7fr_0.9fr] gap-3 border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span>MAC</span>
              <span>AP</span>
              <span className="text-right">Signal</span>
              <span className="text-right">Band</span>
              <span className="text-right">PHY TX/RX</span>
            </div>
            <div className="divide-y divide-border">
              {(clients.data?.clients ?? []).map((client) => (
                <div
                  key={client.mac}
                  className="grid grid-cols-[1fr_1fr_0.8fr_0.7fr_0.9fr] items-center gap-3 px-3 py-2 text-xs"
                >
                  <span className="min-w-0">
                    <Link
                      to={`/devices/${macPath(client.mac)}`}
                      className="truncate font-mono hover:underline"
                    >
                      {client.mac}
                    </Link>
                  </span>
                  <span className="truncate text-muted-foreground">{client.ap}</span>
                  <span className="flex items-center justify-end gap-1.5 tabular-nums">
                    <span className={`inline-block size-2 rounded-full ${wifiSignalQualityDotClass(client.signalQuality)}`} />
                    <span>{formatSignal(client.signalDbm)}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {wifiSignalQualityLabel(client.signalQuality)}
                    </span>
                  </span>
                  <span className="text-right tabular-nums">{formatWifiBand(client.band)}</span>
                  <span className="text-right tabular-nums">
                    {(client.txRateKbps ?? 0) / 1000} / {(client.rxRateKbps ?? 0) / 1000} Mbps
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
