import { formatFact, formatWhen, humanizeKey, outcomeLabel, SEVERITY_LABEL, SEVERITY_RANK } from '@/lib/alerts'
import { cn } from '@/lib/utils'
import type { AlertEventView } from '@/types/alerts'

/** Key facts of a payload as a definition list (the detail page's "What happened", a timeline entry). */
export function FactList({ data, className }: { data: Record<string, unknown>; className?: string }) {
  const entries = Object.entries(data).filter(([key]) => !key.startsWith('_'))
  if (entries.length === 0) return null
  return (
    <dl className={cn('divide-y divide-border/70', className)}>
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-start justify-between gap-4 py-1.5 text-xs">
          <dt className="shrink-0 text-muted-foreground">{humanizeKey(key)}</dt>
          <dd className="min-w-0 text-right break-words">{formatFact(key, value)}</dd>
        </div>
      ))}
    </dl>
  )
}

const DOT: Record<string, string> = {
  opened: 'bg-status-critical',
  reopened: 'bg-status-critical',
  escalated: 'bg-status-critical',
  posted: 'bg-brand',
  resolved: 'bg-status-good',
  blip: 'bg-status-good',
}

/** The alert's events, newest first, on a thread of dots. */
export function AlertTimeline({ events }: { events: AlertEventView[] }) {
  if (events.length === 0) return <p className="text-xs text-muted-foreground">No events recorded.</p>
  return (
    <ol className="relative space-y-3 before:absolute before:top-1.5 before:bottom-1.5 before:left-[3.5px] before:w-px before:bg-border">
      {events.map((event, index) => {
        const previous = events[index + 1]
        const rose = previous && SEVERITY_RANK[event.severity] > SEVERITY_RANK[previous.severity]
        return (
          <li key={event.id} className="relative pl-5">
            <span
              aria-hidden
              className={cn(
                'absolute top-1.5 left-0 size-2 rounded-full ring-2 ring-card',
                DOT[event.outcome] ?? 'bg-muted-foreground/50',
              )}
            />
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <p className="text-[13px] font-medium">
                {outcomeLabel(event.outcome)}
                {rose ? <span className="font-normal text-muted-foreground"> · now {SEVERITY_LABEL[event.severity].toLowerCase()}</span> : null}
              </p>
              <time dateTime={event.occurredAt} className="text-[11px] text-muted-foreground tabular-nums">
                {formatWhen(event.occurredAt)}
              </time>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {event.phase} · {event.source ?? 'perch'}
            </p>
            {event.data && Object.keys(event.data).length > 0 ? (
              <details className="mt-1 text-xs [&[open]>summary]:mb-1">
                <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">Facts</summary>
                <FactList data={event.data} className="rounded-md border border-border px-2.5" />
              </details>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
