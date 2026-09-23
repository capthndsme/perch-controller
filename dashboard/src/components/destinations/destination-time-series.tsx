import { useMemo } from 'react'
import { ServiceTrafficChart } from '@/components/charts/service-traffic-chart'
import { useDestinationTraffic } from '@/hooks/use-destinations'
import { DESTINATION_SERIES_CONFIG, destinationBucketsToPoints } from '@/lib/destinations'
import { formatBucketSeconds, seriesIsSilent } from '@/lib/services'
import type { TimeWindow } from '@/lib/time-window'

/** Downloaded / uploaded history for one destination name (hourly data at best). */
export function DestinationTimeSeries({ serverName, window }: { serverName: string; window: TimeWindow }) {
  const traffic = useDestinationTraffic(serverName, { window })
  const points = useMemo(
    () => destinationBucketsToPoints(traffic.data?.buckets ?? [], traffic.data?.bucketSeconds),
    [traffic.data],
  )

  if (traffic.isPending) return <p className="text-xs text-muted-foreground">Loading history…</p>
  if (traffic.error) return <p className="text-xs text-destructive">{traffic.error.message}</p>
  if (!traffic.data || points.length === 0) {
    return <p className="text-xs text-muted-foreground">No history for this name yet.</p>
  }
  const bucket = formatBucketSeconds(traffic.data.bucketSeconds)
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="section-label">
          Downloaded / uploaded per {bucket} · {serverName}
        </p>
        <p className="text-[11px] text-muted-foreground">Destinations are stored per hour</p>
      </div>
      {seriesIsSilent(points) ? (
        <p className="text-[11px] text-muted-foreground">No traffic for this name in this window.</p>
      ) : null}
      <ServiceTrafficChart
        data={points}
        series={DESTINATION_SERIES_CONFIG}
        rateOverlay="off"
        className="h-[224px] w-full"
      />
    </div>
  )
}
