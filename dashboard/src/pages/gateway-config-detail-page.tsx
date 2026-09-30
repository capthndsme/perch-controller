import { useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ArrowClockwise, ClockCounterClockwise, Crown, Warning } from '@phosphor-icons/react'
import { AuthoritativeDialog, AuthoritativeExplainer } from '@/components/gateway-config/authoritative'
import { ConfirmDialog, ErrorLine, FactRow, ToneBadge } from '@/components/gateway-config/bits'
import { ChangesPanel } from '@/components/gateway-config/changes-panel'
import { DnsPanel } from '@/components/gateway-config/dns-panel'
import { GatewayBadges } from '@/components/gateway-config/gateway-badges'
import { AmbiguityPanel } from '@/components/gateway-sync/ambiguity-panel'
import { ActivityPanel, HistoryPanel } from '@/components/gateway-config/history-panels'
import { ModeChooser, ModeDialog } from '@/components/gateway-config/mode-dialogs'
import { PackagesPanel } from '@/components/gateway-config/packages-panel'
import { PairingPanel } from '@/components/gateway-config/pairing-panel'
import { ConflictsPanel, DriftPanel, EnforcementSuspendedBanner } from '@/components/gateway-config/reconcile-panels'
import { SectionsBrowser } from '@/components/gateway-config/sections-browser'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { PageSpinner, Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useProfile } from '@/hooks/use-auth'
import { useDialog } from '@/hooks/use-dialog'
import {
  useDismissRejoin,
  useGateway,
  useGatewayConfigSettings,
  usePatchGateway,
  useRefreshGateway,
  useRestoreRevision,
} from '@/hooks/use-gateways'
import { ApiError } from '@/lib/api'
import { formatAgo, formatDateTime, refusalMessage, WRITE_BLOCK_TEXT } from '@/lib/gateway-config'
import { cn } from '@/lib/utils'
import type { Gateway, GatewayMode } from '@/types/gateway-config'

const TABS = ['overview', 'changes', 'conflicts', 'drift', 'sections', 'history', 'activity', 'dns'] as const
type Tab = (typeof TABS)[number]

const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  changes: 'Changes',
  conflicts: 'Conflicts',
  drift: 'Drift',
  sections: 'Sections',
  history: 'History',
  activity: 'Activity',
  dns: 'DNS',
}

/** `/gateway/config/:id`: one gateway's config plane, tab in the URL (`?tab=`). */
export function GatewayConfigDetailPage() {
  const params = useParams()
  const id = Number(params.id)
  const gateway = useGateway(Number.isInteger(id) && id > 0 ? id : null)
  const isAdmin = useProfile().data?.role === 'admin'
  const [search, setSearch] = useSearchParams()
  const tab = (TABS as readonly string[]).includes(search.get('tab') ?? '') ? (search.get('tab') as Tab) : 'overview'

  if (gateway.isPending) return <PageSpinner label="Loading the gateway" />
  if (gateway.error || !gateway.data) {
    const notFound = gateway.error instanceof ApiError && gateway.error.status === 404
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Gateway" crumbs={[{ label: 'Gateway configuration', to: '/gateway/config' }, { label: 'Gateway' }]} />
        <p className="text-sm text-destructive">{notFound ? 'No such gateway.' : gateway.error?.message}</p>
      </div>
    )
  }
  const g = gateway.data
  const counts: Partial<Record<Tab, number>> = {
    changes: g.counts.ahead,
    conflicts: g.counts.conflicts,
    drift: g.counts.drift,
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={g.name}
        crumbs={[{ label: 'Gateway configuration', to: '/gateway/config' }, { label: g.name }]}
        description={
          g.observedAt
            ? `Configuration read ${formatAgo(g.observedAt)} · head revision ${g.headRevision}`
            : 'Perch has not read this router’s configuration yet.'
        }
        actions={isAdmin && g.mode !== 'off' && !g.detached ? <RefreshButton gateway={g} /> : null}
      >
        <GatewayBadges gateway={g} />
      </PageHeader>

      <EnforcementSuspendedBanner gateway={g} isAdmin={isAdmin} />
      {g.rejoinOffer ? <RejoinOfferBanner gateway={g} isAdmin={isAdmin} /> : null}
      {g.luciPending ? (
        <p className="flex items-start gap-2 rounded-lg border border-status-warning/50 bg-status-warning/10 px-3 py-2 text-xs">
          <Warning weight="fill" className="mt-px size-4 shrink-0 text-status-warning" />
          LuCI has staged changes that are not applied yet
          {g.uncommitted.length > 0 ? ` (${g.uncommitted.join(', ')})` : ''}. Perch reads committed configuration only.
        </p>
      ) : null}

      <AmbiguityPanel gateway={g} isAdmin={isAdmin} />

      <nav className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none]" aria-label="Sections of the gateway page">
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
                '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors',
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

      {tab === 'overview' ? <Overview gateway={g} isAdmin={isAdmin} /> : null}
      {tab === 'changes' ? <ChangesPanel gateway={g} isAdmin={isAdmin} /> : null}
      {tab === 'conflicts' ? <ConflictsPanel gateway={g} isAdmin={isAdmin} /> : null}
      {tab === 'drift' ? <DriftPanel gateway={g} isAdmin={isAdmin} /> : null}
      {tab === 'sections' ? <SectionsBrowser gateway={g} isAdmin={isAdmin} /> : null}
      {tab === 'history' ? <HistoryPanel gateway={g} isAdmin={isAdmin} /> : null}
      {tab === 'activity' ? <ActivityPanel gateway={g} /> : null}
      {tab === 'dns' ? <DnsPanel gateway={g} isAdmin={isAdmin} /> : null}
    </div>
  )
}

function RefreshButton({ gateway }: { gateway: Gateway }) {
  const refresh = useRefreshGateway(gateway.id)
  return (
    <div className="flex items-center gap-2">
      {refresh.error ? <span className="text-xs text-destructive">{refusalMessage(refresh.error)}</span> : null}
      <Button size="sm" variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending || !gateway.online}>
        {refresh.isPending ? <Spinner className="size-3.5" /> : <ArrowClockwise />}
        Read now
      </Button>
    </div>
  )
}

/** README 3.7: after a reset, offer the newest revision known to work, never simply the newest. */
function RejoinOfferBanner({ gateway, isAdmin }: { gateway: Gateway; isAdmin: boolean }) {
  const offer = gateway.rejoinOffer!
  const restore = useRestoreRevision(gateway.id)
  const dismiss = useDismissRejoin(gateway.id)
  const dialog = useDialog()
  const [, setSearch] = useSearchParams()
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-status-serious/50 bg-status-serious/10 px-3 py-2.5 text-xs" data-testid="rejoin-offer">
      <ClockCounterClockwise weight="bold" className="mt-0.5 size-4 shrink-0 text-status-serious" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-semibold">
          {offer.reason === 'ledger_reset' ? 'This router looks reset' : 'This gateway was bound to a new collector'}
        </p>
        <p className="text-muted-foreground">
          Perch can restore revision #{offer.revision}, the last configuration confirmed working on this router (detected{' '}
          {formatAgo(offer.detectedAt)}). Restoring puts it into the draft; you apply it from the Changes tab.
        </p>
        <ErrorLine message={(restore.error ?? dismiss.error) ? refusalMessage(restore.error ?? dismiss.error) : null} />
      </div>
      {isAdmin ? (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => { restore.reset(); dialog.show() }} disabled={gateway.mode !== 'managed'}>
            Restore #{offer.revision}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={dialog.open}
        onOpenChange={dialog.setOpen}
        title={`Restore revision #${offer.revision}?`}
        description="Perch’s draft becomes that revision. Review it on the Changes tab and apply it; the apply confirms or rolls back like any other."
        confirmLabel="Put it into the draft"
        pending={restore.isPending}
        error={restore.error ? refusalMessage(restore.error) : null}
        onConfirm={async () => {
          try {
            await restore.mutateAsync(offer.revision)
            dialog.setOpen(false)
            setSearch({ tab: 'changes' }, { replace: true })
          } catch {
            // shown
          }
        }}
      >
        {gateway.mode !== 'managed' ? <p>Needs managed mode.</p> : null}
      </ConfirmDialog>
    </div>
  )
}

function Overview({ gateway, isAdmin }: { gateway: Gateway; isAdmin: boolean }) {
  const [modeTarget, setModeTarget] = useState<GatewayMode | null>(null)
  const modeDialog = useDialog()
  const authDialog = useDialog()
  const offDialog = useDialog()
  const patch = usePatchGateway(gateway.id)
  const settings = useGatewayConfigSettings({ enabled: isAdmin })
  const delay = settings.data?.settings.authoritativeRevertDelaySeconds ?? 90
  const caps = gateway.capabilities ?? null
  const path = gateway.managementPath ?? null

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="Mode" description="How far Perch may go with this router’s configuration.">
          {gateway.detached ? (
            <p className="text-xs text-muted-foreground">
              Detached: no collector is bound to this gateway any more. Its history stays.
            </p>
          ) : (
            <>
              <ModeChooser
                gateway={gateway}
                disabled={!isAdmin}
                onPick={(m) => {
                  setModeTarget(m)
                  modeDialog.show()
                }}
              />
              {gateway.mode === 'observe' && gateway.observedAt && isAdmin ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs">
                  <span>Perch holds this router’s configuration. You can let it manage the router two-way.</span>
                  <Button
                    size="sm"
                    onClick={() => {
                      setModeTarget('managed')
                      modeDialog.show()
                    }}
                  >
                    Enable full management
                  </Button>
                </div>
              ) : null}
            </>
          )}
          {modeTarget ? (
            <ModeDialog
              key={modeDialog.key}
              gateway={gateway}
              target={modeTarget}
              open={modeDialog.open}
              onOpenChange={modeDialog.setOpen}
            />
          ) : null}
        </Panel>

        <Panel
          title={
            <span className="flex items-center gap-1.5">
              <Crown weight="fill" className="size-3.5 text-status-warning" />
              Authoritative Mode
            </span>
          }
          description="Off: two-way, conflicts go to a queue. On: Perch wins and router edits are reverted."
          actions={
            isAdmin ? (
              <Switch
                checked={gateway.authoritative}
                disabled={gateway.mode !== 'managed'}
                aria-label="Authoritative Mode"
                onCheckedChange={(next) => {
                  if (next) authDialog.show()
                  else {
                    patch.reset()
                    offDialog.show()
                  }
                }}
              />
            ) : null
          }
        >
          <div className="space-y-2 text-xs">
            {gateway.authoritative ? (
              <p>
                On since {formatDateTime(gateway.authoritativeSince)}. Enforcement is{' '}
                <strong>{gateway.enforcement === 'active' ? 'active' : 'suspended'}</strong>.
              </p>
            ) : gateway.mode !== 'managed' ? (
              <p className="text-muted-foreground">Available in managed mode.</p>
            ) : null}
            <AuthoritativeExplainer delaySeconds={delay} />
          </div>
          <AuthoritativeDialog key={authDialog.key} gateway={gateway} open={authDialog.open} onOpenChange={authDialog.setOpen} />
          <ConfirmDialog
            open={offDialog.open}
            onOpenChange={offDialog.setOpen}
            title="Turn Authoritative Mode off?"
            description="Router edits are imported two-way again; drift that is still open becomes an ordinary router edit."
            confirmLabel="Turn off"
            pending={patch.isPending}
            error={patch.error ? refusalMessage(patch.error) : null}
            onConfirm={async () => {
              try {
                await patch.mutateAsync({ authoritative: false })
                offDialog.setOpen(false)
              } catch {
                // shown
              }
            }}
          />
        </Panel>

        <PackagesPanel gateway={gateway} isAdmin={isAdmin} />
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="Status">
          <div className="divide-y divide-border/70">
            <FactRow label="Writes">
              {gateway.writable ? (
                <ToneBadge tone="good">{gateway.signedWrites ? 'Allowed, signed' : 'Allowed'}</ToneBadge>
              ) : gateway.writeBlockedReason ? (
                <span className="text-muted-foreground">{WRITE_BLOCK_TEXT[gateway.writeBlockedReason]}</span>
              ) : (
                '—'
              )}
            </FactRow>
            <FactRow label="Router access">
              <span className="font-mono">{gateway.agentAccess ?? '—'}</span>
              {gateway.agentAccessConfigured && gateway.agentAccessConfigured !== gateway.agentAccess ? (
                <span className="text-muted-foreground"> (configured {gateway.agentAccessConfigured})</span>
              ) : null}
            </FactRow>
            <FactRow label="Transport">
              {gateway.secure === true ? 'Verified TLS' : gateway.secure === false ? 'Plain HTTP' : 'Unknown'}
            </FactRow>
            <FactRow label="Management path">
              {path ? (
                <span className="font-mono">
                  {path.network ?? '?'} ({path.device})
                </span>
              ) : (
                '—'
              )}
            </FactRow>
            {caps?.openwrt?.release ? (
              <FactRow label="OpenWrt">
                {caps.openwrt.release}
                {caps.openwrt.target ? <span className="text-muted-foreground"> · {caps.openwrt.target}</span> : null}
              </FactRow>
            ) : null}
            {caps?.allowedConfigs ? (
              <FactRow label="Configs Perch may touch">
                <span className="font-mono text-[11px]">{caps.allowedConfigs.join(', ')}</span>
              </FactRow>
            ) : null}
            <FactRow label="Sections">
              {gateway.counts.synced} synced · {gateway.counts.excluded} excluded · {gateway.counts.unmodeled} unmodeled
            </FactRow>
          </div>
        </Panel>
        {!gateway.detached ? <PairingPanel gateway={gateway} isAdmin={isAdmin} /> : null}
      </div>
    </div>
  )
}
