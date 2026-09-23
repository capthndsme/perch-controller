import { useMemo, useState } from 'react'
import { CaretLeft, CaretRight, MagnifyingGlassPlus } from '@phosphor-icons/react'
import { CategoryChip } from '@/components/destinations/category-chip'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { UsageApplications } from '@/components/usage/usage-applications'
import { UsageBarChart } from '@/components/usage/usage-bar-chart'
import { useDeviceUsageControls } from '@/hooks/use-device-usage-controls'
import { useUsage } from '@/hooks/use-usage'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import type { TimeWindow } from '@/lib/time-window'
import {
  bucketHint,
  bucketTitle,
  DEVICE_USAGE_PERIODS,
  DEVICE_USAGE_PRESETS,
  deviceUsageWindow,
  isPageWindowBucket,
  pageWindowForBucket,
  periodNoun,
} from '@/lib/usage'
import type { UsageBucket, UsagePeriod } from '@/types/api'

type DeviceUsageCardProps = {
  mac: string | undefined
  /** The page's window: only read to mark the column the page is showing. */
  pageWindow: TimeWindow
  /** Sets the page's window to a clicked day or month. */
  onPageWindow: (window: TimeWindow) => void
}

/**
 * The device page's Usage card: this device's bytes per local day or month,
 * vnstat style, over a span of its own (Daily 7 / 30 days, Monthly 3 to 12
 * months) that is independent of the page's time window. Hovering a column,
 * or stepping with the arrows, shows that bucket's protocols and categories;
 * clicking one sets the page's window to that day or month so the other
 * charts zoom in. That is the only link between the card and the page.
 */
export function DeviceUsageCard({ mac, pageWindow, onPageWindow }: DeviceUsageCardProps) {
  const { period, preset, setPeriod, setPreset } = useDeviceUsageControls()
  // The monthly presets resolve to a day count from today; recomputed when the preset changes.
  const window = useMemo(() => deviceUsageWindow(preset), [preset])
  const usage = useUsage({ period, window, mac, enabled: Boolean(mac) })

  const data = usage.data
  // While a new period loads the previous one stays on screen: label it by its own period.
  const shownPeriod: UsagePeriod = data?.period ?? period
  const buckets = useMemo(() => data?.buckets ?? [], [data])
  const totals = data?.totals
  const hasData = buckets.length > 0 && (totals?.totalBytes ?? 0) > 0

  const [hovered, setHovered] = useState<number | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  // Selected column: the one picked here, else the one the page shows, else the newest.
  const selectedIndex = useMemo(() => {
    if (buckets.length === 0) return null
    const picked = selectedKey ? buckets.findIndex((b) => b.bucketStart === selectedKey) : -1
    if (picked >= 0) return picked
    const onPage = buckets.findIndex((b) => isPageWindowBucket(pageWindow, b))
    return onPage >= 0 ? onPage : buckets.length - 1
  }, [buckets, selectedKey, pageWindow])
  const detailIndex = hovered !== null && hovered < buckets.length ? hovered : selectedIndex
  const detail = detailIndex !== null ? buckets[detailIndex] : undefined

  function select(index: number) {
    const bucket = buckets[index]
    if (bucket) setSelectedKey(bucket.bucketStart)
  }

  function showOnPage(bucket: UsageBucket) {
    setSelectedKey(bucket.bucketStart)
    onPageWindow(pageWindowForBucket(bucket))
  }

  const noun = shownPeriod === 'month' ? 'month' : 'day'

  return (
    <Panel
      title="Usage"
      description={
        <>
          This device per local {noun}
          {data ? ` (${data.timezone})` : ''}, over its own span, not the page's window. Click a column to show
          that {noun} on this page.
        </>
      }
      updating={usage.isPlaceholderData}
      actions={
        <>
          <Segmented value={period} onChange={setPeriod} options={DEVICE_USAGE_PERIODS} ariaLabel="Usage period" size="xs" />
          <Segmented
            value={preset.id}
            onChange={setPreset}
            options={DEVICE_USAGE_PRESETS[period]}
            ariaLabel="Usage span"
            size="xs"
          />
        </>
      }
    >
      {!mac ? (
        <EmptyState title="No device" />
      ) : usage.isPending && !data ? (
        <p className="text-xs text-muted-foreground">Loading usage…</p>
      ) : usage.error ? (
        <p className="text-xs text-destructive">{usage.error.message}</p>
      ) : !hasData || !totals ? (
        <EmptyState
          title="No usage for this device in this span"
          description="Usage is built from the hourly rollups; it fills in as the collector sees the device."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              <Stat label="Downloaded" value={formatBytes(totals.bytesIn)} swatch="var(--chart-download)" />
              <Stat label="Uploaded" value={formatBytes(totals.bytesOut)} swatch="var(--chart-upload)" />
              <Stat
                label="Total"
                value={formatBytes(totals.totalBytes)}
                sub={`${buckets.length} ${periodNoun(shownPeriod, buckets.length)}`}
              />
              <Stat label="Average" value={formatMbps(totals.avgMbps)} />
            </dl>
            <UsageBarChart
              period={shownPeriod}
              buckets={buckets}
              className="h-[220px] w-full"
              maxBarSize={shownPeriod === 'month' ? 40 : 24}
              selectedIndex={hovered === null ? selectedIndex : hovered}
              onColumnHover={setHovered}
              onColumnClick={(index) => {
                const bucket = buckets[index]
                if (bucket) showOnPage(bucket)
              }}
            />
          </div>

          {detail && detailIndex !== null ? (
            <BucketDetail
              period={shownPeriod}
              bucket={detail}
              onPage={isPageWindowBucket(pageWindow, detail)}
              onPrevious={detailIndex > 0 ? () => select(detailIndex - 1) : undefined}
              onNext={detailIndex < buckets.length - 1 ? () => select(detailIndex + 1) : undefined}
              onShowOnPage={() => showOnPage(detail)}
            />
          ) : null}
        </div>
      )}
    </Panel>
  )
}

function Stat({ label, value, sub, swatch }: { label: string; value: string; sub?: string; swatch?: string }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {swatch ? <span aria-hidden className="size-2 rounded-[2px]" style={{ backgroundColor: swatch }} /> : null}
        {label}
      </dt>
      <dd className="truncate font-mono text-sm font-medium tabular-nums">
        {value}
        {sub ? <span className="ml-1.5 font-sans text-[11px] font-normal text-muted-foreground">{sub}</span> : null}
      </dd>
    </div>
  )
}

type BucketDetailProps = {
  period: UsagePeriod
  bucket: UsageBucket
  /** The page's window is this bucket already. */
  onPage: boolean
  onPrevious?: () => void
  onNext?: () => void
  onShowOnPage: () => void
}

/** One bucket: bytes, the categories it split into, and its top protocols. */
function BucketDetail({ period, bucket, onPage, onPrevious, onNext, onShowOnPage }: BucketDetailProps) {
  const hint = bucketHint(period, bucket)
  const noun = period === 'month' ? 'month' : 'day'
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-md border border-border/70 p-3">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={`Previous ${noun}`}
          disabled={!onPrevious}
          onClick={onPrevious}
        >
          <CaretLeft />
        </Button>
        <p className="min-w-0 flex-1 truncate text-center text-[12.5px] font-medium">
          {bucketTitle(period, bucket.label)}
          {hint ? <span className="ml-1 font-normal text-muted-foreground">· {hint}</span> : null}
        </p>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={`Next ${noun}`} disabled={!onNext} onClick={onNext}>
          <CaretRight />
        </Button>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[12px]">
        <span className="font-mono tabular-nums">
          <span className="text-chart-download">↓</span> {formatBytes(bucket.bytesIn)}
          <span className="ml-2 text-chart-upload">↑</span> {formatBytes(bucket.bytesOut)}
        </span>
        <span className="font-mono tabular-nums text-muted-foreground">
          {bucket.partial ? 'so far ' : ''}
          {formatBytes(bucket.totalBytes)} · {formatMbps(bucket.avgMbps)}
        </span>
      </div>

      {bucket.categories.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Categories">
          {bucket.categories.slice(0, 5).map((c) => (
            <li key={c.category} className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <CategoryChip category={c.category} />
              <span className="font-mono tabular-nums">{c.percentage}%</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="-mx-3 overflow-x-auto border-t border-border/70">
        <UsageApplications protocols={bucket.protocols} other={bucket.otherProtocols} />
      </div>

      <Button
        type="button"
        size="xs"
        variant={onPage ? 'secondary' : 'outline'}
        className="self-start"
        disabled={onPage}
        onClick={onShowOnPage}
      >
        <MagnifyingGlassPlus data-icon="inline-start" />
        {onPage ? `The page shows this ${noun}` : `Show this ${noun} on the page`}
      </Button>
    </div>
  )
}
