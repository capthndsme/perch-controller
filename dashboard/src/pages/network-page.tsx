import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, Info, PencilSimple, ShieldCheck, Trash, Warning } from '@phosphor-icons/react'
import { DashboardToolbar } from '@/components/dashboard/dashboard-toolbar'
import { TimePicker } from '@/components/dashboard/time-picker'
import { PageHeader } from '@/components/layout/page-header'
import { DeleteNetworkDialog } from '@/components/networks/delete-network-dialog'
import { NetworkBadges } from '@/components/networks/network-badges'
import { NetworkCaptureSwitch } from '@/components/networks/network-capture-switch'
import { NetworkFormDialog } from '@/components/networks/network-form-dialog'
import { NetworkHistoryChart } from '@/components/networks/network-history-chart'
import { SectionStatusBadge, UpDot } from '@/components/networks/network-ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { KpiTile } from '@/components/ui/kpi-tile'
import { Panel } from '@/components/ui/panel'
import { useProfile } from '@/hooks/use-auth'
import { useDashboardTime } from '@/hooks/use-dashboard-time'
import { useDevices } from '@/hooks/use-devices'
import { useGatewayNetwork, useGatewayNetworks, useNetworkGateways, useNetworkHistory } from '@/hooks/use-networks'
import { formatLastSeen } from '@/lib/collectors'
import { deviceDisplayName } from '@/lib/device-names'
import { formatBytes } from '@/lib/format-bytes'
import {
  configWriteBlock,
  formatBps,
  kindLine,
  l2ModeLabel,
  networkErrorMessage,
  networkTitle,
  poolRange,
  portSpec,
  scopeMarkLabel,
} from '@/lib/networks'
import { presenceDotClass } from '@/lib/presence'
import { formatTooltipTimestamp, type TimeWindow } from '@/lib/time-window'
import type { DeviceSummary } from '@/types/api'
import type { DeviceNetworkRef, GatewayNetwork, NetworkHistoryResolution } from '@/types/networks'

const DEFAULT_NETWORK_WINDOW: TimeWindow = { kind: 'relative', range: '24h' }
const HISTORY_RESOLUTIONS: NetworkHistoryResolution[] = ['1m', '5m', '15m', '1h']

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-[12.5px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  )
}

/**
 * One network (docs/gateway/networks.md): its traffic history with the scope
 * change marks (decision 8), the devices the capture saw on it (`/devices`
 * rows' `network`), the capture switch (decision 21), its config (kind, VLAN,
 * ports, subnet, DHCP pool, firewall zone) and, for admins,
 * edit and delete.
 */
export function NetworkPage() {
  const params = useParams()
  const navigate = useNavigate()
  const gatewayId = Number(params.gatewayId)
  const networkId = Number(params.networkId)
  const valid = Number.isInteger(gatewayId) && Number.isInteger(networkId)
  const profile = useProfile()
  const isAdmin = profile.data?.role === 'admin'
  const time = useDashboardTime(DEFAULT_NETWORK_WINDOW)
  const gateways = useNetworkGateways()
  const gateway = gateways.data?.find((g) => g.id === gatewayId)
  const detail = useGatewayNetwork(valid ? gatewayId : null, valid ? networkId : null)
  const siblings = useGatewayNetworks(valid ? gatewayId : null)
  const network = detail.data
  const resolution = (HISTORY_RESOLUTIONS as string[]).includes(time.resolutionMode)
    ? (time.resolutionMode as NetworkHistoryResolution)
    : 'auto'
  const history = useNetworkHistory({
    gatewayId: network ? gatewayId : null,
    network: network?.key,
    window: time.window,
    resolution,
    refreshInterval: time.refreshInterval,
  })
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  if (!valid) return <EmptyState title="Not a network" description="The address does not name a network." />
  if (detail.isPending) return <p className="text-sm text-muted-foreground">Loading the network…</p>
  if (detail.error || !network) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Network" crumbs={[{ label: 'Networks', to: '/networks' }, { label: 'Not found' }]} />
        <EmptyState title="Network not found" description={networkErrorMessage(detail.error)} />
      </div>
    )
  }

  const points = history.data?.networks.find((n) => n.network === network.key)?.points ?? []
  const canEditConfig = gateway ? configWriteBlock(gateway) === null || gateway.writeBlockedReason === 'offline' : false

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[
          { label: 'Networks', to: '/networks' },
          { label: gateway?.name ?? `Gateway ${gatewayId}`, to: '/networks' },
          { label: networkTitle(network) },
        ]}
        title={
          <span className="flex items-center gap-2">
            <UpDot up={network.live?.up} />
            {networkTitle(network)}
            {network.label !== network.key ? (
              <span className="font-mono text-sm font-normal text-muted-foreground">{network.key}</span>
            ) : null}
          </span>
        }
        description={`${kindLine(network)}${network.ipv4 ? ` · ${network.ipv4}` : ''}`}
        actions={
          isAdmin && gateway && siblings.data ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)} title={canEditConfig ? undefined : 'Label and purpose only'}>
                <PencilSimple className="size-3.5" />
                Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={network.deleting || gateway.mode !== 'managed' || network.owner !== 'perch'}
                title={
                  gateway.mode !== 'managed'
                    ? 'Needs the gateway in managed mode'
                    : network.owner !== 'perch'
                      ? 'Perch does not manage this network'
                      : undefined
                }
                onClick={() => setDeleting(true)}
              >
                <Trash className="size-3.5" />
                Delete
              </Button>
            </>
          ) : null
        }
      >
        <NetworkBadges network={network} />
      </PageHeader>

      {network.management ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-xs">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-status-good" />
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground">Management network.</span> The gateway reaches Perch through
            it. Changes to it (and to its bridge) go out as a protected apply of their own with a longer confirm window,
            and the router rolls them back by itself if it loses the controller. It cannot be deleted.
          </span>
        </div>
      ) : null}

      <DashboardToolbar>
        <TimePicker
          window={time.window}
          resolutionMode={time.resolutionMode}
          refreshInterval={time.refreshInterval}
          onWindowChange={time.setWindow}
          onResolutionModeChange={time.setResolutionMode}
          onRefreshIntervalChange={time.setRefreshInterval}
        />
      </DashboardToolbar>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Download" value={formatBps(network.live?.downloadBps)} sub="into the network, now" />
        <KpiTile label="Upload" value={formatBps(network.live?.uploadBps)} sub="from the network, now" />
        <KpiTile
          label="Devices"
          value={network.capture ? (network.live?.activeDevices ?? '—') : '—'}
          sub={network.capture ? `active · ${network.live?.devices ?? 0} seen` : 'not captured'}
        />
        <KpiTile
          label="Kernel drops"
          value={network.live?.capture?.kernelDrops?.toLocaleString() ?? '—'}
          sub={(network.live?.capture?.kernelDrops ?? 0) > 0 ? 'per-device figures undercount' : 'capture keeps up'}
          status={(network.live?.capture?.kernelDrops ?? 0) > 0 ? 'warning' : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <Panel
            title="Traffic"
            description="The router’s counters for this network, in client terms. Download = what the router sent into it."
            updating={history.isPlaceholderData}
          >
            {history.error ? (
              <p className="text-sm text-destructive">{networkErrorMessage(history.error)}</p>
            ) : history.isPending ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <NetworkHistoryChart
                points={points}
                from={history.data?.from ?? null}
                to={history.data?.to ?? null}
                scopeChanges={history.data?.scopeChanges ?? []}
                onZoom={time.setWindow}
                onResetZoom={() => time.setWindow(DEFAULT_NETWORK_WINDOW)}
                canResetZoom={time.window.kind === 'absolute'}
              />
            )}
            <ScopeNote
              scopeAtStart={history.data?.scopeAtStart ?? null}
              changes={history.data?.scopeChanges ?? []}
            />
          </Panel>

          <DevicesOnNetwork gatewayId={gatewayId} network={network} window={time.window} />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Capture" description="Whether Perch records this network’s devices and destinations.">
            <NetworkCaptureSwitch gatewayId={gatewayId} networkId={network.id} />
          </Panel>
          <ConfigPanel network={network} />
          <LivePanel network={network} />
        </div>
      </div>

      {editing && gateway && siblings.data ? (
        <NetworkFormDialog gateway={gateway} networks={siblings.data} network={network} onClose={() => setEditing(false)} />
      ) : null}
      {deleting ? (
        <DeleteNetworkDialog
          gatewayId={gatewayId}
          network={network}
          onClose={() => setDeleting(false)}
          onDeleted={() => navigate('/networks')}
        />
      ) : null}
    </div>
  )
}

function ScopeNote({
  scopeAtStart,
  changes,
}: {
  scopeAtStart: 'routed' | 'legacy' | null
  changes: Array<{ scope: 'routed' | 'legacy'; changedAt: string }>
}) {
  const routedSince = changes.find((c) => c.scope === 'routed')
  if (changes.length === 0 && scopeAtStart !== 'legacy') return null
  return (
    <p className="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
      <Info className="mt-px size-3.5 shrink-0" />
      <span>
        {routedSince
          ? `Dashed mark: from ${formatTooltipTimestamp(Date.parse(routedSince.changedAt))} routed traffic between your networks and traffic to the router’s own addresses count as LAN; before it they counted as WAN in the device and destination views. This chart is the router’s own counters and is not affected.`
          : scopeAtStart === 'legacy'
            ? 'The collector still uses the legacy WAN/LAN split: routed traffic between networks counts as WAN in the device views.'
            : `Dashed marks: the WAN/LAN scope rule changed (${scopeMarkLabel('routed')} from a routed mark on).`}
      </span>
    </p>
  )
}

function DevicesOnNetwork({
  gatewayId,
  network,
  window,
}: {
  gatewayId: number
  network: GatewayNetwork
  window: TimeWindow
}) {
  const devices = useDevices({ window })
  const rows = useMemo(
    () =>
      ((devices.data ?? []) as Array<DeviceSummary & { network?: DeviceNetworkRef | null }>)
        .filter((d) => d.network?.gatewayId === gatewayId && d.network.name === network.key)
        .sort((a, b) => b.bytesIn + b.bytesOut - (a.bytesIn + a.bytesOut)),
    [devices.data, gatewayId, network.key],
  )

  return (
    <Panel
      flush
      title="Devices on this network"
      description="Devices with traffic in the window whose latest capture network is this one."
      updating={devices.isPlaceholderData}
    >
      {!network.capture ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">
          Capture is off for this network: Perch keeps no device records for it.
        </p>
      ) : devices.isPending ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">Loading devices…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">No device with traffic on this network in the window.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((d) => (
            <li key={d.mac}>
              <Link
                to={`/devices/${encodeURIComponent(d.mac)}`}
                className="flex items-center justify-between gap-3 px-4 py-2 text-xs hover:bg-muted/20"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`inline-block size-1.5 shrink-0 rounded-full ${presenceDotClass(d.presence?.status === 'connected')}`}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{deviceDisplayName(d)}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {d.primaryIp ?? d.mac}
                      {d.network?.since ? ` · here since ${formatLastSeen(d.network.since)}` : ''}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end font-mono text-[11px] tabular-nums">
                  <span className="inline-flex items-center gap-1">
                    <ArrowDown className="size-3 text-[var(--chart-download)]" />
                    {formatBytes(d.bytesIn)}
                  </span>
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <ArrowUp className="size-3 text-[var(--chart-upload)]" />
                    {formatBytes(d.bytesOut)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function ConfigPanel({ network }: { network: GatewayNetwork }) {
  const pool = network.dhcp
  return (
    <Panel title="Configuration" description={network.owner === 'perch' ? 'Managed by Perch.' : network.owner === 'router' ? 'The router’s (mirrored, not managed).' : 'From the collector’s report only.'}>
      <div className="divide-y divide-border/70">
        <Row label="Key">
          <span className="font-mono">{network.key}</span>
        </Row>
        <Row label="Kind">{l2ModeLabel(network.l2Mode)}</Row>
        {network.bridge ? (
          <Row label="Bridge">
            <span className="font-mono">{network.bridge}</span>
          </Row>
        ) : null}
        {network.vlanId !== null ? <Row label="VLAN">{network.vlanId}</Row> : null}
        {network.parentDevice ? (
          <Row label="Parent">
            <span className="font-mono">{network.parentDevice}</span>
          </Row>
        ) : null}
        <Row label="Device">
          <span className="font-mono">{network.device ?? network.live?.device ?? '—'}</span>
        </Row>
        {network.ports.length > 0 ? (
          <Row label="Ports">
            <span className="flex flex-wrap justify-end gap-1">
              {network.ports.map((p) => (
                <Badge key={p.port} variant="outline" className="rounded font-mono text-[11px]" title={p.tagged ? 'Tagged' : p.pvid ? 'Untagged (PVID)' : 'Untagged'}>
                  {network.l2Mode === 'bridge' ? p.port : portSpec(p)}
                </Badge>
              ))}
            </span>
          </Row>
        ) : null}
        <Row label="IPv4">
          <span className="flex flex-col font-mono">
            {network.ipv4All.length ? network.ipv4All.map((c) => <span key={c}>{c}</span>) : '—'}
          </span>
        </Row>
        {network.live?.ipv6.length ? (
          <Row label="IPv6">
            <span className="flex flex-col font-mono">
              {network.live.ipv6.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </span>
          </Row>
        ) : null}
        <Row label="DHCP pool">
          {pool ? (
            pool.enabled ? (
              <span className="flex flex-col items-end">
                <span className="font-mono">{poolRange(network.ipv4, pool.start, pool.limit) ?? `${pool.start} + ${pool.limit}`}</span>
                <span className="text-[11px] text-muted-foreground">
                  {pool.leaseTime ?? 'default'} lease{pool.owner === 'router' ? ' · the router’s' : ''}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">off</span>
            )
          ) : (
            <span className="text-muted-foreground">none</span>
          )}
        </Row>
        <Row label="Firewall zone">
          <span className="font-mono">{network.firewallZone ?? '—'}</span>
        </Row>
        <Row label="Config state">
          {network.status ? <SectionStatusBadge status={network.status} /> : <span className="text-muted-foreground">—</span>}
        </Row>
      </div>
      {network.status && network.status !== 'in_sync' ? (
        <Link
          to={`/gateway/config/${network.gatewayId}?tab=changes`}
          className="mt-2 inline-block text-xs text-primary underline underline-offset-2"
        >
          Open the gateway’s pending changes
        </Link>
      ) : null}
    </Panel>
  )
}

function LivePanel({ network }: { network: GatewayNetwork }) {
  const live = network.live
  const cap = live?.capture ?? null
  return (
    <Panel title="Live report" description={live ? `From the gateway, ${formatLastSeen(live.reportedAt)}.` : 'The gateway has not reported this network.'}>
      {live ? (
        <div className="divide-y divide-border/70">
          <Row label="Link">{live.up === null ? '—' : live.up ? 'Up' : 'Down'}</Row>
          <Row label="Captured">
            {live.captured === null ? '—' : live.captured ? 'Yes' : 'No (the collector leaves it out)'}
          </Row>
          <Row label="Received / sent">
            <span className="font-mono">
              {live.rxBytes === null ? '—' : formatBytes(live.rxBytes)} / {live.txBytes === null ? '—' : formatBytes(live.txBytes)}
            </span>
          </Row>
          {cap ? (
            <>
              <Row label="Captured WAN ↓ / ↑">
                <span className="font-mono">
                  {formatBytes(cap.bytesInWan)} / {formatBytes(cap.bytesOutWan)}
                </span>
              </Row>
              <Row label="Captured LAN ↓ / ↑">
                <span className="font-mono">
                  {formatBytes(cap.bytesInLan)} / {formatBytes(cap.bytesOutLan)}
                </span>
              </Row>
              <Row label="WAN/LAN rule">{cap.scope === 'routed' ? 'Routed LAN counts as LAN' : cap.scope === 'legacy' ? 'Legacy' : '—'}</Row>
              <Row label="Kernel drops">
                {cap.kernelDrops === null ? (
                  '—'
                ) : cap.kernelDrops > 0 ? (
                  <span className="inline-flex items-center gap-1 text-status-warning">
                    <Warning className="size-3.5" />
                    {cap.kernelDrops.toLocaleString()}
                  </span>
                ) : (
                  '0'
                )}
              </Row>
            </>
          ) : null}
        </div>
      ) : null}
    </Panel>
  )
}
