import { useState, type ReactNode } from 'react'
import { ArrowCounterClockwise, CheckCircle, Prohibit, WarningCircle } from '@phosphor-icons/react'
import { ProgressBar, ToneDot } from '@/components/agent-updates/job-state'
import { useSecondsLeft } from '@/hooks/use-agent-updates'
import { formatBytes } from '@/lib/format-bytes'
import {
  formatCountdown,
  formatTime,
  isOpenJob,
  jobFraction,
  JOB_STATE_LABEL,
  reasonText,
} from '@/lib/agent-updates'
import { cn } from '@/lib/utils'
import type { AgentUpdateJob, AgentUpdateJobSummary, JobState } from '@/types/agent-updates'

type Step = { id: string; label: string; at: string | null; done: boolean; active: boolean; body?: ReactNode }

/** When each step happened: the job's own timestamps, else its timeline (from the events). */
function stepTimes(job: AgentUpdateJobSummary & Partial<AgentUpdateJob>) {
  const seen = (states: JobState[]) => job.timeline?.find((t) => states.includes(t.state))?.at ?? null
  return {
    queued: job.createdAt,
    download: job.stagedAt ?? seen(['staged']),
    install: job.installSentAt ?? seen(['installing']),
    reconnect: job.reconnectedAt ?? seen(['probation']),
    confirm: job.confirmedAt ?? (job.state === 'confirmed' ? job.finishedAt : null),
  }
}

/**
 * One update, step by step: queued → downloaded → installed → reconnected →
 * confirmed, with times, the download bar while it downloads and the
 * countdown to the automatic rollback while the new version is checked. A
 * step finished while you watch ticks in and the rail below it fills; the
 * ones already done when it opened are simply there. Reduced motion: the
 * tick fades in, the rail fills without travelling.
 */
export function JobTimeline({
  job,
  stableSeconds,
  minPushes,
}: {
  job: AgentUpdateJobSummary & Partial<AgentUpdateJob>
  stableSeconds?: number
  minPushes?: number
}) {
  const open = isOpenJob(job.state)
  const times = stepTimes(job)
  const left = useSecondsLeft(job.deadline, open)
  const fraction = jobFraction(job)
  const reached = (key: keyof typeof times) => times[key] !== null

  const downloadDone = reached('download') || ['staged', 'installing', 'probation', 'confirmed'].includes(job.state)
  const installDone = reached('install') || ['probation', 'confirmed'].includes(job.state)
  const reconnectDone = reached('reconnect') || job.state === 'confirmed'
  const confirmDone = job.state === 'confirmed'

  const checkRule =
    stableSeconds !== undefined && minPushes !== undefined
      ? `It confirms once the new version has been connected ${stableSeconds} s and sent ${minPushes} reports.`
      : 'It confirms once the new version has stayed connected and reported.'

  const steps: Step[] = [
    { id: 'queued', label: job.state === 'queued' ? 'Queued' : 'Sent to the device', at: times.queued, done: job.state !== 'queued', active: job.state === 'queued' },
    {
      id: 'download',
      label: job.state === 'staging' ? 'Downloading' : 'Downloaded and verified',
      at: times.download,
      done: downloadDone,
      active: job.state === 'staging',
      body:
        job.state === 'staging' ? (
          <div className="space-y-1">
            <ProgressBar fraction={fraction} label="Download" />
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {job.progress
                ? `${formatBytes(job.progress.bytes)} of ${formatBytes(job.progress.totalBytes)}`
                : 'Starting the download'}
            </p>
          </div>
        ) : null,
    },
    {
      id: 'install',
      label: job.state === 'installing' || job.state === 'staged' ? 'Installing' : 'Installed',
      at: times.install,
      done: installDone,
      active: job.state === 'installing' || job.state === 'staged' || job.state === 'unknown',
      body:
        job.state === 'installing' ? (
          <p className="text-[11px] text-muted-foreground">
            The device keeps the running version, swaps in the new one and restarts the service.
          </p>
        ) : job.state === 'unknown' ? (
          <p className="rounded-md border border-status-warning/40 bg-status-warning/10 px-2 py-1.5 text-[11px]">
            No word from the device since the deadline. It rolls back on its own if the new version never
            checked in; this settles when it reports again.
          </p>
        ) : null,
    },
    {
      id: 'reconnect',
      label: 'New version reconnected',
      at: times.reconnect,
      done: reconnectDone,
      active: false,
    },
    {
      id: 'confirm',
      label: job.state === 'probation' ? 'Checking' : 'Confirmed',
      at: times.confirm,
      done: confirmDone,
      active: job.state === 'probation',
      body:
        job.state === 'probation' ? (
          <div className="space-y-1">
            <ProgressBar fraction={null} sweep label="Check" />
            <p className="text-[11px] text-muted-foreground">
              {checkRule}
              {left !== null ? (
                <>
                  {' '}
                  Rolls back on its own in{' '}
                  <span className="font-mono tabular-nums text-foreground">{formatCountdown(left)}</span> if not.
                </>
              ) : null}
            </p>
          </div>
        ) : null,
    },
  ]

  const outcome = outcomeRow(job)

  return (
    <ol className="relative space-y-0" aria-label="Update steps">
      {steps.map((step, index) => (
        <TimelineStep
          key={step.id}
          step={step}
          last={index === steps.length - 1 && !outcome}
          stopped={!open && !step.done}
        />
      ))}
      {outcome}
    </ol>
  )
}

function TimelineStep({ step, last, stopped }: { step: Step; last: boolean; stopped: boolean }) {
  // Only a step finished while the timeline is on screen ticks in.
  const [doneAtFirst] = useState(step.done)
  return (
    <li className="relative grid grid-cols-[1.25rem_1fr_auto] gap-x-2 pb-3 last:pb-0">
      {!last ? (
        <span aria-hidden className="absolute top-5 bottom-0 left-[calc(0.625rem-0.5px)] w-px bg-border">
          <span
            className={cn(
              'block h-full w-full origin-top bg-status-good transition-[scale] duration-slow ease-out',
            )}
            style={{ scale: `1 ${step.done ? 1 : 0}` }}
          />
        </span>
      ) : null}
      <span className="flex h-5 items-center justify-center">
        {step.done ? (
          <CheckCircle
            weight="fill"
            className={cn(
              'size-4 text-status-good',
              !doneAtFirst &&
                'transition-[scale,opacity] duration-base ease-out starting:opacity-0 motion-safe:starting:scale-90',
            )}
          />
        ) : step.active && !stopped ? (
          <ToneDot tone="active" live className="size-2.5" />
        ) : (
          <span aria-hidden className="size-2.5 rounded-full border border-muted-foreground/50" />
        )}
      </span>
      <div className="min-w-0 space-y-1.5">
        <p className={cn('flex h-5 items-center', step.done || step.active ? 'font-medium' : 'text-muted-foreground')}>
          {step.label}
        </p>
        {step.body && !stopped ? step.body : null}
      </div>
      <span className="flex h-5 items-center font-mono text-[11px] text-muted-foreground tabular-nums">
        {step.at && (step.done || step.id === 'queued') ? formatTime(step.at) : ''}
      </span>
    </li>
  )
}

/** The end of a job that did not confirm: rolled back, failed, cancelled. */
function outcomeRow(job: AgentUpdateJobSummary & Partial<AgentUpdateJob>) {
  if (isOpenJob(job.state) || job.state === 'confirmed') return null
  const reason = reasonText(job.reason)
  const critical = job.state === 'rollback_failed' || job.state === 'rollback_unavailable'
  const neutral = job.state === 'cancelled' || job.state === 'expired'
  const Icon = job.state === 'rolled_back' ? ArrowCounterClockwise : neutral ? Prohibit : WarningCircle
  return (
    <li
      className={cn(
        'mt-3 flex items-start gap-2 rounded-md border px-2.5 py-2',
        critical
          ? 'border-status-critical/40 bg-status-critical/10'
          : neutral
            ? 'border-border bg-muted/40'
            : 'border-status-warning/40 bg-status-warning/10',
        'transition-[opacity,translate] duration-base ease-out starting:translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0',
      )}
    >
      <Icon
        weight="bold"
        className={cn(
          'mt-px size-4 shrink-0',
          critical ? 'text-status-critical' : neutral ? 'text-muted-foreground' : 'text-status-warning',
        )}
      />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">
          {JOB_STATE_LABEL[job.state]}
          {job.state === 'rolled_back' ? ` to ${job.fromVersion}` : ''}
          {job.finishedAt ? (
            <span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground">{formatTime(job.finishedAt)}</span>
          ) : null}
        </p>
        {reason ? <p>{reason}.</p> : null}
        {job.detail ? <p className="text-muted-foreground">{job.detail}</p> : null}
        {job.state === 'rollback_failed' ? (
          <p>The device may need its previous version put back by hand (the rollback copies are kept on it).</p>
        ) : null}
        {job.state === 'rollback_unavailable' ? (
          <p>The new version was left running. If it misbehaves, reinstall over SSH.</p>
        ) : null}
      </div>
    </li>
  )
}
