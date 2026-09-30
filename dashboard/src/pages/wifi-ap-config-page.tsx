import { useRef } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowClockwise, ChartLine, Warning } from '@phosphor-icons/react'
import { ErrorLine, FactRow } from '@/components/gateway-config/bits'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { PageSpinner, Spinner } from '@/components/ui/spinner'
import { ApHealthPanel } from '@/components/wifi-config/ap-health'
import { ApModeCard } from '@/components/wifi-config/ap-mode-card'
import {
  ApActivityPanel,
  ApCapabilitiesPanel,
  ApConflictsPanel,
  ApDraftPanel,
  ApDriftPanel,
  ApHistoryPanel,
  ApSectionsPanel,
} from '@/components/wifi-config/ap-plane-tabs'
import { DivergenceList } from '@/components/wifi-config/divergence-list'
import { useActiveIntoView } from '@/hooks/use-active-into-view'
import { useProfile } from '@/hooks/use-auth'
import { useApConfig, useDivergences, useRefreshApConfig } from '@/hooks/use-wifi-config'
import { ApiError } from '@/lib/api'
import { formatAgo, formatDateTime } from '@/lib/gateway-config'
import { AP_WRITE_BLOCK_TEXT, countryName, wifiRefusalMessage } from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type { ApConfig } from '@/types/wifi-config'

const TABS = ['overview', 'changes', 'conflicts', 'drift', 'sections', 'history', 'activity', 'health', 'capabilities'] as const
type Tab = (typeof TABS)[number]

const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  changes: 'Changes',
  conflicts: 'Conflicts',
  drift: 'Drift',
  sections: 'Sections',
  history: 'History',
  activity: 'Activity',
  health: 'Health',
  capabilities: 'Capabilities',
}

function Overview({ ap, isAdmin }: { ap: ApConfig; isAdmin: boolean }) {
  const divergences = useDivergences({ apId: ap.apId, open: true })
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <ApModeCard ap={ap} isAdmin={isAdmin} detailLink={false} />
      <Panel title="At a glance">
        <div className="divide-y divide-border/60">
          <FactRow label="Agent">{ap.online ? `Online · perch-apd ${ap.agentVersion ?? '?'}` : 'Offline'}</FactRow>
          <FactRow label="Connection">{ap.secure === true ? 'Verified TLS' : ap.secure === false ? 'Plain HTTP' : 'Unknown'}</FactRow>
          <FactRow label="WiFi access on the AP">{ap.access ?? 'not reported'}</FactRow>
          <FactRow label="Writes">{ap.writable ? 'Allowed' : ap.writeBlockedReason ? AP_WRITE_BLOCK_TEXT[ap.writeBlockedReason] : 'Not allowed'}</FactRow>
          <FactRow label="Country">
            {ap.country.effective ? `${countryName(ap.country.effective)} (${ap.country.effective})` : 'Not set'} ·{' '}
            {ap.country.mode === 'fleet' ? 'fleet default' : ap.country.mode === 'fixed' ? 'fixed here' : 'left to the AP'}
          </FactRow>
          <FactRow label="Last read">{ap.observedAt ? formatDateTime(ap.observedAt) : 'never'}</FactRow>
          <FactRow label="Device groups">
            {ap.groups.engine ? (ap.groups.enabled ? 'On (their own sections, left alone)' : 'Available, off') : 'Not on this agent'}
          </FactRow>
        </div>
      </Panel>
      <div className="lg:col-span-2">
        <Panel title="Changed on this access point" description="Edits made here that differ from their network.">
          {divergences.isPending ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (
            <DivergenceList divergences={divergences.data ?? []} isAdmin={isAdmin} onResolved={() => undefined} empty="This access point matches its networks." />
          )}
        </Panel>
      </div>
    </div>
  )
}

function RefreshButton({ ap }: { ap: ApConfig }) {
  const refresh = useRefreshApConfig(ap.apId)
  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending || !ap.online}>
        {refresh.isPending ? <Spinner className="size-3.5" /> : <ArrowClockwise />}
        Read now
      </Button>
      {refresh.error ? <ErrorLine message={wifiRefusalMessage(refresh.error)} /> : null}
    </div>
  )
}

/** `/wifi/sync/:apId`: one access point's WiFi config plane, tab in the URL (`?tab=`). */
export function WifiApConfigPage() {
  const params = useParams()
  const id = Number(params.apId)
  const valid = Number.isInteger(id) && id > 0
  const query = useApConfig(valid ? id : null)
  const isAdmin = useProfile().data?.role === 'admin'
  const [search, setSearch] = useSearchParams()
  const tab = (TABS as readonly string[]).includes(search.get('tab') ?? '') ? (search.get('tab') as Tab) : 'overview'
  const tabsRef = useRef<HTMLElement>(null)
  useActiveIntoView(tabsRef, tab)

  const crumbs = [{ label: 'Sync', to: '/wifi/sync' }, { label: query.data?.name ?? 'Access point' }]
  if (!valid || (query.isPending && !query.data)) {
    if (!valid) {
      return (
        <div className="flex flex-col gap-5">
          <PageHeader title="Access point" crumbs={crumbs} />
          <p className="text-sm text-destructive">No such access point.</p>
        </div>
      )
    }
    return <PageSpinner label="Loading the access point" />
  }
  if (query.error || !query.data) {
    const notFound = query.error instanceof ApiError && query.error.status === 404
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Access point" crumbs={crumbs} />
        <p className="text-sm text-destructive">{notFound ? 'No such access point.' : wifiRefusalMessage(query.error)}</p>
      </div>
    )
  }
  const ap = query.data
  const counts: Partial<Record<Tab, number>> = { changes: ap.counts.ahead, conflicts: ap.counts.conflicts, drift: ap.counts.drift }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={ap.name}
        crumbs={crumbs}
        description={ap.observedAt ? `WiFi configuration read ${formatAgo(ap.observedAt)} · revision ${ap.headRevision}` : 'Perch has not read this access point’s WiFi yet.'}
        actions={
          <>
            <Button asChild size="sm" variant="ghost">
              <Link to={`/wifi/aps/${ap.apId}`}>
                <ChartLine />
                Monitoring
              </Link>
            </Button>
            {isAdmin && ap.mode !== 'off' ? <RefreshButton ap={ap} /> : null}
          </>
        }
      />
      {ap.luciPending ? (
        <p className="flex items-start gap-2 rounded-lg border border-status-warning/50 bg-status-warning/10 px-3 py-2 text-xs">
          <Warning weight="fill" className="mt-px size-4 shrink-0 text-status-warning" />
          LuCI has staged changes that are not applied yet{ap.uncommitted.length ? ` (${ap.uncommitted.join(', ')})` : ''}. Perch reads
          committed configuration only.
        </p>
      ) : null}

      <nav ref={tabsRef} className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Sections of the access point page">
        <div role="tablist" className="flex min-w-max gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => {
                const next = new URLSearchParams(search)
                if (t === 'overview') next.delete('tab')
                else next.set('tab', t)
                setSearch(next, { replace: true })
              }}
              className={cn(
                '-mb-px flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-xs font-medium whitespace-nowrap select-none transition-colors duration-base sm:min-h-9',
                tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {TAB_LABEL[t]}
              {counts[t] ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[10px] tabular-nums',
                    t === 'conflicts' || t === 'drift' ? 'bg-status-critical/15 text-status-critical' : 'bg-primary/15 text-primary',
                  )}
                >
                  {counts[t]}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </nav>

      {tab === 'overview' ? <Overview ap={ap} isAdmin={isAdmin} /> : null}
      {tab === 'changes' ? <ApDraftPanel ap={ap} isAdmin={isAdmin} /> : null}
      {tab === 'conflicts' ? <ApConflictsPanel ap={ap} isAdmin={isAdmin} /> : null}
      {tab === 'drift' ? <ApDriftPanel ap={ap} isAdmin={isAdmin} /> : null}
      {tab === 'sections' ? <ApSectionsPanel ap={ap} isAdmin={isAdmin} /> : null}
      {tab === 'history' ? <ApHistoryPanel ap={ap} isAdmin={isAdmin} /> : null}
      {tab === 'activity' ? <ApActivityPanel ap={ap} /> : null}
      {tab === 'health' ? <ApHealthPanel ap={ap} /> : null}
      {tab === 'capabilities' ? <ApCapabilitiesPanel ap={ap} /> : null}
    </div>
  )
}
