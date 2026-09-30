import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Info, PencilSimple, Warning } from '@phosphor-icons/react'
import { ErrorLine, ToneBadge } from '@/components/gateway-config/bits'
import { NativePage, SyncBadges, type NativeContext } from '@/components/gateway-native/native-ui'
import { DdnsCard } from '@/components/gateway-sync/ddns-card'
import { MultiwanCard } from '@/components/gateway-sync/multiwan-card'
import { WanEditor } from '@/components/gateway-sync/wan-editor'
import { WanReviewDialog } from '@/components/gateway-sync/wan-review-dialog'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { useOrderWans, useWanHistory, useWanOverview } from '@/hooks/use-gateway-internet'
import { formatRelative } from '@/lib/gateway-observation'
import { syncRefusalMessage, unavailableText } from '@/lib/gateway-sync'
import { cn } from '@/lib/utils'
import type { WanOverview, WanTransition, WanView } from '@/types/gateway-sync'

/**
 * `/gateway/internet` (design gateway-sync dashboard.md 2, rest.md 3): the
 * uplinks in failover order with their live state, NAT links, multi-WAN,
 * dynamic DNS and the transition history. Every WAN write is staged and
 * reviewed (diff, the router's checks) before it is applied; the router
 * undoes a change that breaks the internet by itself.
 */
export function GatewayInternetPage() {
  return (
    <NativePage title="Internet" description="Uplinks, failover, dynamic DNS and multi-WAN">
      {(ctx) => <InternetView ctx={ctx} />}
    </NativePage>
  )
}

type Review = { perchIds: string[]; title: string }

function InternetView({ ctx }: { ctx: NativeContext }) {
  const q = useWanOverview(ctx.gateway.id)
  const [editing, setEditing] = useState<WanView | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  if (q.isPending) return <p className="text-sm text-muted-foreground">Loading the internet connections…</p>
  if (q.error) return <ErrorLine message={syncRefusalMessage(q.error)} />
  const v = q.data
  const blocked = unavailableText(v.available ? null : v.unavailableReason, ctx.gateway.name)
  const canWrite = ctx.isAdmin && v.available && !ctx.hardBlocked
  const openReview = (perchIds: string[], title: string) => {
    setEditing(null)
    setReview({ perchIds, title })
  }
  return (
    <>
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        Changes to the internet connection are tested on the router. If the internet does not come back, the router
        undoes the change by itself.
      </p>
      {v.adminOutside ? (
        <p className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/5 px-3 py-2 text-xs">
          <Warning className="mt-0.5 size-4 shrink-0 text-status-warning" />
          You are connected from outside this network. If a change breaks the internet you lose this page; the router
          undoes it by itself within the confirm window ({v.checks.confirmTimeoutSeconds} s).
        </p>
      ) : null}
      {blocked ? <p className="text-xs text-muted-foreground">{blocked}</p> : null}
      <UplinksPanel ctx={ctx} view={v} canWrite={canWrite} onEdit={setEditing} onReview={openReview} />
      {v.natLinks.length > 0 ? (
        <Panel
          title="Other upstream links"
          description="Links to another router (NAT behind NAT). They carry no default route of their own."
        >
          <ul className="divide-y divide-border">
            {v.natLinks.map((wan) => (
              <WanRow key={wan.id} wan={wan} canWrite={canWrite} onEdit={() => setEditing(wan)} />
            ))}
          </ul>
        </Panel>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        <MultiwanCard gatewayId={ctx.gateway.id} uplinks={v.uplinks} />
        <DdnsCard gatewayId={ctx.gateway.id} gatewayName={ctx.gateway.name} canWrite={ctx.isAdmin && !ctx.hardBlocked} />
      </div>
      <HistoryPanel gatewayId={ctx.gateway.id} />
      {editing ? (
        <WanEditor
          key={editing.id}
          gatewayId={ctx.gateway.id}
          wan={editing}
          onClose={() => setEditing(null)}
          onReview={openReview}
        />
      ) : null}
      {review ? (
        <WanReviewDialog
          key={review.perchIds.join(',')}
          gatewayId={ctx.gateway.id}
          perchIds={review.perchIds}
          title={review.title}
          onClose={() => setReview(null)}
        />
      ) : null}
    </>
  )
}

function UplinksPanel({
  ctx,
  view,
  canWrite,
  onEdit,
  onReview,
}: {
  ctx: NativeContext
  view: WanOverview
  canWrite: boolean
  onEdit: (wan: WanView) => void
  onReview: (perchIds: string[], title: string) => void
}) {
  const order = useOrderWans(ctx.gateway.id)
  const byMetric = view.failover.mode === 'metric'
  const move = (index: number, delta: number) => {
    const ids = view.uplinks.map((u) => u.id)
    const [moved] = ids.splice(index, 1)
    ids.splice(index + delta, 0, moved)
    order.mutate(
      { ids, apply: false },
      { onSuccess: () => onReview(ids, 'Review: the failover order') },
    )
  }
  return (
    <Panel
      title="Uplinks"
      description={
        byMetric
          ? 'In failover order. Failover is by route metric: traffic moves only when a link goes down.'
          : 'mwan3 decides how traffic uses them; the order is its policy’s.'
      }
      flush
    >
      {view.uplinks.length === 0 ? (
        <EmptyState title="No internet uplink" description="The router reports no WAN interface." className="py-10" />
      ) : (
        <ul className="divide-y divide-border">
          {view.uplinks.map((wan, i) => (
            <WanRow
              key={wan.id}
              wan={wan}
              canWrite={canWrite}
              onEdit={() => onEdit(wan)}
              reorder={
                byMetric && view.uplinks.length > 1 ? (
                  <span className="flex flex-col">
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Move ${wan.network} up`}
                      disabled={!canWrite || i === 0 || order.isPending}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp className="size-3" />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Move ${wan.network} down`}
                      disabled={!canWrite || i === view.uplinks.length - 1 || order.isPending}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown className="size-3" />
                    </Button>
                  </span>
                ) : null
              }
            />
          ))}
        </ul>
      )}
      {order.isPending ? (
        <p className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          Staging the new order…
        </p>
      ) : null}
      {order.error ? (
        <div className="px-4 pb-3">
          <ErrorLine message={syncRefusalMessage(order.error)} />
        </div>
      ) : null}
    </Panel>
  )
}

function statusOf(wan: WanView): { tone: 'good' | 'warning' | 'critical' | 'neutral'; text: string } {
  if (!wan.enabled) return { tone: 'neutral', text: 'Disabled' }
  if (!wan.live) return { tone: 'neutral', text: 'No report' }
  if (!wan.live.up) return { tone: 'critical', text: wan.live.error ? `Down (${wan.live.error})` : 'Down' }
  if (wan.role === 'internet' && !wan.live.defaultRouteActive) return { tone: 'warning', text: 'Up, no default route' }
  return { tone: 'good', text: 'Up' }
}

function uptime(seconds: number | null): string | null {
  if (seconds === null) return null
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86_400 * 2) return `${Math.round(seconds / 3600)} h`
  return `${Math.round(seconds / 86_400)} days`
}

function WanRow({
  wan,
  canWrite,
  onEdit,
  reorder,
}: {
  wan: WanView
  canWrite: boolean
  onEdit: () => void
  reorder?: ReactNode
}) {
  const status = statusOf(wan)
  const up = uptime(wan.live?.uptimeSeconds ?? null)
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      {reorder ?? null}
      <span
        aria-hidden
        className={cn(
          'mt-1.5 size-2 shrink-0 rounded-full',
          status.tone === 'good' && 'bg-status-good',
          status.tone === 'warning' && 'bg-status-warning',
          status.tone === 'critical' && 'bg-status-critical',
          status.tone === 'neutral' && 'bg-muted-foreground/40',
        )}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{wan.meta.label || wan.network}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{wan.network}</span>
          <ToneBadge tone="neutral">{wan.proto}</ToneBadge>
          {wan.failoverRank === 1 ? <ToneBadge tone="info">Primary</ToneBadge> : null}
          {wan.sqm ? <ToneBadge tone={wan.sqm.mismatch ? 'warning' : 'neutral'}>SQM</ToneBadge> : null}
          {wan.management ? <ToneBadge tone="info">Controller path</ToneBadge> : null}
          {wan.live?.mwan3Status ? (
            <ToneBadge tone={wan.live.mwan3Status === 'online' ? 'good' : 'warning'}>mwan3: {wan.live.mwan3Status}</ToneBadge>
          ) : null}
          <SyncBadges sync={wan.sync} />
        </div>
        <p className="text-xs text-muted-foreground">
          <span className={cn(status.tone === 'critical' && 'text-status-critical')}>{status.text}</span>
          {wan.device ? <> · {wan.device}</> : null}
          {wan.live?.ipv4.length ? (
            <>
              {' · '}
              <span className="font-mono text-foreground">{wan.live.ipv4.join(', ')}</span>
            </>
          ) : null}
          {wan.live?.gateway4 ? <> via <span className="font-mono">{wan.live.gateway4}</span></> : null}
          {up && wan.live?.up ? <> · up {up}</> : null}
          {wan.metric !== null ? <> · metric {wan.metric}</> : null}
        </p>
        {wan.live?.ipv6Prefixes.length ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            IPv6 {wan.live.ipv6Prefixes.map((p) => p.prefix).join(', ')}
          </p>
        ) : null}
        {wan.issues.length > 0 ? (
          <p className="text-[11px] text-status-warning">{wan.issues.map((i) => i.message).join(' ')}</p>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={onEdit}
        disabled={!canWrite || wan.sync.owner !== 'perch'}
        aria-label={`Edit ${wan.network}`}
      >
        <PencilSimple className="size-3.5" />
        Edit
      </Button>
    </li>
  )
}

// ── History ────────────────────────────────────────────────────────────────

type Range = '24h' | '7d' | '30d'

function describe(t: WanTransition): string {
  const d = t.detail ?? {}
  const list = (v: unknown) => (Array.isArray(v) && v.length > 0 ? v.join(', ') : 'none')
  switch (t.event) {
    case 'down':
      return `${t.network} went down`
    case 'up':
      return `${t.network} came back`
    case 'failover':
      return d.to ? `Traffic moved from ${String(d.from ?? 'nothing')} to ${String(d.to)}` : 'No uplink carries traffic'
    case 'ip_changed':
      return `${t.network} got a new address: ${list(d.after)} (was ${list(d.before)})`
    case 'prefix_changed':
      return `${t.network} got a new IPv6 prefix: ${list(d.after)}`
  }
}

/** How long a `down` lasted: until the next `up` of the same network. */
function outageSeconds(list: WanTransition[], index: number): number | null {
  const t = list[index]
  if (t.event !== 'down') return null
  const back = list.slice(index + 1).find((x) => x.network === t.network && x.event === 'up')
  return back ? (Date.parse(back.at) - Date.parse(t.at)) / 1000 : null
}

function span(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(1)} h`
}

function HistoryPanel({ gatewayId }: { gatewayId: number }) {
  const [range, setRange] = useState<Range>('7d')
  const q = useWanHistory(gatewayId, range)
  const list = q.data?.transitions ?? []
  return (
    <Panel
      title="History"
      description="When links went down, came back, failed over or changed address."
      actions={
        <Segmented
          size="xs"
          value={range}
          onChange={setRange}
          ariaLabel="Range"
          options={[
            { id: '24h', label: '24 h' },
            { id: '7d', label: '7 days' },
            { id: '30d', label: '30 days' },
          ]}
        />
      }
    >
      {q.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : q.error ? (
        <ErrorLine message={syncRefusalMessage(q.error)} />
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing happened in this range.</p>
      ) : (
        <ol className="space-y-1 text-xs">
          {list
            .map((t, i) => ({ t, outage: outageSeconds(list, i) }))
            .reverse()
            .map(({ t, outage }, i) => (
              <li key={`${t.at}-${t.network}-${t.event}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
                <time dateTime={t.at} title={new Date(t.at).toLocaleString()} className="w-20 shrink-0 text-muted-foreground">
                  {formatRelative(t.at)}
                </time>
                <span className={cn(t.event === 'down' && 'text-status-critical')}>{describe(t)}</span>
                {outage !== null ? <span className="text-muted-foreground">for {span(outage)}</span> : null}
              </li>
            ))}
        </ol>
      )}
    </Panel>
  )
}
