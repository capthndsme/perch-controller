import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BellRinging, CaretRight, WebhooksLogo } from '@phosphor-icons/react'
import { DialogBody, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Drawer, DrawerContent } from '@/components/ui/drawer'
import { useDelivery } from '@/hooks/use-alerts'
import { useRetained } from '@/hooks/use-retained'
import {
  DELIVERY_STATUS,
  DELIVERY_TONE_CLASS,
  destinationName,
  formatWhen,
  HOLD_REASON_LABEL,
  TRANSITION_LABEL,
  WEBHOOK_FORMAT_LABEL,
} from '@/lib/alerts'
import { cn } from '@/lib/utils'
import type { DeliveryStatus, DeliveryView, DestinationRef } from '@/types/alerts'

export function DeliveryStatusChip({ status, className }: { status: DeliveryStatus; className?: string }) {
  const meta = DELIVERY_STATUS[status]
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-medium whitespace-nowrap',
        DELIVERY_TONE_CLASS[meta.tone],
        className,
      )}
    >
      {meta.label}
    </span>
  )
}

function destinationDetail(destination: DestinationRef | null): string | null {
  if (!destination) return null
  if (destination.kind === 'push') return destination.platform && destination.label ? destination.platform : 'Push'
  return WEBHOOK_FORMAT_LABEL[destination.format]
}

/** What happened to it in a few words: when it went, or why it waits. */
function deliveryLine(delivery: DeliveryView): string {
  if (delivery.status === 'sent') return `Sent ${formatWhen(delivery.sentAt)}`
  if (delivery.status === 'held' && delivery.holdReason)
    return `Held for ${HOLD_REASON_LABEL[delivery.holdReason]} until ${formatWhen(delivery.sendAfter)}`
  if (delivery.status === 'retrying' && delivery.nextAttemptAt) return `Next try ${formatWhen(delivery.nextAttemptAt)}`
  if (delivery.status === 'collapsed') return 'Replaced by a later message'
  return formatWhen(delivery.createdAt)
}

/**
 * Who an alert (or a destination) was sent to, newest first. Admins open a delivery for its attempts; the
 * retries themselves are automatic, so there is no retry button.
 */
export function DeliveryList({
  deliveries,
  canOpen,
  showDestination = true,
  showAlert = false,
}: {
  deliveries: DeliveryView[]
  canOpen: boolean
  showDestination?: boolean
  showAlert?: boolean
}) {
  const [openId, setOpenId] = useState<number | null>(null)
  return (
    <>
      <ul className="divide-y divide-border/70">
        {deliveries.map((delivery) => {
          const Icon = delivery.destination?.kind === 'webhook' ? WebhooksLogo : BellRinging
          const body = (
            <>
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-[13px] font-medium">
                    {showDestination ? destinationName(delivery.destination) : TRANSITION_LABEL[delivery.transition]}
                  </p>
                  <DeliveryStatusChip status={delivery.status} />
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {[
                    showDestination ? TRANSITION_LABEL[delivery.transition] : null,
                    showDestination ? destinationDetail(delivery.destination) : null,
                    showAlert && delivery.alertIds.length > 1 ? `${delivery.alertIds.length} alerts` : null,
                    deliveryLine(delivery),
                    delivery.attempts > 1 ? `${delivery.attempts} tries` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {delivery.lastError && delivery.status !== 'sent' ? (
                  <p className="line-clamp-2 text-xs text-destructive">
                    {delivery.lastStatusCode ? `${delivery.lastStatusCode}: ` : ''}
                    {delivery.lastError}
                  </p>
                ) : null}
              </div>
              {canOpen ? <CaretRight className="mt-1 size-3.5 shrink-0 text-muted-foreground" /> : null}
            </>
          )
          return (
            <li key={delivery.id}>
              {canOpen ? (
                <button
                  type="button"
                  onClick={() => setOpenId(delivery.id)}
                  className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors duration-base hover:bg-muted/40 active:bg-muted/70 active:duration-0"
                >
                  {body}
                </button>
              ) : (
                <div className="flex items-start gap-3 px-4 py-2.5">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
      {canOpen ? <DeliveryDrawer id={openId} onClose={() => setOpenId(null)} /> : null}
    </>
  )
}

/** One delivery's attempts (admin): status code, time taken, the receiver's answer. */
export function DeliveryDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const shownId = useRetained(id)
  const query = useDelivery(id)
  const delivery = query.data && query.data.id === shownId ? query.data : null
  return (
    <Drawer open={id !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DrawerContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Delivery #{shownId}</DialogTitle>
          {delivery ? (
            <DialogDescription>
              {TRANSITION_LABEL[delivery.transition]} to {destinationName(delivery.destination)}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogBody>
          {!delivery ? (
            <p className="text-muted-foreground">{query.error ? query.error.message : 'Loading…'}</p>
          ) : (
            <>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  <DeliveryStatusChip status={delivery.status} />
                </dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd>{formatWhen(delivery.createdAt)}</dd>
                {delivery.sentAt ? (
                  <>
                    <dt className="text-muted-foreground">Sent</dt>
                    <dd>{formatWhen(delivery.sentAt)}</dd>
                  </>
                ) : null}
                {delivery.nextAttemptAt ? (
                  <>
                    <dt className="text-muted-foreground">Next try</dt>
                    <dd>{formatWhen(delivery.nextAttemptAt)}</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Gives up</dt>
                <dd>{formatWhen(delivery.expiresAt)}</dd>
                {delivery.alertIds.length > 0 ? (
                  <>
                    <dt className="text-muted-foreground">{delivery.alertIds.length > 1 ? 'Alerts' : 'Alert'}</dt>
                    <dd className="flex flex-wrap gap-x-2">
                      {delivery.alertIds.slice(0, 20).map((alertId) => (
                        <Link key={alertId} to={`/alerts/${alertId}`} className="underline underline-offset-2" onClick={onClose}>
                          #{alertId}
                        </Link>
                      ))}
                    </dd>
                  </>
                ) : null}
              </dl>
              <div className="space-y-2">
                <p className="section-label">Attempts</p>
                {delivery.attempts.length === 0 ? (
                  <p className="text-muted-foreground">Not tried yet.</p>
                ) : (
                  <ol className="space-y-2">
                    {delivery.attempts.map((attempt, index) => (
                      <li key={`${attempt.attemptedAt}-${index}`} className="rounded-md border border-border p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">
                            {attempt.outcome === 'sent' ? 'Accepted' : attempt.outcome === 'retry' ? 'Will retry' : 'Failed'}
                            {attempt.statusCode ? ` · ${attempt.statusCode}` : ''}
                          </span>
                          <span className="text-muted-foreground tabular-nums">
                            {formatWhen(attempt.attemptedAt)} · {attempt.durationMs} ms
                          </span>
                        </div>
                        {attempt.error ? <p className="mt-1 text-destructive">{attempt.error}</p> : null}
                        {attempt.responseExcerpt ? (
                          <pre className="mt-1.5 max-h-32 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                            {attempt.responseExcerpt}
                          </pre>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          )}
        </DialogBody>
      </DrawerContent>
    </Drawer>
  )
}
