import { useState } from 'react'
import { Info, Plus, Trash } from '@phosphor-icons/react'
import { ErrorLine, IssueList, ToneBadge } from '@/components/gateway-config/bits'
import { Field, ListEditor } from '@/components/gateway-native/native-ui'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useCreateWanAlias, useDeleteWanAlias, useUpdateWan } from '@/hooks/use-gateway-internet'
import { apiErrorCode } from '@/lib/api'
import { refusalField } from '@/lib/gateway-config'
import { checkTargetLabel, syncRefusalMessage } from '@/lib/gateway-sync'
import { refusalIssues } from '@/lib/networks'
import type { WanPatch, WanView } from '@/types/gateway-sync'

/**
 * The WAN editor (design gateway-sync dashboard.md 2.3): fields by the
 * uplink's `editable` level, secrets write-only, and "Review" instead of
 * apply — every write is staged (`?apply=0`) and handed to the review dialog
 * with the sections it touched. A NAT link edits addresses and enable only.
 */

type Proto = 'dhcp' | 'static' | 'pppoe'
type Ipv6Mode = 'off' | 'auto' | 'dhcpv6' | 'relay'

const PROTO_LABEL: Record<Proto, string> = { dhcp: 'DHCP', static: 'Static', pppoe: 'PPPoE' }
const IPV6_LABEL: Record<Ipv6Mode, string> = {
  off: 'Off',
  auto: 'Automatic',
  dhcpv6: 'DHCPv6',
  relay: 'Relay',
}

function isProto(value: string): value is Proto {
  return value === 'dhcp' || value === 'static' || value === 'pppoe'
}

const numOrNull = (text: string) => (text.trim() === '' ? null : Number(text))

export function WanEditor({
  gatewayId,
  wan,
  onClose,
  onReview,
}: {
  gatewayId: number
  wan: WanView
  onClose: () => void
  /** The staged sections, for the review dialog. */
  onReview: (perchIds: string[], title: string) => void
}) {
  const update = useUpdateWan(gatewayId)
  const full = wan.editable === 'full' && wan.role === 'internet'
  // A NAT link (another router upstream) keeps its type; its static addresses are editable.
  const natStatic = wan.role === 'nat_link' && wan.editable === 'full' && wan.proto === 'static'
  const startProto: Proto = isProto(wan.proto) ? wan.proto : 'dhcp'
  const startV6: Ipv6Mode = wan.ipv6.mode === 'static' ? 'off' : wan.ipv6.mode
  const [label, setLabel] = useState(wan.meta.label)
  const [enabled, setEnabled] = useState(wan.enabled)
  const [proto, setProto] = useState<Proto>(startProto)
  const [hostname, setHostname] = useState(wan.dhcp?.hostname ?? '')
  const [addresses, setAddresses] = useState(wan.static?.addresses ?? [])
  const [gateway, setGateway] = useState(wan.static?.gateway ?? '')
  const [username, setUsername] = useState(wan.pppoe?.username ?? '')
  const [password, setPassword] = useState('')
  const [changePassword, setChangePassword] = useState(false)
  const [service, setService] = useState(wan.pppoe?.service ?? '')
  const [useProvider, setUseProvider] = useState(wan.dns.useProvider)
  const [servers, setServers] = useState(wan.dns.servers)
  const [metric, setMetric] = useState(wan.metric === null ? '' : String(wan.metric))
  const [mtu, setMtu] = useState(wan.mtu === null ? '' : String(wan.mtu))
  const [mac, setMac] = useState(wan.mac.source === 'device' ? (wan.mac.effective ?? '') : '')
  const [v6, setV6] = useState<Ipv6Mode>(startV6)
  const [reqPrefix, setReqPrefix] = useState(wan.ipv6.reqPrefix ?? 'auto')
  const [moveSqm, setMoveSqm] = useState(true)
  const [targets, setTargets] = useState<string[]>(wan.meta.checkTargets ?? [])
  const [ownTargets, setOwnTargets] = useState(wan.meta.checkTargets !== null)
  const [confirm, setConfirm] = useState('')
  const lastUplink = apiErrorCode(update.error) === 'wan_last_uplink'
  const expected = refusalField<string>(update.error, 'confirm') ?? ''

  function patch(): WanPatch {
    const p: WanPatch = {}
    if (label.trim() !== wan.meta.label) p.label = label.trim()
    if (enabled !== wan.enabled) p.enabled = enabled
    if (numOrNull(metric) !== wan.metric && metric.trim() !== '') p.metric = Number(metric)
    if (useProvider !== wan.dns.useProvider || JSON.stringify(servers) !== JSON.stringify(wan.dns.servers)) {
      p.dns = { useProvider, servers: useProvider ? [] : servers }
    }
    if (numOrNull(mtu) !== wan.mtu) p.mtu = numOrNull(mtu)
    const checkTargets = ownTargets ? targets : null
    if (JSON.stringify(checkTargets) !== JSON.stringify(wan.meta.checkTargets)) p.checkTargets = checkTargets
    if (natStatic && (JSON.stringify(addresses) !== JSON.stringify(wan.static?.addresses ?? []) || gateway !== (wan.static?.gateway ?? ''))) {
      p.static = { addresses, gateway: gateway.trim() || null }
    }
    if (!full) return p
    if (proto !== startProto) {
      p.proto = proto
      if (wan.sqm) p.moveSqm = moveSqm
    }
    if (proto === 'dhcp' && hostname !== (wan.dhcp?.hostname ?? '')) p.dhcp = { hostname: hostname.trim() || null }
    if (
      proto === 'static' &&
      (proto !== startProto ||
        JSON.stringify(addresses) !== JSON.stringify(wan.static?.addresses ?? []) ||
        gateway !== (wan.static?.gateway ?? ''))
    ) {
      p.static = { addresses, gateway: gateway.trim() || null }
    }
    if (proto === 'pppoe') {
      const pppoe: NonNullable<WanPatch['pppoe']> = {}
      if (username !== (wan.pppoe?.username ?? '') || proto !== startProto) pppoe.username = username.trim()
      if (service !== (wan.pppoe?.service ?? '')) pppoe.service = service.trim() || null
      if (changePassword) pppoe.password = password
      if (Object.keys(pppoe).length > 0) p.pppoe = pppoe
    }
    const macNow = wan.mac.source === 'device' ? (wan.mac.effective ?? '') : ''
    if (mac.trim() !== macNow) p.mac = mac.trim() || null
    if (v6 !== startV6 || (v6 !== 'off' && reqPrefix !== (wan.ipv6.reqPrefix ?? 'auto'))) {
      const n = Number(reqPrefix)
      p.ipv6 = {
        mode: v6,
        ...(v6 === 'off' ? {} : { reqPrefix: Number.isInteger(n) && reqPrefix !== '' ? n : (reqPrefix as 'auto' | 'no') }),
      }
    }
    return p
  }

  function review() {
    const p = patch()
    if (lastUplink && confirm) p.confirm = confirm
    update.mutate(
      { perchId: wan.id, patch: p, apply: false },
      { onSuccess: (r) => onReview(r.object?.sections ?? wan.sections, `Review: ${wan.meta.label || wan.network}`) },
    )
  }

  const empty = Object.keys(patch()).length === 0

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>
            {wan.meta.label || wan.network}{' '}
            <span className="font-mono text-sm font-normal text-muted-foreground">{wan.network}</span>
          </DialogTitle>
          <DialogDescription>
            Nothing is sent yet: Review shows the change and what the router will test before you apply it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name in Perch" hint="Only Perch shows it">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
            </Field>
            <div className="flex items-end justify-between gap-3 pb-1">
              <span className="text-xs">Enabled</span>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" disabled={wan.management} />
            </div>
          </div>
          {wan.management ? (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" />
              Perch reaches the router over this link: it cannot be disabled and its connection type stays.
            </p>
          ) : null}

          {full ? (
            <>
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs">Connection type</span>
                <Segmented
                  size="xs"
                  value={proto}
                  onChange={setProto}
                  ariaLabel="Connection type"
                  options={(['dhcp', 'static', 'pppoe'] as const).map((id) => ({ id, label: PROTO_LABEL[id] }))}
                />
              </div>
              {proto === 'dhcp' ? (
                <Field label="Host name sent to the provider" hint="Empty: the router's">
                  <Input value={hostname} onChange={(e) => setHostname(e.target.value)} />
                </Field>
              ) : null}
              {proto === 'static' ? (
                <StaticFields addresses={addresses} setAddresses={setAddresses} gateway={gateway} setGateway={setGateway} />
              ) : null}
              {proto === 'pppoe' ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="User name">
                    <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
                  </Field>
                  <Field label="Service name" hint="Usually empty">
                    <Input value={service} onChange={(e) => setService(e.target.value)} />
                  </Field>
                  <Field
                    label="Password"
                    hint={
                      wan.pppoe?.password.set
                        ? `Set${wan.pppoe.password.owner === 'router' ? ' on the router' : ' by Perch'}; never shown`
                        : 'Not set'
                    }
                  >
                    {changePassword ? (
                      <Input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="new-password"
                      />
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setChangePassword(true)}>
                        Change password
                      </Button>
                    )}
                  </Field>
                </div>
              ) : null}
              {proto !== startProto && wan.sqm ? (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={moveSqm} onChange={(e) => setMoveSqm(e.target.checked)} />
                  Move the SQM queue ({wan.sqm.queue}) to the new connection
                </label>
              ) : null}
            </>
          ) : natStatic ? (
            <StaticFields addresses={addresses} setAddresses={setAddresses} gateway={gateway} setGateway={setGateway} />
          ) : wan.role === 'internet' ? (
            <p className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="font-mono">{wan.proto}</span> connections are shown as the router has them: edit this
                connection type in LuCI. Perch changes its metric, DNS, MTU and whether it is on.
              </span>
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs">Use the provider’s DNS servers</span>
            <Switch checked={useProvider} onCheckedChange={setUseProvider} aria-label="Use the provider's DNS" />
          </div>
          {!useProvider ? (
            <Field label="DNS servers" hint="In order">
              <ListEditor values={servers} onChange={setServers} placeholder="1.1.1.1" />
            </Field>
          ) : null}

          <details className="rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium">Advanced</summary>
            <div className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Metric" hint="Lower is preferred">
                  <Input value={metric} onChange={(e) => setMetric(e.target.value)} inputMode="numeric" className="font-mono" />
                </Field>
                <Field label="MTU" hint="Empty: automatic">
                  <Input value={mtu} onChange={(e) => setMtu(e.target.value)} inputMode="numeric" className="font-mono" />
                </Field>
                {full ? (
                  <Field
                    label="MAC address"
                    hint={wan.mac.ignoredInterfaceMac ? 'The router ignores the interface-level MAC; set here it applies' : 'Empty: the port’s own'}
                  >
                    <Input value={mac} onChange={(e) => setMac(e.target.value)} className="font-mono" placeholder="02:00:00:00:00:01" />
                  </Field>
                ) : null}
              </div>
              {full ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div className="space-y-1.5">
                    <span className="text-xs">IPv6</span>
                    <Segmented
                      size="xs"
                      value={v6}
                      onChange={setV6}
                      ariaLabel="IPv6 mode"
                      options={(['off', 'auto', 'dhcpv6', 'relay'] as const).map((id) => ({ id, label: IPV6_LABEL[id] }))}
                    />
                  </div>
                  {v6 !== 'off' ? (
                    <Field label="Prefix to ask for" hint="auto, no, or a length (48–64)">
                      <Input value={reqPrefix} onChange={(e) => setReqPrefix(e.target.value)} className="w-28 font-mono" />
                    </Field>
                  ) : null}
                </div>
              ) : null}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs">Own check targets for this link</span>
                  <Switch checked={ownTargets} onCheckedChange={setOwnTargets} aria-label="Own check targets" />
                </div>
                {ownTargets ? (
                  <ListEditor values={targets} onChange={setTargets} placeholder="$gateway or 9.9.9.9" />
                ) : (
                  <p className="text-[11px] text-muted-foreground">The defaults of Settings → Gateway sync.</p>
                )}
                {ownTargets && targets.length > 0 ? (
                  <p className="text-[11px] text-muted-foreground">Checks: {targets.map(checkTargetLabel).join(', ')}</p>
                ) : null}
              </div>
            </div>
          </details>

          {full ? <AliasList gatewayId={gatewayId} wan={wan} onReview={onReview} /> : null}

          {update.error ? (
            <div className="space-y-2">
              <ErrorLine message={syncRefusalMessage(update.error)} />
              <IssueList issues={refusalIssues(update.error)} />
              {lastUplink ? (
                <Field label={`Type "${expected}" to leave the router without internet anyway`}>
                  <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="font-mono" />
                </Field>
              ) : null}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button onClick={review} disabled={update.isPending || empty || (lastUplink && confirm !== expected)}>
            {update.isPending ? <Spinner className="size-3.5 text-current" /> : null}
            Review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StaticFields({
  addresses,
  setAddresses,
  gateway,
  setGateway,
}: {
  addresses: string[]
  setAddresses: (v: string[]) => void
  gateway: string
  setGateway: (v: string) => void
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Addresses" hint="With the prefix length: 203.0.113.10/24">
        <ListEditor values={addresses} onChange={setAddresses} placeholder="203.0.113.10/24" />
      </Field>
      <Field label="Gateway">
        <Input value={gateway} onChange={(e) => setGateway(e.target.value)} className="font-mono" />
      </Field>
    </div>
  )
}

/** "Extra addresses on this link": alias interfaces, each write staged and reviewed like the rest. */
function AliasList({
  gatewayId,
  wan,
  onReview,
}: {
  gatewayId: number
  wan: WanView
  onReview: (perchIds: string[], title: string) => void
}) {
  const create = useCreateWanAlias(gatewayId)
  const del = useDeleteWanAlias(gatewayId)
  const [adding, setAdding] = useState(false)
  const [network, setNetwork] = useState(`${wan.network}_alias`.slice(0, 15))
  const [addresses, setAddresses] = useState<string[]>([])
  const error = create.error ?? del.error
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">Extra addresses on this link</p>
      {wan.aliases.length === 0 && !adding ? <p className="text-[11px] text-muted-foreground">None.</p> : null}
      <ul className="space-y-1">
        {wan.aliases.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2 text-xs">
            <span>
              <span className="font-mono">{a.network}</span>{' '}
              <span className="font-mono text-muted-foreground">{a.addresses.join(', ')}</span>
              {a.sync.owner !== 'perch' ? (
                <ToneBadge tone="neutral" className="ml-1.5">
                  Router’s
                </ToneBadge>
              ) : null}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={del.isPending || a.sync.owner !== 'perch'}
              aria-label={`Remove ${a.network}`}
              onClick={() =>
                del.mutate(
                  { perchId: a.id, apply: false },
                  { onSuccess: () => onReview([a.id], `Review: remove ${a.network}`) },
                )
              }
            >
              <Trash className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      {adding ? (
        <div className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-end">
          <Field label="Name">
            <Input value={network} onChange={(e) => setNetwork(e.target.value)} className="font-mono" maxLength={15} />
          </Field>
          <Field label="Addresses">
            <ListEditor values={addresses} onChange={setAddresses} placeholder="203.0.113.11/24" />
          </Field>
          <Button
            size="sm"
            disabled={create.isPending || addresses.length === 0 || !network.trim()}
            onClick={() =>
              create.mutate(
                { wanId: wan.id, network: network.trim(), addresses, apply: false },
                { onSuccess: (r) => onReview(r.object ? [r.object.id] : wan.sections, `Review: ${network.trim()}`) },
              )
            }
          >
            Review
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus className="size-3.5" />
          Add addresses
        </Button>
      )}
      {error ? <ErrorLine message={syncRefusalMessage(error)} /> : null}
    </div>
  )
}
