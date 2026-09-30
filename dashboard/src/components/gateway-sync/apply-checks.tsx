import { useState } from 'react'
import { CheckCircle, MinusCircle, ShieldCheck, Warning, XCircle } from '@phosphor-icons/react'
import { TypedConfirmDialog } from '@/components/gateway-sync/typed-confirm-dialog'
import { Spinner } from '@/components/ui/spinner'
import { useConfirmApplyWithChecks } from '@/hooks/use-gateway-sync'
import { CHECKS_STATE_LABEL, checkItemTitle, syncRefusalMessage } from '@/lib/gateway-sync'
import { cn } from '@/lib/utils'
import type { ApplyChecks, CheckItem, CheckItemState } from '@/types/gateway-sync'

/**
 * The router-side checks of an apply (design gateway-sync dashboard.md 3,
 * protocol.md 1): after a change that could cut the internet the router
 * verifies interfaces, the default route, reachability and a name lookup,
 * refuses "Keep changes" until they pass, and undoes the change by itself
 * when they cannot. Shown inside the app-wide apply banner.
 */

function StateIcon({ state, animate }: { state: CheckItemState; animate: boolean }) {
  // Only a state reached while the banner is up pops in; what was there when
  // it appeared comes with it. The key remounts the glyph on every change.
  const pop = animate && 'transition-[scale,opacity] duration-base ease-out starting:opacity-0 motion-safe:starting:scale-75'
  switch (state) {
    case 'passed':
      return <CheckCircle key={state} weight="fill" className={cn('size-3.5 shrink-0 text-status-good', pop)} />
    case 'failed':
      return <XCircle key={state} weight="fill" className={cn('size-3.5 shrink-0 text-status-critical', pop)} />
    case 'skipped':
      return <MinusCircle key={state} weight="fill" className={cn('size-3.5 shrink-0 text-muted-foreground', pop)} />
    case 'running':
      return <Spinner key={state} className="size-3.5 shrink-0" />
    default:
      return (
        <span key={state} aria-hidden className="inline-block size-3.5 shrink-0 rounded-full border border-muted-foreground/50" />
      )
  }
}

function CheckRow({ item }: { item: CheckItem }) {
  const [first] = useState(item.state)
  const detail =
    item.state === 'skipped' ? `skipped: already failing before the change${item.detail ? ` (${item.detail})` : ''}` : item.detail
  return (
    <li className="flex min-w-0 items-start gap-1.5" data-check-state={item.state}>
      <span className="mt-px flex">
        <StateIcon state={item.state} animate={item.state !== first} />
      </span>
      <span className="min-w-0">
        <span className={cn(item.state === 'pending' ? 'text-muted-foreground' : 'text-foreground')}>
          {checkItemTitle(item)}
        </span>
        {item.mustPass ? <span className="ml-1 text-[10px] text-muted-foreground">(must pass)</span> : null}
        {detail ? <span className="block break-words text-[11px] text-muted-foreground">{detail}</span> : null}
      </span>
    </li>
  )
}

/** "Checks · 18 s of 60 s": how much of the router's budget is used. */
function budgetText(checks: ApplyChecks, now: number): string | null {
  if (checks.state !== 'running' || !checks.startedAt) return `up to ${checks.timeoutSeconds} s`
  const used = Math.max(0, Math.round((now - Date.parse(checks.startedAt)) / 1000))
  return `${Math.min(used, checks.timeoutSeconds)} s of ${checks.timeoutSeconds} s`
}

/** The checklist under the deadline: one row per item with its state and the router's detail. */
export function ApplyChecksList({ checks, now }: { checks: ApplyChecks; now: number }) {
  const budget = checks.state === 'pending' || checks.state === 'running' ? budgetText(checks, now) : null
  return (
    <div className="space-y-1.5 rounded-md border border-border/70 bg-background/60 px-2.5 py-2" data-testid="apply-checks">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium">
        <ShieldCheck weight="bold" className="size-3.5 text-muted-foreground" />
        {CHECKS_STATE_LABEL[checks.state]}
        {budget ? <span className="font-normal text-muted-foreground tabular-nums">· {budget}</span> : null}
      </p>
      <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {checks.items.map((item) => (
          <CheckRow key={item.id} item={item} />
        ))}
      </ul>
      {checks.allSkipped ? (
        <p className="flex items-start gap-1.5 font-medium">
          <Warning weight="fill" className="mt-px size-3.5 shrink-0 text-status-warning" />
          Nothing could be verified; check the internet yourself before keeping.
        </p>
      ) : null}
      {checks.state === 'overridden' ? (
        <p className="text-muted-foreground">
          Kept without the checks{checks.overriddenBy ? ` by ${checks.overriddenBy.email}` : ''}.
        </p>
      ) : null}
    </div>
  )
}

/** The failed items of a rolled-back job, compact (the finished banner). */
export function FailedChecksList({ items }: { items: CheckItem[] }) {
  if (items.length === 0) return null
  return (
    <ul className="space-y-1" data-testid="failed-checks">
      {items.map((item) => (
        <CheckRow key={item.id} item={item} />
      ))}
    </ul>
  )
}

/** The checks a planned job will run (the draft's `jobs[].checks`, all pending), for review dialogs. */
export function PlannedChecksList({ items }: { items: CheckItem[] }) {
  if (items.length === 0) return <p className="text-xs text-muted-foreground">No checks: the change cannot cut the internet.</p>
  return (
    <ul className="space-y-1 text-xs" data-testid="planned-checks">
      {items.map((item) => (
        <CheckRow key={item.id} item={item} />
      ))}
    </ul>
  )
}

/**
 * "Keep anyway…": keeps a change whose checks cannot pass (an ISP outage
 * during an unrelated edit), after the gateway's name is typed. Audited.
 */
export function KeepAnywayDialog({
  open,
  onOpenChange,
  gatewayId,
  gatewayName,
  applyId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  gatewayId: number
  gatewayName: string
  applyId: string
}) {
  const confirm = useConfirmApplyWithChecks()
  return (
    <TypedConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Keep the change on ${gatewayName} without the checks?`}
      description="The router could not verify that the internet still works after this change. Keep it only if you know why (the provider is down, say) and the change itself is right. This is logged with your name."
      expected={gatewayName}
      confirmLabel="Keep anyway"
      destructive
      pending={confirm.isPending}
      error={confirm.error ? syncRefusalMessage(confirm.error) : null}
      onConfirm={async (typed) => {
        try {
          await confirm.mutateAsync({ gatewayId, applyId, body: { overrideChecks: true, confirm: typed } })
          onOpenChange(false)
        } catch {
          // shown
        }
      }}
    />
  )
}
