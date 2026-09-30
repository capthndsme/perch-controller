import type { ReactNode } from 'react'
import { Warning } from '@phosphor-icons/react'
import { Segmented } from '@/components/ui/segmented'
import { ChoiceCard, SettingRow, SettingsGroup } from '@/components/wifi-config/rows'
import {
  apsLackingFeature,
  FEATURE_LABEL,
  isSecurityDowngrade,
  SECURITY_META,
  SELECTABLE_SECURITY,
} from '@/lib/wifi-config'
import type { HostapdFeature, PmfMode, WifiSecurity } from '@/types/wifi-config'

export type CarryingAp = { apId: number; name: string; features: Partial<Record<HostapdFeature, boolean>> | null }

function lackText(aps: Array<{ name: string }>, feature: HostapdFeature): string {
  const names = aps.map((ap) => ap.name)
  const who = names.length === 1 ? `${names[0]}’s` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}’s`
  return `${who} wpad has no ${FEATURE_LABEL[feature]}`
}

const PMF_OPTIONS: ReadonlyArray<{ id: PmfMode; label: string; title: string }> = [
  { id: 'default', label: 'Default', title: 'OpenWrt picks: required for WPA3, optional for WPA2/WPA3, off for WPA2' },
  { id: 'optional', label: 'Optional', title: 'Devices that can protect management frames do' },
  { id: 'required', label: 'Required', title: 'Only devices with PMF can join' },
  { id: 'disabled', label: 'Off', title: 'Not with WPA3' },
]

/**
 * The Security group (dashboard.md 1.2 item 2): the protocol as radio cards,
 * where a mode some carrying access point cannot run is disabled and says
 * which one lacks it; the passphrase rows (`children`); PMF.
 */
export function SecuritySection({
  value,
  initial,
  onChange,
  carrying,
  pmf,
  onPmfChange,
  disabled,
  children,
}: {
  value: WifiSecurity
  /** The saved mode (null for a new network): a weaker pick is flagged. */
  initial: WifiSecurity | null
  onChange: (security: WifiSecurity) => void
  carrying: CarryingAp[]
  pmf: PmfMode
  onPmfChange: (pmf: PmfMode) => void
  disabled: boolean
  children?: ReactNode
}) {
  const options: WifiSecurity[] = value === 'wpa_wpa2' ? ['wpa_wpa2', ...SELECTABLE_SECURITY] : [...SELECTABLE_SECURITY]
  const downgrade = initial !== null && initial !== value && isSecurityDowngrade(initial, value)

  return (
    <SettingsGroup title="Security" id="security">
      <SettingRow label="Security protocol" stack>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Security protocol">
          {options.map((security) => {
            const meta = SECURITY_META[security]
            const lacking = apsLackingFeature(meta.needs, carrying)
            const blocked = lacking.length > 0 && meta.needs !== null
            return (
              <ChoiceCard
                key={security}
                selected={value === security}
                onSelect={() => onChange(security)}
                disabled={disabled || (blocked && value !== security)}
                title={meta.label}
                hint={meta.hint}
                footnote={blocked ? lackText(lacking, meta.needs!) : undefined}
              />
            )
          })}
        </div>
        {downgrade ? (
          <p className="mt-2 flex items-start gap-1.5 text-xs font-medium">
            <Warning weight="fill" className="mt-px size-3.5 shrink-0 text-status-warning" />
            This lowers the network’s security from {SECURITY_META[initial].label} to {SECURITY_META[value].label}.
          </p>
        ) : null}
      </SettingRow>
      {children}
      {value !== 'open' ? (
        <SettingRow
          label="Protected management frames"
          description="Stops forged disconnects. Leave it on Default unless a device cannot join."
          stack
        >
          <Segmented
            size="xs"
            ariaLabel="Protected management frames"
            value={pmf}
            onChange={(next) => !disabled && onPmfChange(next)}
            options={PMF_OPTIONS}
            className="w-fit"
          />
          {pmf === 'disabled' && value === 'wpa3' ? (
            <p className="mt-1.5 text-xs text-destructive">WPA3 needs protected management frames.</p>
          ) : null}
        </SettingRow>
      ) : null}
    </SettingsGroup>
  )
}
