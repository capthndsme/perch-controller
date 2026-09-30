import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CellTower } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { PageSpinner } from '@/components/ui/spinner'
import { CountryBar } from '@/components/wifi-config/country-bar'
import { RadioApCard } from '@/components/wifi-config/radio-card'
import { RadioEditorSheet } from '@/components/wifi-config/radio-editor'
import { useProfile } from '@/hooks/use-auth'
import { useRetained } from '@/hooks/use-retained'
import { useWifiConfig, useWifiConfigSettings, useWifiRadios } from '@/hooks/use-wifi-config'
import { ApiError } from '@/lib/api'
import { wifiRefusalMessage } from '@/lib/wifi-config'
import type { WifiRadio } from '@/types/wifi-config'

/** `/wifi/radios`: every access point's radios and its country. */
export function WifiRadiosPage() {
  const config = useWifiConfig()
  const radios = useWifiRadios()
  const isAdmin = useProfile().data?.role === 'admin'
  const settings = useWifiConfigSettings({ enabled: isAdmin })
  const [editing, setEditing] = useState<{ radio: WifiRadio; key: number } | null>(null)
  const shown = useRetained(editing)
  const [notice, setNotice] = useState<string | null>(null)

  if (config.isPending || radios.isPending) return <PageSpinner label="Loading radios" />

  const header = (
    <PageHeader
      title="Radios"
      description="Channels, widths and transmit power per access point. A radio change applies to that access point alone."
    />
  )
  const failure = config.error ?? radios.error
  if (failure || !config.data) {
    const missing = failure instanceof ApiError && failure.status === 404
    return (
      <div className="flex flex-col gap-5">
        {header}
        {missing ? (
          <EmptyState icon={<CellTower className="size-6" />} title="WiFi management is not available" description="Update Perch to manage radios from here." />
        ) : (
          <p className="text-sm text-destructive">{wifiRefusalMessage(failure)}</p>
        )}
      </div>
    )
  }

  const aps = config.data.aps.filter((ap) => ap.mode !== 'off')
  const allRadios = radios.data ?? []
  const clientsByRadio = new Map<string, number>()
  for (const network of config.data.networks) {
    for (const ap of network.aps) {
      for (const slot of ap.slots) {
        if (slot.clients === null) continue
        const key = `${ap.apId}:${slot.radio}`
        clientsByRadio.set(key, (clientsByRadio.get(key) ?? 0) + slot.clients)
      }
    }
  }
  const editAp = shown ? config.data.aps.find((ap) => ap.apId === shown.radio.apId) : undefined

  return (
    <div className="flex flex-col gap-5">
      {header}
      {notice ? (
        <p role="status" className="rounded-md border border-status-good/40 bg-status-good/10 px-3 py-2 text-xs">
          {notice}
        </p>
      ) : null}
      {aps.length === 0 ? (
        <EmptyState
          icon={<CellTower className="size-6" />}
          title="Perch is not reading any access point yet"
          description={
            <>
              Turn on Observe for your access points under{' '}
              <Link to="/wifi/sync" className="underline underline-offset-2">
                Sync
              </Link>{' '}
              to see their radios here.
            </>
          }
        />
      ) : (
        <>
          <CountryBar
            aps={aps}
            radios={allRadios}
            fleetDefault={settings.data ? settings.data.settings.countryDefault : undefined}
            isAdmin={isAdmin}
          />
          <div className="grid gap-4 xl:grid-cols-2">
            {aps.map((ap) => (
              <RadioApCard
                key={ap.apId}
                ap={ap}
                radios={allRadios.filter((r) => r.apId === ap.apId)}
                clientsByRadio={clientsByRadio}
                onEdit={(radio) => setEditing({ radio, key: Date.now() })}
              />
            ))}
          </div>
        </>
      )}
      {shown && editAp ? (
        <RadioEditorSheet
          key={shown.key}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          radio={shown.radio}
          apName={editAp.name}
          managed={editAp.mode === 'managed'}
          clients={clientsByRadio.get(`${editAp.apId}:${shown.radio.section}`) ?? null}
          isAdmin={isAdmin}
          onDone={(result, applied) =>
            setNotice(
              result.rolloutError
                ? `Saved as a draft: ${result.rolloutError.message}`
                : applied
                  ? `Applying to ${editAp.name}. Follow it in the banner.`
                  : `Saved as a draft for ${editAp.name}. Nothing changed on the access point yet.`,
            )
          }
        />
      ) : null}
    </div>
  )
}
