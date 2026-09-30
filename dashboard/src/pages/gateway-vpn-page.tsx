import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowsClockwise,
  DownloadSimple,
  Key,
  LinkSimple,
  LockKey,
  PencilSimple,
  Plus,
  Trash,
  Warning,
} from '@phosphor-icons/react'
import { ConfirmDialog, ErrorLine, FactRow, IssueList, PasswordField, ToneBadge } from '@/components/gateway-config/bits'
import {
  Field,
  ListEditor,
  NativePage,
  NativeWriteResult,
  StageOnly,
  SyncBadges,
  type NativeContext,
} from '@/components/gateway-native/native-ui'
import { TypedConfirmDialog } from '@/components/gateway-sync/typed-confirm-dialog'
import { PlainHttpNotice } from '@/components/security/plain-http'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useDialog } from '@/hooks/use-dialog'
import { useGatewaySyncSettings } from '@/hooks/use-gateway-sync'
import {
  useCreateWgInterface,
  useCreateWgPeer,
  useDeleteWgInterface,
  useDeleteWgPeer,
  useRotateWgKey,
  useUpdateWgPeer,
  useWireguard,
} from '@/hooks/use-gateway-vpn'
import { useGatewayNetworks } from '@/hooks/use-networks'
import { apiErrorCode } from '@/lib/api'
import { formatBytes } from '@/lib/format-bytes'
import { formatRelative } from '@/lib/gateway-observation'
import { syncRefusalMessage, unavailableText } from '@/lib/gateway-sync'
import { refusalIssues } from '@/lib/networks'
import { textareaClassName } from '@/lib/portal'
import { downloadText, freeName, freePort, freeSubnet, isWgKey, parseWgConf } from '@/lib/wireguard'
import type { NativeWrite } from '@/types/gateway-native'
import type {
  WgClientConfig,
  WgInterfaceView,
  WgOverview,
  WgPeerPatch,
  WgPeerView,
  WriteAnswer,
} from '@/types/gateway-sync'

/**
 * `/gateway/vpn` (design gateway-sync dashboard.md 4, rest.md 4): WireGuard
 * servers and client links on the managed gateway, and their peers. Private
 * keys are made on the router; a generated peer's config is shown once and
 * never kept (the one-time panel), and the create answer is never cached.
 */
export function GatewayVpnPage() {
  return (
    <NativePage title="VPN" description="WireGuard servers, client links and peers">
      {(ctx) => <VpnView ctx={ctx} />}
    </NativePage>
  )
}

const ROLE_LABEL: Record<WgInterfaceView['role'], string> = {
  server: 'Server',
  client: 'Client link',
  site: 'Site link',
}

function asNative(result: WriteAnswer<unknown>): NativeWrite<unknown> {
  return result as unknown as NativeWrite<unknown>
}

/** Whether the admin's password is asked (Settings → Gateway sync `wgStepUp`; asked when unknown). */
function useStepUp(): boolean {
  const settings = useGatewaySyncSettings()
  return settings.data?.settings.wgStepUp ?? true
}

function passwordError(error: unknown): string | null {
  return apiErrorCode(error) === 'invalid_password' ? 'That password is not right.' : null
}

function VpnView({ ctx }: { ctx: NativeContext }) {
  const q = useWireguard(ctx.gateway.id)
  const server = useDialog()
  const link = useDialog()
  if (q.isPending) return <p className="text-sm text-muted-foreground">Loading WireGuard…</p>
  if (q.error) return <ErrorLine message={syncRefusalMessage(q.error)} />
  const v = q.data
  const blocked = unavailableText(v.available ? null : v.unavailableReason, ctx.gateway.name)
  const canWrite = ctx.isAdmin && v.available && !ctx.hardBlocked
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={server.show} disabled={!canWrite || !v.canGenerateKeys}>
          <Plus className="size-3.5" />
          New WireGuard server
        </Button>
        <Button size="sm" variant="outline" onClick={link.show} disabled={!canWrite}>
          <LinkSimple className="size-3.5" />
          New client link
        </Button>
        {blocked ? <span className="text-xs text-muted-foreground">{blocked}</span> : null}
        {!blocked && !v.canGenerateKeys ? (
          <span className="text-xs text-muted-foreground">
            The gateway agent cannot make WireGuard keys yet: update perch-collector (Settings → Collectors).
          </span>
        ) : null}
      </div>
      {!v.secureTransport ? (
        <PlainHttpNotice>
          The controller reaches this gateway over plain HTTP, so Perch sends it no secrets: preshared keys are off and a
          provider’s private key cannot be pasted here. Keys the router makes itself are unaffected.
        </PlainHttpNotice>
      ) : null}
      {v.interfaces.length === 0 ? (
        <Panel title="WireGuard">
          <EmptyState
            icon={<LockKey className="size-6" />}
            title="No WireGuard interfaces"
            description="A server lets your phone or laptop reach this network from anywhere. Its private key is made on the router and never leaves it."
            className="py-10"
          />
        </Panel>
      ) : (
        v.interfaces.map((iface) => <InterfacePanel key={iface.id} ctx={ctx} view={v} iface={iface} canWrite={canWrite} />)
      )}
      {v.orphanPeers.length > 0 ? (
        <Panel title="Peers without an interface" description="Peer sections whose interface is gone. Remove them in LuCI.">
          <ul className="space-y-1 text-xs">
            {v.orphanPeers.map((p) => (
              <li key={p.perchId} className="font-mono">
                {p.type} · {p.section}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      {server.open ? <NewServerDialog key={server.key} ctx={ctx} view={v} open onClose={() => server.setOpen(false)} /> : null}
      {link.open ? <ClientLinkDialog key={link.key} ctx={ctx} view={v} open onClose={() => link.setOpen(false)} /> : null}
    </>
  )
}

// ── One interface ───────────────────────────────────────────────────────────

function InterfacePanel({
  ctx,
  view,
  iface,
  canWrite,
}: {
  ctx: NativeContext
  view: WgOverview
  iface: WgInterfaceView
  canWrite: boolean
}) {
  const addPeer = useDialog()
  const rotate = useDialog()
  const remove = useDialog()
  const owned = iface.sync.owner === 'perch'
  const editable = canWrite && owned
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{iface.network}</span>
          <ToneBadge tone="info">{ROLE_LABEL[iface.role]}</ToneBadge>
          {!iface.enabled ? <ToneBadge tone="neutral">Disabled</ToneBadge> : null}
          {iface.live ? (
            <ToneBadge tone={iface.live.up ? 'good' : 'warning'}>{iface.live.up ? 'Up' : 'Down'}</ToneBadge>
          ) : null}
          {iface.management ? <ToneBadge tone="info">Controller path</ToneBadge> : null}
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          <SyncBadges sync={iface.sync} />
          {iface.role === 'server' ? (
            <Button size="sm" variant="outline" onClick={addPeer.show} disabled={!editable}>
              <Plus className="size-3.5" />
              Add peer
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={rotate.show}
            disabled={!editable || iface.management || !view.canGenerateKeys}
            aria-label={`Rotate the key of ${iface.network}`}
          >
            <ArrowsClockwise className="size-3.5" />
            Rotate key
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={remove.show}
            disabled={!editable || iface.management}
            aria-label={`Delete ${iface.network}`}
          >
            <Trash className="size-3.5" />
          </Button>
        </div>
      }
    >
      <div className="grid gap-x-8 sm:grid-cols-2">
        <div>
          <FactRow label="Listen port">
            <span className="font-mono">{iface.listenPort ?? '—'}</span>
            {iface.listenPort ? (
              <span className="ml-2 text-muted-foreground">
                {iface.portOpen ? `open on ${iface.portOpen.zones.join(', ') || 'the WAN'}` : 'not open on the WAN'}
              </span>
            ) : null}
          </FactRow>
          <FactRow label="Addresses">
            <span className="font-mono">{iface.addresses.join(', ') || '—'}</span>
          </FactRow>
          <FactRow label="Zone">{iface.zone ?? '—'}</FactRow>
        </div>
        <div>
          <FactRow label="Public key">
            {iface.publicKey ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="max-w-[16rem] truncate font-mono" title={iface.publicKey}>
                  {iface.publicKey}
                </span>
                <CopyButton value={iface.publicKey} ariaLabel={`Copy the public key of ${iface.network}`} />
              </span>
            ) : (
              <span className="text-muted-foreground">not reported yet (apply first)</span>
            )}
          </FactRow>
          <FactRow label="Private key">
            {iface.privateKey.set
              ? iface.privateKey.generatedOnRouter
                ? 'made on the router'
                : iface.privateKey.owner === 'controller'
                  ? 'set by Perch'
                  : 'the router’s'
              : 'none'}
          </FactRow>
          {iface.mtu ? <FactRow label="MTU">{iface.mtu}</FactRow> : null}
        </div>
      </div>
      <PeersTable ctx={ctx} iface={iface} editable={editable} />
      {addPeer.open ? (
        <AddPeerDialog key={addPeer.key} ctx={ctx} view={view} iface={iface} onClose={() => addPeer.setOpen(false)} />
      ) : null}
      {rotate.open ? <RotateDialog key={rotate.key} ctx={ctx} iface={iface} onClose={() => rotate.setOpen(false)} /> : null}
      {remove.open ? <DeleteInterfaceDialog key={remove.key} ctx={ctx} iface={iface} onClose={() => remove.setOpen(false)} /> : null}
    </Panel>
  )
}

function PeersTable({ ctx, iface, editable }: { ctx: NativeContext; iface: WgInterfaceView; editable: boolean }) {
  const [editing, setEditing] = useState<WgPeerView | null>(null)
  const [removing, setRemoving] = useState<WgPeerView | null>(null)
  const del = useDeleteWgPeer(ctx.gateway.id)
  if (iface.peers.length === 0) {
    return (
      <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
        {iface.role === 'server' ? 'No peers yet: add a phone or laptop.' : 'No peer: this link has nowhere to connect.'}
      </p>
    )
  }
  return (
    <div className="-mx-4 mt-3 overflow-x-auto border-t border-border">
      <table className="w-full min-w-[720px] text-xs">
        <thead className="bg-muted/30 text-left text-[11px] text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Peer</th>
            <th className="px-2 py-2 font-medium">Allowed IPs</th>
            <th className="px-2 py-2 font-medium">Endpoint</th>
            <th className="px-2 py-2 font-medium">Last handshake</th>
            <th className="px-2 py-2 text-right font-medium">Received / sent</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {iface.peers.map((p) => (
            <tr key={p.id} className="align-top">
              <td className="px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{p.label ?? 'Unnamed peer'}</span>
                  {p.presharedKey.set ? <ToneBadge tone="neutral">PSK</ToneBadge> : null}
                </div>
                <div className="font-mono text-[11px] text-muted-foreground" title={p.publicKey}>
                  {p.publicKey.slice(0, 12)}…
                </div>
                {p.device ? (
                  <Link to={`/devices/${encodeURIComponent(p.device.mac)}`} className="text-[11px] underline-offset-2 hover:underline">
                    {p.device.name ?? p.device.mac}
                  </Link>
                ) : null}
              </td>
              <td className="px-2 py-2.5 font-mono">{p.allowedIps.join(', ') || '—'}</td>
              <td className="px-2 py-2.5 font-mono">
                {p.live?.endpoint ?? (p.endpoint ? `${p.endpoint.host}:${p.endpoint.port}` : '—')}
              </td>
              <td className="px-2 py-2.5">
                {p.live?.latestHandshakeAt ? (
                  <span className="inline-flex items-center gap-1.5">
                    {formatRelative(p.live.latestHandshakeAt)}
                    {p.live.online ? <ToneBadge tone="good">Online</ToneBadge> : <ToneBadge tone="neutral">Offline</ToneBadge>}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{p.live ? 'never' : '—'}</span>
                )}
              </td>
              <td className="px-2 py-2.5 text-right font-mono">
                {p.live ? `${formatBytes(p.live.rxBytes)} / ${formatBytes(p.live.txBytes)}` : '—'}
              </td>
              <td className="px-4 py-2.5 text-right whitespace-nowrap">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(p)}
                  disabled={!editable || p.sync.owner !== 'perch'}
                  aria-label={`Edit ${p.label ?? 'peer'}`}
                >
                  <PencilSimple className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    del.reset()
                    setRemoving(p)
                  }}
                  disabled={!editable || p.sync.owner !== 'perch'}
                  aria-label={`Remove ${p.label ?? 'peer'}`}
                >
                  <Trash className="size-3.5" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing ? <EditPeerDialog key={editing.id} ctx={ctx} peer={editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.label ?? 'this peer'}?`}
        description="It can no longer connect. Its config on the device stops working; a new peer needs a new config."
        confirmLabel="Remove"
        destructive
        pending={del.isPending}
        error={del.error ? syncRefusalMessage(del.error) : null}
        onConfirm={() => removing && del.mutate({ perchId: removing.id }, { onSuccess: () => setRemoving(null) })}
      />
    </div>
  )
}

// ── New server ──────────────────────────────────────────────────────────────

function NewServerDialog({ ctx, view, open, onClose }: { ctx: NativeContext; view: WgOverview; open: boolean; onClose: () => void }) {
  const create = useCreateWgInterface(ctx.gateway.id)
  const networks = useGatewayNetworks(ctx.gateway.id)
  const stepUp = useStepUp()
  const used = useMemo(() => {
    const cidrs = [
      ...(networks.data ?? []).flatMap((n) => n.ipv4All),
      ...view.interfaces.flatMap((i) => i.addresses),
    ]
    return {
      cidrs,
      names: [...(networks.data ?? []).map((n) => n.key), ...view.interfaces.map((i) => i.network)],
      ports: view.interfaces.map((i) => i.listenPort),
    }
  }, [networks.data, view.interfaces])
  // Defaults follow the networks as they load, until the admin edits the field.
  const [nameEdit, setName] = useState<string | null>(null)
  const [portEdit, setPort] = useState<string | null>(null)
  const [subnetEdit, setSubnet] = useState<string | null>(null)
  const name = nameEdit ?? freeName(used.names)
  const port = portEdit ?? String(freePort(used.ports))
  const subnet = subnetEdit ?? freeSubnet(used.cidrs)
  const [zone, setZone] = useState<'lan' | 'own'>('own')
  const [openPort, setOpenPort] = useState(true)
  const [password, setPassword] = useState('')
  const [stage, setStage] = useState(false)
  const [result, setResult] = useState<WriteAnswer<WgInterfaceView> | null>(null)

  function submit() {
    create.mutate(
      {
        input: {
          network: name.trim(),
          role: 'server',
          listenPort: Number(port),
          addresses: [subnet.trim()],
          ...(zone === 'lan' ? { zone: 'lan' } : { createZone: true }),
          openPort,
          currentPassword: password,
        },
        apply: !stage,
      },
      { onSuccess: setResult },
    )
  }

  const edit = (set: (v: string) => void) => (e: ChangeEvent<HTMLInputElement>) => set(e.target.value)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>New WireGuard server</DialogTitle>
          <DialogDescription>
            Lets your devices reach this network from anywhere. The router makes the private key; only its public key
            reaches Perch.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {result ? (
            <NativeWriteResult result={asNative(result)} gatewayId={ctx.gateway.id} />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Network name">
                  <Input value={name} onChange={edit(setName)} className="font-mono" maxLength={15} />
                </Field>
                <Field label="Listen port" hint="UDP">
                  <Input value={port} onChange={edit(setPort)} inputMode="numeric" className="font-mono" />
                </Field>
                <Field label="Subnet" hint="The router's address in it">
                  <Input value={subnet} onChange={edit(setSubnet)} className="font-mono" />
                </Field>
              </div>
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs">What peers may reach</span>
                <Segmented
                  size="xs"
                  value={zone}
                  onChange={setZone}
                  ariaLabel="Zone"
                  options={[
                    { id: 'own', label: 'Own zone (LAN + internet)' },
                    { id: 'lan', label: 'Full LAN access' },
                  ]}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs">Open the port on the WAN</span>
                <Switch checked={openPort} onCheckedChange={setOpenPort} aria-label="Open the port on the WAN" />
              </div>
              {!openPort ? (
                <p className="text-xs text-muted-foreground">Peers can only connect from inside the network until the port is open.</p>
              ) : null}
              {stepUp ? <PasswordField value={password} onChange={setPassword} error={passwordError(create.error)} /> : null}
              {create.error && !passwordError(create.error) ? (
                <div className="space-y-2">
                  <ErrorLine message={syncRefusalMessage(create.error)} />
                  <IssueList issues={refusalIssues(create.error)} />
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
              <Button variant="outline" onClick={onClose} disabled={create.isPending}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={create.isPending || !name.trim() || !subnet.trim() || (stepUp && !password)}>
                {create.isPending ? <Spinner className="size-3.5 text-current" /> : null}
                {stage ? 'Save draft' : 'Create and apply'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Client link (a provider's .conf) ───────────────────────────────────────

function ClientLinkDialog({ ctx, view, open, onClose }: { ctx: NativeContext; view: WgOverview; open: boolean; onClose: () => void }) {
  const createIface = useCreateWgInterface(ctx.gateway.id)
  const createPeer = useCreateWgPeer(ctx.gateway.id)
  const stepUp = useStepUp()
  const [text, setText] = useState('')
  const [name, setName] = useState(() => freeName(view.interfaces.map((i) => i.network)))
  const [label, setLabel] = useState('provider')
  const [password, setPassword] = useState('')
  const [result, setResult] = useState<WriteAnswer<unknown> | null>(null)
  const parsed = useMemo(() => (text.trim() ? parseWgConf(text) : null), [text])
  const peer = parsed?.peer ?? null
  const problems: string[] = []
  if (parsed) {
    if (parsed.addresses.length === 0) problems.push('The file has no Address.')
    if (!peer?.publicKey || !isWgKey(peer.publicKey)) problems.push('The file has no [Peer] with a PublicKey.')
    if (!peer?.endpoint) problems.push('The [Peer] has no Endpoint (host:port).')
  }
  const sendKey = view.secureTransport && parsed?.privateKey ? parsed.privateKey : null
  const pending = createIface.isPending || createPeer.isPending
  const error = createIface.error ?? createPeer.error

  async function submit() {
    if (!parsed || !peer?.publicKey || problems.length > 0) return
    // The interface first (its key made on the router unless the provider's is sent), then its peer.
    const made = await createIface.mutateAsync({
      input: {
        network: name.trim(),
        role: 'client',
        addresses: parsed.addresses,
        ...(parsed.mtu ? { mtu: parsed.mtu } : {}),
        createZone: true,
        ...(sendKey ? { privateKey: sendKey } : {}),
        currentPassword: password,
      },
    })
    if (!made.object) {
      setResult(made)
      return
    }
    const answer = await createPeer.mutateAsync({
      interfaceId: made.object.id,
      input: {
        label: label.trim() || 'provider',
        publicKey: peer.publicKey,
        presharedKey: 'none',
        allowedIps: peer.allowedIps.length > 0 ? peer.allowedIps : ['0.0.0.0/0'],
        endpoint: peer.endpoint!,
        ...(peer.keepalive ? { keepalive: peer.keepalive } : {}),
        routeAllowedIps: true,
        currentPassword: password,
      },
    })
    setResult(answer)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>New client link</DialogTitle>
          <DialogDescription>
            Connects the router to a VPN provider or another site. Paste the provider’s WireGuard file; it is read in
            this browser.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {result ? (
            <NativeWriteResult result={asNative(result)} gatewayId={ctx.gateway.id} />
          ) : (
            <>
              <Field label="The provider’s .conf">
                <textarea
                  rows={8}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  className={`${textareaClassName} font-mono`}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={'[Interface]\nPrivateKey = …\nAddress = 10.2.0.2/32\n\n[Peer]\nPublicKey = …\nEndpoint = vpn.example.com:51820'}
                />
              </Field>
              {parsed ? (
                <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                  <FactRow label="Addresses">
                    <span className="font-mono">{parsed.addresses.join(', ') || '—'}</span>
                  </FactRow>
                  <FactRow label="Provider">
                    <span className="font-mono">
                      {peer?.endpoint ? `${peer.endpoint.host}:${peer.endpoint.port}` : '—'}
                    </span>
                  </FactRow>
                  <FactRow label="Routes through it">
                    <span className="font-mono">{peer?.allowedIps.join(', ') || '0.0.0.0/0'}</span>
                  </FactRow>
                  <FactRow label="Private key">
                    {parsed.privateKey
                      ? sendKey
                        ? 'sent to the router over TLS, not kept by Perch'
                        : 'not sent (plain HTTP)'
                      : 'none in the file'}
                  </FactRow>
                </div>
              ) : null}
              {parsed && !sendKey ? (
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Key className="mt-0.5 size-4 shrink-0" />
                  The router makes its own key instead. Once applied, register its public key (shown on this page) with
                  the provider.
                </p>
              ) : null}
              {peer?.presharedKey ? (
                <p className="flex items-start gap-2 text-xs text-status-warning">
                  <Warning className="mt-0.5 size-4 shrink-0" />
                  The file has a preshared key. Perch does not copy it: set it in LuCI on the router after applying.
                </p>
              ) : null}
              {problems.length > 0 ? <ErrorLine message={problems.join(' ')} /> : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Network name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono" maxLength={15} />
                </Field>
                <Field label="Peer label">
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} />
                </Field>
              </div>
              {stepUp ? <PasswordField value={password} onChange={setPassword} error={passwordError(error)} /> : null}
              {error && !passwordError(error) ? (
                <div className="space-y-2">
                  <ErrorLine message={syncRefusalMessage(error)} />
                  <IssueList issues={refusalIssues(error)} />
                </div>
              ) : null}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {result ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button
                onClick={() => void submit().catch(() => undefined)}
                disabled={pending || !parsed || problems.length > 0 || !name.trim() || (stepUp && !password)}
              >
                {pending ? <Spinner className="size-3.5 text-current" /> : null}
                Create and apply
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Peers ───────────────────────────────────────────────────────────────────

function AddPeerDialog({
  ctx,
  view,
  iface,
  onClose,
}: {
  ctx: NativeContext
  view: WgOverview
  iface: WgInterfaceView
  onClose: () => void
}) {
  const create = useCreateWgPeer(ctx.gateway.id)
  const stepUp = useStepUp()
  const [mode, setMode] = useState<'generate' | 'paste'>('generate')
  const [label, setLabel] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [dns, setDns] = useState<string[]>([])
  const [clientAllowed, setClientAllowed] = useState<string[]>([])
  const [password, setPassword] = useState('')
  const [stage, setStage] = useState(false)
  const [answer, setAnswer] = useState<WriteAnswer<WgPeerView> | null>(null)
  const [config, setConfig] = useState<WgClientConfig | null>(null)
  const keyProblem = mode === 'paste' && publicKey.trim() !== '' && !isWgKey(publicKey)

  function close() {
    // The one-time config goes with the dialog: nothing else holds it.
    setConfig(null)
    create.reset()
    onClose()
  }

  function submit() {
    create.mutate(
      {
        interfaceId: iface.id,
        input: {
          label: label.trim(),
          ...(mode === 'paste' ? { publicKey: publicKey.trim() } : { generateKeys: true as const }),
          ...(mode === 'generate' && (dns.length > 0 || clientAllowed.length > 0)
            ? {
                client: {
                  ...(dns.length > 0 ? { dns } : {}),
                  ...(clientAllowed.length > 0 ? { allowedIps: clientAllowed } : {}),
                },
              }
            : {}),
          currentPassword: password,
        },
        apply: !stage,
      },
      {
        onSuccess: (r) => {
          const { clientConfig, ...rest } = r
          setAnswer(rest)
          setConfig(clientConfig)
        },
      },
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{config ? 'Save this configuration now' : `Add a peer to ${iface.network}`}</DialogTitle>
          <DialogDescription>
            {config
              ? 'It holds the device’s private key. Perch does not keep it: once you close this, nobody can show it again.'
              : 'A phone, laptop or another router that may connect to this server.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {config ? (
            <OneTimeConfig config={config} />
          ) : answer ? (
            <NativeWriteResult result={asNative(answer)} gatewayId={ctx.gateway.id} />
          ) : (
            <>
              <Segmented
                size="xs"
                value={mode}
                onChange={setMode}
                ariaLabel="Keys"
                options={[
                  { id: 'generate', label: 'Generate a configuration' },
                  { id: 'paste', label: 'I have its public key' },
                ]}
              />
              {mode === 'generate' && !view.secureTransport ? (
                <p className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/5 px-3 py-2 text-xs">
                  <Warning className="mt-0.5 size-4 shrink-0 text-status-warning" />
                  <span>
                    This configuration crosses the network unencrypted on its way to this browser. On a network others
                    share, make the key on the device and paste its public key instead.
                  </span>
                </p>
              ) : null}
              <Field label="Name">
                <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} placeholder="Phone" />
              </Field>
              {mode === 'paste' ? (
                <Field label="The device’s public key" hint={keyProblem ? 'A public key is 44 characters of base64.' : undefined}>
                  <Input
                    value={publicKey}
                    onChange={(e) => setPublicKey(e.target.value)}
                    className="font-mono"
                    spellCheck={false}
                    aria-invalid={keyProblem || undefined}
                  />
                </Field>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="DNS for the device" hint="Empty: the router">
                    <ListEditor values={dns} onChange={setDns} placeholder="192.168.1.1" />
                  </Field>
                  <Field label="Routes through the tunnel" hint="Empty: the LANs and this VPN; 0.0.0.0/0 for everything">
                    <ListEditor values={clientAllowed} onChange={setClientAllowed} placeholder="0.0.0.0/0" />
                  </Field>
                </div>
              )}
              {stepUp ? <PasswordField value={password} onChange={setPassword} error={passwordError(create.error)} /> : null}
              {create.error && !passwordError(create.error) ? (
                <div className="space-y-2">
                  <ErrorLine message={syncRefusalMessage(create.error)} />
                  <IssueList issues={refusalIssues(create.error)} />
                </div>
              ) : null}
              <StageOnly checked={stage} onChange={setStage} />
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {config ? (
            <Button onClick={() => setConfig(null)}>I have saved it</Button>
          ) : answer ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={create.isPending}>
                Cancel
              </Button>
              <Button
                onClick={submit}
                disabled={
                  create.isPending ||
                  !label.trim() ||
                  (mode === 'paste' && !isWgKey(publicKey)) ||
                  (stepUp && !password)
                }
              >
                {create.isPending ? <Spinner className="size-3.5 text-current" /> : null}
                {stage ? 'Save draft' : 'Add and apply'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The config shown once: text, QR code (the `qrcode` package, loaded by this page only), download, copy. */
function OneTimeConfig({ config }: { config: WgClientConfig }) {
  const [qr, setQr] = useState<string | null>(null)
  const [qrFailed, setQrFailed] = useState(false)
  useEffect(() => {
    let live = true
    import('qrcode')
      .then((m) => m.toDataURL(config.text, { errorCorrectionLevel: 'M', margin: 1, width: 240 }))
      .then((url) => live && setQr(url))
      .catch(() => live && setQrFailed(true))
    return () => {
      live = false
    }
  }, [config.text])
  return (
    <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
      <div className="flex size-[240px] items-center justify-center self-start rounded-md border border-border bg-white">
        {qr ? (
          <img src={qr} alt="QR code of the configuration: scan it in the WireGuard app" width={240} height={240} />
        ) : qrFailed ? (
          <span className="px-4 text-center text-xs text-muted-foreground">No QR code: download the file instead.</span>
        ) : (
          <Spinner />
        )}
      </div>
      <div className="min-w-0 space-y-2">
        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
          {config.text}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => downloadText(config.filename, config.text)}>
            <DownloadSimple className="size-3.5" />
            Download {config.filename}
          </Button>
          <CopyButton value={config.text} label="Copy" ariaLabel="Copy the configuration" />
        </div>
        <p className="text-xs text-muted-foreground">
          Scan the code in the WireGuard app, or import the file. Lost it? Remove this peer and add it again.
        </p>
      </div>
    </div>
  )
}

function EditPeerDialog({ ctx, peer, onClose }: { ctx: NativeContext; peer: WgPeerView; onClose: () => void }) {
  const update = useUpdateWgPeer(ctx.gateway.id)
  const [label, setLabel] = useState(peer.label ?? '')
  const [allowed, setAllowed] = useState(peer.allowedIps)
  const [host, setHost] = useState(peer.endpoint?.host ?? '')
  const [port, setPort] = useState(peer.endpoint ? String(peer.endpoint.port) : '51820')
  const [keepalive, setKeepalive] = useState(peer.keepalive ? String(peer.keepalive) : '')
  const [route, setRoute] = useState(peer.routeAllowedIps)
  const [stage, setStage] = useState(false)
  const [result, setResult] = useState<WriteAnswer<WgPeerView> | null>(null)

  function submit() {
    const endpoint = host.trim() ? { host: host.trim(), port: Number(port) } : null
    const same = JSON.stringify(endpoint) === JSON.stringify(peer.endpoint)
    const patch: WgPeerPatch = {
      ...(label.trim() !== (peer.label ?? '') ? { label: label.trim() } : {}),
      ...(JSON.stringify(allowed) !== JSON.stringify(peer.allowedIps) ? { allowedIps: allowed } : {}),
      ...(same ? {} : { endpoint }),
      ...(keepalive !== (peer.keepalive ? String(peer.keepalive) : '')
        ? { keepalive: keepalive ? Number(keepalive) : null }
        : {}),
      ...(route !== peer.routeAllowedIps ? { routeAllowedIps: route } : {}),
    }
    update.mutate({ perchId: peer.id, patch, apply: !stage }, { onSuccess: setResult })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {peer.label ?? 'peer'}</DialogTitle>
          <DialogDescription>Its keys stay as they are.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {result ? (
            <NativeWriteResult result={asNative(result)} gatewayId={ctx.gateway.id} />
          ) : (
            <>
              <Field label="Name">
                <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} />
              </Field>
              <Field label="Allowed IPs" hint="What the router sends to this peer">
                <ListEditor values={allowed} onChange={setAllowed} placeholder="10.7.0.2/32" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem]">
                <Field label="Endpoint" hint="Empty for a roaming device">
                  <Input value={host} onChange={(e) => setHost(e.target.value)} className="font-mono" />
                </Field>
                <Field label="Port">
                  <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className="font-mono" />
                </Field>
              </div>
              <Field label="Keepalive (seconds)" hint="Empty: off">
                <Input value={keepalive} onChange={(e) => setKeepalive(e.target.value)} inputMode="numeric" className="font-mono" />
              </Field>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs">Add routes for its allowed IPs</span>
                <Switch checked={route} onCheckedChange={setRoute} aria-label="Route allowed IPs" />
              </div>
              {update.error ? (
                <div className="space-y-2">
                  <ErrorLine message={syncRefusalMessage(update.error)} />
                  <IssueList issues={refusalIssues(update.error)} />
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
              <Button onClick={submit} disabled={update.isPending}>
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

// ── Rotate and delete ───────────────────────────────────────────────────────

function RotateDialog({ ctx, iface, onClose }: { ctx: NativeContext; iface: WgInterfaceView; onClose: () => void }) {
  const rotate = useRotateWgKey(ctx.gateway.id)
  const stepUp = useStepUp()
  const [password, setPassword] = useState('')
  return (
    <TypedConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Rotate the key of ${iface.network}?`}
      description={`The router makes a new key. Every peer stops connecting until it has the new public key${iface.role === 'server' ? ': update each device’s config' : ': register it with the provider'}.`}
      expected={iface.network}
      what="the network’s name"
      confirmLabel="Rotate key"
      destructive
      pending={rotate.isPending}
      error={rotate.error && !passwordError(rotate.error) ? syncRefusalMessage(rotate.error) : null}
      onConfirm={(typed) =>
        rotate.mutate({ perchId: iface.id, confirm: typed, currentPassword: password }, { onSuccess: onClose })
      }
    >
      {stepUp ? <PasswordField value={password} onChange={setPassword} error={passwordError(rotate.error)} /> : null}
    </TypedConfirmDialog>
  )
}

function DeleteInterfaceDialog({ ctx, iface, onClose }: { ctx: NativeContext; iface: WgInterfaceView; onClose: () => void }) {
  const del = useDeleteWgInterface(ctx.gateway.id)
  return (
    <TypedConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${iface.network}?`}
      description={`Its ${iface.peers.length === 1 ? 'peer' : `${iface.peers.length} peers`}, its firewall rule and its zone go with it. Devices using it lose the connection.`}
      expected={iface.network}
      what="the network’s name"
      confirmLabel="Delete"
      destructive
      pending={del.isPending}
      error={del.error ? syncRefusalMessage(del.error) : null}
      onConfirm={(typed) => del.mutate({ perchId: iface.id, confirm: typed }, { onSuccess: onClose })}
    />
  )
}
