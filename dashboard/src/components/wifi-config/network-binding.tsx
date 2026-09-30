import { useId } from 'react'
import { Link } from 'react-router-dom'
import { DoorOpen, Warning } from '@phosphor-icons/react'
import { ToneBadge } from '@/components/gateway-config/bits'
import { Input } from '@/components/ui/input'
import { ChoiceCard, OverrideMarker, SettingRow, SettingsGroup } from '@/components/wifi-config/rows'
import { useAllNetworks } from '@/hooks/use-networks'
import { cn } from '@/lib/utils'
import type { NetworkSummary } from '@/types/networks'
import type { WifiBinding, WifiNetworkAp } from '@/types/wifi-config'

/**
 * The Network group (dashboard.md 1.2 item 3): where the network's clients
 * land. Main LAN = each access point's own network, untagged; VLAN = one of
 * the gateway's networks by its VLAN id (or a raw id, warned); AP network =
 * a per-AP network name kept from an import.
 */
export function BindingSection({
  value,
  onChange,
  onPickNetwork,
  aps,
  disabled,
}: {
  value: WifiBinding
  onChange: (binding: WifiBinding) => void
  /** A gateway network was picked (guest-purpose networks pre-tick client isolation). */
  onPickNetwork?: (network: NetworkSummary) => void
  /** The network's per-AP rows (for the AP network names). */
  aps: WifiNetworkAp[]
  disabled: boolean
}) {
  const gatewayNetworks = useAllNetworks({ enabled: value.kind === 'vlan' })
  const vlans = (gatewayNetworks.data ?? []).filter((n) => n.vlanId !== null)
  const rawId = useId()
  const vlanId = value.kind === 'vlan' ? value.vlanId : null
  const known = vlanId !== null && vlans.some((n) => n.vlanId === vlanId)
  const apNetworks = aps.filter((ap) => ap.overrides.apNetwork)

  return (
    <SettingsGroup title="Network" id="network">
      <SettingRow label="Clients join" stack>
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Clients join">
          <ChoiceCard
            selected={value.kind === 'lan'}
            onSelect={() => onChange({ kind: 'lan' })}
            disabled={disabled}
            title="Main LAN"
            hint="Each access point’s own network, untagged."
          />
          <ChoiceCard
            selected={value.kind === 'vlan'}
            onSelect={() =>
              onChange({ kind: 'vlan', vlanId: vlans[0]?.vlanId ?? 10, gatewayId: vlans[0]?.gatewayId ?? null, networkPerchId: null })
            }
            disabled={disabled}
            title="VLAN"
            hint="One of the gateway’s networks, tagged on the access points’ uplink."
          />
          {value.kind === 'ap_network' ? (
            <ChoiceCard
              selected
              onSelect={() => undefined}
              disabled={disabled}
              title="AP network"
              hint="A network name per access point, kept as imported."
            />
          ) : null}
        </div>
      </SettingRow>

      {value.kind === 'vlan' ? (
        <SettingRow
          label="Gateway network"
          description="Networks with a VLAN on the managed gateway. Create a new one under Gateway → Networks first."
          stack
        >
          {gatewayNetworks.isPending ? (
            <p className="text-xs text-muted-foreground">Loading the gateway’s networks…</p>
          ) : vlans.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              The gateway has no VLAN networks yet.{' '}
              <Link to="/networks" className="underline underline-offset-2">
                Gateway networks
              </Link>
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Gateway network">
              {vlans.map((n) => (
                <li key={`${n.gatewayId}-${n.id}`}>
                  <ChoiceCard
                    selected={vlanId === n.vlanId}
                    disabled={disabled}
                    onSelect={() => {
                      onChange({ kind: 'vlan', vlanId: n.vlanId!, gatewayId: n.gatewayId, networkPerchId: null })
                      onPickNetwork?.(n)
                    }}
                    title={
                      <span className="flex items-center gap-2">
                        {n.label}
                        <span className="font-mono text-[11px] font-normal text-muted-foreground">VLAN {n.vlanId}</span>
                      </span>
                    }
                    badge={
                      n.purpose === 'guest' ? (
                        <ToneBadge tone="info">
                          <DoorOpen aria-hidden className="size-3" />
                          Guest
                        </ToneBadge>
                      ) : n.purpose !== 'lan' && n.purpose !== 'custom' ? (
                        <ToneBadge tone="neutral">{n.purpose}</ToneBadge>
                      ) : null
                    }
                    hint={n.ipv4 ?? undefined}
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex items-center gap-2">
            <label htmlFor={rawId} className="text-xs text-muted-foreground">
              Or a VLAN id
            </label>
            <Input
              id={rawId}
              inputMode="numeric"
              className="h-9 w-24 font-mono"
              disabled={disabled}
              value={vlanId ?? ''}
              onChange={(event) => {
                const id = Number(event.target.value.replace(/\D/g, ''))
                onChange({ kind: 'vlan', vlanId: id, gatewayId: null, networkPerchId: null })
              }}
            />
          </div>
          {vlanId !== null && !known && !gatewayNetworks.isPending ? (
            <p className={cn('mt-2 flex items-start gap-1.5 text-xs', vlanId < 1 || vlanId > 4094 ? 'text-destructive' : '')}>
              <Warning weight="fill" className="mt-px size-3.5 shrink-0 text-status-warning" />
              {vlanId < 1 || vlanId > 4094
                ? 'A VLAN id is 1–4094.'
                : `The gateway has no network on VLAN ${vlanId}: clients get no address until it does.`}
            </p>
          ) : null}
        </SettingRow>
      ) : null}

      {value.kind === 'ap_network' ? (
        <SettingRow label="Per access point" description="Change these in each access point’s settings below." stack>
          <ul className="space-y-1">
            {apNetworks.map((ap) => (
              <li key={ap.apId} className="flex items-center justify-between gap-2 text-xs">
                <span>{ap.apName}</span>
                <OverrideMarker>{ap.overrides.apNetwork}</OverrideMarker>
              </li>
            ))}
            {apNetworks.length === 0 ? <li className="text-xs text-muted-foreground">No access point names one.</li> : null}
          </ul>
        </SettingRow>
      ) : null}
    </SettingsGroup>
  )
}
