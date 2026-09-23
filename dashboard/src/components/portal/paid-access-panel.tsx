import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { TerminalStateBadge } from '@/components/portal/hotspot-ui'
import { Fact } from '@/components/portal/portal-ui'
import { useHotspotTerminals, usePriceTables } from '@/hooks/use-hotspot'
import { entitlementLabel } from '@/lib/hotspot'
import { formatQuota, rateLabel as speedLabel, relativeTime } from '@/lib/portal'
import type { Portal } from '@/types/api'

/**
 * The Setup tab's paid access and click-through facts (portal.md §14.3,
 * §14.7), with the portal's coin terminals and their live state.
 */
export function PaidAccessPanel({ portal, isAdmin, onEdit }: { portal: Portal; isAdmin: boolean; onEdit: () => void }) {
  const tables = usePriceTables({ enabled: portal.methods.payment })
  const terminals = useHotspotTerminals({ portalId: portal.id, enabled: portal.methods.payment })
  const table = tables.data?.find((t) => t.id === portal.payment.priceTableId)
  const ct = portal.clickThrough
  const ctSpeed = speedLabel(ct.downKbps, ct.upKbps)

  return (
    <Panel
      title="Paid access and click-through"
      className="lg:col-span-2"
      actions={
        isAdmin ? (
          <Button size="sm" variant="outline" onClick={onEdit}>
            Edit
          </Button>
        ) : null
      }
    >
      <div className="grid gap-5 lg:grid-cols-2">
        {portal.methods.payment ? (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-3">
              <Fact label="Price table">
                {table ? (
                  <Link to="/portal/price-tables" className="underline-offset-2 hover:underline">
                    {table.name} · {table.currency}
                  </Link>
                ) : portal.payment.priceTableId ? (
                  `Table ${portal.payment.priceTableId}`
                ) : (
                  'None'
                )}
              </Fact>
              <Fact label="Walk-away timeout">{portal.payment.idleTimeoutSeconds} s</Fact>
            </dl>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground">Coin terminals</p>
                <Link to={`/portal/terminals?portalId=${portal.id}`} className="text-[11px] underline underline-offset-2">
                  Manage
                </Link>
              </div>
              {terminals.data && terminals.data.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  None yet: guests see no way to pay until a terminal is added.
                </p>
              ) : null}
              <ul className="divide-y divide-border rounded-md border border-border empty:hidden">
                {(terminals.data ?? []).map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className="font-medium">{t.name}</span>
                      <TerminalStateBadge terminal={t} />
                    </span>
                    <span className="text-[11px] text-muted-foreground">{t.lastSeenAt ? `heartbeat ${relativeTime(t.lastSeenAt)}` : 'no heartbeat yet'}</span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground">
                Payments of this portal:{' '}
                <Link to={`/portal/payments?portalId=${portal.id}`} className="underline underline-offset-2">
                  ledger
                </Link>
                .
              </p>
            </div>
          </div>
        ) : null}
        {portal.methods.clickThrough ? (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-3">
              <Fact label="Free access">
                {entitlementLabel({ durationSeconds: ct.minutes * 60, quotaBytes: null, downKbps: null })}
                {ct.quotaBytes ? ` · ${formatQuota(ct.quotaBytes)}` : ''}
              </Fact>
              <Fact label="Speed">{ctSpeed ?? 'No cap'}</Fact>
              <Fact label="How often" className="col-span-2">
                {ct.perWindow} time{ct.perWindow === 1 ? '' : 's'} per device in any {ct.windowHours} h
              </Fact>
            </dl>
            {ct.terms ? (
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">Terms</p>
                <p className="max-h-32 overflow-y-auto rounded-md border border-border bg-muted/20 p-2.5 text-xs whitespace-pre-wrap">
                  {ct.terms}
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">No terms text: guests see only the Accept button.</p>
            )}
          </div>
        ) : null}
      </div>
    </Panel>
  )
}
