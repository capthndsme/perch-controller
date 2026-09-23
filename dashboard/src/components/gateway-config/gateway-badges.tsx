import { Crown, LockKey, LockOpen, WifiHigh, WifiSlash } from '@phosphor-icons/react'
import { ToneBadge } from '@/components/gateway-config/bits'
import { MODE_META, SYNC_META } from '@/lib/gateway-config'
import type { Gateway } from '@/types/gateway-config'

/** Online, mode, sync state, Authoritative and transport, as one row of badges. */
export function GatewayBadges({ gateway }: { gateway: Gateway }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {gateway.detached ? (
        <ToneBadge tone="neutral">Detached</ToneBadge>
      ) : gateway.online ? (
        <ToneBadge tone="good">
          <WifiHigh className="size-3" weight="bold" />
          Online
        </ToneBadge>
      ) : (
        <ToneBadge tone="critical">
          <WifiSlash className="size-3" weight="bold" />
          Offline
        </ToneBadge>
      )}
      <ToneBadge tone={MODE_META[gateway.mode].tone} title={MODE_META[gateway.mode].hint}>
        {MODE_META[gateway.mode].label}
      </ToneBadge>
      {gateway.mode !== 'off' ? (
        <ToneBadge tone={SYNC_META[gateway.syncState].tone} dot>
          {SYNC_META[gateway.syncState].label}
        </ToneBadge>
      ) : null}
      {gateway.authoritative ? (
        <ToneBadge tone={gateway.enforcement === 'suspended' ? 'critical' : 'warning'} title="Authoritative Mode">
          <Crown className="size-3" weight="fill" />
          Authoritative{gateway.enforcement === 'suspended' ? ' (suspended)' : ''}
        </ToneBadge>
      ) : null}
      {gateway.online ? (
        gateway.secure === true ? (
          <ToneBadge tone="neutral" title="Verified TLS">
            <LockKey className="size-3" />
            TLS
          </ToneBadge>
        ) : (
          <ToneBadge tone="neutral" title="Plain HTTP">
            <LockOpen className="size-3" />
            {gateway.pairing?.state === 'paired' ? 'Plain HTTP, paired' : 'Plain HTTP'}
          </ToneBadge>
        )
      ) : null}
    </div>
  )
}
