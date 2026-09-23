import { ShieldCheck, Warning } from '@phosphor-icons/react'
import { SectionStatusBadge, ToneBadge } from '@/components/networks/network-ui'
import { purposeLabel } from '@/lib/networks'
import type { GatewayBrief, GatewayNetwork } from '@/types/networks'

/** The chips next to a network's name: management, purpose, removing, capture off, drops, config state. */
export function NetworkBadges({ network, showStatus = true }: { network: GatewayNetwork; showStatus?: boolean }) {
  const drops = network.live?.capture?.kernelDrops ?? 0
  return (
    <span className="flex flex-wrap items-center gap-1">
      {network.management ? (
        <ToneBadge tone="good" title="The gateway reaches Perch through this network: changes to it get a protected apply.">
          <ShieldCheck className="size-3" />
          Management
        </ToneBadge>
      ) : null}
      <ToneBadge tone="muted">{purposeLabel(network.purpose)}</ToneBadge>
      {network.owner === null ? (
        <ToneBadge tone="muted" title="Known from the collector's report only; its config is not modeled.">
          Report only
        </ToneBadge>
      ) : network.owner === 'router' ? (
        <ToneBadge tone="muted" title="Perch mirrors this network's config but does not manage it.">
          Not managed
        </ToneBadge>
      ) : null}
      {network.deleting ? <ToneBadge tone="critical">Removing</ToneBadge> : null}
      {!network.capture ? (
        <ToneBadge tone="muted" title="Perch records no devices or destinations for this network.">
          Not captured
        </ToneBadge>
      ) : null}
      {drops > 0 ? (
        <ToneBadge tone="warning" title="The capture dropped packets in the kernel: per-device figures undercount.">
          <Warning className="size-3" />
          {drops.toLocaleString()} drops
        </ToneBadge>
      ) : null}
      {showStatus && network.status && network.status !== 'in_sync' ? <SectionStatusBadge status={network.status} /> : null}
    </span>
  )
}

export function GatewayModeBadge({ gateway }: { gateway: GatewayBrief }) {
  const label = gateway.mode === 'managed' ? 'Managed' : gateway.mode === 'observe' ? 'Observed' : 'Not managed'
  return (
    <span className="flex flex-wrap items-center gap-1">
      <ToneBadge tone={gateway.mode === 'managed' ? 'good' : 'muted'}>{label}</ToneBadge>
      <ToneBadge tone={gateway.online ? 'good' : 'critical'}>{gateway.online ? 'Online' : 'Offline'}</ToneBadge>
    </span>
  )
}
