import { Link } from 'react-router-dom'
import { Warning } from '@phosphor-icons/react'
import { StatusPill } from '@/components/wifi-config/rows'
import { BAND_LABEL, networkStatusText, sortBands } from '@/lib/wifi-config'
import type { Band, WifiNetwork, WifiRollout } from '@/types/wifi-config'

/** The network's status pill: "In sync", "Applying 1/3", "Changed on Porch AP", … */
export function NetworkStatusPill({ network, rollout }: { network: WifiNetwork; rollout: WifiRollout | null | undefined }) {
  const { label, tone } = networkStatusText(network, rollout)
  return <StatusPill tone={tone}>{label}</StatusPill>
}

/** Band chips in band order. */
export function BandChips({ bands }: { bands: readonly Band[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {sortBands(bands).map((band) => (
        <span
          key={band}
          className="inline-flex h-5 items-center rounded-sm border border-border px-1.5 font-mono text-[11px] text-muted-foreground"
        >
          {BAND_LABEL[band]}
        </span>
      ))}
    </span>
  )
}

/**
 * "Open network on your LAN" (decision D15): anyone nearby lands on the main
 * network. Links to the explanation on the network's page.
 */
export function OpenOnLanChip({ networkId }: { networkId?: number }) {
  const chip = (
    <span className="inline-flex h-5 items-center gap-1 rounded-sm border border-status-warning/60 bg-status-warning/15 px-1.5 text-[11px] font-medium text-foreground">
      <Warning aria-hidden weight="fill" className="size-3 text-status-warning" />
      Open network on your LAN
    </span>
  )
  if (networkId === undefined) return chip
  return (
    <Link to={`/wifi/networks/${networkId}#open-on-lan`} className="rounded-sm outline-offset-2">
      {chip}
    </Link>
  )
}
