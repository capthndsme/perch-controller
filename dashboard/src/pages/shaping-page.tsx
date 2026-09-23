import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Gauge, GearSix, Lock } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { AssignmentsPanel } from '@/components/qos/assignments-panel'
import { DevicesLivePanel } from '@/components/qos/devices-live-panel'
import { EventsPanel } from '@/components/qos/events-panel'
import { GroupsPanel, type KnownDevice } from '@/components/qos/groups-panel'
import { LiveRatesChart } from '@/components/qos/live-rates-chart'
import { PoliciesPanel } from '@/components/qos/policies-panel'
import { PauseControl, QosBanners, QosStatusChips } from '@/components/qos/qos-status'
import { SchedulesPanel } from '@/components/qos/schedules-panel'
import { WanQueuesPanel } from '@/components/qos/wan-queues-panel'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { KpiTile } from '@/components/ui/kpi-tile'
import { PageSpinner } from '@/components/ui/spinner'
import { useProfile } from '@/hooks/use-auth'
import { useDevices } from '@/hooks/use-devices'
import {
  qosSampleKey,
  useQosAssignments,
  useQosDevices,
  useQosGatewayId,
  useQosGroups,
  useQosOverview,
  useQosPolicies,
  useQosSchedules,
  useQosSettings,
  useQosWrites,
} from '@/hooks/use-qos'
import { apiErrorCode } from '@/lib/api'
import { deviceDisplayName } from '@/lib/device-names'
import { refusalText } from '@/lib/qos'
import { qosSamples } from '@/lib/qos-live'
import { cn } from '@/lib/utils'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'policies', label: 'Policies & groups' },
  { id: 'assignments', label: 'Assignments' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'devices', label: 'Devices' },
  { id: 'events', label: 'Events' },
] as const
type Tab = (typeof TABS)[number]['id']

const DEVICE_WINDOW = { kind: 'relative', range: '24h' } as const

/**
 * Traffic shaping on a managed gateway (plan 3 WP-F; contract
 * metrics-be/docs/gateway/qos.md sections 5 and 7). Everyone signed in reads
 * every cap (owner decision 16); only admins edit, and only on a managed
 * gateway. The live gateway's default is the imported WAN queue and no device
 * caps (decision 14): the page says so rather than inviting edits.
 */
export function ShapingPage() {
  const gatewayId = useQosGatewayId()
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab')
  const tab: Tab = TABS.some((t) => t.id === tabParam) ? (tabParam as Tab) : 'overview'
  const isAdmin = useProfile().data?.role === 'admin'
  const overview = useQosOverview(gatewayId)
  const ready = overview.data !== undefined
  const policies = useQosPolicies(gatewayId, ready)
  const groups = useQosGroups(gatewayId, ready)
  const assignments = useQosAssignments(gatewayId, ready)
  const schedules = useQosSchedules(gatewayId, ready)
  const shaped = useQosDevices(gatewayId, ready && (tab === 'devices' || tab === 'assignments'))
  const settings = useQosSettings({ enabled: isAdmin })
  const writes = useQosWrites(gatewayId)
  const deviceRows = useDevices({ window: DEVICE_WINDOW, enabled: ready })

  const known: KnownDevice[] = useMemo(() => {
    const byMac = new Map<string, string>()
    for (const d of deviceRows.data ?? []) byMac.set(d.mac.toLowerCase(), deviceDisplayName(d))
    for (const g of groups.data ?? []) for (const m of g.members) if (m.name && !byMac.has(m.mac)) byMac.set(m.mac, m.name)
    return [...byMac].map(([mac, name]) => ({ mac, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [deviceRows.data, groups.data])

  function setTab(next: Tab) {
    const p = new URLSearchParams(params)
    if (next === 'overview') p.delete('tab')
    else p.set('tab', next)
    setParams(p, { replace: true })
  }

  if (overview.error && !overview.data) {
    const code = apiErrorCode(overview.error)
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Traffic shaping" />
        <EmptyState
          icon={<Gauge className="size-6" />}
          title={code === 'qos_not_gateway' ? 'No managed gateway yet' : code === 'qos_gateway_required' ? 'Pick a gateway' : 'Traffic shaping is not available'}
          description={
            code === 'qos_not_gateway'
              ? 'Traffic shaping runs on a gateway: a router whose collector offers gateway management. Once one connects, its WAN queue shows up here.'
              : refusalText(overview.error)
          }
        />
      </div>
    )
  }
  if (!overview.data) return <PageSpinner label="Loading traffic shaping" />

  const o = overview.data
  const canEdit = isAdmin && o.managed
  const policyList = policies.data ?? o.policies
  const live = new Map(o.policies.map((p) => [p.id, p.live]))
  const maxDepth = settings.data?.settings.maxBucketDepth ?? 4

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        title="Traffic shaping"
        description="WAN queues, speed limits, quotas and schedules on the gateway."
        actions={
          <>
            {isAdmin ? <PauseControl overview={o} writes={writes} /> : null}
            {isAdmin ? (
              <Button asChild size="sm" variant="ghost">
                <Link to="/settings/traffic-shaping">
                  <GearSix className="size-3.5" /> Settings
                </Link>
              </Button>
            ) : null}
          </>
        }
      >
        <QosStatusChips overview={o} />
      </PageHeader>

      <QosBanners overview={o} isAdmin={isAdmin} writes={writes} />

      {!isAdmin ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3.5" /> You can see every cap; only admins change them.
        </p>
      ) : null}

      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
        <div className="flex w-max gap-1 border-b border-border" role="tablist" aria-label="Traffic shaping sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors',
                tab === t.id ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              {t.id === 'events' && o.events.length ? <span className="ml-1 text-muted-foreground">{o.events.length}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' ? (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiTile label="Shaped devices" value={o.counts.shapedDevices} sub="with their own entry" />
            <KpiTile label="Network defaults" value={o.counts.dynamicDevices} sub="devices capped by their network" />
            <KpiTile
              label="Quotas used up"
              value={o.counts.quotasExhausted}
              status={o.counts.quotasExhausted ? 'warning' : undefined}
              sub="blocked or throttled now"
            />
            <KpiTile label="Policies" value={policyList.length} sub={`${policyList.filter((p) => p.shared).length} shared buckets`} />
          </div>
          <WanQueuesPanel queues={o.wan} canEdit={canEdit} writes={writes} />
          <LiveRatesChart samples={qosSamples(qosSampleKey(gatewayId))} wan={o.wan} policies={o.policies} />
        </>
      ) : null}

      {tab === 'policies' ? (
        <>
          <PoliciesPanel policies={policyList} live={live} issues={o.issues} canEdit={canEdit} maxDepth={maxDepth} writes={writes} />
          <GroupsPanel
            groups={groups.data ?? []}
            assignments={assignments.data ?? []}
            policies={policyList}
            devices={known}
            canEdit={canEdit}
            writes={writes}
          />
        </>
      ) : null}

      {tab === 'assignments' ? (
        <AssignmentsPanel
          assignments={assignments.data ?? []}
          policies={policyList}
          groups={groups.data ?? []}
          devices={known}
          shaping={shaped.data ?? []}
          canEdit={canEdit}
          writes={writes}
        />
      ) : null}

      {tab === 'schedules' ? (
        <SchedulesPanel
          schedules={schedules.data ?? []}
          policies={policyList}
          assignments={assignments.data ?? []}
          groups={groups.data ?? []}
          devices={known}
          overview={o}
          canEdit={canEdit}
          writes={writes}
        />
      ) : null}

      {tab === 'devices' ? <DevicesLivePanel rows={shaped.data ?? []} devices={known} loading={shaped.isPending} /> : null}

      {tab === 'events' ? <EventsPanel events={o.events} devices={known} /> : null}
    </div>
  )
}
