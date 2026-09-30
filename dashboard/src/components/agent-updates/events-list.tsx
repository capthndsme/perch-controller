import { Link } from 'react-router-dom'
import {
  ArrowCounterClockwise,
  CheckCircle,
  CloudArrowDown,
  GearSix,
  Info,
  Package,
  Pause,
  Play,
  RocketLaunch,
  WarningCircle,
  XCircle,
  type Icon,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelOverlay } from '@/components/ui/panel-overlay'
import { Spinner } from '@/components/ui/spinner'
import { useAgentUpdateEvents } from '@/hooks/use-agent-updates'
import { useNow } from '@/hooks/use-now'
import { actorText, eventTitle, formatAgo, formatDate, formatTime } from '@/lib/agent-updates'
import { cn } from '@/lib/utils'
import type { AgentUpdateEvent, EventsQuery } from '@/types/agent-updates'

function iconOf(event: AgentUpdateEvent): Icon {
  switch (event.event) {
    case 'agent_update.confirmed':
    case 'agent_update.rollout_completed':
      return CheckCircle
    case 'agent_update.rolled_back':
      return ArrowCounterClockwise
    case 'agent_update.available':
    case 'release_imported':
      return CloudArrowDown
    case 'agent_update.started':
    case 'job_created':
      return Play
    case 'agent_update.rollout_paused':
      return Pause
    case 'rollout_created':
    case 'rollout_resumed':
      return RocketLaunch
    case 'release_withdrawn':
    case 'release_deleted':
      return Package
    case 'settings_changed':
    case 'device_settings_changed':
      return GearSix
    case 'job_aborted':
    case 'rollout_cancelled':
      return XCircle
    default:
      return event.severity === 'info' ? Info : WarningCircle
  }
}

function toneOf(event: AgentUpdateEvent): string {
  if (event.severity === 'critical') return 'text-status-critical'
  if (event.severity === 'warning') return 'text-status-warning'
  if (event.event === 'agent_update.confirmed' || event.event === 'agent_update.rollout_completed') return 'text-status-good'
  return 'text-muted-foreground'
}

/** The free-text line an event carries (the device's or the check's `detail`). */
function detailLine(event: AgentUpdateEvent): string | null {
  const detail = event.detail?.detail
  if (typeof detail === 'string' && detail) return detail
  const changed = event.detail?.changed
  if (Array.isArray(changed) && changed.length > 0) return `Changed: ${changed.join(', ')}`
  return null
}

function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(iso: string, now: number): string {
  const key = dayKey(iso)
  if (key === dayKey(new Date(now).toISOString())) return 'Today'
  if (key === dayKey(new Date(now - 86_400_000).toISOString())) return 'Yesterday'
  return formatDate(iso)
}

type EventsListProps = {
  filters: EventsQuery
  /** A short list inside a sheet: no day headings, no "load more". */
  compact?: boolean
  /** Polls every 5 s (a sheet watching a live update). */
  live?: boolean
  emptyText?: string
  /** Links device names to their sheet on this page. */
  deviceLinks?: boolean
}

/** The audit trail: who did what and what the devices did, newest first. */
export function EventsList({ filters, compact = false, live = false, emptyText, deviceLinks = true }: EventsListProps) {
  const query = useAgentUpdateEvents(filters, { live })
  const now = useNow(30_000)
  const events = query.data?.pages.flatMap((p) => p.events) ?? []

  if (query.isPending) return <p className="text-xs text-muted-foreground">Loading history…</p>
  if (query.error && events.length === 0) return <p className="text-xs text-destructive">{query.error.message}</p>
  if (events.length === 0) {
    return compact ? (
      <p className="text-xs text-muted-foreground">{emptyText ?? 'Nothing yet.'}</p>
    ) : (
      <EmptyState title="Nothing here yet" description={emptyText ?? 'Updates, rollouts and releases leave a trail here.'} />
    )
  }

  return (
    <div className="relative space-y-3">
      <ol className="space-y-0">
        {events.map((event, index) => {
          const newDay = index === 0 || dayKey(event.at) !== dayKey(events[index - 1].at)
          const heading = !compact && newDay ? dayLabel(event.at, now) : null
          const EventIcon = iconOf(event)
          const actor = actorText(event.actor)
          const detail = detailLine(event)
          return (
            <li key={event.id}>
              {heading ? <p className="section-label pt-3 pb-1.5 first:pt-0">{heading}</p> : null}
              <div className="flex items-start gap-2.5 border-b border-border/60 py-2 text-xs last:border-b-0">
                <EventIcon weight="bold" className={cn('mt-px size-4 shrink-0', toneOf(event))} />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="font-medium break-words">{eventTitle(event)}</p>
                  {detail ? <p className="break-words text-muted-foreground">{detail}</p> : null}
                  <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                    {actor ? <span>{actor}</span> : null}
                    {deviceLinks && event.device ? (
                      <Link
                        className="underline-offset-2 hover:text-foreground hover:underline"
                        to={`/settings/updates?device=${encodeURIComponent(event.device.key)}`}
                      >
                        {event.device.name}
                      </Link>
                    ) : null}
                    {event.rolloutId !== null ? (
                      <Link
                        className="underline-offset-2 hover:text-foreground hover:underline"
                        to={`/settings/updates/rollouts/${event.rolloutId}`}
                      >
                        Rollout #{event.rolloutId}
                      </Link>
                    ) : null}
                  </p>
                </div>
                <time
                  dateTime={event.at}
                  title={new Date(event.at).toLocaleString()}
                  className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums"
                >
                  {compact ? formatAgo(event.at, now) : formatTime(event.at)}
                </time>
              </div>
            </li>
          )
        })}
      </ol>
      {!compact && query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? <Spinner className="size-3.5" /> : null}
            Older events
          </Button>
        </div>
      ) : null}
      <PanelOverlay show={query.isPlaceholderData} label="Updating…" />
    </div>
  )
}
