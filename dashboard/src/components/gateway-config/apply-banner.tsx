import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowCounterClockwise,
  CheckCircle,
  Clock,
  ShieldWarning,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useProfile } from '@/hooks/use-auth'
import { fetchApply, useConfirmApply, useGateways, useRevertApply } from '@/hooks/use-gateways'
import { useNow } from '@/hooks/use-now'
import {
  APPLY_KIND_LABEL,
  applyWindowText,
  formatCountdown,
  isOpenApply,
  OUTCOME_REASON,
  refusalMessage,
  secondsUntil,
} from '@/lib/gateway-config'
import { cn } from '@/lib/utils'
import type { Gateway, GatewayApply } from '@/types/gateway-config'

/**
 * The app-wide apply banner (plan 1 section 12.3): every open job of every
 * gateway with its confirm deadline, "Keep changes" and "Revert now", and the
 * outcome once the job leaves `pendingApply` (rolled back, failed, kept).
 * Mounted in the shell, because a network change may reload the page; the
 * jobs it watches survive a reload in sessionStorage.
 */

type Watched = { gatewayId: number; gatewayName: string; applyId: string }
type Finished = { gatewayId: number; gatewayName: string; apply: GatewayApply; seenAt: number }

const WATCH_KEY = 'perch-apply-watch'

function readWatched(): Watched[] {
  try {
    const raw = sessionStorage.getItem(WATCH_KEY)
    const parsed = raw ? (JSON.parse(raw) as Watched[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeWatched(list: Watched[]) {
  try {
    sessionStorage.setItem(WATCH_KEY, JSON.stringify(list))
  } catch {
    // per-tab convenience only
  }
}

export function GatewayApplyBanner() {
  const gateways = useGateways()
  const isAdmin = useProfile().data?.role === 'admin'
  const [finished, setFinished] = useState<Finished[]>([])
  const watched = useRef<Watched[]>(readWatched())

  const open = (gateways.data ?? []).filter((g) => g.pendingApply)

  // Watch open jobs; when one leaves `pendingApply`, fetch its outcome once.
  useEffect(() => {
    const list = gateways.data
    if (!list) return
    const byId = new Map(list.map((g) => [g.id, g]))
    const still: Watched[] = []
    const gone: Watched[] = []
    for (const w of watched.current) {
      const g = byId.get(w.gatewayId)
      if (g?.pendingApply?.id === w.applyId) still.push(w)
      else gone.push(w)
    }
    for (const g of list) {
      if (g.pendingApply && !still.some((w) => w.applyId === g.pendingApply!.id)) {
        still.push({ gatewayId: g.id, gatewayName: g.name, applyId: g.pendingApply.id })
      }
    }
    watched.current = still
    writeWatched(still)
    for (const w of gone) {
      fetchApply(w.gatewayId, w.applyId)
        .then((apply) => {
          // The list can lag behind the job: an apply still open is not an outcome yet.
          if (isOpenApply(apply.state)) return
          setFinished((current) => [
            ...current.filter((f) => f.apply.id !== apply.id),
            { gatewayId: w.gatewayId, gatewayName: w.gatewayName, apply, seenAt: Date.now() },
          ])
        })
        .catch(() => {
          // The job is gone (pruned) or the API is unreachable: nothing to report.
        })
    }
  }, [gateways.data])

  // A kept change is good news: it clears itself.
  useEffect(() => {
    if (!finished.some((f) => f.apply.state === 'confirmed')) return
    const timer = window.setTimeout(() => {
      setFinished((current) =>
        current.filter((f) => f.apply.state !== 'confirmed' || Date.now() - f.seenAt < 15_000),
      )
    }, 15_500)
    return () => window.clearTimeout(timer)
  }, [finished])

  if (open.length === 0 && finished.length === 0) return null

  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      {open.map((g) => (
        <OpenApplyBanner key={g.pendingApply!.id} gateway={g} apply={g.pendingApply!} isAdmin={isAdmin} />
      ))}
      {finished.map((f) => (
        <FinishedBanner
          key={f.apply.id}
          item={f}
          onDismiss={() => setFinished((current) => current.filter((x) => x.apply.id !== f.apply.id))}
        />
      ))}
    </div>
  )
}

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <li className={cn('flex items-center gap-1.5', done ? 'text-foreground' : 'text-muted-foreground')}>
      {done ? (
        <CheckCircle weight="fill" className="size-3.5 text-status-good" />
      ) : (
        <span aria-hidden className="inline-block size-3.5 rounded-full border border-muted-foreground/50" />
      )}
      {label}
    </li>
  )
}

function OpenApplyBanner({ gateway, apply, isAdmin }: { gateway: Gateway; apply: GatewayApply; isAdmin: boolean }) {
  const now = useNow(1000, apply.state === 'pending_confirm')
  const confirm = useConfirmApply()
  const revert = useRevertApply()
  const [confirmRevert, setConfirmRevert] = useState(false)
  const left = secondsUntil(apply.deadlineAt, now)
  const needsAdmin = apply.confirmMode === 'admin_and_agent' && apply.state === 'pending_confirm'
  const adminDone = apply.confirmations.admin !== null
  const error = confirm.error ?? revert.error
  const configs = apply.configs.length > 0 ? apply.configs.join(', ') : null
  const where = `/gateway/config/${gateway.id}`

  let title: string
  let body: string
  if (apply.state === 'queued') {
    title = `Change queued for ${gateway.name}`
    body = apply.queueExpiresAt
      ? `It goes out when the gateway’s agent is back; it expires at ${new Date(apply.queueExpiresAt).toLocaleString()}.`
      : 'It goes out when the gateway’s agent is back.'
  } else if (apply.state === 'sending') {
    title = `Applying on ${gateway.name}…`
    body = 'The router is saving a restore point, then committing and reloading.'
  } else if (apply.kind === 'revert') {
    title = `Authoritative Mode is reverting router edits on ${gateway.name}`
    body = 'Confirms on its own once the agent reconnects.'
  } else {
    title = needsAdmin && !adminDone ? `Keep the changes on ${gateway.name}?` : `Confirming the change on ${gateway.name}`
    body =
      needsAdmin && !adminDone
        ? 'Check that the network still works, then keep the changes. Without a confirmation the router restores the previous configuration by itself.'
        : 'The router restores the previous configuration by itself if the agent does not check in before the deadline.'
  }

  const tone = apply.protected ? 'border-status-serious/60 bg-status-serious/10' : 'border-status-warning/60 bg-status-warning/10'

  return (
    <section
      className={cn('rounded-lg border px-3 py-2.5 text-xs shadow-sm', tone)}
      aria-label={`Change on ${gateway.name}`}
      data-testid="apply-banner"
    >
      <div className="flex flex-col gap-x-4 gap-y-2 md:flex-row md:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          {apply.state === 'pending_confirm' ? (
            <Clock className="mt-0.5 size-4 shrink-0 text-status-warning" weight="bold" />
          ) : (
            <Spinner className="mt-0.5 size-4 shrink-0" />
          )}
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold">
              {title}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {APPLY_KIND_LABEL[apply.kind]}
                {configs ? ` · ${configs}` : ''}
              </span>
            </p>
            <p className="text-muted-foreground">{body}</p>
            {apply.protected ? (
              <p className="flex items-start gap-1.5 font-medium">
                <ShieldWarning className="mt-px size-3.5 shrink-0 text-status-serious" weight="fill" />
                Touches the management path (the network Perch reaches the router through), so it has a longer
                window ({applyWindowText(apply)}). If Perch cannot reach the router afterwards, it rolls back.
              </p>
            ) : null}
            {apply.state === 'pending_confirm' ? (
              <ul className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
                <Step done label="Applied on the router" />
                <Step done={apply.agentReconnectedAt !== null} label="Agent reconnected" />
                <Step done={apply.confirmations.agent !== null} label="Agent checked in" />
                {apply.confirmMode === 'admin_and_agent' ? <Step done={adminDone} label="You kept it" /> : null}
              </ul>
            ) : null}
            {error ? <p className="text-destructive">{refusalMessage(error)}</p> : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {apply.state === 'pending_confirm' && left !== null ? (
            <span
              className={cn(
                'rounded-md border border-border bg-background px-2 py-1 font-mono text-sm font-semibold tabular-nums',
                left <= 15 && 'border-status-critical/60 text-status-critical',
              )}
              aria-label={`${Math.max(0, left)} seconds left`}
              data-testid="apply-countdown"
            >
              {formatCountdown(left)}
            </span>
          ) : null}
          {isAdmin && needsAdmin && !adminDone ? (
            <Button
              size="sm"
              onClick={() => confirm.mutate({ gatewayId: gateway.id, applyId: apply.id })}
              disabled={confirm.isPending}
            >
              {confirm.isPending ? <Spinner className="size-3.5 text-current" /> : <CheckCircle weight="bold" />}
              Keep changes
            </Button>
          ) : null}
          {isAdmin && (apply.state === 'pending_confirm' || apply.state === 'queued') ? (
            confirmRevert ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => revert.mutate({ gatewayId: gateway.id, applyId: apply.id })}
                  disabled={revert.isPending}
                >
                  {revert.isPending ? <Spinner className="size-3.5 text-current" /> : null}
                  {apply.state === 'queued' ? 'Yes, cancel it' : 'Yes, roll back now'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRevert(false)}>
                  No
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmRevert(true)}>
                <ArrowCounterClockwise weight="bold" />
                {apply.state === 'queued' ? 'Cancel' : 'Revert now'}
              </Button>
            )
          ) : null}
          <Button asChild size="sm" variant="ghost">
            <Link to={`${where}?tab=changes`}>Details</Link>
          </Button>
        </div>
      </div>
    </section>
  )
}

function FinishedBanner({ item, onDismiss }: { item: Finished; onDismiss: () => void }) {
  const { apply, gatewayName, gatewayId } = item
  const ok = apply.state === 'confirmed'
  const neutral = apply.state === 'cancelled' || apply.state === 'expired'
  const reason = apply.outcome?.reason ? (OUTCOME_REASON[apply.outcome.reason] ?? apply.outcome.reason) : null
  const discarded = apply.outcome?.discardedConfigs ?? []

  let title: string
  if (ok) title = apply.kind === 'revert' ? `Router edits reverted on ${gatewayName}` : `Changes kept on ${gatewayName}`
  else if (apply.state === 'rolled_back') title = `The change on ${gatewayName} was rolled back`
  else if (apply.state === 'failed') title = `The change on ${gatewayName} failed`
  else if (apply.state === 'expired') title = `The queued change for ${gatewayName} expired`
  else title = `The change for ${gatewayName} was cancelled`

  return (
    <section
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs shadow-sm',
        ok
          ? 'border-status-good/40 bg-status-good/10'
          : neutral
            ? 'border-border bg-muted/40'
            : 'border-status-critical/40 bg-status-critical/10',
      )}
      data-testid="apply-outcome"
    >
      {ok ? (
        <CheckCircle weight="fill" className="mt-0.5 size-4 shrink-0 text-status-good" />
      ) : (
        <WarningCircle weight="fill" className={cn('mt-0.5 size-4 shrink-0', neutral ? 'text-muted-foreground' : 'text-status-critical')} />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        {ok && apply.revision !== null ? <p className="text-muted-foreground">Recorded as revision {apply.revision}.</p> : null}
        {reason ? <p>{reason}{apply.outcome?.assumed ? ' (assumed: the router sent no result in time)' : ''}.</p> : null}
        {apply.outcome?.error ? (
          <p>
            <span className="font-mono">{apply.outcome.error}</span>
            {apply.outcome.message ? `: ${apply.outcome.message}` : ''}
          </p>
        ) : null}
        {discarded.length > 0 ? (
          <p className="font-medium">
            Router edits made during the window were undone too ({discarded.join(', ')}). They are back as conflicts
            so you can keep them.{' '}
            <Link className="underline underline-offset-2" to={`/gateway/config/${gatewayId}?tab=conflicts`}>
              Review conflicts
            </Link>
          </p>
        ) : null}
        {!ok && !neutral ? (
          <p className="text-muted-foreground">Your draft is kept: fix it and apply again.</p>
        ) : null}
      </div>
      <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
        <X />
      </Button>
    </section>
  )
}
