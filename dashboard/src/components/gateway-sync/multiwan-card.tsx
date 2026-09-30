import { Link } from 'react-router-dom'
import { LockSimple } from '@phosphor-icons/react'
import { ErrorLine, FactRow, ToneBadge } from '@/components/gateway-config/bits'
import { CopyButton } from '@/components/ui/copy-button'
import { Panel } from '@/components/ui/panel'
import { useMultiwan } from '@/hooks/use-gateway-internet'
import { isNotBuilt, syncRefusalMessage } from '@/lib/gateway-sync'
import type { MultiwanView, WanView } from '@/types/gateway-sync'

/**
 * Multi-WAN on the Internet page (design gateway-sync dashboard.md 2.6,
 * rest.md 10): mwan3's profile as Perch reads it, the members with their
 * live state, tracking and notes. Read-only (owner decision 12): the banner
 * says why and what would change that.
 */

const KIND_LABEL: Record<NonNullable<MultiwanView['profile']>['kind'], string> = {
  failover: 'Failover',
  balance: 'Load balancing',
  custom: 'Custom policy',
}

const ROUTER_READ_ONLY_LINE =
  "uci add_list perch-collector.main.managed_config='mwan3' && uci commit perch-collector && /etc/init.d/perch-collector restart"

function Blocked({ view }: { view: MultiwanView }) {
  switch (view.writeBlockedReason) {
    case 'owner_decision_12':
      return (
        <>
          Perch shows mwan3 but does not change it (owner decision 12). The owner can switch this on in{' '}
          <Link to="/settings/gateway-sync" className="underline underline-offset-2">
            Settings → Gateway sync
          </Link>
          .
        </>
      )
    case 'router_read_only':
      return (
        <span className="space-y-1">
          <span className="block">The router keeps mwan3 read-only for Perch. To allow it, run on the router:</span>
          <span className="flex items-center gap-1.5">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{ROUTER_READ_ONLY_LINE}</code>
            <CopyButton value={ROUTER_READ_ONLY_LINE} ariaLabel="Copy the command" />
          </span>
        </span>
      )
    case 'capability_missing':
      return <>The gateway agent is too old to change mwan3. Update it (Settings → Collectors).</>
    default:
      return null
  }
}

export function MultiwanCard({ gatewayId, uplinks }: { gatewayId: number; uplinks: WanView[] }) {
  const q = useMultiwan(gatewayId)
  if (q.error && isNotBuilt(q.error)) return null
  const v = q.data
  return (
    <Panel
      title="Multi-WAN"
      description="How traffic is shared between uplinks when mwan3 runs on the router."
      actions={
        v?.installed ? (
          <span className="flex items-center gap-1.5">
            <ToneBadge tone={v.service.running ? 'good' : 'neutral'} dot>
              {v.service.running ? 'Running' : v.service.enabled ? 'Enabled, not running' : 'Not running'}
            </ToneBadge>
            {!v.writable ? (
              <ToneBadge tone="neutral" title="Perch does not change mwan3">
                <LockSimple className="size-3" />
                Read-only
              </ToneBadge>
            ) : null}
          </span>
        ) : null
      }
    >
      {q.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : q.error ? (
        <ErrorLine message={syncRefusalMessage(q.error)} />
      ) : !v!.installed ? (
        <p className="text-xs text-muted-foreground">
          mwan3 is not installed: the router fails over by route metric, and traffic moves only when a link goes down.
        </p>
      ) : (
        <MultiwanBody view={v!} uplinks={uplinks} />
      )}
    </Panel>
  )
}

function MultiwanBody({ view, uplinks }: { view: MultiwanView; uplinks: WanView[] }) {
  const p = view.profile
  const statusOf = (wan: string) => uplinks.find((u) => u.network === wan)?.live?.mwan3Status ?? null
  return (
    <div className="space-y-3 text-xs">
      {view.writeBlockedReason ? (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-muted-foreground">
          <Blocked view={view} />
        </p>
      ) : null}
      {p ? (
        <>
          <p className="text-sm">
            {KIND_LABEL[p.kind]} across {p.members.map((m) => m.wan).join(' and ') || 'no members'}
          </p>
          <table className="w-full">
            <thead className="text-left text-[11px] text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Uplink</th>
                <th className="py-1 font-medium">Metric</th>
                <th className="py-1 font-medium">Weight</th>
                <th className="py-1 font-medium">mwan3</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {p.members.map((m) => {
                const status = statusOf(m.wan)
                return (
                  <tr key={m.wan}>
                    <td className="py-1.5 font-mono">{m.wan}</td>
                    <td className="py-1.5 font-mono">{m.metric}</td>
                    <td className="py-1.5 font-mono">{m.weight}</td>
                    <td className="py-1.5">
                      {status ? <ToneBadge tone={status === 'online' ? 'good' : 'warning'}>{status}</ToneBadge> : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {p.tracking ? (
            <div>
              <FactRow label="Tracking">
                <span className="font-mono">{p.tracking.targets.join(', ') || '—'}</span>
              </FactRow>
              <FactRow label="Counts as up">
                {p.tracking.reliability} of {p.tracking.count} replies, every {p.tracking.interval} s; down after{' '}
                {p.tracking.down} misses, up after {p.tracking.up}
              </FactRow>
            </div>
          ) : null}
          {p.rules.length > 0 ? (
            <div className="space-y-1">
              <p className="font-medium">Rules</p>
              <ul className="space-y-0.5">
                {p.rules.map((r) => (
                  <li key={r.name}>
                    <span className="font-mono">{r.name}</span>: {r.summary} → {r.policy}
                    {r.sticky ? ' (sticky)' : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {p.notes.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
              {p.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground">No mwan3 policy Perch can describe; see the router’s config.</p>
      )}
    </div>
  )
}
