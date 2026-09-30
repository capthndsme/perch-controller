import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle, Pause, Play, Prohibit, Stop, WarningCircle, XCircle } from '@phosphor-icons/react'
import { EventsList } from '@/components/agent-updates/events-list'
import { JobStatus, ToneDot } from '@/components/agent-updates/job-state'
import { FactList, SheetSection, UpdatesSheet } from '@/components/agent-updates/sheet'
import { VersionArrow } from '@/components/agent-updates/version-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAgentRollout, useRolloutAction, useSecondsLeft } from '@/hooks/use-agent-updates'
import {
  cellsOfCounts,
  cellsOfDevices,
  formatCountdown,
  formatDateTime,
  formatInZone,
  METHOD_LABEL,
  pausedText,
  reasonText,
  refusalMessage,
  ROLLOUT_STATE_LABEL,
  skipText,
  TONE_TEXT,
  WAITING_TEXT,
  type TrackCell,
  type Tone,
} from '@/lib/agent-updates'
import { cn } from '@/lib/utils'
import type { AgentFleet, AgentRollout, AgentRolloutDevice, RolloutDeviceState } from '@/types/agent-updates'

// ── The track: one cell per device ─────────────────────────────────────────

const CELL_BG: Record<RolloutDeviceState, string> = {
  pending: 'bg-muted',
  running: 'bg-brand/20',
  confirmed: 'bg-status-good',
  failed: 'bg-status-critical',
  skipped: 'bg-muted-foreground/30',
}

/**
 * The rollout at a glance: a cell per device that fills as it updates (the
 * download's share while it downloads, then a sweep while it installs and is
 * checked) and turns green or red when it is done. Colours change over 300 ms,
 * the fill eases to each reading; nothing moves between polls otherwise.
 */
export function RolloutTrack({ cells, className }: { cells: TrackCell[]; className?: string }) {
  return (
    <div className={cn('flex gap-1', className)} role="list" aria-label="Devices in this rollout">
      {cells.map((cell) => (
        <span
          key={cell.key}
          role="listitem"
          aria-label={cell.label}
          title={cell.label}
          className={cn(
            'relative h-2 min-w-2 flex-1 overflow-hidden rounded-full transition-colors duration-slow ease-out',
            CELL_BG[cell.state],
            cell.state === 'running' && cell.sweep && 'au-sweep',
          )}
        >
          {cell.state === 'running' ? (
            <span
              aria-hidden
              className="absolute inset-0 origin-left rounded-full bg-brand transition-[scale] duration-slow ease-out"
              style={{ scale: `${cell.fraction ?? 1} 1` }}
            />
          ) : null}
        </span>
      ))}
    </div>
  )
}

// ── The stages: canary → observe → roll out → done ─────────────────────────

const STAGES = ['Canary', 'Observe', 'Roll out', 'Done'] as const

function stageIndex(rollout: AgentRollout): number {
  switch (rollout.state) {
    case 'canary':
      return 0
    case 'observing':
      return 1
    case 'rolling':
      return 2
    case 'completed':
      return 3
    default: {
      // Paused or cancelled: where it stopped (the canary until it confirmed).
      const canary = rollout.devices?.find((d) => d.isCanary)
      if (canary) return canary.state === 'confirmed' ? 2 : 0
      return rollout.counts.confirmed > 0 ? 2 : 0
    }
  }
}

/**
 * Four stages with the current one marked. The rail fills to the current
 * stage on the strong ease-in-out (it moves on screen), and the highlight
 * behind the stage's name slides along on the snappy spring. Reduced motion:
 * both change in place.
 */
function StageTrack({ rollout }: { rollout: AgentRollout }) {
  const index = stageIndex(rollout)
  const halted = rollout.state === 'paused' || rollout.state === 'cancelled'
  const done = rollout.state === 'completed'
  const tone: Tone = rollout.state === 'paused' ? 'warning' : rollout.state === 'cancelled' ? 'neutral' : done ? 'good' : 'active'
  return (
    <div className="relative" aria-label={`Stage: ${STAGES[index]}${halted ? ` (${ROLLOUT_STATE_LABEL[rollout.state].toLowerCase()})` : ''}`}>
      <div className="relative grid grid-cols-4">
        {/* The rail between the first and last dot, and its fill. */}
        <span aria-hidden className="absolute top-[7px] right-[12.5%] left-[12.5%] h-0.5 rounded-full bg-muted">
          <span
            className="block h-full origin-left rounded-full bg-status-good transition-[scale] duration-slow ease-in-out motion-reduce:transition-none"
            style={{ scale: `${index / (STAGES.length - 1)} 1` }}
          />
        </span>
        {/* The highlight behind the current stage's name. */}
        <span
          aria-hidden
          className="absolute top-[22px] left-0 h-5 w-1/4 transition-[translate] duration-[360ms] ease-spring-snappy motion-reduce:transition-none"
          style={{ translate: `${index * 100}% 0` }}
        >
          <span
            className={cn(
              'mx-auto block h-full w-[88%] rounded-full transition-colors duration-slow',
              tone === 'warning' ? 'bg-status-warning/15' : tone === 'good' ? 'bg-status-good/15' : tone === 'neutral' ? 'bg-muted' : 'bg-brand/10',
            )}
          />
        </span>
        {STAGES.map((label, i) => {
          const past = i < index || (done && i === index)
          const current = i === index && !done
          return (
            <div key={label} className="relative flex flex-col items-center gap-1.5">
              <span className="flex size-4 items-center justify-center rounded-full bg-card">
                {past ? (
                  <CheckCircle weight="fill" className="size-4 text-status-good" />
                ) : current ? (
                  <ToneDot tone={tone} live={!halted} className="size-2.5" />
                ) : (
                  <span aria-hidden className="size-2.5 rounded-full border border-muted-foreground/50 bg-card" />
                )}
              </span>
              <span
                className={cn(
                  'relative flex h-5 items-center px-2 text-[11px] whitespace-nowrap',
                  current ? cn('font-semibold', halted ? TONE_TEXT[tone] : 'text-foreground') : past ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── What it is doing right now ─────────────────────────────────────────────

/** One sentence (with a live countdown where there is a clock) for where the rollout stands. */
export function RolloutStatusLine({ rollout, window }: { rollout: AgentRollout; window?: AgentFleet['window'] | null }) {
  const open = rollout.state !== 'completed' && rollout.state !== 'cancelled'
  const left = useSecondsLeft(rollout.nextActionAt, open)
  const running = rollout.devices?.filter((d) => d.state === 'running').map((d) => d.device.name) ?? []
  const canary = rollout.devices?.find((d) => d.isCanary)

  let tone: Tone = 'active'
  let text: string
  let clock: string | null = null
  if (rollout.state === 'paused') {
    tone = 'warning'
    const why = pausedText(rollout.pausedReason)
    text = why ? `Paused: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : 'Paused'
  } else if (rollout.state === 'cancelled') {
    tone = 'neutral'
    text = `Cancelled${rollout.finishedAt ? ` ${formatDateTime(rollout.finishedAt)}` : ''}`
  } else if (rollout.state === 'completed') {
    tone = 'good'
    const c = rollout.counts
    text = `Completed: ${c.confirmed} updated${c.skipped ? `, ${c.skipped} skipped` : ''}${c.failed ? `, ${c.failed} failed` : ''}`
  } else if (rollout.waitingFor === 'window') {
    tone = 'neutral'
    const next = window ? formatInZone(window.nextStart, window.timezone) : null
    text = `${WAITING_TEXT.window}${next ? ` (opens ${next})` : ''}`
  } else if (rollout.waitingFor === 'observe' || rollout.state === 'observing') {
    text = `${WAITING_TEXT.observe}${canary ? `, ${canary.device.name}` : ''}: it must stay online on the new version`
    clock = left !== null ? formatCountdown(left) : null
  } else if (rollout.waitingFor === 'gap') {
    tone = 'neutral'
    text = 'Next batch starts in'
    clock = left !== null ? formatCountdown(left) : null
  } else if (rollout.waitingFor) {
    tone = 'neutral'
    text = WAITING_TEXT[rollout.waitingFor]
  } else if (running.length > 0) {
    text = `${rollout.state === 'canary' ? 'Updating the canary, ' : 'Updating '}${running.join(', ')}`
  } else if (!rollout.devices && rollout.counts.running > 0) {
    // A list row has counts, not devices.
    const n = rollout.counts.running
    text = rollout.state === 'canary' ? 'Updating the canary' : `Updating ${n} device${n === 1 ? '' : 's'}`
  } else {
    text = rollout.state === 'canary' ? 'Starting with the canary' : 'Starting the next batch'
  }

  return (
    <p className="flex items-center gap-2 text-xs" aria-live="polite">
      <ToneDot tone={tone} live={tone === 'active'} />
      <span className="min-w-0 flex-1">{text}</span>
      {clock ? (
        <span className="shrink-0 rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums">
          {clock}
        </span>
      ) : null}
    </p>
  )
}

// ── One device's row ───────────────────────────────────────────────────────

const STATE_TONE: Record<RolloutDeviceState, Tone> = {
  pending: 'neutral',
  running: 'active',
  confirmed: 'good',
  failed: 'critical',
  skipped: 'neutral',
}

function RolloutDeviceRow({ item, version }: { item: AgentRolloutDevice; version: string }) {
  // Only a change seen while the sheet is open plays; the state it opened with is simply there.
  const [firstState] = useState(item.state)
  const changed = item.state !== firstState
  const job = item.job
  const Icon =
    item.state === 'confirmed' ? CheckCircle : item.state === 'failed' ? XCircle : item.state === 'skipped' ? Prohibit : null

  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        {Icon ? (
          <Icon
            key={item.state}
            weight="fill"
            className={cn(
              'size-4',
              TONE_TEXT[STATE_TONE[item.state]],
              changed && 'transition-[scale,opacity] duration-base ease-out starting:opacity-0 motion-safe:starting:scale-90',
            )}
          />
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{item.position + 1}</span>
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            to={`/settings/updates?device=${encodeURIComponent(item.device.key)}`}
            className="truncate text-xs font-medium underline-offset-2 hover:underline"
          >
            {item.device.name}
          </Link>
          {item.isCanary ? (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              Canary
            </Badge>
          ) : null}
        </p>
        {job && item.state === 'running' ? (
          <JobStatus job={job} />
        ) : (
          <p className={cn('text-[11px]', item.state === 'failed' ? TONE_TEXT.critical : 'text-muted-foreground')}>
            {item.state === 'skipped'
              ? `Skipped: ${(skipText(item.skipReason) ?? 'by the rollout').toLowerCase()}`
              : item.state === 'failed'
                ? `${job?.state === 'rolled_back' ? 'Rolled back' : 'Failed'}${reasonText(job?.reason) ? `: ${reasonText(job?.reason)!.toLowerCase()}` : ''}`
                : item.state === 'confirmed'
                  ? `Updated${job?.finishedAt ? ` ${formatDateTime(job.finishedAt)}` : ''}`
                  : 'Waiting its turn'}
          </p>
        )}
      </div>
      {job ? <VersionArrow from={job.fromVersion} to={version} className="hidden shrink-0 sm:inline-flex" /> : null}
    </li>
  )
}

// ── The sheet ──────────────────────────────────────────────────────────────

type RolloutSheetProps = {
  rolloutId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  isAdmin: boolean
  window: AgentFleet['window'] | null
}

/**
 * A rollout, live (route `settings/updates/rollouts/:rolloutId`): its stage,
 * what it waits for with the clock running, every device as it goes, and
 * Pause / Resume / Cancel.
 */
export function RolloutSheet({ rolloutId, open, onOpenChange, isAdmin, window }: RolloutSheetProps) {
  const query = useAgentRollout(rolloutId)
  const action = useRolloutAction()
  const [skipFailed, setSkipFailed] = useState(true)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const rollout = query.data

  const openState = rollout ? rollout.state !== 'completed' && rollout.state !== 'cancelled' : false
  const hasFailed = (rollout?.counts.failed ?? 0) > 0
  const run = (kind: 'pause' | 'resume' | 'cancel') =>
    rollout &&
    action.mutate(
      { id: rollout.id, action: kind, skipFailed: kind === 'resume' ? skipFailed && hasFailed : undefined },
      { onSuccess: () => setConfirmCancel(false) },
    )

  const footer =
    isAdmin && rollout && openState ? (
      confirmCancel ? (
        <>
          <p className="w-full text-xs text-muted-foreground">
            Devices that have not started are skipped. One that is updating finishes its update.
          </p>
          <Button type="button" size="sm" variant="destructive" onClick={() => run('cancel')} disabled={action.isPending}>
            Yes, cancel the rollout
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmCancel(false)}>
            Keep it
          </Button>
        </>
      ) : (
        <>
          {rollout.state === 'paused' ? (
            <Button type="button" size="sm" onClick={() => run('resume')} disabled={action.isPending}>
              <Play weight="fill" />
              Resume
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={() => run('pause')} disabled={action.isPending}>
              <Pause weight="fill" />
              Pause
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmCancel(true)}>
            <Stop weight="fill" />
            Cancel rollout
          </Button>
        </>
      )
    ) : null

  return (
    <UpdatesSheet
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={rollout ? `${rollout.product} ${rollout.version}` : rolloutId ? `Rollout #${rolloutId}` : 'Rollout'}
      subtitle={
        rollout ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              {ROLLOUT_STATE_LABEL[rollout.state]}
            </Badge>
            <span>
              Rollout #{rollout.id} · started {formatDateTime(rollout.startedAt ?? rollout.createdAt)}
              {rollout.createdBy ? ` by ${'name' in rollout.createdBy ? rollout.createdBy.name : 'auto-update'}` : ''}
            </span>
          </span>
        ) : null
      }
      footer={footer}
    >
      {query.isPending ? (
        <p className="text-muted-foreground">Loading the rollout…</p>
      ) : query.error ? (
        <p className="text-destructive">{refusalMessage(query.error)}</p>
      ) : rollout ? (
        <>
          <StageTrack rollout={rollout} />

          <div className="space-y-3 rounded-md border border-border p-3">
            <RolloutStatusLine rollout={rollout} window={window} />
            <RolloutTrack cells={rollout.devices ? cellsOfDevices(rollout.devices) : cellsOfCounts(rollout)} />
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {rollout.counts.confirmed} of {rollout.counts.total} updated
              {rollout.counts.failed ? ` · ${rollout.counts.failed} failed` : ''}
              {rollout.counts.skipped ? ` · ${rollout.counts.skipped} skipped` : ''}
            </p>
          </div>

          {rollout.state === 'paused' ? (
            <div className="space-y-2 rounded-md border border-status-warning/50 bg-status-warning/10 px-3 py-2.5">
              <p className="flex items-center gap-2 font-medium">
                <WarningCircle weight="fill" className="size-4 shrink-0 text-status-warning" />
                {rollout.pausedDetail ?? pausedText(rollout.pausedReason) ?? 'Paused'}
              </p>
              <p className="text-muted-foreground">
                Nothing else starts until you resume.{' '}
                {rollout.pausedReason === 'device_failed'
                  ? 'The device that failed went back to its previous version on its own.'
                  : ''}
              </p>
              {isAdmin && hasFailed ? (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={skipFailed}
                    onChange={(event) => setSkipFailed(event.target.checked)}
                  />
                  Skip the failed device when resuming
                </label>
              ) : null}
            </div>
          ) : null}

          {action.error ? <p className="text-destructive">{refusalMessage(action.error)}</p> : null}

          {rollout.devices ? (
            <SheetSection title="Devices">
              <ol className="divide-y divide-border/70">
                {[...rollout.devices]
                  .sort((a, b) => a.position - b.position)
                  .map((item) => (
                    <RolloutDeviceRow key={item.device.key} item={item} version={rollout.version} />
                  ))}
              </ol>
            </SheetSection>
          ) : null}

          <SheetSection title="Plan">
            <FactList
              rows={[
                { label: 'Method', value: rollout.method === 'auto' ? 'Automatic' : METHOD_LABEL[rollout.method] },
                { label: 'Batches', value: `${rollout.batchSize} at a time, ${rollout.batchGapSeconds} s apart` },
                { label: 'Watch the canary', value: `${rollout.canaryObserveMinutes} min` },
                { label: 'Offline devices', value: `Waited for ${rollout.offlineWaitMinutes} min, then skipped` },
                { label: 'On a failure', value: rollout.stopOnFailure ? 'Pause the rollout' : 'Skip it and go on' },
                { label: 'Maintenance window', value: rollout.respectWindow ? 'Starts devices only inside it' : 'Ignored' },
                ...(rollout.auto ? [{ label: 'Started by', value: 'Auto-update' }] : []),
              ]}
            />
          </SheetSection>

          <SheetSection title="History">
            <EventsList filters={{ rolloutId: rollout.id, limit: 12 }} compact live={openState} />
          </SheetSection>
        </>
      ) : null}
    </UpdatesSheet>
  )
}
