import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PencilSimple, Plus, ShieldCheck, Tag, Trash } from '@phosphor-icons/react'
import { DhcpOptionsEditor } from '@/components/gateway-native/dhcp-options-editor'
import {
  Field,
  ListEditor,
  NativePage,
  NativeWriteResult,
  RouterOwnedHint,
  StageOnly,
  SyncBadges,
  type NativeContext,
} from '@/components/gateway-native/native-ui'
import { ConfirmDialog, ErrorLine, IssueList, ToneBadge } from '@/components/gateway-config/bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import {
  useCreateTag,
  useDeleteTag,
  useGatewayDhcp,
  useUpdatePool,
  useUpdateReservation,
  useUpdateTag,
} from '@/hooks/use-gateway-native'
import { apiErrorCode } from '@/lib/api'
import { nativeErrorMessage, optionLines, optionsDraft, optionsPatch, type OptionsDraft } from '@/lib/gateway-native'
import { poolRange, refusalIssues } from '@/lib/networks'
import type { DhcpPool, DhcpReservation, DhcpTag, NativeWrite } from '@/types/gateway-native'

/**
 * DHCP on the managed gateway (docs/gateway/native-sync.md section 2): per
 * network the range, lease time and the options clients receive (router, DNS
 * and NTP servers, domain, any other code), DHCP tags with options of their
 * own, and the tags each reservation carries. IPv6 (odhcpd) is shown only.
 */
export function GatewayDhcpPage() {
  return (
    <NativePage title="DHCP" description="Address pools, the options clients receive, and DHCP tags">
      {(ctx) => <DhcpView ctx={ctx} />}
    </NativePage>
  )
}

function DhcpView({ ctx }: { ctx: NativeContext }) {
  const dhcp = useGatewayDhcp(ctx.gateway.id)
  const [editing, setEditing] = useState<DhcpPool | null>(null)
  if (dhcp.isPending) return <p className="text-sm text-muted-foreground">Loading DHCP…</p>
  if (dhcp.error) return <ErrorLine message={nativeErrorMessage(dhcp.error)} />
  const data = dhcp.data
  return (
    <>
      {data.pools.length === 0 ? (
        <EmptyState title="No DHCP pools" description="The router reported no `config dhcp` sections." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.pools.map((pool) => (
            <PoolCard key={pool.perchId} pool={pool} ctx={ctx} onEdit={() => setEditing(pool)} />
          ))}
        </div>
      )}
      <TagsPanel ctx={ctx} tags={data.tags} />
      <ReservationsPanel ctx={ctx} reservations={data.reservations} tags={data.tags.map((t) => t.name)} />
      {data.odhcpd ? (
        <p className="text-[11px] text-muted-foreground">
          odhcpd {data.odhcpd.maindhcp ? 'serves DHCPv4 too (maindhcp)' : 'handles IPv6 only'}; IPv6 (RA, DHCPv6, NDP) stays
          router-owned.
        </p>
      ) : null}
      {editing ? <PoolDialog pool={editing} ctx={ctx} onClose={() => setEditing(null)} /> : null}
    </>
  )
}

function PoolCard({ pool, ctx, onEdit }: { pool: DhcpPool; ctx: NativeContext; onEdit: () => void }) {
  const editable = pool.sync.owner === 'perch' && !ctx.hardBlocked
  const range = poolRange(pool.subnet, pool.start, pool.limit)
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{pool.network}</span>
          {pool.enabled ? <ToneBadge tone="good">Serving</ToneBadge> : <ToneBadge tone="neutral">Off</ToneBadge>}
          {pool.management ? (
            <ToneBadge tone="warning" title="The gateway agent reaches the controller through this network">
              <ShieldCheck className="size-3" />
              Management
            </ToneBadge>
          ) : null}
          <SyncBadges sync={pool.sync} />
        </span>
      }
      description={pool.subnet ? <span className="font-mono">{pool.subnet}</span> : 'No IPv4 address known'}
      actions={
        editable ? (
          <Button size="sm" variant="outline" onClick={onEdit}>
            <PencilSimple className="size-3.5" />
            Edit
          </Button>
        ) : null
      }
    >
      <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Range</dt>
        <dd className="font-mono break-all">{range ?? `${pool.start ?? 100} + ${pool.limit ?? 150}`}</dd>
        <dt className="text-muted-foreground">Lease time</dt>
        <dd className="font-mono">{pool.leaseTime ?? 'default (12h)'}</dd>
        {optionLines(pool.options, pool.routerAddress).map(([label, value]) => (
          <FragmentRow key={label + value} label={label} value={value} />
        ))}
        {pool.force ? (
          <>
            <dt className="text-muted-foreground">Force</dt>
            <dd>answers even if another DHCP server is seen</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">IPv6</dt>
        <dd className="text-muted-foreground">
          RA {pool.ipv6.ra ?? '—'} · DHCPv6 {pool.ipv6.dhcpv6 ?? '—'} · NDP {pool.ipv6.ndp ?? '—'}{' '}
          <span className="text-[11px]">(router-owned, odhcpd)</span>
        </dd>
      </dl>
      {pool.sync.owner === 'router' ? (
        <div className="mt-2">
          <RouterOwnedHint gatewayId={ctx.gateway.id} what="This pool" />
        </div>
      ) : null}
    </Panel>
  )
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono break-all">{value}</dd>
    </>
  )
}

function PoolDialog({ pool, ctx, onClose }: { pool: DhcpPool; ctx: NativeContext; onClose: () => void }) {
  const update = useUpdatePool(ctx.gateway.id)
  const [enabled, setEnabled] = useState(pool.enabled)
  const [start, setStart] = useState(String(pool.start ?? 100))
  const [limit, setLimit] = useState(String(pool.limit ?? 150))
  const [leaseTime, setLeaseTime] = useState(pool.leaseTime ?? '12h')
  const [force, setForce] = useState(pool.force)
  const [draft, setDraft] = useState<OptionsDraft>(optionsDraft(pool.options))
  const [stage, setStage] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [result, setResult] = useState<NativeWrite<unknown> | null>(null)
  const code = apiErrorCode(update.error)
  const needsConfirm = code === 'dhcp_confirm_required' || code === 'dhcp_gateway_not_router'
  const unparsed = pool.options.other.filter((o) => o.code === null || o.raw.startsWith('tag:')).map((o) => o.raw)

  const submit = () => {
    const patch = {
      ...(enabled !== pool.enabled ? { enabled } : {}),
      ...(Number(start) !== pool.start ? { start: Number(start) } : {}),
      ...(Number(limit) !== pool.limit ? { limit: Number(limit) } : {}),
      ...(leaseTime !== (pool.leaseTime ?? '12h') ? { leaseTime } : {}),
      ...(force !== pool.force ? { force } : {}),
      ...(optionsPatch(pool.options, draft) ? { options: optionsPatch(pool.options, draft) } : {}),
      ...(needsConfirm && confirm ? { confirm } : {}),
    }
    update.mutate({ network: pool.network, patch, apply: !stage }, { onSuccess: setResult })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>DHCP on {pool.network}</DialogTitle>
          <DialogDescription>
            Clients pick up option changes at their next renewal (half the lease time), long after the apply confirms.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {result ? (
            <NativeWriteResult result={result} gatewayId={ctx.gateway.id} />
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-medium">Serve DHCP on this network</div>
                  {pool.management ? (
                    <p className="text-[11px] text-status-warning">
                      The gateway agent reaches Perch through this network: switching it off needs its name typed.
                    </p>
                  ) : null}
                </div>
                <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Serve DHCP" />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="First host" hint={pool.subnet ? `offset in ${pool.subnet}` : undefined}>
                  <Input value={start} inputMode="numeric" onChange={(e) => setStart(e.target.value)} className="font-mono" />
                </Field>
                <Field label="Addresses">
                  <Input value={limit} inputMode="numeric" onChange={(e) => setLimit(e.target.value)} className="font-mono" />
                </Field>
                <Field label="Lease time" hint="12h, 30m, 1200d, infinite">
                  <Input value={leaseTime} onChange={(e) => setLeaseTime(e.target.value)} className="font-mono" />
                </Field>
              </div>
              <p className="font-mono text-[11px] text-muted-foreground">
                {poolRange(pool.subnet, Number(start) || null, Number(limit) || null) ?? ''}
              </p>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs">Answer even when another DHCP server is on the network (force)</span>
                <Switch checked={force} onCheckedChange={setForce} aria-label="Force" />
              </div>
              <DhcpOptionsEditor draft={draft} onChange={setDraft} routerAddress={pool.routerAddress} unparsed={unparsed} />
              {update.error ? (
                <div className="space-y-2">
                  <ErrorLine message={nativeErrorMessage(update.error)} />
                  <IssueList issues={refusalIssues(update.error)} />
                  {needsConfirm ? (
                    <Field label={`Type "${pool.network}" to do it anyway`}>
                      <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="font-mono" />
                    </Field>
                  ) : null}
                </div>
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
              <Button variant="outline" onClick={onClose} disabled={update.isPending}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={update.isPending || (needsConfirm && confirm !== pool.network)}>
                {update.isPending ? <Spinner className="size-3.5 text-current" /> : null}
                {stage ? 'Save draft' : 'Save and apply'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── tags ────────────────────────────────────────────────────────────────────

function TagsPanel({ ctx, tags }: { ctx: NativeContext; tags: DhcpTag[] }) {
  const [editing, setEditing] = useState<DhcpTag | 'new' | null>(null)
  const [deleting, setDeleting] = useState<DhcpTag | null>(null)
  const remove = useDeleteTag(ctx.gateway.id)
  return (
    <Panel
      flush
      title="DHCP tags"
      description="Named option sets: a reservation carrying the tag gets these options instead of (or on top of) its pool's."
      actions={
        !ctx.hardBlocked ? (
          <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
            <Plus className="size-3.5" />
            New tag
          </Button>
        ) : null
      }
    >
      {tags.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">No tags. A tag lets one device get its own DNS server or router.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {tags.map((t) => (
            <li key={t.perchId} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 text-xs">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Tag className="size-3.5 text-muted-foreground" />
                  <span className="font-mono font-medium">{t.name}</span>
                  <SyncBadges sync={t.sync} />
                  <span className="text-[11px] text-muted-foreground">
                    {t.reservations.length} reservation{t.reservations.length === 1 ? '' : 's'}
                  </span>
                </div>
                <p className="font-mono text-[11px] break-all text-muted-foreground">
                  {optionLines(t.options, null)
                    .filter(([label]) => label !== 'Router' || t.options.gateway)
                    .filter(([label]) => label !== 'DNS servers' || t.options.dnsServers.length > 0)
                    .map(([label, value]) => `${label}: ${value}`)
                    .join(' · ') || 'no options'}
                </p>
              </div>
              {t.sync.owner === 'perch' && !ctx.hardBlocked ? (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>
                    <PencilSimple className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(t)} aria-label={`Delete ${t.name}`}>
                    <Trash className="size-3.5" />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing ? <TagDialog ctx={ctx} tag={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null)
            remove.reset()
          }
        }}
        title={`Delete tag ${deleting?.name ?? ''}?`}
        description="The router drops the tag's options at the next apply."
        confirmLabel="Delete and apply"
        destructive
        pending={remove.isPending}
        error={remove.error ? nativeErrorMessage(remove.error) : null}
        onConfirm={() => deleting && remove.mutate({ perchId: deleting.perchId }, { onSuccess: () => setDeleting(null) })}
      />
    </Panel>
  )
}

const EMPTY_OPTIONS = { gateway: null, dnsServers: [], ntpServers: [], domain: null, other: [] }

function TagDialog({ ctx, tag, onClose }: { ctx: NativeContext; tag: DhcpTag | null; onClose: () => void }) {
  const create = useCreateTag(ctx.gateway.id)
  const update = useUpdateTag(ctx.gateway.id)
  const mutation = tag ? update : create
  const view = tag?.options ?? EMPTY_OPTIONS
  const [name, setName] = useState(tag?.name ?? '')
  const [force, setForce] = useState(tag?.force ?? false)
  const [draft, setDraft] = useState<OptionsDraft>(optionsDraft(view))
  const [stage, setStage] = useState(false)
  const [result, setResult] = useState<NativeWrite<unknown> | null>(null)
  const submit = () => {
    const options = optionsPatch(view, draft)
    if (tag) {
      update.mutate(
        { perchId: tag.perchId, input: { options, force: force !== tag.force ? force : undefined }, apply: !stage },
        { onSuccess: setResult },
      )
    } else {
      create.mutate({ input: { name: name.trim(), options, force: force || undefined }, apply: !stage }, { onSuccess: setResult })
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{tag ? `Tag ${tag.name}` : 'New DHCP tag'}</DialogTitle>
          <DialogDescription>Give a reservation this tag (below) to send it these options.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {result ? (
            <NativeWriteResult result={result} gatewayId={ctx.gateway.id} />
          ) : (
            <>
              {!tag ? (
                <Field label="Name" hint="Letters, digits and _; the section name on the router.">
                  <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono" placeholder="kids" />
                </Field>
              ) : null}
              <DhcpOptionsEditor draft={draft} onChange={setDraft} routerAddress={null} unparsed={[]} />
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs">Send the options even when the client did not ask for them (force)</span>
                <Switch checked={force} onCheckedChange={setForce} aria-label="Force" />
              </div>
              {mutation.error ? (
                <>
                  <ErrorLine message={nativeErrorMessage(mutation.error)} />
                  <IssueList issues={refusalIssues(mutation.error)} />
                </>
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
              <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={mutation.isPending || (!tag && !/^[A-Za-z0-9_]{1,32}$/.test(name.trim()))}>
                {mutation.isPending ? <Spinner className="size-3.5 text-current" /> : null}
                {stage ? 'Save draft' : 'Save and apply'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── reservations ────────────────────────────────────────────────────────────

function ReservationsPanel({
  ctx,
  reservations,
  tags,
}: {
  ctx: NativeContext
  reservations: DhcpReservation[]
  tags: string[]
}) {
  const [editing, setEditing] = useState<DhcpReservation | null>(null)
  return (
    <Panel
      flush
      title="Reservations"
      description="Fixed addresses and names; change a device's address or name from its device page, its tags here."
    >
      {reservations.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">No reservations.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {reservations.map((r) => (
            <li key={r.perchId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.hostname ?? 'unnamed'}</span>
                  <span className="font-mono">{r.deny ? 'denied' : (r.ip ?? 'dynamic')}</span>
                  {r.network ? <span className="text-muted-foreground">on {r.network}</span> : null}
                  <SyncBadges sync={{ ...syncOfReservation(r) }} />
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  {r.macs.map((mac) => (
                    <Link key={mac} to={`/devices/${encodeURIComponent(mac)}`} className="font-mono hover:underline">
                      {mac}
                    </Link>
                  ))}
                  {r.leaseTime ? <span>· lease {r.leaseTime}</span> : null}
                  {r.tags.map((t) => (
                    <ToneBadge key={t} tone="info">
                      <Tag className="size-3" />
                      {t}
                    </ToneBadge>
                  ))}
                </div>
              </div>
              {r.owner === 'perch' && !ctx.hardBlocked ? (
                <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                  <Tag className="size-3.5" />
                  Tags
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing ? <ReservationTagsDialog ctx={ctx} reservation={editing} tags={tags} onClose={() => setEditing(null)} /> : null}
    </Panel>
  )
}

function syncOfReservation(r: DhcpReservation) {
  return {
    perchId: r.perchId,
    section: r.section,
    owner: r.owner,
    scope: r.scope,
    issue: null,
    status: r.status as DhcpPool['sync']['status'],
    applied: r.applied,
    conflict: r.conflict,
    driftSince: r.driftSince,
  }
}

function ReservationTagsDialog({
  ctx,
  reservation,
  tags,
  onClose,
}: {
  ctx: NativeContext
  reservation: DhcpReservation
  tags: string[]
  onClose: () => void
}) {
  const update = useUpdateReservation(ctx.gateway.id)
  const [values, setValues] = useState(reservation.tags)
  const [stage, setStage] = useState(false)
  const [result, setResult] = useState<NativeWrite<unknown> | null>(null)
  const unknown = values.filter((t) => !tags.includes(t))
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tags of {reservation.hostname ?? reservation.macs[0]}</DialogTitle>
          <DialogDescription>dnsmasq sends the device the options of every tag it carries.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {result ? (
            <NativeWriteResult result={result} gatewayId={ctx.gateway.id} />
          ) : (
            <>
              <ListEditor values={values} onChange={setValues} placeholder="tag name" addLabel="Add tag" />
              {tags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {tags
                    .filter((t) => !values.includes(t))
                    .map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setValues([...values, t])}
                        className="rounded-sm border border-dashed border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        + {t}
                      </button>
                    ))}
                </div>
              ) : null}
              {unknown.length > 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No DHCP tag section for {unknown.join(', ')}: fine when another rule sets it, otherwise create the tag.
                </p>
              ) : null}
              {update.error ? <ErrorLine message={nativeErrorMessage(update.error)} /> : null}
              <StageOnly checked={stage} onChange={setStage} />
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {result ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={update.isPending}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  update.mutate(
                    { perchId: reservation.perchId, patch: { tags: values }, apply: !stage },
                    { onSuccess: setResult },
                  )
                }
                disabled={update.isPending}
              >
                {update.isPending ? <Spinner className="size-3.5 text-current" /> : null}
                {stage ? 'Save draft' : 'Save and apply'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
