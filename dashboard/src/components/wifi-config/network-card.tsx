import { Link, useNavigate } from 'react-router-dom'
import { CaretRight, EyeSlash, UsersThree, WifiSlash } from '@phosphor-icons/react'
import { BindingChip } from '@/components/wifi-config/binding-chip'
import { BandChips, NetworkStatusPill, OpenOnLanChip } from '@/components/wifi-config/network-status'
import { SecurityChip } from '@/components/wifi-config/security-chip'
import { isOpenOnLan } from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type { WifiNetwork, WifiRollout } from '@/types/wifi-config'

function ApsText({ network }: { network: WifiNetwork }) {
  return (
    <span className="tabular-nums">
      {network.counts.apsCarrying} / {network.counts.aps} APs
    </span>
  )
}

function ClientsText({ network }: { network: WifiNetwork }) {
  if (network.counts.clients === null) return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <UsersThree aria-hidden className="size-3.5 text-muted-foreground" />
      {network.counts.clients}
    </span>
  )
}

function NameBlock({ network }: { network: WifiNetwork }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 truncate text-[13px] font-semibold">
        {!network.enabled ? <WifiSlash aria-label="Off" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
        <span className="truncate">{network.name}</span>
        {network.hidden ? <EyeSlash aria-label="Hidden" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      </p>
      {network.ssid !== network.name ? (
        <p className="truncate font-mono text-[11px] text-muted-foreground">{network.ssid}</p>
      ) : null}
    </div>
  )
}

/**
 * One network as a card (below lg): name and SSID, status, chips for security,
 * binding and bands, "3 / 3 APs", clients. The whole card opens the editor.
 */
export function NetworkCard({ network, rollout }: { network: WifiNetwork; rollout: WifiRollout | null | undefined }) {
  return (
    <li>
      <Link
        to={`/wifi/networks/${network.id}`}
        className={cn(
          'card-surface flex flex-col gap-2.5 p-3.5 select-none [-webkit-touch-callout:none]',
          'transition-colors duration-base hover:bg-muted/30 active:bg-muted/60 active:duration-0',
          !network.enabled && 'opacity-75',
        )}
        data-testid="wifi-network-card"
      >
        <div className="flex items-start justify-between gap-3">
          <NameBlock network={network} />
          <span className="flex shrink-0 items-center gap-1">
            <NetworkStatusPill network={network} rollout={rollout} />
            <CaretRight aria-hidden className="size-3.5 text-muted-foreground" />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <SecurityChip security={network.security} />
          <BindingChip binding={network.binding} />
          <BandChips bands={network.bands} />
        </div>
        {isOpenOnLan(network) ? (
          <div>
            <OpenOnLanChip />
          </div>
        ) : null}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <ApsText network={network} />
          <ClientsText network={network} />
        </div>
      </Link>
    </li>
  )
}

/** The same list as a table from lg up (UniFi's WiFi list). */
export function NetworksTable({ networks, rollout }: { networks: WifiNetwork[]; rollout: WifiRollout | null | undefined }) {
  const navigate = useNavigate()
  return (
    <div className="card-surface overflow-hidden">
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Security</th>
            <th>Network</th>
            <th>Bands</th>
            <th className="text-right">APs</th>
            <th className="text-right">Clients</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {networks.map((network) => (
            <tr
              key={network.id}
              data-clickable="true"
              tabIndex={0}
              onClick={() => navigate(`/wifi/networks/${network.id}`)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  navigate(`/wifi/networks/${network.id}`)
                }
              }}
              className={cn(!network.enabled && 'opacity-70')}
              data-testid="wifi-network-row"
            >
              <td className="max-w-[280px]">
                <NameBlock network={network} />
                {isOpenOnLan(network) ? (
                  <div className="mt-1">
                    <OpenOnLanChip />
                  </div>
                ) : null}
              </td>
              <td>
                <SecurityChip security={network.security} />
              </td>
              <td>
                <BindingChip binding={network.binding} />
              </td>
              <td>
                <BandChips bands={network.bands} />
              </td>
              <td className="text-right">
                <ApsText network={network} />
              </td>
              <td className="text-right">
                <ClientsText network={network} />
              </td>
              <td>
                <NetworkStatusPill network={network} rollout={rollout} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
