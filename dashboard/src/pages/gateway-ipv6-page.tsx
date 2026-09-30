import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowsClockwise, Info, PencilSimple, Trash } from '@phosphor-icons/react'
import { ConfirmDialog, ErrorLine, IssueList, ToneBadge } from '@/components/gateway-config/bits'
import {
  Field,
  ListEditor,
  NativePage,
  NativeWriteResult,
  StageOnly,
  SyncBadges,
  type NativeContext,
} from '@/components/gateway-native/native-ui'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useGatewayIpv6, useUpdateIpv6Lan, useUpdateUla } from '@/hooks/use-gateway-ipv6'
import { useRetained } from '@/hooks/use-retained'
import { apiErrorCode } from '@/lib/api'
import { syncRefusalMessage } from '@/lib/gateway-sync'
import { refusalIssues } from '@/lib/networks'
import type { NativeWrite } from '@/types/gateway-native'
import type { Ipv6Lan, Ipv6LanPatch, Ipv6Mode, Ipv6Overview, WriteAnswer } from '@/types/gateway-sync'

/**
 * `/gateway/ipv6` (design gateway-sync dashboard.md 5, rest.md 5): what the
 * provider delegates, the site's ULA, and each LAN's prefix assignment and
 * router advertisements. The upstream mode is edited on the Internet page;
 * odhcpd stays the router's.
 */
export function GatewayIpv6Page() {
  return (
    <NativePage title="IPv6" description="Delegated prefixes, the ULA and IPv6 on each LAN">
      {(ctx) => <Ipv6View ctx={ctx} />}
    </NativePage>
  )
}

const MODE_LABEL: Record<Ipv6Mode, string> = {
  server: 'Server',
  relay: 'Relay',
  hybrid: 'Hybrid',
  disabled: 'Off',
}

function lifetime(until: string | null): string {
  if (!until) return 'no expiry reported'
  const seconds = Math.round((Date.parse(until) - Date.now()) / 1000)
  if (seconds <= 0) return 'expired'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`
  if (seconds < 86_400 * 2) return `${Math.round(seconds / 3600)} h left`
  return `${Math.round(seconds / 86_400)} days left`
}

function asNative(result: WriteAnswer<unknown>): NativeWrite<unknown> {
  return result as unknown as NativeWrite<unknown>
}

function Ipv6View({ ctx }: { ctx: NativeContext }) {
  const q = useGatewayIpv6(ctx.gateway.id)
  const [editing, setEditing] = useState<Ipv6Lan | null>(null)
  const shown = useRetained(editing)
  if (q.isPending) return <p className="text-sm text-muted-foreground">Loading IPv6…</p>
  if (q.error) return <ErrorLine message={syncRefusalMessage(q.error)} />
  const v = q.data
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <UpstreamPanel view={v} />
        <UlaPanel ctx={ctx} view={v} />
      </div>
      <LansPanel ctx={ctx} view={v} onEdit={setEditing} />
      <OdhcpdPanel view={v} />
      {shown ? (
        <LanDialog
          key={shown.network}
          ctx={ctx}
          lan={shown}
          open={editing !== null}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  )
}

function UpstreamPanel({ view }: { view: Ipv6Overview }) {
  return (
    <Panel
      title="From the provider"
      description="What each internet uplink receives. Change an uplink's IPv6 mode on the Internet page."
      actions={
        <Button asChild variant="outline" size="sm">
          <Link to="/gateway/internet">Internet</Link>
        </Button>
      }
    >
      {view.upstream.length === 0 ? (
        <p className="text-xs text-muted-foreground">No internet uplink is known yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {view.upstream.map((u) => (
            <li key={u.wan} className="space-y-1.5 py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{u.wan}</span>
                {u.companion ? <span className="font-mono text-[11px] text-muted-foreground">via {u.companion}</span> : null}
                <ToneBadge tone={u.mode === 'off' ? 'neutral' : 'info'}>IPv6 {u.mode}</ToneBadge>
              </div>
              {u.delegated.length > 0 ? (
                <ul className="space-y-0.5">
                  {u.delegated.map((d) => (
                    <li key={d.prefix} className="flex flex-wrap items-baseline gap-2 text-xs">
                      <span className="font-mono">{d.prefix}</span>
                      <span className="text-muted-foreground">
                        delegated · {lifetime(d.validUntil)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {u.mode === 'off'
                    ? 'IPv6 is off on this uplink.'
                    : `Your provider gives no IPv6 prefix on ${u.wan}${view.observedAt ? '' : ' (or the router has not reported it yet)'}.`}
                </p>
              )}
              {u.addresses.length > 0 ? (
                <p className="font-mono text-[11px] text-muted-foreground">{u.addresses.join(' · ')}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function UlaPanel({ ctx, view }: { ctx: NativeContext; view: Ipv6Overview }) {
  const update = useUpdateUla(ctx.gateway.id)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [result, setResult] = useState<WriteAnswer<Ipv6Overview> | null>(null)
  const editable = view.ula.sync?.owner === 'perch' && !ctx.hardBlocked
  const run = (ula: string | null) => {
    setResult(null)
    update.mutate({ patch: { ula } }, { onSuccess: (r) => { setResult(r); setConfirmRemove(false) } })
  }
  return (
    <Panel
      title="Local prefix (ULA)"
      description="The site's private IPv6 prefix: devices keep these addresses even when the provider's prefix changes."
      actions={<SyncBadges sync={view.ula.sync} />}
    >
      <div className="space-y-3">
        <p className="font-mono text-sm">{view.ula.prefix ?? <span className="text-muted-foreground">none</span>}</p>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => run('generate')} disabled={update.isPending}>
              {update.isPending ? <Spinner className="size-3.5 text-current" /> : <ArrowsClockwise className="size-3.5" />}
              {view.ula.prefix ? 'Generate a new one' : 'Generate'}
            </Button>
            {view.ula.prefix ? (
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)} disabled={update.isPending}>
                <Trash className="size-3.5" />
                Remove
              </Button>
            ) : null}
          </div>
        ) : view.ula.sync ? (
          <p className="text-xs text-muted-foreground">Router-owned: include the network globals section to edit it here.</p>
        ) : null}
        {update.error ? <ErrorLine message={syncRefusalMessage(update.error)} /> : null}
        {result ? <NativeWriteResult result={asNative(result)} gatewayId={ctx.gateway.id} /> : null}
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the ULA?"
        description="Devices lose their local IPv6 addresses; anything that reached them by those addresses stops working."
        confirmLabel="Remove"
        destructive
        pending={update.isPending}
        onConfirm={() => run(null)}
      />
    </Panel>
  )
}

function LansPanel({ ctx, view, onEdit }: { ctx: NativeContext; view: Ipv6Overview; onEdit: (lan: Ipv6Lan) => void }) {
  return (
    <Panel title="IPv6 on the LANs" description="Prefix assignment and router advertisements per network." flush>
      {view.lans.length === 0 ? (
        <EmptyState title="No LAN with a DHCP pool" description="IPv6 is set per network through its DHCP pool." className="py-10" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="border-y border-border bg-muted/30 text-left text-[11px] text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Network</th>
                <th className="px-2 py-2 font-medium">Assignment</th>
                <th className="px-2 py-2 font-medium">Prefixes now</th>
                <th className="px-2 py-2 font-medium">RA</th>
                <th className="px-2 py-2 font-medium">DHCPv6</th>
                <th className="px-2 py-2 font-medium">NDP</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {view.lans.map((lan) => (
                <tr key={lan.network} className="align-top">
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{lan.network}</span>
                      {lan.management ? <ToneBadge tone="info">Controller path</ToneBadge> : null}
                      {lan.ownership === 'router' ? (
                        <ToneBadge tone="neutral" title="The router keeps these IPv6 options until you edit them here">
                          Router-owned until edited
                        </ToneBadge>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-2 py-2.5 font-mono">
                    {lan.ip6assign ? `/${lan.ip6assign}` : 'none'}
                    {lan.ip6hint ? <span className="text-muted-foreground"> · hint {lan.ip6hint}</span> : null}
                  </td>
                  <td className="px-2 py-2.5 font-mono">
                    {lan.assigned.length > 0 ? lan.assigned.join(', ') : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-2 py-2.5">{lan.ra ? MODE_LABEL[lan.ra] : '—'}</td>
                  <td className="px-2 py-2.5">{lan.dhcpv6 ? MODE_LABEL[lan.dhcpv6] : '—'}</td>
                  <td className="px-2 py-2.5">{lan.ndp ? MODE_LABEL[lan.ndp] : '—'}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onEdit(lan)}
                      disabled={ctx.hardBlocked || lan.sync?.owner !== 'perch'}
                      aria-label={`Edit IPv6 on ${lan.network}`}
                    >
                      <PencilSimple className="size-3.5" />
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

const MODES: Ipv6Mode[] = ['server', 'hybrid', 'relay', 'disabled']
const NDP_MODES = ['hybrid', 'relay', 'disabled'] as const

function LanDialog({ ctx, lan, open, onClose }: { ctx: NativeContext; lan: Ipv6Lan; open: boolean; onClose: () => void }) {
  const update = useUpdateIpv6Lan(ctx.gateway.id)
  const [assign, setAssign] = useState(lan.ip6assign ? String(lan.ip6assign) : '')
  const [hint, setHint] = useState(lan.ip6hint ?? '')
  const [ra, setRa] = useState<Ipv6Mode>(lan.ra ?? 'server')
  const [dhcpv6, setDhcpv6] = useState<Ipv6Mode>(lan.dhcpv6 ?? 'server')
  const [ndp, setNdp] = useState<(typeof NDP_MODES)[number]>(lan.ndp ?? 'disabled')
  const [slaac, setSlaac] = useState(lan.raSlaac ?? true)
  const [dns, setDns] = useState(lan.dns)
  const [confirm, setConfirm] = useState('')
  const [stage, setStage] = useState(false)
  const [result, setResult] = useState<WriteAnswer<Ipv6Lan> | null>(null)
  const needsConfirm = apiErrorCode(update.error) === 'ipv6_admin_path'

  function submit() {
    const patch: Ipv6LanPatch = {
      ...(assign !== (lan.ip6assign ? String(lan.ip6assign) : '') ? { ip6assign: assign === '' ? null : Number(assign) } : {}),
      ...(hint !== (lan.ip6hint ?? '') ? { ip6hint: hint === '' ? null : hint } : {}),
      ...(ra !== lan.ra ? { ra } : {}),
      ...(dhcpv6 !== lan.dhcpv6 ? { dhcpv6 } : {}),
      ...(ndp !== lan.ndp ? { ndp } : {}),
      ...(slaac !== (lan.raSlaac ?? true) ? { raSlaac: slaac } : {}),
      ...(JSON.stringify(dns) !== JSON.stringify(lan.dns) ? { dns } : {}),
      ...(needsConfirm && confirm ? { confirm } : {}),
    }
    update.mutate({ network: lan.network, patch, apply: !stage }, { onSuccess: setResult })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>IPv6 on {lan.network}</DialogTitle>
          <DialogDescription>
            Clients pick up router advertisements within minutes; a new prefix length renumbers the network.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {result ? (
            <NativeWriteResult result={asNative(result)} gatewayId={ctx.gateway.id} />
          ) : (
            <>
              {lan.ownership === 'router' ? (
                <p className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <Info className="mt-0.5 size-4 shrink-0" />
                  The router still owns this pool's IPv6 options. Saving here hands them to Perch; the router's other
                  DHCP settings stay as they are.
                </p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Prefix length for this LAN" hint="64 is one /64 from the delegated prefix; empty = none">
                  <Input value={assign} inputMode="numeric" onChange={(e) => setAssign(e.target.value)} className="font-mono" />
                </Field>
                <Field label="Subnet hint" hint="Up to four hex digits: which /64 of the prefix">
                  <Input value={hint} onChange={(e) => setHint(e.target.value)} className="font-mono" />
                </Field>
              </div>
              <ModeRow label="Router advertisements" value={ra} onChange={setRa} options={MODES} />
              <ModeRow label="DHCPv6" value={dhcpv6} onChange={setDhcpv6} options={MODES} />
              <ModeRow label="NDP proxy" value={ndp} onChange={setNdp} options={NDP_MODES} />
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs">Let devices pick their own address (SLAAC)</span>
                <Switch checked={slaac} onCheckedChange={setSlaac} aria-label="SLAAC" />
              </div>
              <Field label="DNS servers announced" hint="Empty: the router itself">
                <ListEditor values={dns} onChange={setDns} placeholder="fd00::1" />
              </Field>
              {update.error ? (
                <div className="space-y-2">
                  <ErrorLine message={syncRefusalMessage(update.error)} />
                  <IssueList issues={refusalIssues(update.error)} />
                  {needsConfirm ? (
                    <Field label={`You are connected over IPv6 on ${lan.network}. Type "${lan.network}" to switch it off anyway`}>
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
              <Button onClick={submit} disabled={update.isPending || (needsConfirm && confirm !== lan.network)}>
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

function ModeRow<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: T
  onChange: (v: T) => void
  options: readonly T[]
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-xs">{label}</span>
      <Segmented
        size="xs"
        value={value}
        onChange={onChange}
        ariaLabel={label}
        options={options.map((o) => ({ id: o, label: MODE_LABEL[o as Ipv6Mode] ?? o }))}
      />
    </div>
  )
}

function OdhcpdPanel({ view }: { view: Ipv6Overview }) {
  const o = view.odhcpd
  if (!o.perchId && Object.keys(o.options).length === 0) return null
  return (
    <Panel title="odhcpd" description="The router's IPv6 DHCP and RA server. Perch leaves its own settings to the router.">
      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Main DHCP server</dt>
          <dd>{o.maindhcp === null ? 'unknown' : o.maindhcp ? 'odhcpd' : 'dnsmasq'}</dd>
        </div>
        {Object.entries(o.options)
          .filter(([k]) => k !== 'maindhcp')
          .map(([k, value]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="font-mono text-muted-foreground">{k}</dt>
              <dd className="truncate font-mono">{Array.isArray(value) ? value.join(' ') : value}</dd>
            </div>
          ))}
      </dl>
    </Panel>
  )
}
