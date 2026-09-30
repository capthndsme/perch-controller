import { ArrowRight, PushPin } from '@phosphor-icons/react'
import { Badge } from '@/components/ui/badge'
import { CHANNEL_LABEL } from '@/lib/agent-updates'
import { cn } from '@/lib/utils'
import type { AgentUpdateDevice, Channel } from '@/types/agent-updates'

const CHANNEL_CLASS: Record<Channel, string> = {
  stable: 'border-border text-muted-foreground',
  pre: 'border-status-warning/50 text-foreground',
  local: 'border-brand/40 text-brand',
}

export function ChannelBadge({ channel, className }: { channel: Channel; className?: string }) {
  return (
    <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', CHANNEL_CLASS[channel], className)}>
      {CHANNEL_LABEL[channel]}
    </Badge>
  )
}

/**
 * A device's version: the number, its channel, "held at" when pinned, and
 * "older than this controller" when below the version the controller installs.
 */
export function VersionBadge({ device, showChannel = true }: { device: AgentUpdateDevice; showChannel?: boolean }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      <span className="font-mono text-xs tabular-nums">{device.version ?? 'unknown'}</span>
      {showChannel && device.selfUpdate.supported ? <ChannelBadge channel={device.channel} /> : null}
      {device.pinnedVersion ? (
        <Badge variant="outline" className="h-4 px-1.5 text-[10px]" title={`Held at ${device.pinnedVersion}: no offers, rollouts skip it`}>
          <PushPin weight="fill" />
          Held
        </Badge>
      ) : null}
      {device.versionState === 'below_controller' ? (
        <Badge
          variant="outline"
          className="h-4 border-status-warning/50 px-1.5 text-[10px]"
          title="Older than the version this controller installs on new devices"
        >
          Older than this controller
        </Badge>
      ) : null}
    </span>
  )
}

/** `1.1.0-pre.4 → 1.1.0-pre.5`. */
export function VersionArrow({ from, to, className }: { from: string | null; to: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1 font-mono text-xs tabular-nums', className)}>
      <span className="truncate text-muted-foreground">{from ?? '?'}</span>
      <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{to}</span>
    </span>
  )
}
