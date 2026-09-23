import { useState } from 'react'
import { Eye, PencilSimple, Plus, ShieldCheck, Trash } from '@phosphor-icons/react'
import { ConfirmDialog, ErrorLine, IssueList, ToneBadge } from '@/components/gateway-config/bits'
import {
  Field,
  NativePage,
  NativeWriteResult,
  RouterOwnedHint,
  StageOnly,
  SyncBadges,
  type NativeContext,
} from '@/components/gateway-native/native-ui'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useDeleteRoute, useGatewayRouting, useSaveRoute } from '@/hooks/use-gateway-native'
import { apiErrorCode } from '@/lib/api'
import { nativeErrorMessage } from '@/lib/gateway-native'
import { refusalIssues } from '@/lib/networks'
import { ROUTE_TYPES, type ConfigSectionRow, type GatewayRouting, type NativeWrite, type RouteType, type StaticRoute } from '@/types/gateway-native'

/**
 * Routing on the managed gateway (docs/gateway/native-sync.md section 4):
 * static routes, managed two-way; policy rules, mwan3 and pbr read-only
 * (owner decision 12: mwan3/pbr are not managed).
 */
export function GatewayRoutingPage() {
  return (
    <NativePage title="Routing" description="Static routes; policy rules and multi-WAN shown read-only">
      {(ctx) => <RoutingView ctx={ctx} />}
    </NativePage>
  )
}

function RoutingView({ ctx }: { ctx: NativeContext }) {
  const routing = useGatewayRouting(ctx.gateway.id)
  const [editing, setEditing] = useState<StaticRoute | 'new' | null>(null)
  const [deleting, setDeleting] = useState<StaticRoute | null>(null)
  const remove = useDeleteRoute(ctx.gateway.id)
  if (routing.isPending) return <p className="text-sm text-muted-foreground">Loading routes…</p>
  if (routing.error) return <ErrorLine message={nativeErrorMessage(routing.error)} />
  const data = routing.data
  return (
    <>
      <Panel
        flush
        title="Static routes"
        description={
          data.management.controllerAddress
            ? `The gateway agent reaches Perch at ${data.management.controllerAddress} through ${data.management.network ?? 'its default route'}: a route that would take that path away is refused.`
            : 'Routes the router installs in its tables.'
        }
        actions={
          !ctx.hardBlocked ? (
            <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
              <Plus className="size-3.5" />
              New route
            </Button>
          ) : null
        }
      >
        {data.routes.length === 0 ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground">No static routes.</p>
        ) : (
          <RoutesList routes={data.routes} ctx={ctx} onEdit={setEditing} onDelete={setDeleting} />
        )}
      </Panel>
      <PolicyRulesPanel data={data} />
      <MultiWanPanel data={data} />
      {editing ? (
        <RouteDialog ctx={ctx} data={data} route={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null)
            remove.reset()
          }
        }}
        title={`Delete the route to ${deleting?.target ?? ''}?`}
        description="The router drops it at the next apply."
        confirmLabel="Delete and apply"
        destructive
        pending={remove.isPending}
        error={remove.error ? nativeErrorMessage(remove.error) : null}
        onConfirm={() => deleting && remove.mutate({ perchId: deleting.id }, { onSuccess: () => setDeleting(null) })}
      />
    </>
  )
}

function RoutesList({
  routes,
  ctx,
  onEdit,
  onDelete,
}: {
  routes: StaticRoute[]
  ctx: NativeContext
  onEdit: (r: StaticRoute) => void
  onDelete: (r: StaticRoute) => void
}) {
  return (
    <ul className="divide-y divide-border border-t border-border">
      {routes.map((r) => (
        <li key={r.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 text-xs">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-medium break-all">{r.target ?? '?'}</span>
              {r.type !== 'unicast' ? <ToneBadge tone="serious">{r.type}</ToneBadge> : null}
              {!r.enabled ? <ToneBadge tone="neutral">Disabled</ToneBadge> : null}
              {r.managementPath ? (
                <ToneBadge tone="warning" title="Covers the controller's address: its apply is protected (longer confirm window)">
                  <ShieldCheck className="size-3" />
                  Management path
                </ToneBadge>
              ) : null}
              <SyncBadges sync={r.sync} />
            </div>
            <p className="font-mono text-[11px] break-all text-muted-foreground">
              IPv{r.family} · via {r.gateway ?? 'on-link'} · dev {r.interface ?? '—'}
              {r.metric !== null ? ` · metric ${r.metric}` : ''}
              {r.table ? ` · table ${r.table}` : ''}
              {Object.keys(r.extra).length > 0
                ? ` · ${Object.entries(r.extra)
                    .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(' ') : v}`)
                    .join(' · ')}`
                : ''}
            </p>
            {r.sync.owner === 'router' ? <RouterOwnedHint gatewayId={ctx.gateway.id} what="This route" /> : null}
          </div>
          {r.sync.owner === 'perch' && !ctx.hardBlocked ? (
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => onEdit(r)} aria-label={`Edit the route to ${r.target}`}>
                <PencilSimple className="size-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDelete(r)} aria-label={`Delete the route to ${r.target}`}>
                <Trash className="size-3.5" />
              </Button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

const DROPPING = new Set(['unreachable', 'prohibit', 'blackhole', 'throw'])

function RouteDialog({
  ctx,
  data,
  route,
  onClose,
}: {
  ctx: NativeContext
  data: GatewayRouting
  route: StaticRoute | null
  onClose: () => void
}) {
  const save = useSaveRoute(ctx.gateway.id)
  const [family, setFamily] = useState<'4' | '6'>(String(route?.family ?? 4) as '4' | '6')
  const [iface, setIface] = useState(route?.interface ?? data.interfaces.find((i) => i.lan)?.name ?? '')
  const [target, setTarget] = useState(route?.target ?? '')
  const [gateway, setGateway] = useState(route?.gateway ?? '')
  const [metric, setMetric] = useState(route?.metric !== null && route?.metric !== undefined ? String(route.metric) : '')
  const [table, setTable] = useState(route?.table ?? '')
  const [type, setType] = useState<RouteType>((route?.type as RouteType) ?? 'unicast')
  const [enabled, setEnabled] = useState(route?.enabled ?? true)
  const [stage, setStage] = useState(false)
  const [result, setResult] = useState<NativeWrite<unknown> | null>(null)
  const pathRefused = apiErrorCode(save.error) === 'routing_controller_path'

  const submit = () => {
    const input = {
      ...(route ? {} : { family: Number(family) as 4 | 6 }),
      interface: iface || null,
      target: target.trim(),
      gateway: gateway.trim() || null,
      metric: metric.trim() ? Number(metric) : null,
      table: table.trim() || null,
      type,
      enabled,
    }
    save.mutate({ perchId: route?.id ?? null, input, apply: !stage }, { onSuccess: setResult })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{route ? `Route to ${route.target}` : 'New static route'}</DialogTitle>
          <DialogDescription>Goes out in an apply the router confirms or rolls back on its own.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {result ? (
            <NativeWriteResult result={result} gatewayId={ctx.gateway.id} />
          ) : (
            <>
              {!route ? (
                <Field label="Family">
                  <Segmented
                    value={family}
                    onChange={setFamily}
                    ariaLabel="Address family"
                    size="xs"
                    className="w-fit"
                    options={[
                      { id: '4', label: 'IPv4' },
                      { id: '6', label: 'IPv6' },
                    ]}
                  />
                </Field>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Target" hint={family === '6' ? 'e.g. fd00:50::/64' : 'e.g. 192.168.50.0/24'}>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} className="font-mono" />
                </Field>
                <Field label="Interface" hint={DROPPING.has(type) ? 'Optional for this type.' : 'The network it leaves by.'}>
                  <select
                    value={iface}
                    onChange={(e) => setIface(e.target.value)}
                    className="h-8 w-full border border-input bg-transparent px-2 text-xs"
                  >
                    <option value="">—</option>
                    {data.interfaces.map((i) => (
                      <option key={i.name} value={i.name}>
                        {i.name}
                        {i.up === false ? ' (down)' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Gateway" hint="Next hop; empty = on-link.">
                  <Input value={gateway} onChange={(e) => setGateway(e.target.value)} className="font-mono" placeholder={family === '6' ? 'fd00::1' : '192.168.1.2'} />
                </Field>
                <Field label="Metric">
                  <Input value={metric} inputMode="numeric" onChange={(e) => setMetric(e.target.value)} className="font-mono" placeholder="0" />
                </Field>
                <Field label="Table" hint="Empty = main.">
                  <Input value={table} onChange={(e) => setTable(e.target.value)} className="font-mono" />
                </Field>
                <Field label="Type">
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as RouteType)}
                    className="h-8 w-full border border-input bg-transparent px-2 text-xs"
                  >
                    {ROUTE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs">Enabled</span>
                <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
              </div>
              {save.error ? (
                pathRefused ? (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <div>
                      <p className="font-medium text-destructive">Refused: this would cut the gateway off from Perch.</p>
                      <p>{nativeErrorMessage(save.error)}</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <ErrorLine message={nativeErrorMessage(save.error)} />
                    <IssueList issues={refusalIssues(save.error)} />
                  </>
                )
              ) : null}
              <StageOnly checked={stage} onChange={setStage} />
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {result ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={save.isPending}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={save.isPending || !target.trim()}>
                {save.isPending ? <Spinner className="size-3.5 text-current" /> : null}
                {stage ? 'Save draft' : 'Save and apply'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReadOnlyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Eye className="size-3.5 shrink-0" />
      {children}
    </p>
  )
}

function optionsText(options: Record<string, string | string[]>): string {
  return Object.entries(options)
    .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(' ') : v}`)
    .join(' · ')
}

function PolicyRulesPanel({ data }: { data: GatewayRouting }) {
  return (
    <Panel flush title="Policy rules" description={<ReadOnlyNote>Read only: policy routing is observed, not managed.</ReadOnlyNote>}>
      {data.policyRules.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">No `rule` sections.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {[...data.policyRules]
            .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
            .map((r) => (
              <li key={r.id} className="px-4 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium">{r.priority ?? '—'}</span>
                  <span className="text-muted-foreground">IPv{r.family}</span>
                  {r.lookup ? <span>lookup {r.lookup}</span> : null}
                  <span className="font-mono text-[11px] text-muted-foreground">{r.section}</span>
                </div>
                <p className="font-mono text-[11px] break-all text-muted-foreground">{optionsText(r.options)}</p>
              </li>
            ))}
        </ul>
      )}
    </Panel>
  )
}

function SectionRows({ rows }: { rows: ConfigSectionRow[] }) {
  return (
    <ul className="divide-y divide-border border-t border-border">
      {rows.map((r) => (
        <li key={r.id} className="px-4 py-1.5 text-xs">
          <span className="font-mono">
            {r.type} <span className="font-medium">{r.section}</span>
          </span>
          <p className="font-mono text-[11px] break-all text-muted-foreground">{optionsText(r.options)}</p>
        </li>
      ))}
    </ul>
  )
}

function MultiWanPanel({ data }: { data: GatewayRouting }) {
  const live = data.mwan3.observed
  const hasMwan3 = live !== null || data.mwan3.config !== null
  return (
    <Panel
      flush
      title="Multi-WAN (mwan3) and policy routing (pbr)"
      description={<ReadOnlyNote>Read only: mwan3 and pbr are not managed by Perch (owner decision).</ReadOnlyNote>}
    >
      {!hasMwan3 && !data.pbr.config ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Neither mwan3 nor pbr is configured on this router.</p>
      ) : null}
      {live ? (
        <div className="space-y-2 border-t border-border px-4 py-2.5 text-xs">
          <p className="text-muted-foreground">
            Service {live.service?.enabled ? 'enabled' : 'disabled'} at boot, {live.service?.running ? 'running' : 'not running'}
          </p>
          {live.interfaces.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {live.interfaces.map((i) => (
                <li key={i.name}>
                  <ToneBadge tone={i.status === 'online' ? 'good' : i.status === 'offline' ? 'critical' : 'neutral'} dot>
                    {i.name} · {i.status ?? 'unknown'}
                  </ToneBadge>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {data.mwan3.config ? (
        <>
          <p className="border-t border-border px-4 pt-2 text-[11px] font-medium text-muted-foreground">mwan3 config</p>
          <SectionRows rows={data.mwan3.config} />
        </>
      ) : null}
      {data.pbr.config ? (
        <>
          <p className="border-t border-border px-4 pt-2 text-[11px] font-medium text-muted-foreground">pbr config</p>
          <SectionRows rows={data.pbr.config} />
        </>
      ) : null}
    </Panel>
  )
}
