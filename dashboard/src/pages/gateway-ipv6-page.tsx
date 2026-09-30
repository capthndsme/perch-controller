import { Binary } from '@phosphor-icons/react'
import { NativePage } from '@/components/gateway-native/native-ui'
import { EmptyState } from '@/components/ui/empty-state'

/**
 * `/gateway/ipv6`: delegated prefixes, ULA, RA and DHCPv6 per LAN (design
 * gateway-sync dashboard.md 5). Placeholder of work package D0; D3 owns this
 * file and replaces it.
 */
export function GatewayIpv6Page() {
  return (
    <NativePage title="IPv6" description="Prefixes from your provider and IPv6 on your networks">
      {() => (
        <EmptyState
          icon={<Binary className="size-6" />}
          title="Coming soon"
          description="Perch will show the prefixes your provider delegates and manage IPv6 on each network here."
          className="py-14"
        />
      )}
    </NativePage>
  )
}
