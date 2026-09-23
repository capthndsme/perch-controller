import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowCounterClockwise, CheckCircle } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { Spinner } from '@/components/ui/spinner'
import { ActorName } from '@/components/gateway-config/actor'
import { ConfirmDialog, DiffList, ToneBadge } from '@/components/gateway-config/bits'
import { useDialog } from '@/hooks/use-dialog'
import { useEvents, useRestoreRevision, useRevision, useRevisions } from '@/hooks/use-gateways'
import {
  EVENT_LABEL,
  eventTone,
  formatDateTime,
  REVISION_SOURCE_LABEL,
  refusalMessage,
  ROUTER_EVENTS,
  routerAuthorLabel,
} from '@/lib/gateway-config'
import type { Gateway, GatewayRevision } from '@/types/gateway-config'

/** Revisions (the agreed states), their diffs, and restore into the draft. */
export function HistoryPanel({ gateway, isAdmin }: { gateway: Gateway; isAdmin: boolean }) {
  const revisions = useRevisions(gateway.id)
  const [open, setOpen] = useState<number | null>(null)
  const items = revisions.data?.pages.flatMap((p) => p.items) ?? []
  return (
    <Panel
      title="History"
      description="Every state both sides agreed on, whoever made it. A tick marks states known to work on the router."
      flush
    >
      {revisions.isPending ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState title="No revisions yet" description="The first read of the router records revision 1." />
        </div>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border text-xs">
          {items.map((rev) => (
            <li key={rev.number}>
              <button
                type="button"
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-left hover:bg-muted/40"
                onClick={() => setOpen(open === rev.number ? null : rev.number)}
                aria-expanded={open === rev.number}
              >
                <span className="w-10 font-mono font-medium">#{rev.number}</span>
                {rev.confirmedAt ? (
                  <CheckCircle weight="fill" className="size-3.5 text-status-good" aria-label="Confirmed working" />
                ) : (
                  <span className="size-3.5" />
                )}
                <ToneBadge tone={rev.source === 'rollback' ? 'serious' : rev.source === 'controller' ? 'info' : 'neutral'}>
                  {REVISION_SOURCE_LABEL[rev.source]}
                </ToneBadge>
                <span className="min-w-0 flex-1 truncate">{rev.summary}</span>
                <span className="text-muted-foreground">
                  <ActorName actor={rev.author} fallback={routerAuthorLabel(rev.routerAuthor) ?? '—'} /> ·{' '}
                  {formatDateTime(rev.createdAt)}
                </span>
              </button>
              {open === rev.number ? (
                <RevisionDetail gateway={gateway} revision={rev} isAdmin={isAdmin} isHead={rev.number === gateway.headRevision} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {revisions.hasNextPage ? (
        <div className="border-t border-border px-4 py-2">
          <Button size="xs" variant="ghost" onClick={() => revisions.fetchNextPage()} disabled={revisions.isFetchingNextPage}>
            Load older
          </Button>
        </div>
      ) : null}
    </Panel>
  )
}

function RevisionDetail({
  gateway,
  revision,
  isAdmin,
  isHead,
}: {
  gateway: Gateway
  revision: GatewayRevision
  isAdmin: boolean
  isHead: boolean
}) {
  const detail = useRevision(gateway.id, revision.number)
  const restore = useRestoreRevision(gateway.id)
  const dialog = useDialog()
  const navigate = useNavigate()
  return (
    <div className="space-y-2 bg-muted/20 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {revision.applyId ? <span>Apply <span className="font-mono">{revision.applyId}</span></span> : null}
        {revision.confirmedAt ? <span>Confirmed working {formatDateTime(revision.confirmedAt)}</span> : <span>Not confirmed on the router</span>}
        {revision.note ? <span>Note: {revision.note}</span> : null}
        {isAdmin && gateway.mode === 'managed' && !isHead ? (
          <Button size="xs" variant="outline" className="ml-auto" onClick={() => { restore.reset(); dialog.show() }}>
            <ArrowCounterClockwise />
            Restore this revision
          </Button>
        ) : null}
      </div>
      {detail.isPending ? <Spinner className="size-3.5" /> : <DiffList entries={detail.data?.diff ?? []} />}
      <ConfirmDialog
        open={dialog.open}
        onOpenChange={dialog.setOpen}
        title={`Restore revision #${revision.number}?`}
        description="Perch’s draft becomes that revision’s configuration. Nothing is written until you apply it on the Changes tab."
        confirmLabel="Put it into the draft"
        pending={restore.isPending}
        error={restore.error ? refusalMessage(restore.error) : null}
        onConfirm={async () => {
          try {
            await restore.mutateAsync(revision.number)
            dialog.setOpen(false)
            navigate('?tab=changes')
          } catch {
            // shown
          }
        }}
      >
        {!revision.confirmedAt ? (
          <p className="text-status-serious">This revision was never confirmed working on the router.</p>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}

/** The audit log (`gateway_config_events`). */
export function ActivityPanel({ gateway }: { gateway: Gateway }) {
  const events = useEvents(gateway.id)
  const items = events.data?.pages.flatMap((p) => p.items) ?? []
  return (
    <Panel title="Activity" description="Everything that happened to this gateway’s configuration, with who did it." flush>
      {events.isPending ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border text-xs">
          {items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2">
              <span className="w-32 shrink-0 text-muted-foreground tabular-nums">{formatDateTime(e.createdAt)}</span>
              <ToneBadge tone={eventTone(e.event)}>{EVENT_LABEL[e.event] ?? e.event}</ToneBadge>
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block">
                  <ActorName actor={e.user} fallback={ROUTER_EVENTS.has(e.event) ? 'On the router' : 'Perch'} />
                  {e.applyId ? <span className="ml-2 font-mono text-[11px] text-muted-foreground">{e.applyId}</span> : null}
                  {e.revision !== null ? <span className="ml-2 text-muted-foreground">rev #{e.revision}</span> : null}
                </span>
                {e.detail && Object.keys(e.detail).length > 0 ? (
                  <span className="block font-mono text-[11px] break-all text-muted-foreground">{detailText(e.detail)}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {events.hasNextPage ? (
        <div className="border-t border-border px-4 py-2">
          <Button size="xs" variant="ghost" onClick={() => events.fetchNextPage()} disabled={events.isFetchingNextPage}>
            Load older
          </Button>
        </div>
      ) : null}
    </Panel>
  )
}

function detailText(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('  ')
    .slice(0, 400)
}
