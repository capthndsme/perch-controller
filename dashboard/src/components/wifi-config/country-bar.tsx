import { useId } from 'react'
import { Link } from 'react-router-dom'
import { Warning } from '@phosphor-icons/react'
import { ErrorLine, ToneBadge } from '@/components/gateway-config/bits'
import { Spinner } from '@/components/ui/spinner'
import { SettingsGroup } from '@/components/wifi-config/rows'
import { useUpdateApConfig } from '@/hooks/use-wifi-config'
import { countryName, countryOptions, wifiRefusalMessage } from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type { ApConfig, CountryPolicy, WifiRadio } from '@/types/wifi-config'

const SELECT =
  'h-9 min-w-0 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30'

function CountryRow({
  ap,
  radios,
  fleetDefault,
  isAdmin,
}: {
  ap: ApConfig
  radios: WifiRadio[]
  fleetDefault: string | null | undefined
  isAdmin: boolean
}) {
  const update = useUpdateApConfig(ap.apId)
  const policyId = useId()
  const codeId = useId()
  const values = [...new Set(radios.filter((r) => r.present).map((r) => r.country ?? '—'))]
  const mixed = values.length > 1 || (ap.country.effective !== null && values.some((v) => v !== ap.country.effective))
  const target =
    ap.country.mode === 'fleet' ? (fleetDefault ?? null) : ap.country.mode === 'fixed' ? ap.country.effective : null
  const locked = !isAdmin || !ap.country.settable || update.isPending
  const pending = update.isPending ? (update.variables?.country ?? null) : null
  const mode = pending?.mode ?? ap.country.mode

  function change(policy: CountryPolicy) {
    update.mutate({ country: policy })
  }

  return (
    <div className="space-y-2 px-4 py-3" data-testid="country-row">
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-label={ap.online ? 'Online' : 'Offline'}
          className={cn('size-1.5 rounded-full', ap.online ? 'bg-status-good' : 'bg-muted-foreground/50')}
        />
        <span className="text-[13px] font-medium">{ap.name}</span>
        <span className="flex flex-wrap gap-1">
          {values.map((v) => (
            <ToneBadge key={v} tone="neutral" title={v === '—' ? 'Not set on a radio' : countryName(v)}>
              <span className="font-mono">{v}</span>
            </ToneBadge>
          ))}
        </span>
        {mixed ? (
          <ToneBadge tone="warning">
            <Warning aria-hidden weight="fill" className="size-3 text-status-warning" />
            Radios disagree
          </ToneBadge>
        ) : null}
        {update.isPending ? <Spinner className="size-3.5" /> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={policyId} className="sr-only">
          Country policy for {ap.name}
        </label>
        <select
          id={policyId}
          className={cn(SELECT, 'flex-1 sm:flex-none')}
          value={mode}
          disabled={locked}
          onChange={(event) => {
            const next = event.target.value as CountryPolicy['mode']
            if (next === 'fixed') change({ mode: 'fixed', code: ap.country.effective ?? fleetDefault ?? 'US' })
            else change({ mode: next })
          }}
        >
          <option value="fleet">Fleet default{fleetDefault ? ` (${fleetDefault})` : fleetDefault === null ? ' (not set)' : ''}</option>
          <option value="fixed">This country</option>
          <option value="router">Leave to the access point</option>
        </select>
        {mode === 'fixed' ? (
          <>
            <label htmlFor={codeId} className="sr-only">
              Country for {ap.name}
            </label>
            <select
              id={codeId}
              className={cn(SELECT, 'w-full sm:w-56')}
              value={pending?.code ?? ap.country.effective ?? ''}
              disabled={locked}
              onChange={(event) => change({ mode: 'fixed', code: event.target.value })}
            >
              {countryOptions().map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {!ap.country.settable
          ? 'This access point cannot set its country (it runs in a container): left as it is.'
          : ap.country.selfManaged
            ? 'Its radio firmware sets the regulatory rules itself; the country is written but the firmware has the last word.'
            : mode === 'router'
              ? 'Perch leaves the country alone on this access point.'
              : target
                ? `Every radio runs as ${countryName(target)}${mixed ? ' after the next rollout to it' : ''}.`
                : 'No fleet default yet: each radio keeps what it has.'}
      </p>
      <ErrorLine message={update.error ? wifiRefusalMessage(update.error) : null} />
    </div>
  )
}

/**
 * The country bar of the Radios page (dashboard.md 1.3, decision D10): one
 * country per access point, written to every present radio; the fleet
 * default from settings; the US/TW/PH mix shown as it is until the admin
 * picks. Containers and self-managed radios say why they are different.
 */
export function CountryBar({
  aps,
  radios,
  fleetDefault,
  isAdmin,
}: {
  aps: ApConfig[]
  radios: WifiRadio[]
  /** Settings → Wi-Fi management `countryDefault`; undefined when this viewer cannot read settings. */
  fleetDefault: string | null | undefined
  isAdmin: boolean
}) {
  return (
    <SettingsGroup
      title="Country"
      description="One country per access point, written to every radio. It sets which channels and how much power are legal."
      actions={
        isAdmin ? (
          <Link to="/settings/wifi-config#country" className="text-xs font-medium text-primary underline-offset-2 hover:underline">
            Fleet default{fleetDefault ? `: ${fleetDefault}` : ''}
          </Link>
        ) : null
      }
    >
      {aps.map((ap) => (
        <CountryRow
          key={ap.apId}
          ap={ap}
          radios={radios.filter((r) => r.apId === ap.apId)}
          fleetDefault={fleetDefault}
          isAdmin={isAdmin && ap.mode !== 'off'}
        />
      ))}
    </SettingsGroup>
  )
}
