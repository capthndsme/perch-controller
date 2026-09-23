import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDown, ArrowUp, Info, Plus, TreeStructure, Warning } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { GatewayModeBadge, NetworkBadges } from '@/components/networks/network-badges'
import { NetworkCaptureSwitch } from '@/components/networks/network-capture-switch'
import { NetworkFormDialog } from '@/components/networks/network-form-dialog'
import { UpDot } from '@/components/networks/network-ui'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { useProfile } from '@/hooks/use-auth'
import { useGatewayNetworkLists, useNetworkGateways } from '@/hooks/use-networks'
import { ApiError } from '@/lib/api'
import {
  configWriteBlock,
  configWriteHardBlocked,
  formatBps,
  hasKernelDrops,
  kindLine,
  l2ModeLabel,
  networkErrorMessage,
  networkTitle,
  poolRange,
} from '@/lib/networks'
import type { GatewayBrief, GatewayNetwork } from '@/types/networks'

/**
 * Networks (plan 1 section 12.4): every gateway's LAN-side networks with their
 * kind, VLAN, subnet, DHCP pool, firewall zone, live rates and
 * device counts, the capture switch, and the admin's create dialog.
 */
export function NetworksPage() {
  const gateways = useNetworkGateways()
  const list = gateways.data ?? []
  const lists = useGatewayNetworkLists(list.map((g) => g.id))

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Networks"
        description="Every network behind your gateways: LANs, VLANs, guest and IoT networks, with their live traffic."
      />

      {gateways.isPending ? (
        <p className="text-sm text-muted-foreground">Loading gateways…</p>
      ) : gateways.error ? (
        <EmptyState
          title={gateways.error instanceof ApiError && gateways.error.status === 404 ? 'No gateway support' : 'Could not load the gateways'}
          description={
            gateways.error instanceof ApiError && gateways.error.status === 404
              ? 'This controller has no managed gateway support yet.'
              : networkErrorMessage(gateways.error)
          }
        />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<TreeStructure className="size-6" />}
          title="No gateway yet"
          description="Networks come from the collector running on your router (the Gateway agent). Once it connects, its networks show up here."
        />
      ) : (
        list.map((gateway, i) => (
          <GatewayNetworksPanel
            key={gateway.id}
            gateway={gateway}
            networks={lists[i]?.data}
            isPending={lists[i]?.isPending ?? true}
            error={lists[i]?.error ?? null}
          />
        ))
      )}
    </div>
  )
}

function GatewayNetworksPanel({
  gateway,
  networks,
  isPending,
  error,
}: {
  gateway: GatewayBrief
  networks: GatewayNetwork[] | undefined
  isPending: boolean
  error: Error | null
}) {
  const profile = useProfile()
  const isAdmin = profile.data?.role === 'admin'
  const [creating, setCreating] = useState(false)
  const blocked = configWriteHardBlocked(gateway)
  const drops = (networks ?? []).filter(hasKernelDrops)

  return (
    <Panel
      flush
      title={
        <span className="flex flex-wrap items-center gap-2">
          {gateway.name}
          <GatewayModeBadge gateway={gateway} />
        </span>
      }
      description={gateway.mode === 'managed' ? undefined : 'Read-only: create and change networks once the gateway is managed.'}
      actions={
        isAdmin ? (
          <Button
            size="sm"
            variant="outline"
            disabled={blocked || !networks}
            title={blocked ? (configWriteBlock(gateway) ?? undefined) : undefined}
            onClick={() => setCreating(true)}
          >
            <Plus className="size-3.5" />
            New network
          </Button>
        ) : null
      }
    >
      {drops.length > 0 ? (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs">
          <Warning className="mt-0.5 size-4 shrink-0 text-status-warning" />
          <span>
            The capture on {drops.map((n) => n.key).join(', ')} dropped packets in the kernel, so per-device traffic
            there undercounts. The router may be short of CPU or the capture buffer is too small.
          </span>
        </div>
      ) : null}
      {isPending ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">Loading networks…</p>
      ) : error ? (
        <p className="px-4 pb-4 text-sm text-destructive">{networkErrorMessage(error)}</p>
      ) : !networks || networks.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState title="No networks reported" description="The gateway has not reported its networks yet." />
        </div>
      ) : (
        <>
          <NetworksTable gateway={gateway} networks={networks} isAdmin={isAdmin} />
          <NetworksCards gateway={gateway} networks={networks} />
        </>
      )}
      {creating && networks ? (
        <NetworkFormDialog gateway={gateway} networks={networks} onClose={() => setCreating(false)} />
      ) : null}
    </Panel>
  )
}

function Rates({ network }: { network: GatewayNetwork }) {
  const live = network.live
  if (!live || (live.downloadBps === null && live.uploadBps === null)) {
    return <span className="text-muted-foreground">—</span>
  }
  return (
    <span className="inline-flex flex-col items-end gap-0.5 font-mono text-[11.5px] tabular-nums">
      <span className="inline-flex items-center gap-1">
        <ArrowDown className="size-3 text-[var(--chart-download)]" />
        {formatBps(live.downloadBps)}
      </span>
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ArrowUp className="size-3 text-[var(--chart-upload)]" />
        {formatBps(live.uploadBps)}
      </span>
    </span>
  )
}

function Devices({ network }: { network: GatewayNetwork }) {
  const live = network.live
  if (!network.capture) return <span className="text-muted-foreground">not captured</span>
  if (!live || live.devices === null) return <span className="text-muted-foreground">—</span>
  return (
    <span className="tabular-nums">
      {live.activeDevices ?? 0}
      <span className="text-muted-foreground"> / {live.devices}</span>
    </span>
  )
}

function Subnets({ network }: { network: GatewayNetwork }) {
  const all = network.ipv4All.length > 0 ? network.ipv4All : (network.live?.ipv4 ?? [])
  if (all.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <span className="flex flex-col font-mono text-[11.5px]">
      {all.map((c) => (
        <span key={c}>{c}</span>
      ))}
    </span>
  )
}

function Pool({ network }: { network: GatewayNetwork }) {
  const pool = network.dhcp
  if (!pool) return <span className="text-muted-foreground">none</span>
  if (!pool.enabled) return <span className="text-muted-foreground">off</span>
  const range = poolRange(network.ipv4, pool.start, pool.limit)
  return (
    <span className="flex flex-col">
      <span className="font-mono text-[11.5px]">{range ?? `${pool.start ?? '?'} + ${pool.limit ?? '?'}`}</span>
      <span className="text-[11px] text-muted-foreground">
        {pool.leaseTime ?? 'default'} lease{pool.owner === 'router' ? ' · router’s' : ''}
      </span>
    </span>
  )
}

function NetworksTable({
  gateway,
  networks,
  isAdmin,
}: {
  gateway: GatewayBrief
  networks: GatewayNetwork[]
  isAdmin: boolean
}) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-y border-border bg-muted/30 text-left text-muted-foreground">
            <th className="px-4 py-2 font-medium">Network</th>
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 font-medium">Subnet</th>
            <th className="px-3 py-2 font-medium">DHCP pool</th>
            <th className="px-3 py-2 font-medium">Zone</th>
            <th className="px-3 py-2 text-right font-medium">Traffic</th>
            <th className="px-3 py-2 text-right font-medium" title="Active now / seen">
              Devices
            </th>
            <th className="px-4 py-2 font-medium">Capture</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {networks.map((n) => (
            <tr key={n.id} className="align-top hover:bg-muted/20">
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-1.5">
                  <UpDot up={n.live?.up} />
                  <Link to={`/networks/${gateway.id}/${n.id}`} className="font-medium hover:underline">
                    {networkTitle(n)}
                  </Link>
                  {n.label !== n.key ? <span className="font-mono text-[11px] text-muted-foreground">{n.key}</span> : null}
                </div>
                <div className="mt-1">
                  <NetworkBadges network={n} />
                </div>
              </td>
              <td className="px-3 py-2.5">
                <span className="block">{kindLine(n)}</span>
                <span className="text-[11px] text-muted-foreground">{n.l2Mode ? l2ModeLabel(n.l2Mode) : 'Not modeled'}</span>
              </td>
              <td className="px-3 py-2.5">
                <Subnets network={n} />
              </td>
              <td className="px-3 py-2.5">
                <Pool network={n} />
              </td>
              <td className="px-3 py-2.5">
                {n.firewallZone ? <span className="font-mono">{n.firewallZone}</span> : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-3 py-2.5 text-right">
                <Rates network={n} />
              </td>
              <td className="px-3 py-2.5 text-right">
                <Devices network={n} />
              </td>
              <td className="px-4 py-2.5">
                {isAdmin ? (
                  <NetworkCaptureSwitch gatewayId={gateway.id} networkId={n.id} compact />
                ) : (
                  <span className="text-muted-foreground">{n.capture ? 'On' : 'Off'}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="flex items-center gap-1.5 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        <Info className="size-3.5" />
        Rates are the router’s interface counters (every 30 s); devices are those the capture saw on the network.
        Change a network’s firewall zone from its Edit dialog.
      </p>
    </div>
  )
}

function NetworksCards({ gateway, networks }: { gateway: GatewayBrief; networks: GatewayNetwork[] }) {
  return (
    <ul className="divide-y divide-border border-t border-border md:hidden">
      {networks.map((n) => (
        <li key={n.id}>
          <Link to={`/networks/${gateway.id}/${n.id}`} className="block space-y-1.5 px-4 py-3 hover:bg-muted/20">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <UpDot up={n.live?.up} />
                  <span className="truncate text-[13px] font-medium">{networkTitle(n)}</span>
                  {n.label !== n.key ? <span className="font-mono text-[11px] text-muted-foreground">{n.key}</span> : null}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {kindLine(n)}
                  {n.ipv4 ? ` · ${n.ipv4}` : ''}
                </p>
              </div>
              <Rates network={n} />
            </div>
            <NetworkBadges network={n} />
            <p className="text-[11px] text-muted-foreground">
              Devices <Devices network={n} />
              {n.dhcp?.enabled ? ` · DHCP ${poolRange(n.ipv4, n.dhcp.start, n.dhcp.limit) ?? 'on'}` : ''}
              {n.firewallZone ? ` · zone ${n.firewallZone}` : ''}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  )
}
