import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Broadcast, Devices } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { KpiTile } from '@/components/ui/kpi-tile'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { UsageApplications } from '@/components/usage/usage-applications'
import { UsageAppsChart } from '@/components/usage/usage-apps-chart'
import { UsageBarChart } from '@/components/usage/usage-bar-chart'
import { UsageIntervalsPanel } from '@/components/usage/usage-intervals-panel'
import { UsageTable } from '@/components/usage/usage-table'
import { useUsage } from '@/hooks/use-usage'
import { useUsageControls } from '@/hooks/use-usage-controls'
import { categoryLabel } from '@/lib/categories'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import { formatProtocolLabel } from '@/lib/protocols'
import {
  dateInputsForWindow,
  formatLocalInstant,
  periodNoun,
  presetForWindow,
  relativeWindow,
  USAGE_CHART_MODES,
  USAGE_PERIODS,
  USAGE_PRESETS,
  USAGE_SCOPES,
  windowFromDates,
} from '@/lib/usage'

const CUSTOM = 'custom'

/** vnstat-style data usage per day / week / month. */
export function UsagePage() {
  const { period, window, scope, mode, setPeriod, setWindow, setScope, setMode } = useUsageControls()
  const usage = useUsage({ period, window, scope })

  const preset = presetForWindow(period, window)
  const [customOpen, setCustomOpen] = useState(false)
  const showCustom = customOpen || window.kind === 'absolute'
  const presetOptions = useMemo(
    () => [
      ...USAGE_PRESETS[period].map((p) => ({ id: p.id, label: p.label, title: p.title })),
      { id: CUSTOM, label: 'Custom', title: 'Pick a start and end date' },
    ],
    [period],
  )
  const presetValue = showCustom && !preset ? CUSTOM : (preset?.id ?? CUSTOM)
  const dates = dateInputsForWindow(window)

  function onPreset(id: string) {
    if (id === CUSTOM) {
      setCustomOpen(true)
      return
    }
    setCustomOpen(false)
    const next = USAGE_PRESETS[period].find((p) => p.id === id)
    if (next) setWindow(relativeWindow(next.range))
  }

  function onDates(from: string, to: string) {
    const next = windowFromDates(from, to)
    if (next) setWindow(next)
  }

  const data = usage.data
  const totals = data?.totals
  const buckets = data?.buckets ?? []
  const hasData = buckets.length > 0 && (totals?.totalBytes ?? 0) > 0
  const topProtocol = totals?.protocols[0]
  const peakAt = formatLocalInstant(totals?.wifiClients.peakAt)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Usage"
        description="Data usage per day, week or month, vnstat style. Buckets follow the instance timezone."
        actions={
          <>
            <Segmented value={period} onChange={setPeriod} options={USAGE_PERIODS} ariaLabel="Period" />
            <Segmented value={presetValue} onChange={onPreset} options={presetOptions} ariaLabel="Range" />
            {showCustom ? (
              <div className="flex items-center gap-1.5">
                <Input
                  type="date"
                  aria-label="From date"
                  className="h-8 w-36 rounded-md"
                  value={dates.from}
                  max={dates.to}
                  onChange={(event) => onDates(event.target.value, dates.to)}
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="date"
                  aria-label="To date"
                  className="h-8 w-36 rounded-md"
                  value={dates.to}
                  min={dates.from}
                  onChange={(event) => onDates(dates.from, event.target.value)}
                />
              </div>
            ) : null}
            <Segmented value={scope} onChange={setScope} options={USAGE_SCOPES} ariaLabel="Traffic scope" />
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile
          label="Downloaded"
          value={formatBytes(totals?.bytesIn ?? 0)}
          sub={`${buckets.length} ${periodNoun(period, buckets.length)} in window`}
          icon={<ArrowDown className="size-4 text-chart-download" />}
        />
        <KpiTile
          label="Uploaded"
          value={formatBytes(totals?.bytesOut ?? 0)}
          sub={data ? `${scope === 'all' ? 'WAN + LAN' : scope.toUpperCase()} scope` : 'in window'}
          icon={<ArrowUp className="size-4 text-chart-upload" />}
        />
        <KpiTile
          label="Total"
          value={formatBytes(totals?.totalBytes ?? 0)}
          sub={`${formatMbps(totals?.avgMbps ?? 0)} average`}
        />
        <KpiTile
          label="Active devices"
          value={String(totals?.activeDevices ?? 0)}
          sub="distinct in window"
          icon={<Devices className="size-4" />}
        />
        <KpiTile
          label="Wi-Fi clients"
          value={
            totals && totals.wifiClients.avg !== null ? (
              <>
                {totals.wifiClients.avg}
                <span className="text-base font-normal text-muted-foreground"> avg · </span>
                {totals.wifiClients.max}
                <span className="text-base font-normal text-muted-foreground"> peak</span>
              </>
            ) : (
              '—'
            )
          }
          sub={peakAt ? `peak at ${peakAt}` : 'no Wi-Fi totals in window'}
          icon={<Broadcast className="size-4" />}
        />
        <KpiTile
          label="Top protocol"
          value={<span className="text-lg">{topProtocol ? formatProtocolLabel(topProtocol.protocol) : '—'}</span>}
          sub={topProtocol ? `${topProtocol.percentage}% · ${categoryLabel(topProtocol.category)}` : 'no protocol data yet'}
        />
      </div>

      <Panel
        title={`Usage per ${period}`}
        description={
          mode === 'apps'
            ? `Two columns per ${period}: download on the left, upload on the right, each stacked by application. The running ${period} is drawn lighter.${data ? ` Timezone ${data.timezone}.` : ''}`
            : data
              ? `Download at the baseline, upload on top. The running ${period} is drawn lighter. Timezone ${data.timezone}.`
              : 'Download at the baseline, upload on top.'
        }
        updating={usage.isPlaceholderData}
        actions={<Segmented value={mode} onChange={setMode} options={USAGE_CHART_MODES} ariaLabel="Chart mode" size="xs" />}
      >
        {usage.isPending && !data ? (
          <p className="text-xs text-muted-foreground">Loading usage…</p>
        ) : usage.error ? (
          <p className="text-xs text-destructive">{usage.error.message}</p>
        ) : hasData && totals && mode === 'apps' ? (
          <UsageAppsChart period={period} buckets={buckets} totals={totals} className="h-[260px] w-full" />
        ) : hasData ? (
          <UsageBarChart period={period} buckets={buckets} className="h-[260px] w-full" />
        ) : (
          <EmptyState
            title="No usage in this window"
            description="Usage is built from the hourly rollups; it fills in as the collector runs."
          />
        )}
      </Panel>

      {period === 'day' ? <UsageIntervalsPanel window={window} scope={scope} /> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel
          title={period === 'day' ? 'Daily' : period === 'week' ? 'Weekly' : 'Monthly'}
          description={
            data
              ? `Newest first. ${data.source === 'daily' ? 'From the daily rollups (UTC day boundaries).' : 'From the hourly rollups.'}`
              : 'Newest first.'
          }
          updating={usage.isPlaceholderData}
          flush
        >
          {usage.isPending && !data ? (
            <p className="px-4 pb-4 text-xs text-muted-foreground">Loading usage…</p>
          ) : usage.error ? (
            <p className="px-4 pb-4 text-xs text-destructive">{usage.error.message}</p>
          ) : hasData && totals ? (
            <UsageTable period={period} buckets={buckets} totals={totals} />
          ) : (
            <div className="px-4 pb-4">
              <EmptyState
                title="No usage in this window"
                description="Usage is built from the hourly rollups; it fills in as the collector runs."
              />
            </div>
          )}
        </Panel>

        <Panel
          title="Applications in this window"
          description="Top protocols over the whole window, with their nDPI category."
          updating={usage.isPlaceholderData}
          flush
        >
          {usage.isPending && !data ? (
            <p className="px-4 pb-4 text-xs text-muted-foreground">Loading…</p>
          ) : (
            <UsageApplications protocols={totals?.protocols ?? []} other={totals?.otherProtocols ?? null} />
          )}
        </Panel>
      </div>
    </div>
  )
}
