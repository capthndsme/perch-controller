import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { PencilSimple, ShieldCheck, Trash } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { PageSpinner } from '@/components/ui/spinner'
import { NetworkCaptureSwitch } from '@/components/networks/network-capture-switch'
import { GrantsPanel } from '@/components/portal/grants-panel'
import { PortalFormDialog } from '@/components/portal/portal-form-dialog'
import { PortalHealthBadge, PortalNotices, PortalStatusFacts } from '@/components/portal/portal-status'
import { ConfirmDialog, ErrorNote, Fact } from '@/components/portal/portal-ui'
import { SessionsPanel } from '@/components/portal/sessions-panel'
import { useDeletePortal, useIsPortalAdmin, usePortal, usePortalTemplates } from '@/hooks/use-portal'
import { ApiError, apiErrorCode } from '@/lib/api'
import { errorDetail } from '@/lib/portal'
import type { Portal } from '@/types/api'

type Tab = 'guests' | 'sessions' | 'setup'

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'guests', label: 'Guests' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'setup', label: 'Setup' },
]

/** `/portal/portals/:id`: one portal's health, guests, history and setup. */
export function PortalDetailPage() {
  const params = useParams()
  const id = Number(params.id)
  const portal = usePortal(Number.isInteger(id) && id > 0 ? id : null)
  const { isAdmin } = useIsPortalAdmin()
  const [search, setSearch] = useSearchParams()
  const tab = (TABS.some((t) => t.id === search.get('tab')) ? search.get('tab') : 'guests') as Tab
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  if (portal.isPending) return <PageSpinner label="Loading portal" />
  if (portal.error || !portal.data) {
    const missing = portal.error instanceof ApiError && portal.error.status === 404
    return (
      <div className="flex w-full flex-col gap-5">
        <PageHeader title="Portal" crumbs={[{ label: 'Guest portal', to: '/portal' }, { label: 'Portal' }]} />
        {missing ? <p className="text-sm text-muted-foreground">This portal does not exist (any more).</p> : <ErrorNote error={portal.error} />}
      </div>
    )
  }
  const data = portal.data

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        title={data.name}
        crumbs={[{ label: 'Guest portal', to: '/portal' }, { label: data.name }]}
        description={`${data.gateway?.name ?? `Gateway ${data.gatewayId}`} · ${data.network.label ?? data.network.name ?? data.network.perchId}`}
        actions={
          isAdmin ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <PencilSimple className="size-3.5" />
                Edit
              </Button>
              <Button size="sm" variant="destructive" onClick={() => setDeleting(true)}>
                <Trash className="size-3.5" />
                Delete
              </Button>
            </>
          ) : null
        }
      >
        <div className="flex flex-wrap gap-1.5">
          <PortalHealthBadge portal={data} />
        </div>
      </PageHeader>

      <PortalNotices portal={data} />

      <section className="card-surface p-4">
        <PortalStatusFacts portal={data} />
      </section>

      <Segmented
        ariaLabel="Portal view"
        value={tab}
        options={TABS}
        className="w-fit"
        onChange={(next) => {
          const nextSearch = new URLSearchParams(search)
          if (next === 'guests') nextSearch.delete('tab')
          else nextSearch.set('tab', next)
          setSearch(nextSearch, { replace: true })
        }}
      />

      {tab === 'guests' ? <GrantsPanel portalId={data.id} isAdmin={isAdmin} /> : null}
      {tab === 'sessions' ? <SessionsPanel portalId={data.id} /> : null}
      {tab === 'setup' ? <PortalSetupPanel portal={data} isAdmin={isAdmin} onEdit={() => setEditing(true)} /> : null}

      {editing ? <PortalFormDialog portal={data} onClose={() => setEditing(false)} /> : null}
      {deleting ? <DeletePortalDialog portal={data} onClose={() => setDeleting(false)} /> : null}
    </div>
  )
}

function PortalSetupPanel({ portal, isAdmin, onEdit }: { portal: Portal; isAdmin: boolean; onEdit: () => void }) {
  const templates = usePortalTemplates({ enabled: isAdmin })
  const template = portal.templateId === null ? null : templates.data?.find((t) => t.id === portal.templateId)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        title="Setup"
        actions={
          isAdmin ? (
            <Button size="sm" variant="outline" onClick={onEdit}>
              Edit
            </Button>
          ) : null
        }
      >
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Fact label="Network">
            {portal.network.label ?? portal.network.name ?? portal.network.perchId}
            {portal.network.purpose ? <span className="ml-1 text-muted-foreground">({portal.network.purpose})</span> : null}
          </Fact>
          <Fact label="Sign-in methods">
            {[portal.methods.voucher ? 'Vouchers' : null, portal.methods.password ? 'Username + password' : null]
              .filter(Boolean)
              .join(', ') || 'None'}
          </Fact>
          <Fact label="Page template">
            {portal.templateId === null ? (
              'Gateway’s compiled-in pages'
            ) : isAdmin ? (
              <Link to={`/portal/templates/${portal.templateId}`} className="underline-offset-2 hover:underline">
                {template?.name ?? `Template ${portal.templateId}`}
              </Link>
            ) : (
              `Template ${portal.templateId}`
            )}
          </Fact>
          <Fact label="Instance on the router">{portal.instance ?? '—'}</Fact>
          <Fact label="Origins the page may call" className="sm:col-span-2">
            {portal.cspConnectSrc.length ? (
              <span className="font-mono">{portal.cspConnectSrc.join(', ')}</span>
            ) : (
              'None (the page talks only to the gateway)'
            )}
          </Fact>
        </dl>
        {portal.privacyNotice ? (
          <div className="mt-4 space-y-1">
            <p className="text-[11px] text-muted-foreground">Privacy notice</p>
            <p className="rounded-md border border-border bg-muted/20 p-2.5 text-xs whitespace-pre-wrap">{portal.privacyNotice}</p>
          </div>
        ) : null}
      </Panel>

      <Panel title="Guest privacy" description="Whether Perch records what guests do on this network.">
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <p>
              The portal itself keeps only what it needs to run: guests’ MAC addresses, sign-ins and how much time and
              data they used, pruned after the session retention under{' '}
              <Link to="/settings/portal" className="underline underline-offset-2">
                Settings → Guest portal
              </Link>
              . Whether the network’s traffic also appears in Perch’s device and destination views is the
              network’s capture switch below (also on the{' '}
              <Link to="/networks" className="underline underline-offset-2">
                Networks
              </Link>{' '}
              page).
            </p>
          </div>
          <NetworkCaptureSwitch gatewayId={portal.gatewayId} perchId={portal.network.perchId} />
        </div>
      </Panel>
    </div>
  )
}

function DeletePortalDialog({ portal, onClose }: { portal: Portal; onClose: () => void }) {
  const navigate = useNavigate()
  const remove = useDeletePortal()
  const blocked = apiErrorCode(remove.error) === 'portal_active_grants'
  const activeGrants = errorDetail<number>(remove.error, 'activeGrants')

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Delete ${portal.name}?`}
      description="The sign-in page comes off the network and its guests lose access. Vouchers bound to it stop working here."
      confirmLabel={blocked ? 'End their access and delete' : 'Delete portal'}
      destructive
      pending={remove.isPending}
      error={blocked ? null : remove.error}
      onConfirm={() =>
        remove.mutate(
          { id: portal.id, force: blocked },
          {
            onSuccess: () => {
              onClose()
              navigate('/portal')
            },
          },
        )
      }
    >
      {blocked ? (
        <p className="rounded-md border border-status-warning/50 bg-status-warning/10 p-2.5">
          {activeGrants ?? 'Some'} guest{activeGrants === 1 ? ' is' : 's are'} still online. Deleting ends their access
          (revoked) now.
        </p>
      ) : null}
    </ConfirmDialog>
  )
}
