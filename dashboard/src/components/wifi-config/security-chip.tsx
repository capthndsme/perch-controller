import { Lock, LockOpen } from '@phosphor-icons/react'
import { ToneBadge } from '@/components/gateway-config/bits'
import { SECURITY_META } from '@/lib/wifi-config'
import type { WifiSecurity } from '@/types/wifi-config'

/** `WPA2`, `WPA2/WPA3`, `WPA3`, `OWE`, or `Open` in amber. */
export function SecurityChip({ security }: { security: WifiSecurity }) {
  const meta = SECURITY_META[security]
  const open = security === 'open'
  return (
    <ToneBadge tone={meta.tone} title={meta.hint}>
      {open ? <LockOpen aria-hidden className="size-3" /> : <Lock aria-hidden className="size-3" />}
      {meta.label}
    </ToneBadge>
  )
}
