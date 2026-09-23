import { useState } from 'react'
import { Link } from 'react-router-dom'
import { DoorOpen, Plus, Users } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageSpinner } from '@/components/ui/spinner'
import { PortalFormDialog } from '@/components/portal/portal-form-dialog'
import { PortalHealthBadge } from '@/components/portal/portal-status'
import { DeliveryBadge, ErrorNote, PortalSectionNav } from '@/components/portal/portal-ui'
import { useIsPortalAdmin, usePortals } from '@/hooks/use-portal'
import { methodLabels } from '@/lib/portal'
import type { Portal } from '@/types/api'

/** `/portal`: the guest portals of every gateway, one per network. */
export function PortalPage() {
  const { isAdmin } = useIsPortalAdmin()
  const portals = usePortals()
  const [creating, setCreating] = useState(false)

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        title="Guest portal"
        description="Sign-in pages in front of guest networks: vouchers, portal users, coin terminals and click-through."
        actions={
          isAdmin ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              New portal
            </Button>
          ) : null
        }
      />
      <PortalSectionNav />

      {portals.isPending ? <PageSpinner label="Loading portals" /> : null}
      {portals.error ? <ErrorNote error={portals.error} /> : null}

      {portals.data && portals.data.length === 0 ? (
        <EmptyState
          icon={<DoorOpen className="size-6" />}
          title="No guest portal yet"
          description={
            isAdmin
              ? 'Create one on a guest network of your gateway. Guests then see a sign-in page before they get online.'
              : 'An admin can create one on a guest network of the gateway.'
          }
        />
      ) : null}

      {portals.data && portals.data.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {portals.data.map((portal) => (
            <PortalCard key={portal.id} portal={portal} />
          ))}
        </div>
      ) : null}

      {creating ? <PortalFormDialog onClose={() => setCreating(false)} /> : null}
    </div>
  )
}

function PortalCard({ portal }: { portal: Portal }) {
  const methods = methodLabels(portal.methods).join(' · ')
  const clients = portal.status.clients
  return (
    <Link
      to={`/portal/portals/${portal.id}`}
      className="card-surface group flex flex-col gap-3 p-4 transition-colors hover:border-foreground/20"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h2 className="truncate text-sm font-semibold group-hover:underline">{portal.name}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {portal.gateway?.name ?? `Gateway ${portal.gatewayId}`} ·{' '}
            {portal.network.label ?? portal.network.name ?? portal.network.perchId}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <DeliveryBadge delivery={portal.status.delivery} />
          <PortalHealthBadge portal={portal} />
        </div>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-baseline gap-1.5">
          <Users className="size-4 self-center text-muted-foreground" />
          <span className="text-2xl font-semibold tabular-nums">{clients.authenticated}</span>
          <span className="text-xs text-muted-foreground">online</span>
          {clients.queued > 0 ? (
            <span className="text-xs text-muted-foreground">· {clients.queued} queued</span>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {methods ? (
            <Badge variant="outline" className="rounded-sm text-muted-foreground">
              {methods}
            </Badge>
          ) : null}
        </div>
      </div>
    </Link>
  )
}
