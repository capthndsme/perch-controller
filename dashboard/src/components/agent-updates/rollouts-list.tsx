import { Link } from 'react-router-dom'
import { CaretRight, RocketLaunch } from '@phosphor-icons/react'
import { RolloutStatusLine, RolloutTrack } from '@/components/agent-updates/rollout-sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useAgentRollout, useAgentRollouts } from '@/hooks/use-agent-updates'
import {
  cellsOfCounts,
  cellsOfDevices,
  formatDateTime,
  isOpenRollout,
  ROLLOUT_STATE_LABEL,
} from '@/lib/agent-updates'
import { cn } from '@/lib/utils'
import type { AgentFleet, AgentRollout } from '@/types/agent-updates'

const STATE_BADGE: Record<AgentRollout['state'], string> = {
  canary: 'border-brand/40 text-brand',
  observing: 'border-brand/40 text-brand',
  rolling: 'border-brand/40 text-brand',
  paused: 'border-status-warning/60',
  completed: 'border-status-good/50',
  cancelled: 'text-muted-foreground',
}

function RolloutRow({ rollout, window }: { rollout: AgentRollout; window: AgentFleet['window'] | null }) {
  const open = isOpenRollout(rollout.state)
  return (
    <li>
      <Link
        to={`/settings/updates/rollouts/${rollout.id}`}
        className="flex items-center gap-3 px-3.5 py-3 transition-colors duration-base hover:bg-muted/40 active:bg-muted/70 active:duration-0"
      >
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">
              {rollout.product} <span className="font-mono">{rollout.version}</span>
            </span>
            <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', STATE_BADGE[rollout.state])}>
              {ROLLOUT_STATE_LABEL[rollout.state]}
            </Badge>
            {rollout.auto ? (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-muted-foreground">
                Auto-update
              </Badge>
            ) : null}
          </div>
          <RolloutTrack cells={cellsOfCounts(rollout)} className="max-w-md" />
          {open ? (
            <RolloutStatusLine rollout={rollout} window={window} />
          ) : (
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {rollout.counts.confirmed} of {rollout.counts.total} updated
              {rollout.counts.skipped ? ` · ${rollout.counts.skipped} skipped` : ''}
              {rollout.counts.failed ? ` · ${rollout.counts.failed} failed` : ''} ·{' '}
              {formatDateTime(rollout.finishedAt ?? rollout.startedAt ?? rollout.createdAt)}
            </p>
          )}
        </div>
        <CaretRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  )
}

/** Every rollout, open ones first: a row each, tap for the live sheet. */
export function RolloutsPanel({
  isAdmin,
  window,
  onNew,
}: {
  isAdmin: boolean
  window: AgentFleet['window'] | null
  onNew: () => void
}) {
  const query = useAgentRollouts('all')
  const list = query.data ?? []
  const open = list.filter((r) => isOpenRollout(r.state))
  const past = list.filter((r) => !isOpenRollout(r.state))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-xl text-xs text-muted-foreground">
          A rollout updates one product on several devices: a canary first, a pause to watch it, then the rest a batch
          at a time. It stops on a failure; the device that failed goes back to its previous version by itself.
        </p>
        {isAdmin ? (
          <Button type="button" size="sm" onClick={onNew}>
            <RocketLaunch />
            New rollout
          </Button>
        ) : null}
      </div>
      {query.isPending ? (
        <p className="text-xs text-muted-foreground">Loading rollouts…</p>
      ) : query.error ? (
        <p className="text-xs text-destructive">{query.error.message}</p>
      ) : list.length === 0 ? (
        <EmptyState title="No rollouts yet" description="Start one to update every access point or collector in turn." />
      ) : (
        <>
          {open.length > 0 ? (
            <section className="space-y-2">
              <h2 className="section-label">In progress</h2>
              <ul className="card-surface divide-y divide-border overflow-hidden">
                {open.map((r) => (
                  <RolloutRow key={r.id} rollout={r} window={window} />
                ))}
              </ul>
            </section>
          ) : null}
          {past.length > 0 ? (
            <section className="space-y-2">
              <h2 className="section-label">Finished</h2>
              <ul className="card-surface divide-y divide-border overflow-hidden">
                {past.map((r) => (
                  <RolloutRow key={r.id} rollout={r} window={window} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}

/** The Devices tab's banner for a rollout in progress: its live track, and a way in. */
export function OpenRolloutCard({ id, window }: { id: number; window: AgentFleet['window'] | null }) {
  const query = useAgentRollout(id)
  const rollout = query.data
  if (!rollout) return null
  return (
    <Link
      to={`/settings/updates/rollouts/${rollout.id}?tab=devices`}
      className="card-surface block space-y-2.5 px-3.5 py-3 transition-colors duration-base hover:bg-muted/30 active:bg-muted/60 active:duration-0"
    >
      <div className="flex items-center gap-2">
        <RocketLaunch className="size-4 shrink-0 text-brand" />
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          Rollout of {rollout.product} <span className="font-mono">{rollout.version}</span>
        </p>
        <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', STATE_BADGE[rollout.state])}>
          {ROLLOUT_STATE_LABEL[rollout.state]}
        </Badge>
        <CaretRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </div>
      <RolloutTrack cells={rollout.devices ? cellsOfDevices(rollout.devices) : cellsOfCounts(rollout)} />
      <RolloutStatusLine rollout={rollout} window={window} />
    </Link>
  )
}
