import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  CaretDown,
  CaretUp,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
  Warning,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/firewall/confirm-dialog'
import { SyncBadge, ToneBadge } from '@/components/firewall/firewall-ui'
import { OrderStatus } from '@/components/firewall/order-status'
import { PortForwardDialog } from '@/components/firewall/port-forward-dialog'
import {
  useDeletePortForward,
  useUpdatePortForward,
  type FirewallDevice,
} from '@/hooks/use-firewall'
import { firewallErrorMessage, firstPort, formatPorts, formatProto, forwardTitle } from '@/lib/firewall'
import { cn } from '@/lib/utils'
import type { FirewallIssue, FirewallOverview, FirewallWriteSummary, PortForward } from '@/types/firewall'

type SortKey = 'external' | 'name' | 'device' | 'internal' | 'order' | 'status'
type Filter = 'all' | 'enabled' | 'disabled' | 'warnings'

type Row = {
  forward: PortForward
  title: string
  target: { name: string; mac: string | null; reserved: boolean }
  warnings: string[]
}

type Devices = { list: FirewallDevice[]; byMac: Map<string, FirewallDevice>; byIp: Map<string, FirewallDevice> }

/**
 * Port forwards (DNAT redirects, firewall.md section 4): searchable and
 * sortable for a router with dozens of them, with overlap warnings, the sync
 * state, and the admin's create / edit / enable / delete.
 */
export function PortForwardsPanel({
  gatewayId,
  overview,
  devices,
  canWrite,
  writeHint,
  onWrite,
}: {
  gatewayId: number
  overview: FirewallOverview
  devices: Devices
  canWrite: boolean
  writeHint: string | null
  onWrite: (summary: FirewallWriteSummary) => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'external', dir: 1 })
  const [editing, setEditing] = useState<PortForward | 'new' | null>(null)
  const [deleting, setDeleting] = useState<PortForward | null>(null)
  const update = useUpdatePortForward(gatewayId)
  const remove = useDeletePortForward(gatewayId)
  const [toggleError, setToggleError] = useState<string | null>(null)

  const byId = useMemo(() => new Map(overview.portForwards.map((f) => [f.id, f])), [overview.portForwards])
  const nameOf = (id: string) => {
    const f = byId.get(id)
    return f ? forwardTitle(f) : null
  }

  const issuesById = useMemo(() => {
    const map = new Map<string, FirewallIssue[]>()
    for (const issue of overview.issues) {
      if (!issue.perchId || !byId.has(issue.perchId)) continue
      map.set(issue.perchId, [...(map.get(issue.perchId) ?? []), issue])
    }
    return map
  }, [overview.issues, byId])

  const rows: Row[] = useMemo(
    () =>
      overview.portForwards.map((f) => {
        const known = f.device ? devices.byMac.get(f.device.mac.toLowerCase()) : f.destIp ? devices.byIp.get(f.destIp) : undefined
        const target = f.device
          ? { name: known?.name ?? f.device.name ?? f.device.mac, mac: f.device.mac.toLowerCase(), reserved: true }
          : { name: known?.name ?? f.destIp ?? '—', mac: known?.mac ?? null, reserved: false }
        const warnings: string[] = []
        if (f.shadowedBy) {
          warnings.push(
            `Never used: “${titleOf(byId.get(f.shadowedBy)) ?? f.shadowedBy}” earlier in the list forwards the same port, and the first match wins.`,
          )
        }
        for (const issue of issuesById.get(f.id) ?? []) {
          if (issue.code !== 'firewall_redirect_shadowed') warnings.push(issue.message)
        }
        if (f.sync.issue === 'ambiguous') warnings.push('Another router forward has the same name: Perch only observes both until one is renamed.')
        return { forward: f, title: forwardTitle(f), target, warnings }
      }),
    [overview.portForwards, devices.byMac, devices.byIp, issuesById, byId],
  )

  const counts = {
    total: rows.length,
    enabled: rows.filter((r) => r.forward.enabled).length,
    warnings: rows.filter((r) => r.warnings.length > 0).length,
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = rows.filter((r) => {
      if (filter === 'enabled' && !r.forward.enabled) return false
      if (filter === 'disabled' && r.forward.enabled) return false
      if (filter === 'warnings' && r.warnings.length === 0) return false
      if (!q) return true
      const f = r.forward
      return [r.title, r.target.name, f.destIp ?? '', f.externalPort ?? '', f.destPort ?? '', f.proto.join(' '), r.target.mac ?? '', f.sync.section]
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
    const cmp = (a: Row, b: Row): number => {
      switch (sort.key) {
        case 'name':
          return a.title.localeCompare(b.title)
        case 'device':
          return a.target.name.localeCompare(b.target.name)
        case 'internal':
          return firstPort(a.forward.destPort ?? a.forward.externalPort) - firstPort(b.forward.destPort ?? b.forward.externalPort)
        case 'order':
          return (a.forward.position ?? 0) - (b.forward.position ?? 0)
        case 'status':
          return Number(b.warnings.length > 0) - Number(a.warnings.length > 0) || Number(b.forward.enabled) - Number(a.forward.enabled)
        default:
          return firstPort(a.forward.externalPort) - firstPort(b.forward.externalPort) || (a.forward.position ?? 0) - (b.forward.position ?? 0)
      }
    }
    return list.sort((a, b) => cmp(a, b) * sort.dir)
  }, [rows, query, filter, sort])

  function toggle(f: PortForward, enabled: boolean) {
    setToggleError(null)
    update.mutate(
      { id: f.id, body: { enabled } },
      {
        onSuccess: (data) =>
          onWrite({
            what: `${enabled ? 'Enabled' : 'Disabled'} “${forwardTitle(f)}”`,
            issues: data.issues,
            apply: data.apply,
            applyError: data.applyError,
          }),
        onError: (error) => setToggleError(`${forwardTitle(f)}: ${firewallErrorMessage(error, nameOf)}`),
      },
    )
  }

  const header = (key: SortKey, label: string, className?: string) => (
    <th className={cn('px-3 py-2 font-medium', className)} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))}
      >
        {label}
        {sort.key === key ? sort.dir === 1 ? <CaretUp className="size-3" /> : <CaretDown className="size-3" /> : null}
      </button>
    </th>
  )

  const canEdit = (f: PortForward) => canWrite && f.sync.scope === 'synced' && f.sync.issue !== 'ambiguous'

  return (
    <div className="flex flex-col gap-3">
      <OrderStatus
        type="redirect"
        order={overview.orders.redirect}
        gatewayId={gatewayId}
        canWrite={canWrite}
        nameOf={(id) => nameOf(id) ?? id}
        onWrite={onWrite}
      />
      <Panel
        flush
        title="Port forwards"
        description={
          <>
            {counts.total} forwards · {counts.enabled} enabled
            {counts.warnings > 0 ? (
              <span className="text-status-warning"> · {counts.warnings} with warnings</span>
            ) : null}
          </>
        }
        actions={
          canWrite || writeHint ? (
            <Button size="sm" variant="outline" disabled={!canWrite} title={writeHint ?? undefined} onClick={() => setEditing('new')}>
              <Plus className="size-3.5" />
              New port forward
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-2 px-4 pb-3 sm:flex-row sm:items-center">
          <div className="relative sm:max-w-xs sm:flex-1">
            <MagnifyingGlass className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" />
            <Input
              aria-label="Search port forwards"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, port, device or address"
              className="pl-8"
            />
          </div>
          <Segmented
            size="xs"
            ariaLabel="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { id: 'all', label: 'All' },
              { id: 'enabled', label: 'Enabled' },
              { id: 'disabled', label: 'Disabled' },
              { id: 'warnings', label: `Warnings${counts.warnings ? ` (${counts.warnings})` : ''}` },
            ]}
            className="w-fit"
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground md:hidden">
            Sort
            <select
              className="h-7 rounded-md border border-input bg-transparent px-2 text-xs dark:bg-input/30"
              value={sort.key}
              onChange={(e) => setSort({ key: e.target.value as SortKey, dir: 1 })}
            >
              <option value="external">External port</option>
              <option value="name">Name</option>
              <option value="device">Device</option>
              <option value="order">Router order</option>
              <option value="status">Warnings first</option>
            </select>
          </label>
        </div>

        {toggleError ? <p className="px-4 pb-2 text-xs text-destructive">{toggleError}</p> : null}

        {rows.length === 0 ? (
          <div className="px-4 pb-4">
            <EmptyState
              title="No port forwards"
              description="Nothing on your network is reachable from the internet through a forwarded port."
            />
          </div>
        ) : visible.length === 0 ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground">Nothing matches.</p>
        ) : (
          <>
            {/* Desktop: a sortable table. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-[12.5px]">
                <thead className="border-y border-border bg-muted/30 text-[11px] text-muted-foreground">
                  <tr>
                    {header('name', 'Name')}
                    <th className="px-3 py-2 font-medium">Protocol</th>
                    {header('external', 'External')}
                    <th className="w-4 px-0 py-2" aria-hidden />
                    {header('device', 'Forwards to')}
                    {header('internal', 'Internal')}
                    <th className="px-3 py-2 font-medium">Enabled</th>
                    {header('status', 'State')}
                    <th className="px-3 py-2" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {visible.map((r) => {
                    const f = r.forward
                    return (
                      <tr key={f.id} className={cn('align-top', !f.enabled && 'text-muted-foreground')}>
                        <td className="max-w-[16rem] px-3 py-2">
                          <div className="flex items-start gap-1.5">
                            {r.warnings.length > 0 ? (
                              <Warning className="mt-0.5 size-3.5 shrink-0 text-status-warning" aria-label="Warning" />
                            ) : null}
                            <div className="min-w-0">
                              <p className="truncate font-medium text-foreground" title={r.title}>
                                {r.title}
                              </p>
                              {r.warnings.map((w) => (
                                <p key={w} className="text-[11px] text-status-warning">
                                  {w}
                                </p>
                              ))}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 font-mono text-[11.5px]">{formatProto(f.proto)}</td>
                        <td className="px-3 py-2 font-mono text-[11.5px]">{formatPorts(f.externalPort) || 'all'}</td>
                        <td className="px-0 py-2 text-muted-foreground">
                          <ArrowRight className="mt-0.5 size-3" />
                        </td>
                        <td className="px-3 py-2">
                          <Target row={r} />
                        </td>
                        <td className="px-3 py-2 font-mono text-[11.5px]">
                          {f.destPort ? formatPorts(f.destPort) : <span className="text-muted-foreground">same</span>}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit(f) ? (
                            <Switch
                              checked={f.enabled}
                              disabled={update.isPending && update.variables?.id === f.id}
                              onCheckedChange={(next) => toggle(f, next)}
                              aria-label={`${f.enabled ? 'Disable' : 'Enable'} ${r.title}`}
                            />
                          ) : (
                            <span>{f.enabled ? 'Yes' : 'No'}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <SyncBadge sync={f.sync} />
                        </td>
                        <td className="px-3 py-2">
                          {canEdit(f) ? (
                            <div className="flex justify-end gap-1">
                              <Button size="icon-xs" variant="ghost" aria-label={`Edit ${r.title}`} onClick={() => setEditing(f)}>
                                <PencilSimple />
                              </Button>
                              <Button size="icon-xs" variant="ghost" aria-label={`Delete ${r.title}`} onClick={() => setDeleting(f)}>
                                <Trash />
                              </Button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Phone: one card per forward. */}
            <ul className="divide-y divide-border/70 border-t border-border md:hidden">
              {visible.map((r) => {
                const f = r.forward
                return (
                  <li key={f.id} className={cn('space-y-1.5 px-4 py-3', !f.enabled && 'opacity-70')}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium">{r.title}</p>
                        <p className="font-mono text-[11.5px]">
                          {formatProto(f.proto)} {formatPorts(f.externalPort) || 'all'}
                          <ArrowRight className="mx-1 inline size-3 text-muted-foreground" />
                          {f.destPort ? formatPorts(f.destPort) : formatPorts(f.externalPort)}
                        </p>
                      </div>
                      {canEdit(f) ? (
                        <Switch
                          checked={f.enabled}
                          disabled={update.isPending && update.variables?.id === f.id}
                          onCheckedChange={(next) => toggle(f, next)}
                          aria-label={`${f.enabled ? 'Disable' : 'Enable'} ${r.title}`}
                        />
                      ) : (
                        <ToneBadge tone="muted">{f.enabled ? 'Enabled' : 'Disabled'}</ToneBadge>
                      )}
                    </div>
                    <Target row={r} />
                    {r.warnings.map((w) => (
                      <p key={w} className="flex items-start gap-1.5 text-[11.5px] text-status-warning">
                        <Warning className="mt-0.5 size-3.5 shrink-0" />
                        {w}
                      </p>
                    ))}
                    <div className="flex items-center justify-between gap-2">
                      <SyncBadge sync={f.sync} />
                      {canEdit(f) ? (
                        <div className="flex gap-1">
                          <Button size="xs" variant="ghost" onClick={() => setEditing(f)}>
                            <PencilSimple />
                            Edit
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setDeleting(f)}>
                            <Trash />
                            Delete
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </Panel>

      {editing ? (
        <PortForwardDialog
          gatewayId={gatewayId}
          overview={overview}
          devices={devices}
          forward={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={`Delete “${forwardTitle(deleting)}”?`}
          description={`${formatProto(deleting.proto)} ${formatPorts(deleting.externalPort)} stops reaching ${deleting.destIp ?? 'the device'} from the internet once the router applies it.`}
          confirmLabel="Delete"
          destructive
          pending={remove.isPending}
          error={remove.error}
          nameOf={nameOf}
          onClose={() => {
            setDeleting(null)
            remove.reset()
          }}
          onConfirm={(apply) =>
            remove.mutate(
              { id: deleting.id, apply },
              {
                onSuccess: (data) => {
                  onWrite({
                    what: `Deleted “${forwardTitle(deleting)}”`,
                    issues: data.issues,
                    apply: data.apply,
                    applyError: data.applyError,
                  })
                  setDeleting(null)
                },
              },
            )
          }
        >
          <p className="text-muted-foreground">
            The DHCP reservation of the device stays; delete it from the device’s page if it is no longer needed.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  )
}

function titleOf(f: PortForward | undefined): string | null {
  return f ? forwardTitle(f) : null
}

function Target({ row }: { row: Row }) {
  const f = row.forward
  return (
    <div className="min-w-0">
      {row.target.mac ? (
        <Link
          to={`/devices/${encodeURIComponent(row.target.mac)}`}
          className="block truncate font-medium text-foreground hover:underline"
        >
          {row.target.name}
        </Link>
      ) : (
        <span className="block truncate font-medium text-foreground">{row.target.name}</span>
      )}
      <span className="flex flex-wrap items-center gap-1 font-mono text-[11px] text-muted-foreground">
        {f.destIp ?? '—'}
        {f.destZone ? <span className="font-sans">· {f.destZone}</span> : null}
        {!row.target.reserved && f.destIp ? (
          <span className="font-sans" title="No DHCP reservation holds this address.">
            · not reserved
          </span>
        ) : null}
      </span>
    </div>
  )
}
