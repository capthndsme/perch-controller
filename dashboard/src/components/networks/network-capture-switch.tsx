import { useId } from 'react'
import { ShieldCheck } from '@phosphor-icons/react'
import { Switch } from '@/components/ui/switch'
import { useProfile } from '@/hooks/use-auth'
import { useGatewayNetworks, useSetNetworkCapture } from '@/hooks/use-networks'
import { formatLastSeen } from '@/lib/collectors'
import { networkErrorMessage, networkTitle } from '@/lib/networks'
import { cn } from '@/lib/utils'
import type { GatewayNetwork } from '@/types/networks'

type NetworkCaptureSwitchProps = {
  gatewayId: number
  /** `gateway_networks.id`. Or name the network by its interface section or key: */
  networkId?: number
  /** The interface section's perch id (what the portal pages store). */
  perchId?: string
  /** The network's key (`guest`). */
  networkKey?: string
  /** Hide the privacy note (a table cell). */
  compact?: boolean
  className?: string
}

function findNetwork(
  networks: GatewayNetwork[] | undefined,
  by: Pick<NetworkCaptureSwitchProps, 'networkId' | 'perchId' | 'networkKey'>,
): GatewayNetwork | undefined {
  if (!networks) return undefined
  if (by.networkId !== undefined) return networks.find((n) => n.id === by.networkId)
  if (by.perchId) return networks.find((n) => n.perchId === by.perchId)
  if (by.networkKey) return networks.find((n) => n.key === by.networkKey)
  return undefined
}

/**
 * Whether Perch accounts a network's devices at all (owner decision 21): the
 * per-network capture switch. Works in every gateway mode (metadata, no apply);
 * off sends the network to the collector's capture exclude list and the
 * controller drops any device rows it still sends. Admins toggle it, everyone
 * sees it. Reusable: the portal's Setup tab mounts it for its guest network.
 */
export function NetworkCaptureSwitch({
  gatewayId,
  networkId,
  perchId,
  networkKey,
  compact = false,
  className,
}: NetworkCaptureSwitchProps) {
  const id = useId()
  const profile = useProfile()
  const isAdmin = profile.data?.role === 'admin'
  const networks = useGatewayNetworks(gatewayId)
  const network = findNetwork(networks.data, { networkId, perchId, networkKey })
  const setCapture = useSetNetworkCapture(gatewayId)

  if (networks.isPending) {
    return <p className={cn('text-xs text-muted-foreground', className)}>Loading the network…</p>
  }
  if (!network) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)}>
        {networks.error ? networkErrorMessage(networks.error) : 'This network is not known to the gateway yet.'}
      </p>
    )
  }

  const on = network.capture
  const switchEl = (
    <Switch
      id={id}
      checked={on}
      disabled={!isAdmin || setCapture.isPending}
      onCheckedChange={(next) => setCapture.mutate({ networkId: network.id, capture: next })}
      aria-label={`Capture traffic on ${networkTitle(network)}`}
    />
  )

  if (compact) {
    return (
      <span className={cn('inline-flex items-center gap-2', className)}>
        {switchEl}
        <span className="text-xs text-muted-foreground">{on ? 'On' : 'Off'}</span>
      </span>
    )
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-start justify-between gap-3">
        <label htmlFor={id} className="min-w-0 space-y-0.5">
          <span className="block text-[13px] font-medium">
            Capture traffic on {networkTitle(network)}
          </span>
          <span className="block text-xs text-muted-foreground">
            {on
              ? 'On: its devices, destinations and protocols appear in Perch.'
              : 'Off: Perch records no devices, destinations or protocols for this network.'}
          </span>
        </label>
        {switchEl}
      </div>
      {network.live?.captured === false && on ? (
        <p className="text-xs text-muted-foreground">
          The collector does not capture this network right now (its own capture settings leave it out, or the
          network is down).
        </p>
      ) : null}
      {network.captureChangedAt ? (
        <p className="text-[11px] text-muted-foreground">Last changed {formatLastSeen(network.captureChangedAt)}.</p>
      ) : null}
      {!isAdmin ? <p className="text-[11px] text-muted-foreground">Only admins can change this.</p> : null}
      {setCapture.error ? <p className="text-xs text-destructive">{networkErrorMessage(setCapture.error)}</p> : null}
      <div className="flex items-start gap-2.5 rounded-md border border-border bg-muted/20 p-2.5 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1.5">
          <p>
            Off tells the collector on the router to skip the network, and the controller drops whatever it still
            sends, so no device, destination or protocol history is kept for it from then on. What was recorded before
            stays until retention removes it. The network’s own traffic totals (the router’s interface counters) are
            kept either way.
          </p>
          <p>
            On a guest network, keeping capture <strong>off</strong> is the privacy-preserving choice. If you keep it
            on, say so in the guest portal’s privacy notice: guests’ traffic records are personal data (Data Privacy
            Act, RA 10173).
          </p>
        </div>
      </div>
    </div>
  )
}
