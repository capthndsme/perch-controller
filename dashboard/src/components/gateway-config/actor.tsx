import type { ReactNode } from 'react'
import { Robot } from '@phosphor-icons/react'
import { SYSTEM_VIA_META } from '@/lib/gateway-config'
import { cn } from '@/lib/utils'
import type { ActorRef } from '@/types/gateway-config'

/**
 * Who made a change (revisions, applies, events): a user's email, or Perch
 * itself (`{ system: true, name: 'Perch (system)', via }` from the API,
 * config-plane.md 6.8), shown as "Perch (system)" with a small badge naming
 * the part of Perch that wrote it. `fallback` when nobody is named.
 */
export function ActorName({
  actor,
  fallback = null,
  className,
}: {
  actor: ActorRef | undefined
  fallback?: ReactNode
  className?: string
}) {
  if (!actor) return fallback === null ? null : <span className={className}>{fallback}</span>
  if (!actor.system) return <span className={cn('break-all', className)}>{actor.email}</span>
  const via = SYSTEM_VIA_META[actor.via] ?? { label: actor.via, hint: 'Written by Perch itself.' }
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', className)} title={via.hint}>
      <Robot aria-hidden className="size-3.5 shrink-0" />
      <span>{actor.name || 'Perch (system)'}</span>
      <span className="inline-flex h-4 items-center rounded-sm border border-primary/30 bg-primary/5 px-1 text-[10px] font-medium text-foreground">
        {via.label}
      </span>
    </span>
  )
}
