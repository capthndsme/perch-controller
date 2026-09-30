import { GlobeHemisphereWest } from '@phosphor-icons/react'
import { NativePage } from '@/components/gateway-native/native-ui'
import { EmptyState } from '@/components/ui/empty-state'

/**
 * `/gateway/internet`: the WAN uplinks, failover order, DDNS and multi-WAN
 * (design gateway-sync dashboard.md 2). Placeholder of work package D0; D1
 * owns this file and replaces it.
 */
export function GatewayInternetPage() {
  return (
    <NativePage title="Internet" description="Uplinks, failover, dynamic DNS and multi-WAN">
      {() => (
        <EmptyState
          icon={<GlobeHemisphereWest className="size-6" />}
          title="Coming soon"
          description="Perch will manage the router’s internet connections here, with every change tested on the router before it is kept."
          className="py-14"
        />
      )}
    </NativePage>
  )
}
