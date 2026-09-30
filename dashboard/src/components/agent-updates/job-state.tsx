import { useNow } from '@/hooks/use-now'
import { useSecondsLeft, type RolloutMember } from '@/hooks/use-agent-updates'
import {
  formatAgo,
  formatCountdown,
  isOpenJob,
  jobFraction,
  jobStateText,
  JOB_STATE_TONE,
  TONE_BG,
  TONE_TEXT,
  type Tone,
} from '@/lib/agent-updates'
import { cn } from '@/lib/utils'
import type { AgentUpdateDevice, AgentUpdateJobSummary } from '@/types/agent-updates'

/** A state dot; `live` adds the halo that says "happening now" (au-halo, still under reduced motion). */
export function ToneDot({ tone, live = false, className }: { tone: Tone; live?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        TONE_BG[tone],
        live && cn('au-halo', TONE_TEXT[tone]),
        className,
      )}
    />
  )
}

/**
 * A thin progress bar. A known fraction fills from the left with a transform
 * (scale), easing to each new reading in 300 ms so a 5 s poll glides instead
 * of jumping; without one (installing, checking) a band sweeps along it.
 */
export function ProgressBar({
  fraction,
  tone = 'active',
  sweep = false,
  className,
  label,
}: {
  fraction: number | null
  tone?: Tone
  sweep?: boolean
  className?: string
  label?: string
}) {
  const f = fraction === null ? 1 : Math.min(1, Math.max(0, fraction))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction === null ? undefined : Math.round(f * 100)}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', sweep && 'au-sweep', className)}
    >
      <div
        className={cn(
          'h-full w-full origin-left rounded-full transition-[scale,background-color] duration-slow ease-out',
          TONE_BG[tone],
          fraction === null && !sweep && 'opacity-40',
        )}
        style={{ scale: `${f} 1` }}
      />
    </div>
  )
}

/**
 * An open or just-finished job in one line: the state in words with its dot,
 * and under it the download bar, or the check's countdown to the deadline.
 */
export function JobStatus({ job, compact = false }: { job: AgentUpdateJobSummary; compact?: boolean }) {
  const open = isOpenJob(job.state)
  const tone = JOB_STATE_TONE[job.state]
  const checking = job.state === 'probation' || job.state === 'installing'
  const left = useSecondsLeft(job.deadline, open && checking)
  const fraction = jobFraction(job)
  const moving = job.state === 'staging' || job.state === 'staged' || job.state === 'installing' || job.state === 'probation'

  return (
    <div className={cn('min-w-0 space-y-1', compact ? 'max-w-48' : 'max-w-60')}>
      <p className="flex min-w-0 items-center gap-1.5 text-xs">
        <ToneDot tone={tone} live={moving} />
        <span className={cn('truncate font-medium', !open && tone === 'critical' && TONE_TEXT.critical)} title={jobStateText(job)}>
          {jobStateText(job)}
        </span>
        {checking && left !== null ? (
          <span
            className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums"
            aria-label={`${Math.max(0, left)} seconds before it rolls back on its own`}
            title="Rolls back on its own if the new version does not check in by then"
          >
            {formatCountdown(left)}
          </span>
        ) : null}
      </p>
      {open && job.state !== 'queued' && job.state !== 'unknown' ? (
        <ProgressBar
          fraction={job.state === 'staging' ? fraction : null}
          sweep={job.state !== 'staging'}
          label={jobStateText(job)}
        />
      ) : null}
    </div>
  )
}

/** A device's status cell when nothing runs: its last outcome if recent, else where it stands. */
export function DeviceStatus({ device, member }: { device: AgentUpdateDevice; member?: RolloutMember }) {
  const now = useNow(30_000)
  if (device.activeJob) return <JobStatus job={device.activeJob} compact />
  if (member) {
    return (
      <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <ToneDot tone="neutral" />
        <span className="truncate">
          {member.state === 'running' ? 'Starting' : 'Waiting its turn'} in rollout #{member.rolloutId}
        </span>
      </p>
    )
  }
  const last = device.lastJob
  const recent = last?.finishedAt ? now - Date.parse(last.finishedAt) < 6 * 3600_000 : false
  if (last && recent) {
    const tone = JOB_STATE_TONE[last.state]
    return (
      <p className="flex min-w-0 items-center gap-1.5 text-xs">
        <ToneDot tone={tone} />
        <span className={cn('truncate', tone === 'critical' ? TONE_TEXT.critical : tone === 'neutral' && 'text-muted-foreground')} title={jobStateText(last)}>
          {jobStateText(last)}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{formatAgo(last.finishedAt, now)}</span>
      </p>
    )
  }
  if (!device.selfUpdate.supported) {
    return (
      <p className="flex items-center gap-1.5 text-xs">
        <ToneDot tone="warning" />
        <span>Needs a manual update</span>
      </p>
    )
  }
  if (device.pinnedVersion) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ToneDot tone="neutral" />
        Held
      </p>
    )
  }
  if (device.available) {
    return (
      <p className="flex items-center gap-1.5 text-xs">
        <ToneDot tone="active" />
        <span>Update available</span>
      </p>
    )
  }
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <ToneDot tone="good" />
      Up to date
    </p>
  )
}
