import { useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { BellSimple, BellSimpleSlash, CheckCircle, FunnelSimple, GearSix } from '@phosphor-icons/react'
import { AlertRow } from '@/components/alerts/alert-row'
import { ChipRow, FilterChip } from '@/components/alerts/alert-filters'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelOverlay } from '@/components/ui/panel-overlay'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { useAlertSummary, useMarkAlertsRead } from '@/hooks/use-alert-summary'
import { useAlertCatalogue, useAlertList } from '@/hooks/use-alerts'
import { useProfile } from '@/hooks/use-auth'
import { useNow } from '@/hooks/use-now'
import { ApiError } from '@/lib/api'
import { CATEGORIES, CATEGORY_SHORT, isCategory, isSeverity } from '@/lib/alerts'
import type { AlertListFilters, Category, Severity } from '@/types/alerts'

type View = 'all' | 'active'

const VIEWS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
] as const

const SEVERITY_FILTERS: ReadonlyArray<{ id: Severity; label: string }> = [
  { id: 'info', label: 'Any severity' },
  { id: 'warning', label: 'Warning and up' },
  { id: 'critical', label: 'Critical' },
]

/** The inbox's filters live in the URL: `?view=active&severity=warning&category=wan,agents&blips=1`. */
function useInboxParams() {
  const [search, setSearch] = useSearchParams()
  const view: View = search.get('view') === 'active' ? 'active' : 'all'
  const severityParam = search.get('severity') ?? ''
  const minSeverity: Severity = isSeverity(severityParam) ? severityParam : 'info'
  const categoryParam = search.get('category') ?? ''
  const categories = useMemo(() => categoryParam.split(',').filter(isCategory), [categoryParam])
  const blips = search.get('blips') === '1'

  const set = (patch: Record<string, string | null>) => {
    setSearch(
      (current) => {
        const next = new URLSearchParams(current)
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === '') next.delete(key)
          else next.set(key, value)
        }
        return next
      },
      { replace: true },
    )
  }

  return {
    view,
    minSeverity,
    categories,
    blips,
    setView: (value: View) => set({ view: value === 'all' ? null : value }),
    setSeverity: (value: Severity) => set({ severity: value === 'info' ? null : value }),
    toggleCategory: (value: Category) =>
      set({
        category: (categories.includes(value) ? categories.filter((c) => c !== value) : [...categories, value]).join(','),
      }),
    setBlips: (value: boolean) => set({ blips: value ? '1' : null }),
    clear: () => set({ severity: null, category: null, blips: null }),
  }
}

/**
 * Alerts inbox (design README §5), phone first: All / Active, severity and category chips, rows that open
 * the alert. Opening it marks everything read; the rows keep their dots until the next refresh, so what was
 * new stays visible for this visit.
 */
export function AlertsPage() {
  const params = useInboxParams()
  const filters: AlertListFilters = {
    view: params.view,
    minSeverity: params.minSeverity,
    categories: params.categories,
    blips: params.blips,
    limit: 50,
  }
  const list = useAlertList(filters)
  const summary = useAlertSummary()
  const catalogue = useAlertCatalogue()
  const isAdmin = useProfile().data?.role === 'admin'
  const now = useNow(30_000)
  const { mutate: markRead, isPending: marking } = useMarkAlertsRead()

  useEffect(() => {
    markRead(undefined)
  }, [markRead])

  const categoryLabel = (key: Category) => CATEGORY_SHORT[key]
  // Only the categories this controller has types for (the catalogue), in their order.
  const categoryKeys = catalogue.data
    ? catalogue.data.categories.map((c) => c.key).filter((key) => catalogue.data.types.some((t) => t.category === key))
    : CATEGORIES.filter((key) => key !== 'updates')

  const alerts = list.data?.pages.flatMap((page) => page.alerts) ?? []
  const filtered = params.minSeverity !== 'info' || params.categories.length > 0 || params.blips
  const unread = summary.data?.unread ?? 0

  if (list.error instanceof ApiError && list.error.status === 404) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <PageHeader title="Alerts" />
        <EmptyState
          icon={<BellSimpleSlash className="size-6" />}
          title="This controller has no alerts"
          description="Alerts arrive with a newer version of Perch Network Controller."
        />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <PageHeader title="Alerts" description="What Perch noticed on your network, newest first." />

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <Segmented ariaLabel="Which alerts" value={params.view} onChange={params.setView} options={VIEWS} />
          <div className="flex items-center gap-1">
            {unread > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => markRead(undefined)} disabled={marking}>
                <CheckCircle />
                <span className="max-sm:sr-only">Mark all read</span>
              </Button>
            ) : null}
            <Button asChild variant="ghost" size="sm">
              <Link to={isAdmin ? '/settings/alerts' : '/settings/notifications'}>
                <GearSix />
                {isAdmin ? 'Rules' : 'Notifications'}
              </Link>
            </Button>
          </div>
        </div>
        <ChipRow label="Filters">
          {SEVERITY_FILTERS.map((option) => (
            <FilterChip
              key={option.id}
              pressed={params.minSeverity === option.id}
              onClick={() => params.setSeverity(option.id)}
            >
              {option.label}
            </FilterChip>
          ))}
          <span aria-hidden className="my-1 w-px shrink-0 bg-border" />
          {categoryKeys.map((key) => (
            <FilterChip key={key} pressed={params.categories.includes(key)} onClick={() => params.toggleCategory(key)}>
              {categoryLabel(key)}
            </FilterChip>
          ))}
          <span aria-hidden className="my-1 w-px shrink-0 bg-border" />
          <FilterChip
            pressed={params.blips}
            onClick={() => params.setBlips(!params.blips)}
            title="Also list conditions that cleared before anyone was notified"
          >
            Short blips
          </FilterChip>
        </ChipRow>
      </div>

      <section className="card-surface relative min-h-40 overflow-hidden">
        {list.isPending ? (
          <p className="px-4 py-6 text-xs text-muted-foreground">Loading alerts…</p>
        ) : list.error ? (
          <p className="px-4 py-6 text-xs text-destructive">{list.error.message}</p>
        ) : alerts.length === 0 ? (
          <div className="p-4">
            <InboxEmpty
              view={params.view}
              filtered={filtered}
              isAdmin={isAdmin}
              onClear={params.clear}
              onShowAll={() => params.setView('all')}
            />
          </div>
        ) : (
          <ul className="divide-y divide-border/70">
            {alerts.map((alert) => (
              <li key={alert.id}>
                <AlertRow alert={alert} now={now} showBody />
              </li>
            ))}
          </ul>
        )}
        <PanelOverlay show={list.isPlaceholderData} label="Updating…" />
      </section>

      {list.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {list.isFetchingNextPage ? <Spinner /> : null}
          Show older alerts
        </Button>
      ) : null}
    </div>
  )
}

function InboxEmpty({
  view,
  filtered,
  isAdmin,
  onClear,
  onShowAll,
}: {
  view: View
  filtered: boolean
  isAdmin: boolean
  onClear: () => void
  onShowAll: () => void
}) {
  if (filtered) {
    return (
      <EmptyState
        icon={<FunnelSimple className="size-6" />}
        title="Nothing matches these filters"
        description={
          <Button variant="link" size="sm" className="h-auto p-0" onClick={onClear}>
            Clear filters
          </Button>
        }
      />
    )
  }
  if (view === 'active') {
    return (
      <EmptyState
        icon={<CheckCircle className="size-6 text-status-good" />}
        title="Nothing needs attention"
        description={
          <Button variant="link" size="sm" className="h-auto p-0" onClick={onShowAll}>
            Show all alerts
          </Button>
        }
      />
    )
  }
  return (
    <EmptyState
      icon={<BellSimple className="size-6" />}
      title="No alerts yet"
      description={
        <>
          Perch lists here what needs you: an access point or the collector going silent, the internet dropping, a
          gateway change rolled back, a new device.{' '}
          <Link to="/settings/notifications" className="underline underline-offset-2">
            {isAdmin ? 'Set up notifications' : 'Get notified on this device'}
          </Link>
          .
        </>
      }
    />
  )
}
