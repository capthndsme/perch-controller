import { useState } from 'react'
import { Eye, LockSimple, Plus, PushPin, Trash } from '@phosphor-icons/react'
import { DnsPanel } from '@/components/gateway-config/dns-panel'
import { ErrorLine, IssueList, ToneBadge } from '@/components/gateway-config/bits'
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
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useGatewayDnsFull, useUpdateDnsSettings } from '@/hooks/use-gateway-native'
import { nativeErrorMessage } from '@/lib/gateway-native'
import { refusalIssues } from '@/lib/networks'
import type { DnsInstance, DnsSettings, DnsSettingsPatch, DnsSettingsWrite } from '@/types/gateway-native'

/**
 * DNS on the managed gateway (docs/gateway/native-sync.md section 3):
 * dnsmasq's upstream servers, domain forwards, address overrides, the local
 * domain and rebind protection, then the local records and names. Items the
 * router added stay the router's; a front resolver (AdGuard Home) is only
 * observed.
 */
export function GatewayDnsPage() {
  return (
    <NativePage title="DNS" description="Upstream servers, local domain, rebind protection and local records">
      {(ctx) => <DnsView ctx={ctx} />}
    </NativePage>
  )
}

function DnsView({ ctx }: { ctx: NativeContext }) {
  const dns = useGatewayDnsFull(ctx.gateway.id)
  const [instanceId, setInstanceId] = useState<string | null>(null)
  // Lives here: the editor remounts with fresh data after a save.
  const [result, setResult] = useState<DnsSettingsWrite | null>(null)
  if (dns.isPending) return <p className="text-sm text-muted-foreground">Loading DNS…</p>
  if (dns.error) return <ErrorLine message={nativeErrorMessage(dns.error)} />
  const settings = dns.data.settings
  const instance = settings.instances.find((i) => i.perchId === instanceId) ?? settings.instances[0] ?? null
  return (
    <>
      <ResolverNote settings={settings} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {instance ? (
          <InstanceEditor
            key={`${instance.perchId}-${JSON.stringify(instance.settings)}`}
            ctx={ctx}
            instance={instance}
            instances={settings.instances}
            onPick={setInstanceId}
            settings={settings}
            result={result}
            onResult={setResult}
          />
        ) : (
          <EmptyState title="No dnsmasq instance" description="The router reported no `config dnsmasq` section." />
        )}
        <ControllerNameCard ctx={ctx} settings={settings} instance={instance} />
      </div>
      <DnsPanel gateway={ctx.gateway} isAdmin={ctx.isAdmin} />
    </>
  )
}

function ResolverNote({ settings }: { settings: DnsSettings }) {
  if (!settings.frontResolver && settings.dnsmasqPort === 53) return null
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
      <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="space-y-0.5">
        {settings.frontResolver ? (
          <p>
            <span className="font-medium">{settings.frontResolver}</span> answers DNS on port 53
            {settings.dnsmasqPort ? `, dnsmasq sits behind it on :${settings.dnsmasqPort}` : ''}. Perch only observes it and
            never changes its configuration{settings.adguard ? ' (AdGuard Home keeps its own UI)' : ''}.
          </p>
        ) : settings.dnsmasqPort === 0 ? (
          <p>dnsmasq's DNS is off on the router (port 0): it serves DHCP only.</p>
        ) : settings.dnsmasqPort === null ? (
          <p>The router has not reported which process answers DNS yet.</p>
        ) : (
          <p>dnsmasq answers DNS on port {settings.dnsmasqPort}.</p>
        )}
        <p className="text-muted-foreground">
          Local names resolve for clients only when the front resolver forwards the local domain to dnsmasq. dnsmasq's port
          stays the router's setting.
        </p>
      </div>
    </div>
  )
}

type Row = { domain: string; value: string }

function InstanceEditor({
  ctx,
  instance,
  instances,
  onPick,
  settings,
  result,
  onResult,
}: {
  ctx: NativeContext
  instance: DnsInstance
  instances: DnsInstance[]
  onPick: (id: string) => void
  settings: DnsSettings
  result: DnsSettingsWrite | null
  onResult: (r: DnsSettingsWrite) => void
}) {
  const s = instance.settings
  const editable = instance.sync.owner === 'perch' && !ctx.hardBlocked
  const update = useUpdateDnsSettings(ctx.gateway.id)
  const [domain, setDomain] = useState(s.domain ?? '')
  const [local, setLocal] = useState((s.local ?? '').replace(/^\/|\/$/g, ''))
  const [rebind, setRebind] = useState(s.rebindProtection)
  const [noresolv, setNoresolv] = useState(s.noresolv)
  const mine = <T extends { owner: string }>(items: T[]) => items.filter((i) => i.owner === 'perch')
  const [upstreams, setUpstreams] = useState(mine(s.upstreams).map((u) => u.value))
  const [forwards, setForwards] = useState<Row[]>(
    mine(s.forwards).map((f) => ({ domain: f.domains.join('/'), value: f.server ?? '' })),
  )
  const [addresses, setAddresses] = useState<Row[]>(
    mine(s.addresses).map((a) => ({ domain: a.domains.join('/'), value: a.address })),
  )
  const [rebindDomains, setRebindDomains] = useState(mine(s.rebindDomains).map((r) => r.value))
  const [stage, setStage] = useState(false)

  const patch: DnsSettingsPatch = {}
  if (domain.trim() !== (s.domain ?? '')) patch.domain = domain.trim() || null
  if (local.trim() !== (s.local ?? '').replace(/^\/|\/$/g, '')) patch.local = local.trim() || null
  if (rebind !== s.rebindProtection) patch.rebindProtection = rebind
  if (noresolv !== s.noresolv) patch.noresolv = noresolv
  if (upstreams.join('\n') !== mine(s.upstreams).map((u) => u.value).join('\n')) patch.upstreams = upstreams
  const fwd = forwards.filter((f) => f.domain.trim())
  if (JSON.stringify(fwd) !== JSON.stringify(mine(s.forwards).map((f) => ({ domain: f.domains.join('/'), value: f.server ?? '' })))) {
    patch.forwards = fwd.map((f) => ({ domain: f.domain.trim(), server: f.value.trim() || null }))
  }
  const adr = addresses.filter((a) => a.domain.trim())
  if (JSON.stringify(adr) !== JSON.stringify(mine(s.addresses).map((a) => ({ domain: a.domains.join('/'), value: a.address })))) {
    patch.addresses = adr.map((a) => ({ domain: a.domain.trim(), address: a.value.trim() || null }))
  }
  if (rebindDomains.join('\n') !== mine(s.rebindDomains).map((r) => r.value).join('\n')) patch.rebindDomains = rebindDomains
  const dirty = Object.keys(patch).length > 0

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          dnsmasq
          <span className="font-mono text-[11px] text-muted-foreground">{instance.section}</span>
          <SyncBadges sync={instance.sync} />
        </span>
      }
      description={`Port ${s.port ?? '?'} (router-owned)${s.interfaces.length ? ` · on ${s.interfaces.join(', ')}` : ''}${s.notInterfaces.length ? ` · not on ${s.notInterfaces.join(', ')}` : ''}`}
      actions={
        instances.length > 1 ? (
          <select
            value={instance.perchId}
            onChange={(e) => onPick(e.target.value)}
            className="h-7 border border-input bg-transparent px-2 text-xs"
            aria-label="dnsmasq instance"
          >
            {instances.map((i) => (
              <option key={i.perchId} value={i.perchId}>
                {i.section}
              </option>
            ))}
          </select>
        ) : null
      }
    >
      <div className="space-y-4">
        {!editable && instance.sync.owner === 'router' ? <RouterOwnedHint gatewayId={ctx.gateway.id} what="This dnsmasq instance" /> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Local domain" hint="Appended to host names (domain).">
            <Input value={domain} disabled={!editable} onChange={(e) => setDomain(e.target.value)} className="font-mono" placeholder="lan" />
          </Field>
          <Field label="Answer locally only" hint="Queries under it never leave the router (local).">
            <Input value={local} disabled={!editable} onChange={(e) => setLocal(e.target.value)} className="font-mono" placeholder="lan" />
          </Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <ToggleRow
            label="Rebind protection"
            hint="Drops upstream answers that point into private ranges."
            checked={rebind}
            onChange={setRebind}
            disabled={!editable}
          />
          <ToggleRow
            label="Ignore the WAN's DNS servers"
            hint="noresolv: only the upstream servers below are asked."
            checked={noresolv}
            onChange={setNoresolv}
            disabled={!editable}
          />
        </div>
        <ItemsField
          label="Upstream servers"
          hint="address[#port]; asked in the router's order, Perch's after."
          router={s.upstreams.filter((u) => u.owner === 'router').map((u) => u.value)}
        >
          <ListEditor values={upstreams} onChange={setUpstreams} disabled={!editable} placeholder="192.168.1.53 or 203.0.113.53#5353" />
        </ItemsField>
        <ItemsField
          label="Domain forwards"
          hint="Send one domain to its own server; an empty server answers it locally only."
          router={s.forwards.filter((f) => f.owner === 'router').map((f) => f.value)}
        >
          <RowsEditor rows={forwards} onChange={setForwards} disabled={!editable} valuePlaceholder="192.168.1.2" />
        </ItemsField>
        <ItemsField
          label="Address overrides"
          hint="Answer a domain (and everything under it) with a fixed address; empty = NXDOMAIN."
          router={s.addresses.filter((a) => a.owner === 'router').map((a) => a.value)}
        >
          <RowsEditor rows={addresses} onChange={setAddresses} disabled={!editable} valuePlaceholder="192.168.1.10" />
        </ItemsField>
        <ItemsField
          label="Rebind exceptions"
          hint="Domains allowed to answer with private addresses."
          router={s.rebindDomains.filter((r) => r.owner === 'router').map((r) => r.value)}
        >
          <ListEditor values={rebindDomains} onChange={setRebindDomains} disabled={!editable} placeholder="perch.example.com" />
        </ItemsField>
        {s.other.length > 0 ? (
          <Field label="Entries Perch cannot read" hint="Kept as they are.">
            <ul className="font-mono text-[11px] text-muted-foreground">
              {s.other.map((o) => (
                <li key={o.option + o.value} className="break-all">
                  {o.option} {o.value}
                </li>
              ))}
            </ul>
          </Field>
        ) : null}

        {update.error ? (
          <div className="space-y-2">
            <ErrorLine message={nativeErrorMessage(update.error)} />
            <IssueList issues={refusalIssues(update.error)} />
          </div>
        ) : null}
        {result ? <NativeWriteResult result={{ ...result, gatewayId: ctx.gateway.id, object: null }} gatewayId={ctx.gateway.id} /> : null}
        {editable ? (
          <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
            <StageOnly checked={stage} onChange={setStage} />
            <Button
              size="sm"
              disabled={!dirty || update.isPending}
              onClick={() =>
                update.mutate(
                  { patch: { ...patch, instance: instance.perchId }, apply: !stage },
                  { onSuccess: onResult },
                )
              }
            >
              {update.isPending ? <Spinner className="size-3.5 text-current" /> : null}
              {stage ? 'Save draft' : 'Save and apply'}
            </Button>
          </div>
        ) : null}
        {settings.observedAt === null ? (
          <p className="text-[11px] text-muted-foreground">The router has not reported its resolver yet.</p>
        ) : null}
      </div>
    </Panel>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
      <div>
        <div className="text-xs font-medium">{label}</div>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </div>
  )
}

function ItemsField({
  label,
  hint,
  router,
  children,
}: {
  label: string
  hint: string
  router: string[]
  children: React.ReactNode
}) {
  return (
    <Field label={label} hint={hint}>
      {router.length > 0 ? (
        <ul className="mb-1.5 flex flex-wrap gap-1.5">
          {router.map((v) => (
            <li
              key={v}
              title="Added on the router: Perch keeps it and never removes it"
              className="inline-flex max-w-full items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              <LockSimple className="size-3 shrink-0" />
              <span className="truncate">{v}</span>
              <ToneBadge tone="neutral" className="h-4 px-1 text-[10px]">
                router
              </ToneBadge>
            </li>
          ))}
        </ul>
      ) : null}
      {children}
    </Field>
  )
}

function RowsEditor({
  rows,
  onChange,
  disabled,
  valuePlaceholder,
}: {
  rows: Row[]
  onChange: (rows: Row[]) => void
  disabled: boolean
  valuePlaceholder: string
}) {
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-1.5">
          <Input
            value={r.domain}
            disabled={disabled}
            aria-label="Domain"
            placeholder="example.com"
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, domain: e.target.value } : x)))}
            className="h-7 font-mono"
          />
          <Input
            value={r.value}
            disabled={disabled}
            aria-label="Address"
            placeholder={valuePlaceholder}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            className="h-7 font-mono"
          />
          {!disabled ? (
            <Button type="button" size="sm" variant="ghost" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <Trash className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ))}
      {!disabled ? (
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...rows, { domain: '', value: '' }])}>
          <Plus className="size-3.5" />
          Add
        </Button>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">None from Perch.</p>
      ) : null}
    </div>
  )
}

function ControllerNameCard({
  ctx,
  settings,
  instance,
}: {
  ctx: NativeContext
  settings: DnsSettings
  instance: DnsInstance | null
}) {
  const host = settings.controllerHost
  const update = useUpdateDnsSettings(ctx.gateway.id)
  const [result, setResult] = useState<DnsSettingsWrite | null>(null)
  const canFix = instance && instance.suggestRebindDomain && instance.sync.owner === 'perch' && !ctx.hardBlocked
  return (
    <Panel
      className="self-start"
      title={
        <span className="flex items-center gap-2">
          <PushPin className="size-3.5" />
          The controller's name
        </span>
      }
      description="The name the gateway agents dial. DNS changes that would change or drop its answer are refused."
    >
      {host.name ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Name</dt>
          <dd className="font-mono break-all">{host.name}</dd>
          <dt className="text-muted-foreground">Resolves to</dt>
          <dd className="font-mono break-all">
            {host.addresses.length > 0 ? host.addresses.join(', ') : <span className="text-status-serious">{host.error ?? 'nothing'}</span>}
          </dd>
          <dt className="text-muted-foreground">Answered by</dt>
          <dd>{host.local ? 'a local record on the router' : 'upstream DNS'}</dd>
          <dt className="text-muted-foreground">Source</dt>
          <dd>{host.source === 'resolver' ? 'the router’s own lookup' : host.source === 'app_url' ? 'the controller URL' : '—'}</dd>
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">The agents dial the controller by address: no name to protect.</p>
      )}
      {instance?.suggestRebindDomain ? (
        <div className="mt-3 space-y-2 rounded-md border border-status-warning/30 bg-status-warning/10 p-2.5 text-xs">
          <p>
            Rebind protection drops this name's private answer. Devices behind the gateway that resolve through it
            (access points) cannot reach Perch by name.
          </p>
          {canFix ? (
            <Button
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  {
                    patch: {
                      instance: instance.perchId,
                      rebindDomains: [
                        ...instance.settings.rebindDomains.filter((r) => r.owner === 'perch').map((r) => r.value),
                        host.name!,
                      ],
                    },
                  },
                  { onSuccess: setResult },
                )
              }
            >
              {update.isPending ? <Spinner className="size-3.5 text-current" /> : null}
              Allow {host.name}
            </Button>
          ) : null}
        </div>
      ) : null}
      {update.error ? <ErrorLine message={nativeErrorMessage(update.error)} /> : null}
      {result ? (
        <div className="mt-2">
          <NativeWriteResult result={{ ...result, gatewayId: ctx.gateway.id, object: null }} gatewayId={ctx.gateway.id} />
        </div>
      ) : null}
    </Panel>
  )
}
