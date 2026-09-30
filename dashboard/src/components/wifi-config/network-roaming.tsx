import { Info } from '@phosphor-icons/react'
import { Switch } from '@/components/ui/switch'
import type { CarryingAp } from '@/components/wifi-config/network-security'
import { SettingRow, SettingsGroup } from '@/components/wifi-config/rows'
import { apsLackingFeature } from '@/lib/wifi-config'
import type { Roaming } from '@/types/wifi-config'

/**
 * The Roaming group (dashboard.md 1.2 item 5, decision D9): 802.11r with its
 * mobility domain shown read-only, 802.11k and 802.11v. Band steering is not
 * Perch's yet, and it says so.
 */
export function RoamingSection({
  roaming,
  onChange,
  carrying,
  disabled,
}: {
  roaming: Roaming
  onChange: (roaming: Roaming) => void
  carrying: CarryingAp[]
  disabled: boolean
}) {
  const noFt = apsLackingFeature('11r', carrying)
  return (
    <SettingsGroup
      title="Roaming"
      id="roaming"
      description="Helps phones and laptops move between access points without dropping calls."
    >
      <SettingRow
        label="Fast roaming (802.11r)"
        description={
          <>
            Devices hand over to the next access point without a full reconnect. Some older smart-home devices refuse to join
            with it on.
            {roaming.ft ? (
              <span className="mt-1 block">
                Mobility domain{' '}
                <code className="rounded-sm bg-muted px-1 font-mono text-[11px] text-foreground">
                  {roaming.mobilityDomain ?? 'chosen when saved'}
                </code>
              </span>
            ) : null}
            {noFt.length > 0 ? (
              <span className="mt-1 block text-status-serious">
                Not on {noFt.map((ap) => ap.name).join(', ')}: its wpad has no 802.11r.
              </span>
            ) : null}
          </>
        }
        control={
          <Switch
            checked={roaming.ft}
            disabled={disabled}
            onCheckedChange={(ft) => onChange({ ...roaming, ft })}
            aria-label="Fast roaming (802.11r)"
          />
        }
      />
      <SettingRow
        label="Neighbour reports (802.11k)"
        description="Access points tell devices which others are nearby, so they pick the next one sooner."
        control={
          <Switch
            checked={roaming.rrm}
            disabled={disabled}
            onCheckedChange={(rrm) => onChange({ ...roaming, rrm })}
            aria-label="Neighbour reports (802.11k)"
          />
        }
      />
      <SettingRow
        label="BSS transition (802.11v)"
        description="Access points may suggest a better one to a device."
        control={
          <Switch
            checked={roaming.btm}
            disabled={disabled}
            onCheckedChange={(btm) => onChange({ ...roaming, btm })}
            aria-label="BSS transition (802.11v)"
          />
        }
      />
      <p className="flex items-start gap-1.5 px-4 py-2.5 text-[11px] text-muted-foreground">
        <Info aria-hidden className="mt-px size-3.5 shrink-0" />
        Band steering is not managed by Perch yet.
      </p>
    </SettingsGroup>
  )
}
