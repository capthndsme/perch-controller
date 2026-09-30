import { Info, Warning, WarningOctagon } from '@phosphor-icons/react'
import { SEVERITY_LABEL, SEVERITY_TONE } from '@/lib/alerts'
import { cn } from '@/lib/utils'
import type { Severity } from '@/types/alerts'

const ICON = { critical: WarningOctagon, warning: Warning, info: Info } as const

/** One glyph per severity in its status colour; `quiet` (resolved, blips) draws it muted. */
export function SeverityIcon({
  severity,
  quiet = false,
  className,
}: {
  severity: Severity
  quiet?: boolean
  className?: string
}) {
  const Icon = ICON[severity]
  return (
    <Icon
      weight="fill"
      role="img"
      aria-label={SEVERITY_LABEL[severity]}
      className={cn('size-5 shrink-0', quiet ? 'text-muted-foreground/70' : SEVERITY_TONE[severity].icon, className)}
    />
  )
}
