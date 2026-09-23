import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAllNetworks, useDeviceNetworks } from '@/hooks/use-networks'
import { formatLastSeen } from '@/lib/collectors'
import type { NetworkSummary } from '@/types/networks'

function formatWhen(value: string): string {
  const ts = Date.parse(value)
  if (Number.isNaN(ts)) return value
  return new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' }).format(ts)
}

/**
 * The device page's "Network" line (docs/gateway/networks.md section 4.3):
 * the capture network the device was last an endpoint on, linked to the
 * network's page, and the earlier networks on demand. Renders nothing on a
 * controller without networks or for a device no gateway has placed.
 */
export function DeviceNetworkRow({ mac }: { mac: string | undefined }) {
  const networks = useDeviceNetworks(mac)
  const summaries = useAllNetworks({ enabled: Boolean(networks.data?.latest) })
  const [open, setOpen] = useState(false)
  const latest = networks.data?.latest ?? null
  if (!latest) return null

  const find = (gatewayId: number, key: string): NetworkSummary | undefined =>
    summaries.data?.find((n) => n.gatewayId === gatewayId && n.key === key)
  const current = find(latest.gatewayId, latest.network)
  const earlier = (networks.data?.history ?? []).filter((h) => h.endedAt !== null)

  return (
    <div className="py-1.5 text-[12.5px]">
      <div className="flex items-start justify-between gap-3">
        <span className="shrink-0 text-muted-foreground">Network</span>
        <span className="min-w-0 text-right">
          {current ? (
            <Link to={`/networks/${latest.gatewayId}/${current.id}`} className="font-medium hover:underline">
              {current.label || latest.network}
            </Link>
          ) : (
            <span className="font-medium">{latest.network}</span>
          )}
          {current?.vlanId ? <span className="text-muted-foreground"> · VLAN {current.vlanId}</span> : null}
          <span className="block text-[11px] text-muted-foreground">since {formatLastSeen(latest.seenAt)}</span>
          {earlier.length > 0 ? (
            <button
              type="button"
              className="text-[11px] text-primary underline-offset-2 hover:underline"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {open ? 'Hide earlier networks' : `Earlier networks (${earlier.length})`}
            </button>
          ) : null}
        </span>
      </div>
      {open ? (
        <ul className="mt-1.5 space-y-1 rounded-md border border-border/70 bg-muted/20 px-2.5 py-1.5 text-[11px]">
          {earlier.map((h) => {
            const n = find(h.gatewayId, h.network)
            return (
              <li key={`${h.gatewayId}-${h.network}-${h.startedAt}`} className="flex justify-between gap-3">
                <span className="font-medium">{n?.label || h.network}</span>
                <span className="text-right text-muted-foreground">
                  {formatWhen(h.startedAt)} – {formatWhen(h.endedAt!)}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
