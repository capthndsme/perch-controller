import { SlidersHorizontal } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/ui/empty-state'

/**
 * `/settings/gateway-sync`: router check targets and timeouts, the WAN
 * confirm window, Authoritative Mode for WAN edits, WireGuard staleness,
 * UPnP events and multi-WAN writes (design gateway-sync rest.md 11,
 * dashboard.md 8). Placeholder of work package D0; D5 owns this file and
 * replaces it.
 */
export function GatewaySyncSettingsPage() {
  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <PageHeader
        title="Gateway sync"
        description="How the router verifies internet changes, and the limits of WAN, VPN and UPnP management."
        crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Gateway sync' }]}
      />
      <EmptyState
        icon={<SlidersHorizontal className="size-6" />}
        title="Coming soon"
        description="The defaults apply until this page arrives: checks against the WAN gateway, 1.1.1.1 and 8.8.8.8, a 5-minute confirm window for internet changes."
        className="py-14"
      />
    </div>
  )
}
