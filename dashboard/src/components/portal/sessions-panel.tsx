import { useState } from 'react'
import { ArrowDown, ArrowUp } from '@phosphor-icons/react'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { ErrorNote, Pager } from '@/components/portal/portal-ui'
import { usePortalSessions } from '@/hooks/use-portal'
import { formatBytes } from '@/lib/format-bytes'
import { formatDateTime, formatSeconds, normalizeMac } from '@/lib/portal'
import { cn } from '@/lib/utils'

const PAGE = 50

const END_REASONS: Record<string, string> = {
  expired: 'time up',
  quota: 'data used up',
  revoked: 'revoked',
  logout: 'logged out',
  router_deauth: 'removed on the router',
  replaced: 'replaced',
  moved: 'moved to another device',
  rejected: 'refused by the router',
  paused: 'idle',
  lost: 'lost by the router',
  removed: 'removed',
}

/** A portal's session history: one row per active stretch of a grant. */
export function SessionsPanel({ portalId }: { portalId: number }) {
  const [macInput, setMacInput] = useState('')
  const [offset, setOffset] = useState(0)
  const mac = normalizeMac(macInput) ?? undefined
  const sessions = usePortalSessions({ portalId, mac, limit: PAGE, offset })

  return (
    <Panel
      title="Sessions"
      description="Each stretch a device was online, newest first. Kept for the retention set under Settings → Guest portal."
      updating={sessions.isPlaceholderData}
      actions={
        <Input
          aria-label="Filter sessions by MAC"
          placeholder="Filter by MAC"
          value={macInput}
          onChange={(e) => {
            setMacInput(e.target.value)
            setOffset(0)
          }}
          className={cn('h-7 w-full rounded-md font-mono sm:w-52', macInput && !mac && 'border-status-warning')}
        />
      }
    >
      {sessions.error ? <ErrorNote error={sessions.error} /> : null}
      {sessions.isPending ? <p className="text-xs text-muted-foreground">Loading sessions…</p> : null}
      {sessions.data && sessions.data.items.length === 0 ? <EmptyState title="No sessions yet" /> : null}
      {sessions.data && sessions.data.items.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {sessions.data.items.map((session) => {
            const start = session.startedAt ? new Date(session.startedAt).getTime() : null
            const end = session.endedAt ? new Date(session.endedAt).getTime() : sessions.dataUpdatedAt
            const open = !session.endedAt
            return (
              <li key={session.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs">
                <span className="font-mono font-medium">{session.mac}</span>
                {session.ip ? <span className="font-mono text-[11px] text-muted-foreground">{session.ip}</span> : null}
                <span className="text-muted-foreground">
                  {formatDateTime(session.startedAt)}
                  {start !== null ? ` · ${formatSeconds((end - start) / 1000)}` : ''}
                </span>
                <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                  <ArrowDown className="size-3" />
                  {formatBytes(session.bytesDown)}
                  <ArrowUp className="ml-1 size-3" />
                  {formatBytes(session.bytesUp)}
                </span>
                <span className={cn('ml-auto text-[11px]', open ? 'font-medium text-status-good' : 'text-muted-foreground')}>
                  {open ? 'Online now' : session.endReason ? (END_REASONS[session.endReason] ?? session.endReason) : 'ended'}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
      {sessions.data ? <Pager offset={offset} limit={PAGE} total={sessions.data.total} onChange={setOffset} /> : null}
    </Panel>
  )
}
