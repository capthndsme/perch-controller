import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowsDownUp, GitDiff } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/firewall/firewall-ui'
import { ConfirmDialog } from '@/components/firewall/confirm-dialog'
import { useResolveOrder } from '@/hooks/use-firewall'
import { ORDER_STATUS_TEXT, applyChangesPath } from '@/lib/firewall'
import { cn } from '@/lib/utils'
import type { FirewallOrder, FirewallWriteSummary } from '@/types/firewall'

function formatWhen(value: string | null): string {
  if (!value) return ''
  const ts = Date.parse(value)
  if (Number.isNaN(ts)) return value
  return new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' }).format(ts)
}

/** Two orders side by side; entries whose place differs are marked. */
function OrderColumns({
  router,
  desired,
  nameOf,
}: {
  router: string[]
  desired: string[]
  nameOf: (id: string) => string
}) {
  const column = (title: string, ids: string[], other: string[]) => (
    <div className="min-w-0">
      <p className="section-label mb-1">{title}</p>
      <ol className="space-y-0.5">
        {ids.map((id, i) => (
          <li
            key={id}
            className={cn(
              'flex gap-2 rounded px-1.5 py-0.5 text-[12px]',
              other[i] !== id && 'bg-status-warning/15 font-medium',
            )}
          >
            <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{i + 1}</span>
            <span className="min-w-0 truncate">{nameOf(id)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {column('On the router', router, desired)}
      {column('In Perch', desired, router)}
    </div>
  )
}

/**
 * The state of an ordered list (rules or port forwards) and, for a conflict or
 * drift, how to settle it (`POST …/order/resolve`, firewall.md section 3).
 */
export function OrderStatus({
  type,
  order,
  gatewayId,
  canWrite,
  nameOf,
  onWrite,
}: {
  type: 'rule' | 'redirect'
  order: FirewallOrder | null
  gatewayId: number
  canWrite: boolean
  nameOf: (id: string) => string
  onWrite: (summary: FirewallWriteSummary) => void
}) {
  const resolve = useResolveOrder(gatewayId)
  const [asking, setAsking] = useState<'router' | 'controller' | null>(null)
  const [showOrders, setShowOrders] = useState(false)
  if (!order || order.status === 'in_sync') return null
  const noun = type === 'rule' ? 'rules' : 'port forwards'

  function run(take: 'router' | 'controller', apply: boolean) {
    resolve.mutate(
      { type, take, apply },
      {
        onSuccess: (data) => {
          setAsking(null)
          onWrite({
            what:
              take === 'router'
                ? `Kept the router’s order of the ${noun}`
                : `Perch’s order of the ${noun} goes to the router`,
            issues: [],
            apply: data.apply,
            applyError: data.applyError,
          })
        },
      },
    )
  }

  const dialog = asking ? (
    <ConfirmDialog
      title={asking === 'router' ? 'Keep the router’s order?' : 'Use Perch’s order?'}
      description={
        asking === 'router'
          ? `Perch takes the order the ${noun} have on the router now. Nothing is written to the router.`
          : `The router’s ${noun} are put back into Perch’s order by an apply (confirm and rollback as usual).`
      }
      confirmLabel={asking === 'router' ? 'Keep the router’s order' : 'Use Perch’s order'}
      pending={resolve.isPending}
      error={resolve.error}
      showApply={asking === 'controller'}
      onConfirm={(apply) => run(asking, apply)}
      onClose={() => {
        setAsking(null)
        resolve.reset()
      }}
    />
  ) : null

  if (order.status === 'ahead') {
    return (
      <Callout
        tone="info"
        icon={<ArrowsDownUp className="size-4" />}
        title={`The new order of the ${noun} is not on the router yet`}
        actions={
          <Button asChild size="xs" variant="outline">
            <Link to={applyChangesPath(gatewayId)}>Pending changes</Link>
          </Button>
        }
      >
        {ORDER_STATUS_TEXT.ahead}
      </Callout>
    )
  }

  const conflict = order.status === 'conflict'
  const routerOrder = order.conflict?.router ?? order.router
  return (
    <>
      <Callout
        tone={conflict ? 'critical' : 'warning'}
        icon={<GitDiff className="size-4" />}
        title={
          conflict
            ? `The order of the ${noun} was changed both here and on the router`
            : `The order of the ${noun} was changed on the router`
        }
        actions={
          <>
            <Button size="xs" variant="ghost" onClick={() => setShowOrders((v) => !v)}>
              {showOrders ? 'Hide orders' : 'Compare'}
            </Button>
            {canWrite ? (
              <>
                <Button size="xs" variant="outline" onClick={() => setAsking('router')}>
                  Keep the router’s
                </Button>
                {conflict ? (
                  <Button size="xs" onClick={() => setAsking('controller')}>
                    Use Perch’s
                  </Button>
                ) : null}
              </>
            ) : null}
          </>
        }
      >
        {conflict ? (
          <>
            The router’s order stays live until you choose.{' '}
            {order.conflict ? `Noticed ${formatWhen(order.conflict.detectedAt)}.` : ''} Until then new {noun} are placed,
            but nothing is reordered.
          </>
        ) : (
          <>
            {ORDER_STATUS_TEXT.drift} {order.driftSince ? `Changed ${formatWhen(order.driftSince)}.` : ''} Keep the
            router’s order to stop that.
          </>
        )}
      </Callout>
      {showOrders ? (
        <div className="card-surface p-3">
          <OrderColumns router={routerOrder} desired={order.desired} nameOf={nameOf} />
        </div>
      ) : null}
      {dialog}
    </>
  )
}
