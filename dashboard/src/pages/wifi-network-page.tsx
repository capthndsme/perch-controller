import { useParams } from 'react-router-dom'
import { PageHeader } from '@/components/layout/page-header'
import { PageSpinner } from '@/components/ui/spinner'
import { NetworkEditor } from '@/components/wifi-config/network-editor'
import { useProfile } from '@/hooks/use-auth'
import { useWifiConfig, useWifiConfigSettings, useWifiNetwork, useWifiRadios } from '@/hooks/use-wifi-config'
import { ApiError } from '@/lib/api'
import { wifiRefusalMessage } from '@/lib/wifi-config'

/** `/wifi/networks/new` and `/wifi/networks/:id`: the network editor. */
export function WifiNetworkPage() {
  const params = useParams()
  const id = params.id ? Number(params.id) : null
  const valid = id === null || (Number.isInteger(id) && id > 0)
  const network = useWifiNetwork(valid ? id : null)
  const config = useWifiConfig()
  const radios = useWifiRadios()
  const profile = useProfile()
  const isAdmin = profile.data?.role === 'admin'
  const settings = useWifiConfigSettings({ enabled: isAdmin && id === null })

  const crumbs = [{ label: 'WiFi networks', to: '/wifi/networks' }, { label: 'Network' }]
  if (!valid) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Network" crumbs={crumbs} />
        <p className="text-sm text-destructive">No such network.</p>
      </div>
    )
  }
  const loading =
    (id !== null && network.isPending) ||
    config.isPending ||
    radios.isPending ||
    profile.isPending ||
    (isAdmin && id === null && settings.isPending)
  if (loading) return <PageSpinner label="Loading the network" />
  const failure = (id !== null ? network.error : null) ?? config.error
  if (failure) {
    const notFound = failure instanceof ApiError && failure.status === 404
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Network" crumbs={crumbs} />
        <p className="text-sm text-destructive">{notFound ? 'No such network.' : wifiRefusalMessage(failure)}</p>
      </div>
    )
  }

  return (
    <NetworkEditor
      key={id ?? 'new'}
      network={id !== null ? (network.data ?? null) : null}
      aps={config.data?.aps ?? []}
      radios={radios.data ?? []}
      rollout={config.data?.rollout ?? null}
      isAdmin={isAdmin}
      fastRoamingDefault={settings.data?.settings.newNetworkFastRoaming ?? false}
    />
  )
}
