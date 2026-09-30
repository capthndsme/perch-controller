import { useState, type ReactNode } from 'react'
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CaretUp,
  CheckCircle,
  Circle,
  Clock,
  Crosshair,
  HandTap,
  Pause,
  Play,
  SkipForward,
  Stop,
  WarningCircle,
  WifiSlash,
  X,
  XCircle,
} from '@phosphor-icons/react'
import { ConfirmDialog, ErrorLine } from '@/components/gateway-config/bits'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { StatusPill } from '@/components/wifi-config/rows'
import { EditorSheet } from '@/components/wifi-config/sheet'
import { useDialog } from '@/hooks/use-dialog'
import { useNow } from '@/hooks/use-now'
import { useConfirmApApply, useRevertApApply, useRollout, useRolloutAction } from '@/hooks/use-wifi-config'
import { formatCountdown, formatDateTime } from '@/lib/gateway-config'
import {
  currentStep,
  outcomeReasonText,
  plural,
  ROLLOUT_KIND_LABEL,
  ROLLOUT_STATE_META,
  rolloutProgress,
  stepPhase,
  wifiRefusalMessage,
  type StepIcon,
} from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type { RolloutAction, WifiRollout, WifiRolloutStep } from '@/types/wifi-config'

const ICON_CLASS = 'size-4 shrink-0'

export function StepGlyph({ icon, className }: { icon: StepIcon; className?: string }) {
  switch (icon) {
    case 'queued':
      return <Circle aria-hidden className={cn(ICON_CLASS, 'text-muted-foreground/60', className)} />
    case 'busy':
      return <Spinner className={cn(ICON_CLASS, className)} />
    case 'wait':
      return <Clock aria-hidden weight="bold" className={cn(ICON_CLASS, 'text-status-warning', className)} />
    case 'radar':
      return <Crosshair aria-hidden weight="bold" className={cn(ICON_CLASS, 'text-status-warning', className)} />
    case 'you':
      return <HandTap aria-hidden weight="bold" className={cn(ICON_CLASS, 'text-status-warning', className)} />
    case 'done':
      return <CheckCircle aria-hidden weight="fill" className={cn(ICON_CLASS, 'text-status-good', className)} />
    case 'failed':
      return <XCircle aria-hidden weight="fill" className={cn(ICON_CLASS, 'text-status-critical', className)} />
    case 'skipped':
      return <SkipForward aria-hidden weight="bold" className={cn(ICON_CLASS, 'text-muted-foreground', className)} />
    case 'offline':
      return <WifiSlash aria-hidden weight="bold" className={cn(ICON_CLASS, 'text-muted-foreground', className)} />
  }
}

/** Keep changes / Revert now for the step whose apply is in its confirm window. */
function StepApplyButtons({ step, compact = false }: { step: WifiRolloutStep; compact?: boolean }) {
  const confirm = useConfirmApApply(step.apId)
  const revert = useRevertApApply(step.apId)
  const [askRevert, setAskRevert] = useState(false)
  const apply = step.apply
  if (!apply || apply.state !== 'pending_confirm') return null
  const needsAdmin = apply.confirmMode === 'admin_and_agent' && apply.confirmations.admin === null
  const size = compact ? 'sm' : 'default'
  return (
    <>
      {needsAdmin ? (
        <Button size={size} onClick={() => confirm.mutate(apply.id)} disabled={confirm.isPending} data-testid="rollout-keep">
          {confirm.isPending ? <Spinner className="size-3.5 text-current" /> : <CheckCircle weight="bold" />}
          Keep changes
        </Button>
      ) : null}
      {askRevert ? (
        <>
          <Button size={size} variant="destructive" onClick={() => revert.mutate(apply.id)} disabled={revert.isPending}>
            {revert.isPending ? <Spinner className="size-3.5 text-current" /> : null}
            Yes, roll back {step.apName}
          </Button>
          <Button size={size} variant="ghost" onClick={() => setAskRevert(false)}>
            No
          </Button>
        </>
      ) : (
        <Button size={size} variant="outline" onClick={() => setAskRevert(true)}>
          <ArrowCounterClockwise weight="bold" />
          Revert now
        </Button>
      )}
      {confirm.error || revert.error ? (
        <ErrorLine message={wifiRefusalMessage(confirm.error ?? revert.error)} />
      ) : null}
    </>
  )
}

/** The pill's one-tap "Keep" for a step that waits for an admin (admin_and_agent). */
function PillKeepButton({ step }: { step: WifiRolloutStep }) {
  const confirm = useConfirmApApply(step.apId)
  const apply = step.apply
  if (!apply) return null
  return (
    <Button size="sm" className="rounded-full" onClick={() => confirm.mutate(apply.id)} disabled={confirm.isPending}>
      {confirm.isPending ? <Spinner className="size-3.5 text-current" /> : <CheckCircle weight="bold" />}
      Keep
    </Button>
  )
}

/** The rollout-level actions (controller.md 6.4): Pause/Resume; on a stop Retry, Skip, Roll back, Cancel. */
export function RolloutActions({ rollout, compact = false }: { rollout: WifiRollout; compact?: boolean }) {
  const action = useRolloutAction()
  const cancelDialog = useDialog()
  const rollbackDialog = useDialog()
  const size = compact ? 'sm' : 'default'
  const stopAp = rollout.stop?.apId
  const stoppedStep = stopAp !== undefined ? rollout.steps.find((s) => s.apId === stopAp) : undefined
  const completed = rollout.steps.filter((s) => s.state === 'confirmed').length
  const run = (a: RolloutAction, apId?: number) => action.mutate({ id: rollout.id, action: a, apId })
  const busy = (a: RolloutAction) => action.isPending && action.variables?.action === a

  return (
    <>
      {rollout.state === 'running' ? (
        <Button size={size} variant="outline" onClick={() => run('pause')} disabled={action.isPending}>
          {busy('pause') ? <Spinner className="size-3.5" /> : <Pause weight="bold" />}
          Pause
        </Button>
      ) : null}
      {rollout.state === 'paused' ? (
        <Button size={size} onClick={() => run('resume')} disabled={action.isPending}>
          {busy('resume') ? <Spinner className="size-3.5 text-current" /> : <Play weight="bold" />}
          Resume
        </Button>
      ) : null}
      {rollout.state === 'stopped' && stoppedStep ? (
        <>
          <Button size={size} onClick={() => run('retry', stoppedStep.apId)} disabled={action.isPending} data-testid="rollout-retry">
            {busy('retry') ? <Spinner className="size-3.5 text-current" /> : <ArrowClockwise weight="bold" />}
            Retry {stoppedStep.apName}
          </Button>
          <Button size={size} variant="outline" onClick={() => run('skip', stoppedStep.apId)} disabled={action.isPending}>
            {busy('skip') ? <Spinner className="size-3.5" /> : <SkipForward weight="bold" />}
            Skip this AP
          </Button>
          {completed > 0 ? (
            <Button size={size} variant="outline" onClick={rollbackDialog.show} disabled={action.isPending}>
              <ArrowCounterClockwise weight="bold" />
              Roll back {plural(completed, 'AP')}
            </Button>
          ) : null}
        </>
      ) : null}
      {rollout.state === 'stopped' || rollout.state === 'paused' ? (
        <Button size={size} variant="ghost" onClick={cancelDialog.show} disabled={action.isPending}>
          <Stop weight="bold" />
          Cancel
        </Button>
      ) : null}
      {action.error ? <ErrorLine message={wifiRefusalMessage(action.error)} /> : null}
      <ConfirmDialog
        open={cancelDialog.open}
        onOpenChange={cancelDialog.setOpen}
        title="Cancel the rollout?"
        description="Access points not reached yet keep their current settings; Perch keeps the change as a draft for them. Access points already updated stay updated."
        confirmLabel="Cancel the rollout"
        destructive
        pending={busy('cancel')}
        onConfirm={() => action.mutate({ id: rollout.id, action: 'cancel' }, { onSuccess: () => cancelDialog.setOpen(false) })}
      />
      <ConfirmDialog
        open={rollbackDialog.open}
        onOpenChange={rollbackDialog.setOpen}
        title={`Roll back ${plural(completed, 'access point')}?`}
        description="Each access point this rollout already updated goes back to its settings from before it, one at a time."
        confirmLabel="Roll back"
        destructive
        pending={busy('rollback')}
        onConfirm={() => action.mutate({ id: rollout.id, action: 'rollback' }, { onSuccess: () => rollbackDialog.setOpen(false) })}
      />
    </>
  )
}

/** Every step in rollout order with its phase and clock. */
export function RolloutSteps({ rollout }: { rollout: WifiRollout }) {
  const live = rollout.state === 'running' || rollout.state === 'paused'
  const now = useNow(1000, live)
  return (
    <ol className="space-y-1.5" data-testid="rollout-steps">
      {[...rollout.steps]
        .sort((a, b) => a.position - b.position)
        .map((step) => {
          const phase = stepPhase(step, now)
          const active = step.state === 'applying'
          const stopped = rollout.stop?.apId === step.apId
          return (
            <li
              key={step.apId}
              className={cn(
                'rounded-lg border px-3 py-2.5',
                stopped ? 'border-status-critical/40 bg-status-critical/5' : active ? 'border-status-warning/50 bg-status-warning/5' : 'border-border',
              )}
            >
              <div className="flex items-center gap-2.5">
                <StepGlyph icon={phase.icon} />
                <span className="text-[13px] font-medium">{step.apName}</span>
                <span className={cn('min-w-0 flex-1 truncate text-xs', phase.tone === 'critical' ? 'text-status-critical' : 'text-muted-foreground')}>
                  {phase.label}
                </span>
                {phase.secondsLeft !== null && active && phase.icon !== 'radar' ? (
                  <span
                    className={cn(
                      'rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums',
                      phase.secondsLeft <= 15 && 'border-status-critical/60 text-status-critical',
                    )}
                    aria-label={`${Math.max(0, phase.secondsLeft)} seconds left`}
                  >
                    {formatCountdown(phase.secondsLeft)}
                  </span>
                ) : null}
              </div>
              {step.outcome?.message && step.state !== 'failed' ? (
                <p className="mt-1 pl-6.5 text-xs text-muted-foreground">{step.outcome.message}</p>
              ) : null}
              {step.apply?.health && !step.apply.health.ok && step.state === 'rolled_back' ? (
                <ul className="mt-1 space-y-0.5 pl-6.5 text-xs text-muted-foreground">
                  {step.apply.health.problems.map((p, i) => (
                    <li key={`${p.code}-${i}`}>{p.message}</li>
                  ))}
                </ul>
              ) : null}
              {active && step.apply?.state === 'pending_confirm' ? (
                <div className="mt-2 flex flex-wrap gap-2 pl-6.5">
                  <StepApplyButtons step={step} compact />
                </div>
              ) : null}
            </li>
          )
        })}
    </ol>
  )
}

function stopText(rollout: WifiRollout): string | null {
  if (!rollout.stop) return null
  const step = rollout.steps.find((s) => s.apId === rollout.stop!.apId)
  const text = outcomeReasonText(rollout.stop.reason)
  const reason = text.charAt(0).toLowerCase() + text.slice(1)
  return `Stopped at ${step?.apName ?? 'an access point'}: ${reason}${rollout.stop.message ? ` (${rollout.stop.message})` : ''}. It restored its previous settings; the others after it were not touched.`
}

/** The rollout in a sheet (a bottom sheet on a phone): state, steps, actions, what stopped it. */
export function RolloutDetailSheet({
  rolloutId,
  initial,
  open,
  onOpenChange,
  isAdmin,
}: {
  rolloutId: number
  initial?: WifiRollout
  open: boolean
  onOpenChange: (open: boolean) => void
  isAdmin: boolean
}) {
  const query = useRollout(open ? rolloutId : null)
  const rollout = query.data ?? initial
  const meta = rollout ? ROLLOUT_STATE_META[rollout.state] : null
  const openState = rollout && (rollout.state === 'running' || rollout.state === 'paused' || rollout.state === 'stopped')
  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={rollout ? `${ROLLOUT_KIND_LABEL[rollout.kind]} #${rollout.id}` : 'Rollout'}
      description={
        rollout ? (
          <span className="flex flex-wrap items-center gap-2">
            {meta ? <StatusPill tone={meta.tone}>{meta.label}</StatusPill> : null}
            <span>
              {rollout.requestedBy?.email ?? (rollout.requestedBy?.system ? 'Perch' : 'Someone')} · {formatDateTime(rollout.createdAt)}
            </span>
          </span>
        ) : undefined
      }
      footer={
        isAdmin && rollout && openState ? (
          <div className="flex flex-col-reverse flex-wrap gap-2 sm:flex-row sm:justify-end [&>*]:w-full sm:[&>*]:w-auto">
            <RolloutActions rollout={rollout} />
          </div>
        ) : undefined
      }
    >
      {!rollout ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          {rollout.stop ? (
            <p className="flex items-start gap-2 rounded-md border border-status-critical/40 bg-status-critical/10 px-2.5 py-2 text-xs">
              <WarningCircle weight="fill" className="mt-px size-4 shrink-0 text-status-critical" />
              {stopText(rollout)}
            </p>
          ) : null}
          {rollout.note ? <p className="text-xs text-muted-foreground">Note: {rollout.note}</p> : null}
          <RolloutSteps rollout={rollout} />
          <p className="text-[11px] text-muted-foreground">
            One access point at a time
            {rollout.confirmMode === 'admin_and_agent' ? ', each kept only when you press Keep changes' : ', each kept once it reconnects and its networks come up'}
            . Offline access points are {rollout.offlinePolicy === 'skip' ? 'skipped and catch up when they return' : 'waited for'}.
          </p>
        </div>
      )}
    </EditorSheet>
  )
}

// ── The app-wide progress (banner on desktop, pill above the tab bar on a phone) ──

function headline(rollout: WifiRollout, now: number): { title: string; detail: string | null; tone: 'run' | 'stop' | 'pause' | 'done' | 'cancel'; icon: ReactNode } {
  const { done, total } = rolloutProgress(rollout)
  const step = currentStep(rollout)
  if (rollout.state === 'completed') {
    const skipped = rollout.steps.filter((s) => s.state === 'skipped').length
    return {
      title: `WiFi updated on ${plural(done - skipped, 'access point')}`,
      detail: skipped > 0 ? `${plural(skipped, 'offline access point')} catch${skipped === 1 ? 'es' : ''} up when back` : null,
      tone: 'done',
      icon: <CheckCircle weight="fill" className="size-4 text-status-good" />,
    }
  }
  if (rollout.state === 'cancelled') {
    return { title: 'WiFi rollout cancelled', detail: `${done} of ${total} done`, tone: 'cancel', icon: <Stop weight="fill" className="size-4 text-muted-foreground" /> }
  }
  if (rollout.state === 'stopped') {
    return {
      title: `WiFi rollout stopped${step ? ` at ${step.apName}` : ''}`,
      detail: rollout.stop ? outcomeReasonText(rollout.stop.reason) : null,
      tone: 'stop',
      icon: <WarningCircle weight="fill" className="size-4 text-status-critical" />,
    }
  }
  if (rollout.state === 'paused') {
    return { title: 'WiFi rollout paused', detail: `${done} of ${total} done`, tone: 'pause', icon: <Pause weight="fill" className="size-4 text-primary" /> }
  }
  const phase = step ? stepPhase(step, now) : null
  return {
    title: `Updating WiFi · ${Math.min(done + 1, total)} of ${total}`,
    detail: step && phase ? `${step.apName}: ${phase.label.charAt(0).toLowerCase()}${phase.label.slice(1)}${phase.secondsLeft !== null && phase.icon !== 'radar' ? ` ${formatCountdown(phase.secondsLeft)}` : ''}` : null,
    tone: 'run',
    icon: phase && phase.icon !== 'busy' ? <StepGlyph icon={phase.icon} /> : <Spinner className="size-4" />,
  }
}

const TONE_SURFACE = {
  run: 'border-status-warning/60 bg-status-warning/10',
  stop: 'border-status-critical/40 bg-status-critical/10',
  pause: 'border-primary/30 bg-primary/5',
  done: 'border-status-good/40 bg-status-good/10',
  cancel: 'border-border bg-muted/40',
} as const

/**
 * The running (or stopped) rollout, app-wide (dashboard.md 1.6): a banner on
 * wide screens with the step chips and the actions; below lg a pill above
 * the bottom navigation that opens the rollout sheet. A spacer at the end of
 * the page keeps the last content clear of the pill. Loaded lazily by
 * `WifiRolloutBanner` (rollout-banner.tsx) only while there is one to show.
 */
export function RolloutProgress({
  rollout,
  isAdmin,
  onDismiss,
}: {
  rollout: WifiRollout
  isAdmin: boolean
  /** Finished rollouts can be dismissed. */
  onDismiss?: () => void
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const live = rollout.state === 'running'
  const now = useNow(1000, live)
  const head = headline(rollout, now)
  const open = rollout.state === 'running' || rollout.state === 'paused' || rollout.state === 'stopped'
  const step = currentStep(rollout)
  const steps = [...rollout.steps].sort((a, b) => a.position - b.position)

  return (
    <>
      <section
        className={cn(
          'hidden rounded-lg border px-3 py-2.5 text-xs shadow-sm lg:block',
          'transition-[opacity,translate] duration-base ease-out starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0',
          TONE_SURFACE[head.tone],
        )}
        aria-live="polite"
        data-testid="wifi-rollout-banner"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5">{head.icon}</span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-sm font-semibold">
              {head.title}
              {head.detail ? <span className="ml-2 text-xs font-normal text-muted-foreground">{head.detail}</span> : null}
            </p>
            {open ? (
              <ul className="flex flex-wrap gap-x-3 gap-y-1">
                {steps.map((s) => {
                  const phase = stepPhase(s, now)
                  return (
                    <li key={s.apId} className="flex items-center gap-1.5 text-muted-foreground">
                      <StepGlyph icon={phase.icon} className="size-3.5" />
                      <span className={s.state === 'applying' ? 'font-medium text-foreground' : ''}>{s.apName}</span>
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {isAdmin && live && step ? <StepApplyButtons step={step} compact /> : null}
            {isAdmin && open ? <RolloutActions rollout={rollout} compact /> : null}
            <Button size="sm" variant="ghost" onClick={() => setSheetOpen(true)}>
              Details
            </Button>
            {!open && onDismiss ? (
              <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
                <X />
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      <div aria-hidden className="order-last h-12 lg:hidden" />
      <div
        className={cn(
          'fixed inset-x-3 bottom-[calc(var(--bottom-nav-height)+0.5rem)] z-30 lg:hidden',
          'transition-[opacity,translate] duration-slow ease-out starting:translate-y-3 starting:opacity-0 motion-reduce:starting:translate-y-0',
        )}
      >
        {/* Opaque underneath: the tone tints are translucent and the page scrolls behind the pill. */}
        <div className="mx-auto max-w-xl rounded-full bg-card shadow-lg">
        <div className={cn('flex items-center gap-2 rounded-full border py-1.5 pr-1.5 pl-3.5', TONE_SURFACE[head.tone])}>
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 text-left select-none [-webkit-touch-callout:none]"
            aria-label={`${head.title}. Show details`}
            data-testid="wifi-rollout-pill"
          >
            <span className="shrink-0">{head.icon}</span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold">{head.title}</span>
              {head.detail ? <span className="block truncate text-[11px] text-muted-foreground">{head.detail}</span> : null}
            </span>
          </button>
          {isAdmin && live && step && stepPhase(step, now).needsAdmin ? <PillKeepButton step={step} /> : null}
          {!open && onDismiss ? (
            <Button size="icon" variant="ghost" className="rounded-full" aria-label="Dismiss" onClick={onDismiss}>
              <X />
            </Button>
          ) : (
            <Button size="icon" variant="ghost" className="rounded-full" aria-label="Show details" onClick={() => setSheetOpen(true)}>
              <CaretUp weight="bold" />
            </Button>
          )}
        </div>
        </div>
      </div>

      <RolloutDetailSheet
        rolloutId={rollout.id}
        initial={rollout}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        isAdmin={isAdmin}
      />
    </>
  )
}

/** A compact row of step glyphs (the history list). */
export function StepDots({ rollout }: { rollout: WifiRollout }) {
  const now = useNow(1000, false)
  return (
    <span className="inline-flex items-center gap-0.5">
      {[...rollout.steps]
        .sort((a, b) => a.position - b.position)
        .map((s) => (
          <span key={s.apId} title={`${s.apName}: ${stepPhase(s, now).label}`}>
            <StepGlyph icon={stepPhase(s, now).icon} className="size-3.5" />
          </span>
        ))}
    </span>
  )
}

