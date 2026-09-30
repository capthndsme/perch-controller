import { useEffect, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { ArrowsClockwise, MagnifyingGlass, X } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { PageSpinner } from '@/components/ui/spinner'
import { AdoptionWizard } from '@/components/wifi-config/adoption-wizard'
import { ApModeCard } from '@/components/wifi-config/ap-mode-card'
import { DivergenceList } from '@/components/wifi-config/divergence-list'
import { Callout } from '@/components/wifi-config/rows'
import { RolloutHistory } from '@/components/wifi-config/rollout-history'
import { useProfile } from '@/hooks/use-auth'
import { useDivergences, useWifiConfig } from '@/hooks/use-wifi-config'
import { ApiError } from '@/lib/api'
import { plural, wifiRefusalMessage } from '@/lib/wifi-config'
import type { ResolveDivergencesResult } from '@/types/wifi-config'

function resolvedText(result: ResolveDivergencesResult): string {
  if (result.rolloutError) return `Resolved. Saved as a draft: ${result.rolloutError.message}`
  if (result.rollout) return `Resolved. Rolling out to ${plural(result.rollout.steps.length, 'access point')}.`
  return 'Resolved.'
}

/**
 * `/wifi/sync` (dashboard.md 1.4): each access point's mode and write state,
 * the changes made on the access points (divergences), adoption, and the
 * rollouts history. `?adopt=1` opens the adoption wizard; `?network=N`
 * narrows the divergences to one network.
 */
export function WifiSyncPage() {
  const config = useWifiConfig()
  const isAdmin = useProfile().data?.role === 'admin'
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const networkFilter = Number(params.get('network')) || undefined
  const divergences = useDivergences({ open: true, networkId: networkFilter })
  const [notice, setNotice] = useState<string | null>(null)
  const adoptOpen = params.get('adopt') === '1'
  const [adoptKey, setAdoptKey] = useState(0)

  // `#divergences` from the networks list: scroll there once the list is in.
  const ready = !config.isPending && !divergences.isPending
  useEffect(() => {
    if (!ready || !location.hash) return
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [ready, location.hash])

  if (config.isPending) return <PageSpinner label="Loading WiFi sync" />

  const setAdopt = (open: boolean) => {
    if (open && !adoptOpen) setAdoptKey((k) => k + 1)
    const next = new URLSearchParams(params)
    if (open) next.set('adopt', '1')
    else next.delete('adopt')
    setParams(next, { replace: true })
  }

  const header = (
    <PageHeader
      title="Sync"
      description="How Perch reads and writes each access point’s WiFi, and what changed on the access points themselves."
      actions={
        isAdmin && config.data ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setAdopt(true)}>
              <MagnifyingGlass />
              Adopt networks
            </Button>
            <Button asChild size="sm" variant="ghost">
              <Link to="/settings/wifi-config">Settings</Link>
            </Button>
          </>
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
          <EmptyState icon={<ArrowsClockwise className="size-6" />} title="WiFi management is not available" description="Update Perch to manage access points’ WiFi." />
        ) : (
          <p className="text-sm text-destructive">{wifiRefusalMessage(config.error)}</p>
        )}
      </div>
    )
  }

  const { aps, adoptionPending, networks } = config.data
  const list = divergences.data ?? []
  const filteredName = networkFilter ? networks.find((n) => n.id === networkFilter)?.name : null

  return (
    <div className="flex flex-col gap-5">
      {header}

      {notice ? (
        <p role="status" className="rounded-md border border-status-good/40 bg-status-good/10 px-3 py-2 text-xs">
          {notice}
        </p>
      ) : null}

      {adoptionPending > 0 || (networks.length === 0 && aps.length > 0) ? (
        <Callout
          tone="info"
          icon={<MagnifyingGlass weight="bold" className="size-4 text-primary" />}
          title={
            adoptionPending > 0
              ? `Perch found ${plural(adoptionPending, 'WiFi network')} on your access points`
              : 'Start by letting Perch read your access points'
          }
          action={
            isAdmin ? (
              <Button size="sm" onClick={() => setAdopt(true)}>
                Review
              </Button>
            ) : null
          }
        >
          Adopt them as they are: nothing on the access points changes until you switch one to Managed.
        </Callout>
      ) : null}

      <div id="divergences" className="scroll-mt-24">
        <Panel
          title="Changed on the access points"
          description="Edits made in LuCI or uci on one access point that differ from the network. The access point keeps its value until you decide."
          updating={divergences.isPlaceholderData}
          actions={
            filteredName ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  const next = new URLSearchParams(params)
                  next.delete('network')
                  setParams(next, { replace: true })
                }}
              >
                {filteredName}
                <X />
              </Button>
            ) : null
          }
        >
          {divergences.isPending ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (
            <DivergenceList divergences={list} isAdmin={isAdmin} onResolved={(r) => setNotice(resolvedText(r))} />
          )}
        </Panel>
      </div>

      <section className="space-y-2">
        <h2 className="section-label px-1">Access points</h2>
        {aps.length === 0 ? (
          <EmptyState
            title="No access point with a Perch agent"
            description={
              <>
                Install perch-apd on your OpenWrt access points under{' '}
                <Link to="/settings/wifi-sources" className="underline underline-offset-2">
                  Settings → WiFi sources
                </Link>
                .
              </>
            }
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {aps.map((ap) => (
              <ApModeCard key={ap.apId} ap={ap} isAdmin={isAdmin} />
            ))}
          </div>
        )}
      </section>

      <RolloutHistory isAdmin={isAdmin} />

      <AdoptionWizard key={adoptKey} open={adoptOpen} onOpenChange={setAdopt} aps={aps} isAdmin={isAdmin} />
    </div>
  )
}
