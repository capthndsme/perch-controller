import { Link } from 'react-router-dom'
import { SeverityIcon } from '@/components/alerts/severity-icon'
import { alertStateChip, formatAgo, STATE_CHIP_CLASS, subjectText } from '@/lib/alerts'
import { cn } from '@/lib/utils'
import type { AlertView } from '@/types/alerts'

/** The small state chip: Active, Resolved, Flapping, Muted, Pending, Notice. */
export function AlertStateChip({ alert, className }: { alert: AlertView; className?: string }) {
  const chip = alertStateChip(alert)
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-medium whitespace-nowrap',
        STATE_CHIP_CLASS[chip.tone],
        className,
      )}
    >
      {chip.label}
    </span>
  )
}

/**
 * One alert in a list (inbox, bell): severity, title, subject, when, state; a dot in the leading gutter
 * while it is unread. The whole row is the link to the alert, tinted the moment a finger lands.
 */
export function AlertRow({
  alert,
  now,
  showBody = false,
  onNavigate,
  className,
}: {
  alert: AlertView
  now: number
  showBody?: boolean
  onNavigate?: () => void
  className?: string
}) {
  const quiet = alert.state === 'resolved' || alert.state === 'pending'
  const when = alert.state === 'resolved' ? alert.resolvedAt : (alert.openedAt ?? alert.lastEventAt)
  return (
    <Link
      to={`/alerts/${alert.id}`}
      onClick={onNavigate}
      className={cn(
        'relative flex items-start gap-3 px-4 py-3 select-none transition-colors duration-base hover:bg-muted/40 active:bg-muted/70 active:duration-0 [-webkit-touch-callout:none]',
        className,
      )}
    >
      {alert.unread ? (
        <span aria-label="Unread" role="img" className="absolute top-[1.1rem] left-1.5 size-2 rounded-full bg-brand" />
      ) : null}
      <SeverityIcon severity={alert.severity} quiet={quiet} className="mt-px" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-start justify-between gap-3">
          <p className={cn('line-clamp-2 text-[13.5px] leading-snug', alert.unread ? 'font-semibold' : 'font-medium')}>
            {alert.title}
          </p>
          <time dateTime={when ?? undefined} className="mt-px shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {formatAgo(when, now)}
          </time>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-xs text-muted-foreground">{subjectText(alert.subject)}</p>
          <AlertStateChip alert={alert} />
        </div>
        {showBody && alert.body ? (
          <p className="line-clamp-1 text-xs text-muted-foreground sm:line-clamp-2">{alert.body}</p>
        ) : null}
      </div>
    </Link>
  )
}
