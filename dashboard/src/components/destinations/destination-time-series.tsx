import { useMemo } from 'react'
import { ServiceTrafficChart } from '@/components/charts/service-traffic-chart'
import { useDestinationTraffic } from '@/hooks/use-destinations'
import {
  DESTINATION_SERIES_CONFIG,
  destinationBucketsToPoints,
  destinationResolutionFor,
} from '@/lib/destinations'
import type { TimeWindow } from '@/lib/time-window'

/** Downloaded / uploaded history for one destination name. */
export function DestinationTimeSeries({ serverName, window }: { serverName: string; window: TimeWindow }) {
  const resolution = destinationResolutionFor(window)
  const traffic = useDestinationTraffic(serverName, { window, resolution })
  const points = useMemo(
    () => destinationBucketsToPoints(traffic.data?.buckets ?? [], traffic.data?.resolutionSeconds),
    [traffic.data],
  )

  if (traffic.isPending) return <p className="text-xs text-muted-foreground">Loading history…</p>
  if (traffic.error) return <p className="text-xs text-destructive">{traffic.error.message}</p>
  if (!traffic.data || points.length === 0) {
    return <p className="text-xs text-muted-foreground">No per-{resolution} history for this name yet.</p>
  }
  return (
    <div className="space-y-1">
      <p className="section-label">
        Downloaded / uploaded per {resolution === '1d' ? 'day' : 'hour'} · {serverName}
      </p>
      <ServiceTrafficChart
        data={points}
        series={DESTINATION_SERIES_CONFIG}
        rateOverlay="off"
        className="h-[224px] w-full"
      />
    </div>
  )
}
