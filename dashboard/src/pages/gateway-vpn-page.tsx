import { LockKey } from '@phosphor-icons/react'
import { NativePage } from '@/components/gateway-native/native-ui'
import { EmptyState } from '@/components/ui/empty-state'

/**
 * `/gateway/vpn`: WireGuard interfaces and peers (design gateway-sync
 * dashboard.md 4). Placeholder of work package D0; D2 owns this file and
 * replaces it.
 */
export function GatewayVpnPage() {
  return (
    <NativePage title="VPN" description="WireGuard servers, client links and peers">
      {() => (
        <EmptyState
          icon={<LockKey className="size-6" />}
          title="Coming soon"
          description="Perch will manage WireGuard on the router here. Its private keys are made on the router and never leave it."
          className="py-14"
        />
      )}
    </NativePage>
  )
}
