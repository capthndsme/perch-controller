import { Link, useParams } from 'react-router-dom'
import { useMemo, useState } from 'react'
import { ArrowLeft } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { BandwidthChart } from '@/components/charts/bandwidth-chart'
import { SignalChart } from '@/components/charts/signal-chart'
import { DashboardToolbar } from '@/components/dashboard/dashboard-toolbar'
import { TimePicker } from '@/components/dashboard/time-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useDashboardTime } from '@/hooks/use-dashboard-time'
import { useProfile } from '@/hooks/use-auth'
import { useDeviceOverview } from '@/hooks/use-devices'
import {
  useKickWifiClient,
  useSteerWifiClient,
  useWifiAps,
  useWifiClient,
  useWifiClientSignal,
} from '@/hooks/use-wifi'
import { controlDisabledReason, wifiCommandErrorMessage } from '@/lib/ap-agents'
import { deviceDisplayName } from '@/lib/device-names'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import { presenceDotClass, presenceLabel } from '@/lib/presence'
import { type TimeWindow } from '@/lib/time-window'
import { formatSignal, formatWifiBand, wifiSignalQualityLabel } from '@/lib/wifi'
import { macPath } from '@/lib/traffic'

const DEFAULT_WIFI_CLIENT_WINDOW: TimeWindow = { kind: 'relative', range: '24h' }

export function WifiClientPage() {
  const { mac: macParam } = useParams()
  const mac = macParam ? decodeURIComponent(macParam) : undefined
  const queryClient = useQueryClient()
  const {
    window,
    resolutionMode,
    resolution,
    refreshInterval,
    setWindow,
    setResolutionMode,
    setRefreshInterval,
  } = useDashboardTime(DEFAULT_WIFI_CLIENT_WINDOW)
  const profile = useProfile()
  const kick = useKickWifiClient()
  const steer = useSteerWifiClient()
  const [commandMessage, setCommandMessage] = useState<string | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)

  const detail = useWifiClient(mac)
  // The AP serving the client decides whether Kick / Steer can work at all.
  const aps = useWifiAps({ includeDisabled: true })
  const clientApId = detail.data?.latest.apId
  const clientAp = aps.data?.find((ap) => ap.id === clientApId)
  const controls = clientAp?.controls ?? null
  // Kick and Steer need the client on its AP right now.
  const connected = detail.data?.latest.active === true
  const commandReasons = controls
    ? [
        ...new Set(
          [controlDisabledReason(controls, 'kick'), controlDisabledReason(controls, 'steer')].filter(
            (reason): reason is string => reason !== null
          )
        ),
      ]
    : aps.data && clientApId !== undefined && !clientAp
      ? ['The AP this client was last seen on is not registered any more.']
      : []

  async function onKick() {
    if (!mac) return
    setCommandMessage(null)
    setCommandError(null)
    try {
      const result = await kick.mutateAsync(mac)
      setCommandMessage(
        `Disconnected from ${result.ifname}${result.via === 'agent' ? ' via perch-apd' : ''}. It may reconnect right away.`
      )
    } catch (cause) {
      setCommandError(wifiCommandErrorMessage(cause, 'Kick failed.'))
    }
  }

  async function onSteer() {
    if (!mac) return
    setCommandMessage(null)
    setCommandError(null)
    try {
      const result = await steer.mutateAsync({ mac })
      const seconds = Math.round(result.banTimeMs / 1000)
      setCommandMessage(
        `Disconnected and refused for ${seconds} s, so it should join another AP.`
      )
    } catch (cause) {
      setCommandError(wifiCommandErrorMessage(cause, 'Steer failed.'))
    }
  }
  const signal = useWifiClientSignal(mac, { window, resolution, refreshInterval })
  const deviceOverview = useDeviceOverview(mac, {
    window,
    resolution,
    scope: 'all',
    refreshInterval,
  })
  const identity = deviceOverview.data?.identity[0]
  const displayName = deviceDisplayName(
    {
      mac,
      customName: detail.data?.label?.name ?? identity?.customName,
      hostname: identity?.hostname ?? detail.data?.latest.hostname,
    },
    'Client',
  )
  const trafficSummary = useMemo(() => {
    const buckets = deviceOverview.data?.traffic.buckets ?? []
    const latest = buckets[buckets.length - 1]
    const totalBytesIn = buckets.reduce((sum, bucket) => sum + bucket.bytesIn, 0)
    const totalBytesOut = buckets.reduce((sum, bucket) => sum + bucket.bytesOut, 0)
    return {
      totalBytesIn,
      totalBytesOut,
      latestMbpsIn: latest?.mbpsIn ?? 0,
      latestMbpsOut: latest?.mbpsOut ?? 0,
    }
  }, [deviceOverview.data])
  const signalChartData = useMemo(
    () =>
      (signal.data?.buckets ?? [])
        .map((bucket) => {
          const ts = Date.parse(bucket.bucketStart)
          if (Number.isNaN(ts) || bucket.signalDbm === null) return null
          return {
            ts,
            signalDbm: bucket.signalDbm,
            snrDb: bucket.snrDb,
          }
        })
        .filter((point): point is NonNullable<typeof point> => point !== null),
    [signal.data]
  )
  const wifiSpeedChartData = useMemo(
    () =>
      (signal.data?.buckets ?? [])
        .map((bucket) => {
          const ts = Date.parse(bucket.bucketStart)
          if (Number.isNaN(ts)) return null
          if (bucket.txRateKbps === null && bucket.rxRateKbps === null) return null
          return {
            ts,
            download: (bucket.txRateKbps ?? 0) / 1000,
            upload: (bucket.rxRateKbps ?? 0) / 1000,
          }
        })
        .filter((point): point is NonNullable<typeof point> => point !== null),
    [signal.data]
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

      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{displayName}</h1>
        <p className="font-mono text-sm text-muted-foreground">{mac ?? 'Client'}</p>
        {identity?.ips.length ? (
          <div className="flex flex-wrap gap-2">
            {identity.ips.map((ip) => (
              <Badge key={ip} variant="outline" className="rounded-md font-mono">
                {ip}
              </Badge>
            ))}
          </div>
        ) : null}
        {detail.data?.latest ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline">
              <span aria-hidden className={`inline-block size-2 rounded-full ${presenceDotClass(connected)}`} />
              {presenceLabel(connected, detail.data.latest.lastSeenAt)}
            </Badge>
            <Badge variant="outline">
              {connected ? detail.data.latest.ap : `Last on ${detail.data.latest.ap}`}
            </Badge>
            <Badge variant="outline">{detail.data.latest.ssid ?? 'Unknown SSID'}</Badge>
            <Badge variant="outline">{formatWifiBand(detail.data.latest.band)}</Badge>
            {/* The last signal of a client that walked away says nothing about its link. */}
            {connected ? (
              <Badge variant="outline">
                {formatSignal(detail.data.latest.signalDbm)} ·{' '}
                {wifiSignalQualityLabel(detail.data.latest.signalQuality)}
              </Badge>
            ) : null}
            <Button asChild size="sm" variant="ghost" className="px-2">
              <Link to={`/devices/${macPath(mac ?? '')}`}>Open device detail</Link>
            </Button>
            {profile.data?.role === 'admin' ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={kick.isPending || !controls?.kick || !connected}
                  onClick={() => void onKick()}
                >
                  {kick.isPending ? 'Kicking…' : 'Kick client'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={steer.isPending || !controls?.steer || !connected}
                  onClick={() => void onSteer()}
                >
                  {steer.isPending ? 'Steering…' : 'Steer client'}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
        {profile.data?.role === 'admin' && detail.data?.latest ? (
          <>
            {!connected ? <p className="text-xs text-muted-foreground">Not connected right now.</p> : null}
            {commandReasons.map((reason) => (
              <p key={reason} className="text-xs text-muted-foreground">
                {reason}
              </p>
            ))}
            {commandMessage ? <p className="text-xs text-primary">{commandMessage}</p> : null}
            {commandError ? <p className="text-xs text-destructive">{commandError}</p> : null}
          </>
        ) : null}
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

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Traffic context</h2>
          <p className="text-xs text-muted-foreground">
            Merged from the device detail view for this same MAC.
          </p>
        </div>
        {deviceOverview.isPending ? (
          <p className="text-sm text-muted-foreground">Loading device traffic context…</p>
        ) : deviceOverview.error ? (
          <p className="text-sm text-muted-foreground">
            Device traffic context unavailable: {deviceOverview.error.message}
          </p>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-4">
              <div className="rounded-lg border p-3">
                <p className="text-[11px] text-muted-foreground">Download now</p>
                <p className="mt-1 text-sm font-medium tabular-nums">
                  {formatMbps(trafficSummary.latestMbpsIn)}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-[11px] text-muted-foreground">Upload now</p>
                <p className="mt-1 text-sm font-medium tabular-nums">
                  {formatMbps(trafficSummary.latestMbpsOut)}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-[11px] text-muted-foreground">Window download</p>
                <p className="mt-1 text-sm font-medium tabular-nums">
                  {formatBytes(trafficSummary.totalBytesIn)}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-[11px] text-muted-foreground">Window upload</p>
                <p className="mt-1 text-sm font-medium tabular-nums">
                  {formatBytes(trafficSummary.totalBytesOut)}
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Top protocols</h3>
              {(deviceOverview.data?.protocols ?? []).slice(0, 5).map((protocol) => (
                <div
                  key={protocol.protocol}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-lg border p-2.5 text-xs"
                >
                  <span className="truncate font-medium">{protocol.protocol}</span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {protocol.percentage}%
                  </span>
                  <span className="text-right tabular-nums">
                    {formatBytes(protocol.bytesIn + protocol.bytesOut)}
                  </span>
                </div>
              ))}
              {(deviceOverview.data?.protocols.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">No protocol breakdown yet.</p>
              ) : null}
            </div>
          </>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Signal history</h2>
          <p className="text-xs text-muted-foreground">
            Aggregated WiFi station snapshots over the selected window.
          </p>
        </div>
        {signal.isPending ? (
          <p className="text-sm text-muted-foreground">Loading signal buckets…</p>
        ) : signal.error ? (
          <p className="text-sm text-destructive">{signal.error.message}</p>
        ) : signalChartData.length > 0 ? (
          <SignalChart
            data={signalChartData}
            range={signal.data}
            stepSeconds={signal.data?.resolutionSeconds}
            className="h-[300px] w-full"
            onZoom={setWindow}
            onResetZoom={() => setWindow(DEFAULT_WIFI_CLIENT_WINDOW)}
            canResetZoom={window.kind === 'absolute'}
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="grid grid-cols-[1fr_0.8fr_0.8fr_0.8fr] gap-3 border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span>Bucket</span>
              <span className="text-right">Signal</span>
              <span className="text-right">SNR</span>
              <span className="text-right">PHY TX/RX</span>
            </div>
            <div className="divide-y divide-border">
              {(signal.data?.buckets ?? []).map((bucket) => (
                <div
                  key={bucket.bucketStart}
                  className="grid grid-cols-[1fr_0.8fr_0.8fr_0.8fr] items-center gap-3 px-3 py-2 text-xs"
                >
                  <span className="truncate text-muted-foreground">{bucket.bucketStart}</span>
                  <span className="text-right tabular-nums">{formatSignal(bucket.signalDbm)}</span>
                  <span className="text-right tabular-nums">
                    {bucket.snrDb !== null ? `${Math.round(bucket.snrDb)} dB` : 'n/a'}
                  </span>
                  <span className="text-right tabular-nums">
                    {(bucket.txRateKbps ?? 0) / 1000} / {(bucket.rxRateKbps ?? 0) / 1000} Mbps
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">WiFi speed history</h2>
          <p className="text-xs text-muted-foreground">
            PHY link rates over time (AP→client download, client→AP upload).
          </p>
        </div>
        {signal.isPending ? (
          <p className="text-sm text-muted-foreground">Loading WiFi speed buckets…</p>
        ) : signal.error ? (
          <p className="text-sm text-destructive">{signal.error.message}</p>
        ) : wifiSpeedChartData.length > 0 ? (
          <BandwidthChart
            data={wifiSpeedChartData}
            className="h-[300px] w-full"
            onZoom={setWindow}
            onResetZoom={() => setWindow(DEFAULT_WIFI_CLIENT_WINDOW)}
            canResetZoom={window.kind === 'absolute'}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No WiFi speed buckets yet.</p>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Roaming events</h2>
          <p className="text-xs text-muted-foreground">
            Detected AP/interface transitions for this client.
          </p>
        </div>
        {detail.isPending ? (
          <p className="text-sm text-muted-foreground">Loading events…</p>
        ) : detail.error ? (
          <p className="text-sm text-destructive">{detail.error.message}</p>
        ) : (
          <div className="space-y-2">
            {(detail.data?.roamingEvents ?? []).map((event) => (
              <div key={event.id} className="rounded-lg border border-border p-3 text-xs">
                <p className="font-medium">{event.eventType}</p>
                <p className="mt-1 text-muted-foreground">
                  {event.eventType === 'ap_roam' ? (
                    `${event.from.apName ?? 'unknown'} → ${event.to.apName ?? 'unknown'}`
                  ) : event.eventType === 'band_steer' ? (
                    `${event.from.apName ?? 'unknown'} (${formatWifiBand(event.from.band)}) → ${event.to.apName ?? 'unknown'} (${formatWifiBand(event.to.band)})`
                  ) : (
                    `${event.from.apName ?? 'unknown'} (${event.from.ifname ?? 'unknown'}) → ${event.to.apName ?? 'unknown'} (${event.to.ifname ?? 'unknown'})`
                  )}
                </p>
                <p className="text-[11px] text-muted-foreground">{event.detectedAt}</p>
              </div>
            ))}
            {(detail.data?.roamingEvents.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">No roaming events yet.</p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}
