import { DoorOpen, Network, Tag } from '@phosphor-icons/react'
import { ToneBadge } from '@/components/gateway-config/bits'
import { bindingText } from '@/lib/wifi-config'
import type { WifiNetwork } from '@/types/wifi-config'

/** Where a network's clients land: `LAN`, `VLAN 30 · Guest` (+ the portal), `AP network`. */
export function BindingChip({ binding }: { binding: WifiNetwork['binding'] }) {
  const Icon = binding.kind === 'vlan' ? Tag : Network
  return (
    <span className="inline-flex items-center gap-1">
      <ToneBadge tone={binding.kind === 'vlan' ? 'info' : 'neutral'}>
        <Icon aria-hidden className="size-3" />
        {bindingText(binding)}
      </ToneBadge>
      {binding.portal ? (
        <ToneBadge tone="info" title="Clients sign in through this guest portal">
          <DoorOpen aria-hidden className="size-3" />
          {binding.portal.name}
        </ToneBadge>
      ) : null}
    </span>
  )
}
