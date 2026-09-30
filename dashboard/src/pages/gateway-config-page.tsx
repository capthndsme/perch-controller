import { Link } from 'react-router-dom'
import { ArrowRight, Network as RouterIcon } from '@phosphor-icons/react'
import { GatewayBadges } from '@/components/gateway-config/gateway-badges'
import { AmbiguityPanel } from '@/components/gateway-sync/ambiguity-panel'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageSpinner } from '@/components/ui/spinner'
import { useProfile } from '@/hooks/use-auth'
import { useGateways } from '@/hooks/use-gateways'
import { APPLY_STATE_META, formatAgo } from '@/lib/gateway-config'

/** `/gateway/config`: every gateway with its mode and sync state. */
export function GatewayConfigPage() {
  const gateways = useGateways()
  const isAdmin = useProfile().data?.role === 'admin'

  if (gateways.isPending) return <PageSpinner label="Loading gateways" />

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Gateway configuration"
        description="The router’s own configuration, mirrored or managed two-way."
        actions={
          isAdmin ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/settings/gateway-config">Settings</Link>
            </Button>
          ) : null
        }
      />
      {gateways.error ? (
        <p className="text-sm text-destructive">{gateways.error.message}</p>
      ) : (gateways.data ?? []).length === 0 ? (
        <EmptyState
          icon={<RouterIcon className="size-6" />}
          title="No gateways yet"
          description="A perch-collector running on an OpenWrt router becomes a gateway once it is adopted under Settings → Collectors."
        />
      ) : (
        <>
        {gateways.data!.map((g) => (
          <AmbiguityPanel key={g.id} gateway={g} isAdmin={isAdmin} />
        ))}
        <ul className="grid gap-3 lg:grid-cols-2">
          {gateways.data!.map((g) => (
            <li key={g.id}>
              <Link
                to={`/gateway/config/${g.id}`}
                className="card-surface flex flex-col gap-3 p-4 transition-colors hover:bg-muted/30"
                data-testid="gateway-card"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      <RouterIcon className="size-4 text-muted-foreground" />
                      {g.name}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {g.observedAt ? `Read ${formatAgo(g.observedAt)}` : 'Not read yet'} · revision {g.headRevision}
                    </p>
                  </div>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                </div>
                <GatewayBadges gateway={g} />
                {g.mode !== 'off' ? (
                  <dl className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
                    {(
                      [
                        ['Synced', g.counts.synced],
                        ['Excluded', g.counts.excluded],
                        ['Unmodeled', g.counts.unmodeled],
                        ['Drafts', g.counts.ahead],
                        ['Conflicts', g.counts.conflicts],
                        ['Drift', g.counts.drift],
                      ] as const
                    ).map(([label, n]) => (
                      <div key={label} className="rounded-md border border-border px-2 py-1.5">
                        <dt className="text-[11px] text-muted-foreground">{label}</dt>
                        <dd className={`font-mono text-sm ${n > 0 && (label === 'Conflicts' || label === 'Drift') ? 'text-status-critical' : ''}`}>
                          {n}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {g.pendingApply ? (
                  <p className="text-xs">
                    Change in progress: {APPLY_STATE_META[g.pendingApply.state].label.toLowerCase()}
                  </p>
                ) : null}
                {g.rejoinOffer ? (
                  <p className="text-xs text-status-serious">
                    Reset detected: restoring revision {g.rejoinOffer.revision} is offered.
                  </p>
                ) : null}
                {g.mode === 'observe' && g.observedAt && isAdmin ? (
                  <p className="text-xs text-primary">Full management can be enabled.</p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
        </>
      )}
    </div>
  )
}
