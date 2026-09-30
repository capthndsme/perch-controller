import { Link } from 'react-router-dom'
import { BellSimpleSlash, GearSix } from '@phosphor-icons/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { AlertRow } from '@/components/alerts/alert-row'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { cn } from '@/lib/utils'
import type { AlertSummary } from '@/types/alerts'

/**
 * What the bell opens (popover on desktop, sheet on a phone): the counts, the latest six alerts and the
 * ways on to the inbox. Loaded with the first hover or press of the bell.
 */
export function BellPanel({
  summary,
  sheet = false,
  onNavigate,
}: {
  summary: AlertSummary | undefined
  sheet?: boolean
  onNavigate: () => void
}) {
  const now = useNow(30_000)
  const active = summary ? summary.active.critical + summary.active.warning + summary.active.info : 0
  const Title = sheet ? DialogPrimitive.Title : 'h2'
  const latest = summary?.latest ?? []

  return (
    <div className="flex flex-col">
      <div className={cn('flex items-center justify-between gap-3 border-b border-border px-4', sheet ? 'pb-3' : 'py-2.5')}>
        <div className="min-w-0">
          <Title className="text-[15px] font-semibold sm:text-sm">Alerts</Title>
          <p className="text-xs text-muted-foreground">
            {summary ? <ActiveLine summary={summary} /> : 'Loading…'}
          </p>
        </div>
        <Button asChild variant="ghost" size="icon-sm" aria-label="Notification settings" title="Notification settings">
          <Link to="/settings/notifications" onClick={onNavigate}>
            <GearSix className="size-4" />
          </Link>
        </Button>
      </div>

      {summary && latest.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-6 py-8 text-center">
          <BellSimpleSlash className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">Nothing yet</p>
          <p className="text-xs text-muted-foreground">
            Perch lists here what needs you: an access point going silent, the internet dropping, a new device.
          </p>
        </div>
      ) : (
        <ul className={cn('divide-y divide-border/70', sheet ? 'max-h-[60svh] overflow-y-auto overscroll-contain' : 'max-h-[26rem] overflow-y-auto')}>
          {latest.map((alert) => (
            <li key={alert.id}>
              <AlertRow alert={alert} now={now} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      )}

      <div className={cn('flex gap-2 border-t border-border px-4 pt-3', sheet ? 'pb-1' : 'pb-3')}>
        <Button asChild variant="outline" size={sheet ? 'lg' : 'sm'} className="flex-1">
          <Link to="/alerts" onClick={onNavigate}>
            View all
          </Link>
        </Button>
        {active > 0 ? (
          <Button asChild variant="outline" size={sheet ? 'lg' : 'sm'} className="flex-1">
            <Link to="/alerts?view=active" onClick={onNavigate}>
              Active ({active})
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function ActiveLine({ summary }: { summary: AlertSummary }) {
  const { critical, warning, info } = summary.active
  if (critical + warning + info === 0) return <>All clear{summary.unread > 0 ? ` · ${summary.unread} unread` : ''}</>
  const parts = [
    critical ? `${critical} critical` : null,
    warning ? `${warning} warning` : null,
    info ? `${info} info` : null,
  ].filter(Boolean)
  return (
    <>
      Active: {parts.join(', ')}
      {summary.unread > 0 ? ` · ${summary.unread} unread` : ''}
    </>
  )
}
