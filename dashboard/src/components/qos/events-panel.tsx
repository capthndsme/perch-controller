import { Link } from 'react-router-dom'
import type { KnownDevice } from '@/components/qos/groups-panel'
import { ToneDot } from '@/components/qos/qos-bits'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { formatLastSeen } from '@/lib/collectors'
import { EVENT_TEXT, eventDetail, formatWhen } from '@/lib/qos'
import { macPath } from '@/lib/traffic'
import type { QosEvent } from '@/types/api'

/**
 * The router's shaper events (`qos.event`, the last 50 the controller holds in
 * memory, newest first): caps reached, quotas used up, WAN queues switched off
 * or on at the router, failed applies.
 */
export function EventsPanel({ events, devices }: { events: QosEvent[]; devices: KnownDevice[] }) {
  const names = new Map(devices.map((d) => [d.mac, d.name]))
  return (
    <Panel title="Events" description="From the router, newest first. The controller keeps the last 50 in memory (a restart clears them)." flush>
      {events.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState title="No events" description="Caps reached, quotas used up and pauses at the router show up here." />
        </div>
      ) : (
        <ol className="divide-y divide-border/70 border-t border-border/70">
          {events.map((e, i) => {
            const meta = EVENT_TEXT[e.type] ?? { label: e.type, tone: 'muted' as const }
            const detail = eventDetail(e.detail)
            return (
              <li key={`${e.receivedAt}-${i}`} className="flex items-start gap-2.5 px-4 py-2 text-[12.5px]">
                <ToneDot tone={meta.tone} className="mt-1.5" />
                <div className="min-w-0 flex-1">
                  <p>
                    <span className="font-medium">{meta.label}</span>
                    {e.mac ? (
                      <>
                        {' · '}
                        <Link to={`/devices/${macPath(e.mac)}`} className="hover:underline">
                          {names.get(e.mac) ?? e.mac}
                        </Link>
                      </>
                    ) : null}
                  </p>
                  {detail ? <p className="truncate text-[11px] text-muted-foreground">{detail}</p> : null}
                </div>
                <time dateTime={e.at} title={formatWhen(e.at)} className="shrink-0 text-[11px] text-muted-foreground">
                  {formatLastSeen(e.at)}
                </time>
              </li>
            )
          })}
        </ol>
      )}
    </Panel>
  )
}
