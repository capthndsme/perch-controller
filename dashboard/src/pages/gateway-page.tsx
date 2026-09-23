import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowClockwise, CheckCircle, Info, Warning } from '@phosphor-icons/react'
import { GatewayBackupsPanel } from '@/components/gateway/gateway-backups-panel'
import { GatewayFreshnessPanel } from '@/components/gateway/gateway-freshness-panel'
import { GatewayLeasesPanel } from '@/components/gateway/gateway-leases-panel'
import { GatewayNeighborsPanel } from '@/components/gateway/gateway-neighbors-panel'
import { GatewayResolverPanel, GatewaySystemPanel, HardwareOffloadingAlert } from '@/components/gateway/gateway-system-panel'
import { GatewayUpnpPanel } from '@/components/gateway/gateway-upnp-panel'
import { GatewayWanPanel } from '@/components/gateway/gateway-wan-panel'
import { PageHeader } from '@/components/layout/page-header'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageSpinner, Spinner } from '@/components/ui/spinner'
import { useProfile } from '@/hooks/use-auth'
import {
  useDefaultGatewayId,
  useGatewayInterfaces,
  useGatewayLeases,
  useGatewayNeighbors,
  useGatewayObservation,
  useGatewaySystem,
  useGatewayUpnp,
  useGatewayWanStatus,
  useRefreshGatewayObservation,
} from '@/hooks/use-gateway-observation'
import { apiErrorCode } from '@/lib/api'
import { formatLastSeen } from '@/lib/collectors'
import {
  BACKUP_CAPABILITY,
  hasCapability,
  OBSERVE_CAPABILITY,
  observationSupport,
  observeErrorMessage,
  PART_LABELS,
} from '@/lib/gateway-observation'
import { cn } from '@/lib/utils'
import type { GatewayObservationOverview, GatewayObservationPart, GatewayObserveResult } from '@/types/api'

/** `?gateway=N` picks a gateway; otherwise the one reporting gateway stats. */
function gatewayFromParams(params: URLSearchParams): number | null {
  const raw = params.get('gateway')
  if (!raw) return null
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * The router's runtime state as its Gateway agent reports it: WAN links and
 * failover, DHCP leases, the neighbour table, UPnP mappings, and (admins) the
 * resolver, system facts and backups. Read-only: Perch observes the router
 * here and changes nothing on it (docs/gateway/observation.md).
 */
export function GatewayPage() {
  const [params] = useSearchParams()
  const explicitId = gatewayFromParams(params)
  const defaultId = useDefaultGatewayId()
  const gatewayId = explicitId ?? defaultId.data ?? null

  if (explicitId === null && defaultId.isPending) return <PageSpinner label="Loading the gateway" />

  if (explicitId === null && defaultId.error) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Gateway" />
        <p className="text-sm text-destructive">{defaultId.error.message}</p>
      </div>
    )
  }

  if (gatewayId === null) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Gateway" description="Your router's WAN links, leases, neighbours and port mappings." />
        <EmptyState
          title="No Gateway agent yet"
          description={
            <>
              Install perch-collector on your OpenWrt router and adopt it in{' '}
              <Link to="/settings/collectors" className="text-brand underline-offset-2 hover:underline">
                Settings → Collectors
              </Link>
              . Once it reports, this page shows its WAN links, DHCP leases, neighbours and UPnP mappings.
            </>
          }
          className="py-14"
        />
      </div>
    )
  }

  return <GatewayView gatewayId={gatewayId} />
}

function GatewayView({ gatewayId }: { gatewayId: number }) {
  const profile = useProfile()
  const isAdmin = profile.data?.role === 'admin'
  const overview = useGatewayObservation(gatewayId)
  const data = overview.data
  const support = data ? observationSupport(data) : 'unknown'
  const reports = support === 'full'
  const reported = (part: GatewayObservationPart) => data?.parts[part] !== undefined

  const wan = useGatewayWanStatus(gatewayId, { enabled: reports })
  const interfaces = useGatewayInterfaces(gatewayId, { enabled: reports })
  const leases = useGatewayLeases(gatewayId, { enabled: reports })
  const neighbors = useGatewayNeighbors(gatewayId, { enabled: reports })
  const upnp = useGatewayUpnp(gatewayId, { enabled: reports })
  const system = useGatewaySystem(gatewayId, { enabled: reports && isAdmin })

  if (overview.isPending) return <PageSpinner label="Loading the gateway" />

  if (!data) {
    const notFound = apiErrorCode(overview.error) === 'gateway_not_found'
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Gateway" />
        {notFound ? (
          <EmptyState
            title={`No gateway with id ${gatewayId}`}
            description={
              <>
                It is not an adopted collector on a router.{' '}
                <Link to="/gateway" className="text-brand underline-offset-2 hover:underline">
                  Show the default gateway
                </Link>
              </>
            }
          />
        ) : (
          <p className="text-sm text-destructive">{overview.error?.message ?? 'Failed to load the gateway.'}</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Gateway"
        description="Your router's state as its Gateway agent reports it. Read-only: Perch changes nothing here."
        actions={isAdmin ? <RefreshButton gatewayId={gatewayId} overview={data} /> : null}
      >
        <AgentChips overview={data} />
      </PageHeader>

      {data.flowOffloadingHw === true ? <HardwareOffloadingAlert /> : null}
      <SupportBanner overview={data} />

      {reports ? (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <GatewayWanPanel
              wan={wan.data}
              interfaces={interfaces.data}
              isPending={wan.isPending}
              error={wan.error}
              reported={reported('interfaces')}
            />
            <div className="flex flex-col gap-4">
              <GatewayFreshnessPanel overview={data} isAdmin={isAdmin} />
              {isAdmin ? (
                <GatewayResolverPanel resolver={system.data?.resolver} isPending={system.isPending} error={system.error} />
              ) : null}
            </div>
          </div>

          <GatewayLeasesPanel
            data={leases.data}
            isPending={leases.isPending}
            isPlaceholderData={leases.isPlaceholderData}
            error={leases.error}
            reported={reported('dhcp')}
          />

          <div className="grid gap-4 xl:grid-cols-2">
            <GatewayNeighborsPanel
              data={neighbors.data}
              isPending={neighbors.isPending}
              error={neighbors.error}
              reported={reported('neighbors')}
            />
            <GatewayUpnpPanel data={upnp.data} isPending={upnp.isPending} error={upnp.error} reported={reported('upnp')} />
          </div>

          {isAdmin ? (
            <div className="grid gap-4 xl:grid-cols-2">
              <GatewaySystemPanel
                data={system.data}
                isPending={system.isPending}
                error={system.error}
                reported={reported('system')}
              />
              <GatewayBackupsPanel
                gatewayId={gatewayId}
                canBackup={hasCapability(data, BACKUP_CAPABILITY)}
                online={data.online}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">System facts, the resolver and backups are shown to admins.</p>
          )}
        </>
      ) : null}
    </div>
  )
}

/** Agent name, connection, router hostname and release, and whether the session is encrypted. */
function AgentChips({ overview }: { overview: GatewayObservationOverview }) {
  const polled = overview.transport === 'poll'
  const reportedAt = Object.values(overview.parts)
    .map((p) => p?.observedAt ?? '')
    .sort()
    .at(-1)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="outline" className="gap-1.5 rounded text-[11px] font-normal">
        <span
          aria-hidden
          className={cn(
            'inline-block size-1.5 rounded-full',
            overview.online ? 'bg-status-good' : polled ? 'bg-muted-foreground/60' : 'bg-status-critical',
          )}
        />
        <span className="font-medium">{overview.name}</span>
        <span className="text-muted-foreground">
          {overview.online ? 'connected' : polled ? 'polled' : reportedAt ? `offline, last report ${formatLastSeen(reportedAt)}` : 'offline'}
        </span>
      </Badge>
      {overview.hostname ? (
        <Badge variant="outline" className="rounded text-[11px] font-normal">
          {overview.hostname}
        </Badge>
      ) : null}
      {overview.release ? (
        <Badge variant="outline" className="rounded text-[11px] font-normal text-muted-foreground">
          {overview.release}
        </Badge>
      ) : null}
      {overview.online && overview.secure !== null ? (
        <Badge
          variant="outline"
          className={cn('rounded text-[11px] font-normal', overview.secure ? 'text-muted-foreground' : 'text-status-warning')}
          title={overview.secure ? 'The agent connected over TLS.' : 'The agent connected over plain HTTP.'}
        >
          {overview.secure ? 'TLS' : 'plain HTTP'}
        </Badge>
      ) : null}
    </div>
  )
}

/** What the page can show from this agent: nothing yet, an older collector, or everything. */
function SupportBanner({ overview }: { overview: GatewayObservationOverview }) {
  const support = observationSupport(overview)
  if (support === 'full') return null
  if (support === 'none') {
    return (
      <EmptyState
        icon={<Info className="size-6" />}
        title="This Gateway agent does not report the router's state"
        description={
          <>
            {overview.name} sends traffic and gateway stats (see the Gateway panel on{' '}
            <Link to="/traffic" className="text-brand underline-offset-2 hover:underline">
              Traffic
            </Link>
            ), but not its leases, neighbours, UPnP mappings or WAN status. Update perch-collector on the
            router to a release with the gateway observation channel and this page fills on its next
            report.
          </>
        }
        className="py-12"
      />
    )
  }
  return (
    <EmptyState
      icon={<Info className="size-6" />}
      title="Nothing observed yet"
      description={
        overview.transport === 'poll'
          ? `${overview.name} is polled over HTTP and has not reported the router's state. Router state arrives with every poll from a perch-collector release with the gateway observation channel; older ones send traffic and gateway stats only.`
          : `${overview.name} is not connected and has never reported the router's state. Once a perch-collector release with the gateway observation channel connects, its first report fills this page.`
      }
      className="py-12"
    />
  )
}

/** Admin: ask the router for a fresh report now; says what changed, or why it could not. */
function RefreshButton({ gatewayId, overview }: { gatewayId: number; overview: GatewayObservationOverview }) {
  const refresh = useRefreshGatewayObservation(gatewayId)
  const [result, setResult] = useState<GatewayObserveResult | null>(null)
  const capable = hasCapability(overview, OBSERVE_CAPABILITY)
  const disabledReason =
    capable === false
      ? 'This Gateway agent cannot refresh on demand: update perch-collector on the router.'
      : !overview.online
        ? overview.transport === 'poll'
          ? 'A polled collector reports with every poll; there is nothing to ask.'
          : 'The Gateway agent is not connected.'
        : null

  async function onRefresh() {
    setResult(null)
    try {
      setResult(await refresh.mutateAsync(undefined))
    } catch {
      // Shown from refresh.error below.
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void onRefresh()}
        disabled={refresh.isPending || disabledReason !== null}
        title={disabledReason ?? 'Ask the router for its current state now (admins).'}
      >
        {refresh.isPending ? <Spinner className="size-3.5" /> : <ArrowClockwise className="size-3.5" />}
        {refresh.isPending ? 'Asking the router…' : 'Refresh now'}
      </Button>
      {disabledReason && capable === false ? (
        <p className="max-w-xs text-[11px] sm:text-right text-muted-foreground">{disabledReason}</p>
      ) : null}
      {refresh.error ? (
        <Alert variant="destructive" className="max-w-sm rounded-lg">
          <Warning className="size-4" />
          <AlertTitle>Refresh failed</AlertTitle>
          <AlertDescription>{observeErrorMessage(refresh.error)}</AlertDescription>
        </Alert>
      ) : null}
      {result ? <RefreshResult result={result} /> : null}
    </div>
  )
}

function RefreshResult({ result }: { result: GatewayObserveResult }) {
  const entries = Object.entries(result.parts) as [GatewayObservationPart, string][]
  const changed = entries.filter(([, outcome]) => outcome === 'written').map(([part]) => PART_LABELS[part] ?? part)
  const failed = entries.filter(([, outcome]) => outcome === 'failed' || outcome === 'invalid')
  return (
    <p className="flex max-w-sm items-start gap-1.5 text-[11px] sm:text-right text-muted-foreground" role="status">
      <CheckCircle className="mt-px size-3.5 shrink-0 text-status-good" />
      <span>
        Refreshed {entries.length} parts
        {changed.length > 0 ? `; changed: ${changed.join(', ')}` : '; nothing changed'}
        {failed.length > 0 ? `; not stored: ${failed.map(([part]) => PART_LABELS[part] ?? part).join(', ')}` : ''}.
      </span>
    </p>
  )
}
