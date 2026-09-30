import { Link } from 'react-router-dom'
import { ArrowsSplit, MagnifyingGlass, Plus, WifiHigh } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageSpinner } from '@/components/ui/spinner'
import { NetworkCard, NetworksTable } from '@/components/wifi-config/network-card'
import { Callout } from '@/components/wifi-config/rows'
import { useProfile } from '@/hooks/use-auth'
import { useWifiConfig } from '@/hooks/use-wifi-config'
import { ApiError } from '@/lib/api'
import { plural, wifiRefusalMessage } from '@/lib/wifi-config'

/** `/wifi/networks`: every Wi-Fi network the access points broadcast, as Perch manages them. */
export function WifiNetworksPage() {
  const config = useWifiConfig()
  const isAdmin = useProfile().data?.role === 'admin'

  if (config.isPending) return <PageSpinner label="Loading WiFi networks" />

  const header = (
    <PageHeader
      title="WiFi networks"
      description="The networks your access points broadcast. A change rolls out to one access point at a time."
      actions={
        isAdmin && config.data ? (
          <Button asChild size="sm">
            <Link to="/wifi/networks/new">
              <Plus weight="bold" />
              New network
            </Link>
          </Button>
        ) : null
      }
    />
  )

  if (config.error || !config.data) {
    const missing = config.error instanceof ApiError && config.error.status === 404
    return (
      <div className="flex flex-col gap-5">
        {header}
        {missing ? (
          <EmptyState
            icon={<WifiHigh className="size-6" />}
            title="WiFi management is not available"
            description="This controller has no WiFi management yet. Update Perch to manage networks and radios from here."
          />
        ) : (
          <p className="text-sm text-destructive">{wifiRefusalMessage(config.error)}</p>
        )}
      </div>
    )
  }

  const { networks, aps, divergences, adoptionPending, rollout } = config.data
  const readingAps = aps.filter((ap) => ap.mode !== 'off')
  const sorted = [...networks].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))

  return (
    <div className="flex flex-col gap-5">
      {header}

      {adoptionPending > 0 ? (
        <Callout
          tone="info"
          icon={<MagnifyingGlass weight="bold" className="size-4 text-primary" />}
          title={`Perch found ${plural(adoptionPending, 'WiFi network')} on your access points`}
          action={
            <Button asChild size="sm">
              <Link to="/wifi/sync?adopt=1">Review</Link>
            </Button>
          }
        >
          Adopt them as they are: nothing on the access points changes.
        </Callout>
      ) : null}

      {divergences > 0 ? (
        <Callout
          tone="serious"
          icon={<ArrowsSplit weight="bold" className="size-4 text-status-serious" />}
          title={`${plural(divergences, 'change was', 'changes were')} made on the access points`}
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/wifi/sync#divergences">Review</Link>
            </Button>
          }
        >
          Someone edited a network in LuCI or uci on one access point. Decide whether it applies to all of them.
        </Callout>
      ) : null}

      {networks.length === 0 ? (
        readingAps.length === 0 ? (
          <EmptyState
            icon={<WifiHigh className="size-6" />}
            title="Perch is not reading any access point yet"
            description={
              <>
                Turn on Observe for your access points under{' '}
                <Link to="/wifi/sync" className="underline underline-offset-2">
                  Sync
                </Link>
                : Perch then finds the networks they broadcast and offers to adopt them, without changing anything.
              </>
            }
          />
        ) : (
          <EmptyState
            icon={<WifiHigh className="size-6" />}
            title="No networks yet"
            description={
              isAdmin
                ? 'Create one, or adopt what the access points already broadcast from Sync.'
                : 'An admin can create one, or adopt what the access points already broadcast.'
            }
          />
        )
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 lg:hidden">
            {sorted.map((network) => (
              <NetworkCard key={network.id} network={network} rollout={rollout} />
            ))}
          </ul>
          <div className="hidden lg:block">
            <NetworksTable networks={sorted} rollout={rollout} />
          </div>
        </>
      )}
    </div>
  )
}
