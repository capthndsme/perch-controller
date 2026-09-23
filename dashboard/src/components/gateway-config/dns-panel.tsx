import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, PencilSimple, Plus, Trash, X } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { ErrorLine, IssueList, ToneBadge } from '@/components/gateway-config/bits'
import {
  useApplyLabelNames,
  useCreateDnsRecord,
  useDeleteDnsRecord,
  useGatewayDns,
  useSetDnsLabelPolicy,
  useUpdateDnsRecord,
} from '@/hooks/use-gateways'
import { refusalMessage, STATUS_META } from '@/lib/gateway-config'
import type { ApplyError, DnsRecord, Gateway, Issue, PendingLabelName, SectionStatus } from '@/types/gateway-config'

/** What happened to the apply a domain write starts (`?apply=1`, the default). */
export function WriteOutcome({
  issues,
  applyError,
  gatewayId,
}: {
  issues?: Issue[]
  applyError?: ApplyError
  gatewayId: number
}) {
  return (
    <>
      {issues && issues.length > 0 ? <IssueList issues={issues} /> : null}
      {applyError ? (
        <p className="text-status-serious">
          Saved in the draft, not applied yet: {applyError.message}{' '}
          <Link to={`/gateway/config/${gatewayId}?tab=changes`} className="underline underline-offset-2">
            Pending changes
          </Link>
        </p>
      ) : null}
    </>
  )
}

/**
 * Local DNS (config-plane.md section 10.3): address and alias records, host
 * names from reservations, and device labels as DNS names under review.
 */
export function DnsPanel({ gateway, isAdmin }: { gateway: Gateway; isAdmin: boolean }) {
  const dns = useGatewayDns(gateway.id)
  const managed = gateway.mode === 'managed'
  if (dns.isPending) return <p className="text-xs text-muted-foreground">Loading…</p>
  if (dns.error) return <ErrorLine message={refusalMessage(dns.error)} />
  const data = dns.data!
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <RecordsPanel gateway={gateway} records={data.records} reserved={data.reserved} canEdit={isAdmin && managed} />
      <div className="flex flex-col gap-4">
        <LabelNamesPanel gateway={gateway} data={data} canEdit={isAdmin} managed={managed} />
        <Panel title="Host names" description="Names the router hands out with DHCP reservations." flush>
          {data.names.length === 0 ? (
            <p className="px-4 pb-4 text-xs text-muted-foreground">No named reservations.</p>
          ) : (
            <ul className="divide-y divide-border/70 border-t border-border text-xs">
              {data.names.map((n) => (
                <li key={n.perchId} className="flex flex-wrap items-center gap-2 px-4 py-1.5">
                  <span className="font-mono font-medium">{n.hostname}</span>
                  <span className="font-mono text-muted-foreground">{n.ip ?? 'dynamic'}</span>
                  {n.macs[0] ? (
                    <Link to={`/devices/${encodeURIComponent(n.macs[0])}`} className="font-mono text-[11px] text-muted-foreground hover:underline">
                      {n.macs[0]}
                    </Link>
                  ) : null}
                  <ToneBadge tone={n.owner === 'perch' ? 'info' : 'neutral'} className="ml-auto">
                    {n.owner === 'perch' ? 'Perch' : 'Router'}
                  </ToneBadge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}

function RecordsPanel({
  gateway,
  records,
  reserved,
  canEdit,
}: {
  gateway: Gateway
  records: DnsRecord[]
  reserved: string[]
  canEdit: boolean
}) {
  const create = useCreateDnsRecord(gateway.id)
  const [type, setType] = useState<'a' | 'cname'>('a')
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const reservedHit = reserved.some((r) => r.toLowerCase() === name.trim().toLowerCase().split('.')[0])

  return (
    <Panel title="DNS records" description="Local names the router answers (dnsmasq `domain` and `cname`)." flush>
      {records.length === 0 ? (
        <div className="px-4 pb-3">
          <EmptyState title="No records" />
        </div>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border text-xs">
          {records.map((r) => (
            <RecordRow key={r.perchId} gateway={gateway} record={r} canEdit={canEdit} />
          ))}
        </ul>
      )}
      {canEdit ? (
        <form
          className="space-y-2 border-t border-border px-4 py-3 text-xs"
          onSubmit={async (e) => {
            e.preventDefault()
            try {
              await create.mutateAsync({ type, name: name.trim(), value: value.trim() })
              setName('')
              setValue('')
            } catch {
              // shown
            }
          }}
        >
          <p className="section-label">Add a record</p>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              size="xs"
              ariaLabel="Record type"
              value={type}
              onChange={setType}
              options={[
                { id: 'a', label: 'Address' },
                { id: 'cname', label: 'Alias' },
              ]}
            />
            <Input className="w-40 flex-1 font-mono" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            <Input
              className="w-40 flex-1 font-mono"
              placeholder={type === 'a' ? '192.168.1.20' : 'target.lan'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label={type === 'a' ? 'Address' : 'Target'}
            />
            <Button type="submit" size="sm" disabled={!name.trim() || !value.trim() || create.isPending || reservedHit}>
              {create.isPending ? <Spinner className="size-3.5 text-current" /> : <Plus />}
              Add
            </Button>
          </div>
          {reservedHit ? <p className="text-status-serious">“{name.trim()}” is reserved and cannot be used.</p> : null}
          <ErrorLine message={create.error ? refusalMessage(create.error) : null} />
          {create.data ? <WriteOutcome gatewayId={gateway.id} issues={create.data.issues} applyError={create.data.applyError} /> : null}
          <p className="text-[11px] text-muted-foreground">Reserved: {reserved.join(', ')}</p>
        </form>
      ) : null}
    </Panel>
  )
}

function RecordRow({ gateway, record, canEdit }: { gateway: Gateway; record: DnsRecord; canEdit: boolean }) {
  const update = useUpdateDnsRecord(gateway.id)
  const remove = useDeleteDnsRecord(gateway.id)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(record.name)
  const [value, setValue] = useState(record.value)
  const status = STATUS_META[record.status as SectionStatus]
  const mine = record.owner === 'perch'
  const error = update.error ?? remove.error

  return (
    <li className="space-y-1 px-4 py-2">
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            try {
              await update.mutateAsync({ perchId: record.perchId, name: name.trim(), value: value.trim() })
              setEditing(false)
            } catch {
              // shown
            }
          }}
        >
          <Input className="w-36 flex-1 font-mono" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          <Input className="w-36 flex-1 font-mono" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Value" />
          <Button type="submit" size="icon-xs" aria-label="Save" disabled={update.isPending}>
            <Check />
          </Button>
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Cancel" onClick={() => setEditing(false)}>
            <X />
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <ToneBadge tone="neutral">{record.type === 'a' ? 'A' : 'CNAME'}</ToneBadge>
          <span className="font-mono font-medium">{record.name}</span>
          <span className="text-muted-foreground">→</span>
          <span className="font-mono">{record.value}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {status ? <ToneBadge tone={status.tone} dot>{status.label}</ToneBadge> : null}
            <ToneBadge tone={record.owner === 'perch' ? 'info' : 'neutral'}>{record.owner === 'perch' ? 'Perch' : 'Router'}</ToneBadge>
            {canEdit && mine ? (
              <>
                <Button size="icon-xs" variant="ghost" aria-label={`Edit ${record.name}`} onClick={() => setEditing(true)}>
                  <PencilSimple />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Delete ${record.name}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(record.perchId)}
                >
                  <Trash />
                </Button>
              </>
            ) : null}
          </span>
        </div>
      )}
      <ErrorLine message={error ? refusalMessage(error) : null} />
      {update.data ? <WriteOutcome gatewayId={gateway.id} issues={update.data.issues} applyError={update.data.applyError} /> : null}
    </li>
  )
}

function LabelNamesPanel({
  gateway,
  data,
  canEdit,
  managed,
}: {
  gateway: Gateway
  data: { labelNames: 'off' | 'review'; pendingLabelNames: PendingLabelName[] }
  canEdit: boolean
  managed: boolean
}) {
  const policy = useSetDnsLabelPolicy(gateway.id)
  const approve = useApplyLabelNames(gateway.id)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const pending = data.pendingLabelNames.filter((p) => !dismissed.has(p.mac))
  const approvable = pending.filter((p) => !p.blocked)
  const error = policy.error ?? approve.error

  return (
    <Panel
      title="Device labels as DNS names"
      description="A device’s label becomes its DNS name only after an admin approves it. Reserved names are always refused."
      actions={
        canEdit ? (
          <Segmented
            size="xs"
            ariaLabel="Label names"
            value={data.labelNames}
            onChange={(v) => policy.mutate(v)}
            options={[
              { id: 'review', label: 'Review' },
              { id: 'off', label: 'Off' },
            ]}
          />
        ) : null
      }
      flush
    >
      <div className="px-4 pb-2 text-xs">
        <ErrorLine message={error ? refusalMessage(error) : null} />
        {approve.data ? <WriteOutcome gatewayId={gateway.id} issues={approve.data.issues as Issue[]} applyError={approve.data.applyError as ApplyError} /> : null}
      </div>
      {data.labelNames === 'off' ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Off: labels stay labels.</p>
      ) : pending.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">No label waits for review.</p>
      ) : (
        <>
          <ul className="divide-y divide-border/70 border-t border-border text-xs">
            {pending.map((p) => (
              <li key={p.mac} className="flex flex-wrap items-center gap-2 px-4 py-2" data-testid="label-name">
                <span className="min-w-0 flex-1">
                  <Link to={`/devices/${encodeURIComponent(p.mac)}`} className="font-medium hover:underline">
                    {p.label}
                  </Link>
                  <span className="ml-2 font-mono text-muted-foreground">
                    {p.current ?? '(no name)'} → <span className="text-foreground">{p.slug}</span>
                  </span>
                </span>
                {p.blocked ? (
                  <ToneBadge tone="warning">{p.blocked === 'reserved' ? 'Reserved name' : 'Router owns this host'}</ToneBadge>
                ) : canEdit ? (
                  <span className="flex gap-1.5">
                    <Button size="xs" variant="outline" disabled={!managed || approve.isPending} onClick={() => approve.mutate([p.mac])}>
                      <Check />
                      Approve
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setDismissed((s) => new Set(s).add(p.mac))}
                      title="Hide for now; rename the device’s label to change the proposal"
                    >
                      Reject
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {canEdit && approvable.length > 1 ? (
            <div className="border-t border-border px-4 py-2">
              <Button size="xs" variant="outline" disabled={!managed || approve.isPending} onClick={() => approve.mutate(approvable.map((p) => p.mac))}>
                Approve all {approvable.length}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  )
}
