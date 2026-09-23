import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ShieldCheck, Warning } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { Callout, LastWriteNote, ToneBadge } from '@/components/firewall/firewall-ui'
import { FirewallOverviewPanel } from '@/components/firewall/overview-panel'
import { PortForwardsPanel } from '@/components/firewall/port-forwards-panel'
import { RulesPanel } from '@/components/firewall/rules-panel'
import { EmptyState } from '@/components/ui/empty-state'
import { KpiTile } from '@/components/ui/kpi-tile'
import { Spinner } from '@/components/ui/spinner'
import { useProfile } from '@/hooks/use-auth'
import { useFirewall, useFirewallDevices, useFirewallGateways } from '@/hooks/use-firewall'
import { ApiError, apiErrorCode } from '@/lib/api'
import { firewallErrorMessage, firewallWriteBlock, firewallWriteHardBlocked } from '@/lib/firewall'
import { cn } from '@/lib/utils'
import type { FirewallOverview, FirewallWriteSummary, FwGateway } from '@/types/firewall'

const TABS = ['overview', 'forwards', 'rules'] as const
type Tab = (typeof TABS)[number]

/** Which gateway: `?gateway=`, else the first managed one, else the first. */
function pickGateway(list: FwGateway[], wanted: string | null): FwGateway | undefined {
  const id = Number(wanted)
  return list.find((g) => g.id === id) ?? list.find((g) => g.mode === 'managed') ?? list[0]
}

/**
 * `/firewall`: the managed gateway's firewall (plan 2 section 4.3,
 * docs/gateway/firewall.md): zones and forwardings, port forwards, traffic
 * rules and their order. Everything here is admin-only on the server, reads
 * included. The tab and the gateway are URL state (`?tab=`, `?gateway=`).
 */
export function FirewallPage() {
  const [search, setSearch] = useSearchParams()
  const profile = useProfile()
  const isAdmin = profile.data?.role === 'admin'
  const gateways = useFirewallGateways()
  const list = gateways.data ?? []
  const gateway = pickGateway(list, search.get('gateway'))
  const firewall = useFirewall(gateway?.id ?? null, { enabled: isAdmin })
  const tab: Tab = (TABS as readonly string[]).includes(search.get('tab') ?? '') ? (search.get('tab') as Tab) : 'overview'

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(search)
    if (value === null) next.delete(key)
    else next.set(key, value)
    setSearch(next, { replace: true })
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Firewall"
        description="What may reach what: zones, port forwards from the internet, and traffic rules on your gateway."
        actions={
          list.length > 1 ? (
            <select
              aria-label="Gateway"
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs dark:bg-input/30"
              value={gateway?.id ?? ''}
              onChange={(e) => setParam('gateway', e.target.value)}
            >
              {list.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          ) : null
        }
      >
        {gateway ? (
          <span className="flex flex-wrap items-center gap-1">
            <ToneBadge tone="muted" className="text-foreground">
              {gateway.name}
            </ToneBadge>
            <ToneBadge tone={gateway.mode === 'managed' ? 'good' : 'muted'}>
              {gateway.mode === 'managed' ? 'Managed' : gateway.mode === 'observe' ? 'Observed' : 'Not managed'}
            </ToneBadge>
            {gateway.authoritative ? <ToneBadge tone="info">Authoritative</ToneBadge> : null}
            <ToneBadge tone={gateway.online ? 'good' : 'critical'}>{gateway.online ? 'Online' : 'Offline'}</ToneBadge>
          </span>
        ) : null}
      </PageHeader>

      {profile.isPending || gateways.isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : !isAdmin ? (
        <EmptyState
          icon={<ShieldCheck className="size-6" />}
          title="Admins only"
          description="The firewall shows which of your devices are reachable from the internet, so only admins can see it."
        />
      ) : gateways.error ? (
        <EmptyState
          title={gateways.error instanceof ApiError && gateways.error.status === 404 ? 'No gateway support' : 'Could not load the gateways'}
          description={
            gateways.error instanceof ApiError && gateways.error.status === 404
              ? 'This controller has no managed gateway support yet.'
              : firewallErrorMessage(gateways.error)
          }
        />
      ) : !gateway ? (
        <EmptyState
          icon={<ShieldCheck className="size-6" />}
          title="No gateway yet"
          description="The firewall comes from the collector running on your router. Once it connects and the gateway is observed or managed, its firewall shows up here."
        />
      ) : gateway.mode === 'off' ? (
        <EmptyState
          title="The gateway is not observed"
          description={
            <>
              Turn on observation or management for {gateway.name} under{' '}
              <Link to={`/gateway/config/${gateway.id}`} className="underline underline-offset-2">
                Gateway config
              </Link>{' '}
              to see its firewall.
            </>
          }
        />
      ) : firewall.isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading the firewall…
        </div>
      ) : firewall.error ? (
        <EmptyState
          title="Could not load the firewall"
          description={
            apiErrorCode(firewall.error) === 'admin_required'
              ? 'Only admins can see the firewall.'
              : firewallErrorMessage(firewall.error)
          }
        />
      ) : (
        <FirewallBody
          key={gateway.id}
          gateway={gateway}
          overview={firewall.data!}
          tab={tab}
          onTab={(t) => setParam('tab', t === 'overview' ? null : t)}
        />
      )}
    </div>
  )
}

function FirewallBody({
  gateway,
  overview,
  tab,
  onTab,
}: {
  gateway: FwGateway
  overview: FirewallOverview
  tab: Tab
  onTab: (tab: Tab) => void
}) {
  const devices = useFirewallDevices()
  const [lastWrite, setLastWrite] = useState<FirewallWriteSummary | null>(null)
  const writeHint = firewallWriteBlock(gateway)
  const canWrite = !firewallWriteHardBlocked(gateway)
  const enabledForwards = overview.portForwards.filter((f) => f.enabled).length
  const forwardWarnings = overview.portForwards.filter((f) => f.shadowedBy).length
  const ruleWarnings = overview.rules.filter((r) => r.shadowedBy || r.pathIssue).length
  const orderTrouble = [overview.orders.rule, overview.orders.redirect].filter(
    (o) => o && (o.status === 'conflict' || o.status === 'drift'),
  ).length
  const errors = overview.issues.filter((i) => i.severity === 'error').length

  const counts: Record<Tab, number | null> = {
    overview: null,
    forwards: overview.portForwards.length,
    rules: overview.rules.length,
  }
  const labels: Record<Tab, string> = { overview: 'Overview', forwards: 'Port forwards', rules: 'Rules' }

  return (
    <>
      {writeHint ? (
        <Callout tone={canWrite ? 'info' : 'warning'} title={canWrite ? 'Changes wait for the gateway' : 'Read only'}>
          {writeHint}{' '}
          {gateway.mode !== 'managed' ? (
            <Link to={`/gateway/config/${gateway.id}`} className="text-primary underline underline-offset-2">
              Gateway config
            </Link>
          ) : null}
        </Callout>
      ) : null}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiTile label="Zones" value={overview.zones.length} sub={`${overview.forwardings.length} forwardings`} />
        <KpiTile
          label="Port forwards"
          value={overview.portForwards.length}
          sub={`${enabledForwards} enabled`}
          status={forwardWarnings > 0 ? 'warning' : undefined}
        />
        <KpiTile
          label="Traffic rules"
          value={overview.rules.length}
          sub={`${overview.rules.filter((r) => r.sync.scope === 'synced').length} editable here`}
          status={ruleWarnings > 0 ? 'warning' : undefined}
        />
        <KpiTile
          label="Needs attention"
          value={errors + forwardWarnings + ruleWarnings + orderTrouble}
          sub={orderTrouble > 0 ? 'order changed on the router' : 'shadowed entries, path issues, errors'}
          status={errors + orderTrouble > 0 ? 'critical' : forwardWarnings + ruleWarnings > 0 ? 'warning' : 'good'}
        />
      </div>

      <div className="-mx-1 overflow-x-auto px-1">
        <div role="tablist" aria-label="Firewall" className="flex min-w-max gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => onTab(t)}
              className={cn(
                '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors',
                tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {labels[t]}
              {counts[t] !== null ? (
                <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{counts[t]}</span>
              ) : null}
              {t === 'rules' && (ruleWarnings > 0 || overview.orders.rule?.status === 'conflict') ? (
                <Warning className="size-3 text-status-warning" />
              ) : null}
              {t === 'forwards' && (forwardWarnings > 0 || overview.orders.redirect?.status === 'conflict') ? (
                <Warning className="size-3 text-status-warning" />
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {lastWrite ? (
        <LastWriteNote gatewayId={gateway.id} {...lastWrite} onDismiss={() => setLastWrite(null)} />
      ) : null}

      {tab === 'overview' ? <FirewallOverviewPanel overview={overview} /> : null}
      {tab === 'forwards' ? (
        <PortForwardsPanel
          gatewayId={gateway.id}
          overview={overview}
          devices={devices}
          canWrite={canWrite}
          writeHint={writeHint}
          onWrite={setLastWrite}
        />
      ) : null}
      {tab === 'rules' ? (
        <RulesPanel
          gatewayId={gateway.id}
          overview={overview}
          devices={devices.list}
          canWrite={canWrite}
          writeHint={writeHint}
          onWrite={setLastWrite}
        />
      ) : null}
    </>
  )
}
