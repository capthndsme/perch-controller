import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowsClockwise, DownloadSimple, PencilSimple, Plus, Trash, Warning } from '@phosphor-icons/react'
import { ConfirmDialog, ErrorLine, IssueList, ToneBadge } from '@/components/gateway-config/bits'
import { Field, NativeWriteResult, StageOnly, SyncBadges } from '@/components/gateway-native/native-ui'
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
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useDialog } from '@/hooks/use-dialog'
import { useDdns, useDdnsUpdateNow, useDeleteDdnsService, useSaveDdnsService } from '@/hooks/use-gateway-internet'
import { formatRelative } from '@/lib/gateway-observation'
import { isNotBuilt, syncRefusalMessage, unavailableText } from '@/lib/gateway-sync'
import { refusalIssues } from '@/lib/networks'
import { PLAIN_HTTP_DOCS_URL } from '@/lib/transport-security'
import type { NativeWrite } from '@/types/gateway-native'
import type { DdnsOverview, DdnsServiceInput, DdnsServiceView, WriteAnswer } from '@/types/gateway-sync'

/**
 * Dynamic DNS on the Internet page (design gateway-sync dashboard.md 2.7,
 * rest.md 9): each ddns-scripts service with the address its name has
 * against the WAN's, its last update and error, "Update now", and the
 * add/edit dialog. Passwords are write-only and need verified TLS.
 */
export function DdnsCard({ gatewayId, gatewayName, canWrite }: { gatewayId: number; gatewayName: string; canWrite: boolean }) {
  const q = useDdns(gatewayId)
  const edit = useDialog()
  const [editing, setEditing] = useState<DdnsServiceView | null>(null)
  const [removing, setRemoving] = useState<DdnsServiceView | null>(null)
  const del = useDeleteDdnsService(gatewayId)
  const now = useDdnsUpdateNow(gatewayId)
  if (q.error && isNotBuilt(q.error)) return null
  const v = q.data
  const blocked = v ? unavailableText(v.available ? null : v.unavailableReason, gatewayName) : null
  const writable = canWrite && !!v?.available

  return (
    <Panel
      title="Dynamic DNS"
      description="Keeps a name pointing at this connection when the provider changes its address."
      actions={
        v?.installed ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!writable}
            onClick={() => {
              setEditing(null)
              edit.show()
            }}
          >
            <Plus className="size-3.5" />
            Add
          </Button>
        ) : null
      }
    >
      {q.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : q.error ? (
        <ErrorLine message={syncRefusalMessage(q.error)} />
      ) : !v!.installed ? (
        <div className="flex flex-col gap-3 rounded-md border border-dashed border-border p-3 text-xs sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground">
            ddns-scripts is not installed on {gatewayName} ({v!.installPackages.join(', ')}).
          </p>
          <Button asChild size="sm" variant="outline" className="shrink-0">
            <Link to={`/gateway/config/${gatewayId}`}>
              <DownloadSimple />
              Install on gateway
            </Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {blocked ? <p className="text-xs text-muted-foreground">{blocked}</p> : null}
          {v!.services.length === 0 ? (
            <p className="text-xs text-muted-foreground">No services.</p>
          ) : (
            <ul className="divide-y divide-border">
              {v!.services.map((s) => (
                <ServiceRow
                  key={s.id}
                  service={s}
                  view={v!}
                  writable={writable}
                  updating={now.isPending && now.variables?.perchId === s.id}
                  onUpdateNow={() => now.mutate({ perchId: s.id })}
                  onEdit={() => {
                    setEditing(s)
                    edit.show()
                  }}
                  onRemove={() => {
                    del.reset()
                    setRemoving(s)
                  }}
                />
              ))}
            </ul>
          )}
          {now.error ? <ErrorLine message={syncRefusalMessage(now.error)} /> : null}
          {now.data ? (
            <p className="text-xs text-muted-foreground">
              {now.data.started ? 'The router is updating the name; the result shows here within a minute.' : 'The router did not start the update.'}
            </p>
          ) : null}
        </div>
      )}
      {edit.open && v ? (
        <DdnsDialog key={edit.key} gatewayId={gatewayId} view={v} service={editing} onClose={() => edit.setOpen(false)} />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? 'this service'}?`}
        description="The name keeps its last address at the provider but stops following this connection."
        confirmLabel="Remove"
        destructive
        pending={del.isPending}
        error={del.error ? syncRefusalMessage(del.error) : null}
        onConfirm={() => removing && del.mutate({ perchId: removing.id }, { onSuccess: () => setRemoving(null) })}
      />
    </Panel>
  )
}

function ServiceRow({
  service: s,
  view,
  writable,
  updating,
  onUpdateNow,
  onEdit,
  onRemove,
}: {
  service: DdnsServiceView
  view: DdnsOverview
  writable: boolean
  updating: boolean
  onUpdateNow: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  const owned = s.sync.owner === 'perch'
  return (
    <li className="space-y-1.5 py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{s.domain ?? s.name}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{s.name}</span>
        {!s.enabled ? <ToneBadge tone="neutral">Off</ToneBadge> : null}
        {s.live?.matches === false ? <ToneBadge tone="warning">Points elsewhere</ToneBadge> : null}
        {s.live?.lastError ? <ToneBadge tone="serious">Failing</ToneBadge> : null}
        <SyncBadges sync={s.sync} />
        <span className="ml-auto flex items-center gap-1">
          {view.canUpdateNow ? (
            <Button size="sm" variant="ghost" onClick={onUpdateNow} disabled={!writable || updating || !s.enabled}>
              {updating ? <Spinner className="size-3.5" /> : <ArrowsClockwise className="size-3.5" />}
              Update now
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onEdit} disabled={!writable || !owned} aria-label={`Edit ${s.name}`}>
            <PencilSimple className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onRemove} disabled={!writable || !owned} aria-label={`Remove ${s.name}`}>
            <Trash className="size-3.5" />
          </Button>
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {s.provider ?? (s.updateUrl ? 'custom URL' : 'no provider')}
        {s.live ? (
          <>
            {' · '}the name has <span className="font-mono text-foreground">{s.live.registeredIp ?? '?'}</span>, the
            connection <span className="font-mono text-foreground">{s.live.wanIp ?? '?'}</span>
            {' · '}updated {formatRelative(s.live.lastUpdateAt)}
          </>
        ) : (
          ' · no report from the router yet'
        )}
      </p>
      {s.live?.lastError ? <p className="text-xs text-status-serious">{s.live.lastError}</p> : null}
    </li>
  )
}

const NAME = /^[A-Za-z0-9_]{1,32}$/

function DdnsDialog({
  gatewayId,
  view,
  service,
  onClose,
}: {
  gatewayId: number
  view: DdnsOverview
  service: DdnsServiceView | null
  onClose: () => void
}) {
  const save = useSaveDdnsService(gatewayId)
  const [name, setName] = useState(service?.name ?? 'home')
  const [enabled, setEnabled] = useState(service?.enabled ?? true)
  const [kind, setKind] = useState<'provider' | 'url'>(service?.updateUrl ? 'url' : 'provider')
  const [provider, setProvider] = useState(service?.provider ?? '')
  const [url, setUrl] = useState(service?.updateUrl ?? '')
  const [domain, setDomain] = useState(service?.domain ?? '')
  const [username, setUsername] = useState(service?.username ?? '')
  const [password, setPassword] = useState('')
  const [useHttps, setUseHttps] = useState(service?.useHttps ?? true)
  const [useIpv6, setUseIpv6] = useState(service?.useIpv6 ?? false)
  const [check, setCheck] = useState(String(service?.checkIntervalMinutes ?? 10))
  const [force, setForce] = useState(String(service?.forceIntervalHours ?? 72))
  const [stage, setStage] = useState(false)
  const [result, setResult] = useState<WriteAnswer<DdnsServiceView> | null>(null)
  const listId = `ddns-providers-${gatewayId}`
  const plainUrl = kind === 'url' && /^http:\/\//i.test(url.trim())
  const nameBad = !service && !NAME.test(name)

  function submit() {
    const input: Partial<DdnsServiceInput> = {
      enabled,
      provider: kind === 'provider' ? provider.trim() || null : null,
      updateUrl: kind === 'url' ? url.trim() || null : null,
      domain: domain.trim(),
      username: username.trim() || null,
      useHttps,
      useIpv6,
      checkIntervalMinutes: Number(check),
      forceIntervalHours: Number(force),
      ...(password ? { password } : {}),
    }
    save.mutate(
      { perchId: service?.id ?? null, input: service ? input : { ...input, name, domain: domain.trim() }, apply: !stage },
      { onSuccess: setResult },
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{service ? `Edit ${service.name}` : 'Add a dynamic DNS name'}</DialogTitle>
          <DialogDescription>ddns-scripts on the router updates the name; its address comes from the primary uplink.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {result ? (
            <NativeWriteResult result={result as unknown as NativeWrite<unknown>} gatewayId={gatewayId} />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Service name" hint={service ? 'Fixed' : 'Letters, digits, _'}>
                  <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!!service} className="font-mono" aria-invalid={nameBad || undefined} />
                </Field>
                <div className="flex items-end justify-between gap-3 pb-1">
                  <span className="text-xs">Enabled</span>
                  <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
                </div>
              </div>
              <Segmented
                size="xs"
                value={kind}
                onChange={setKind}
                ariaLabel="Provider or URL"
                options={[
                  { id: 'provider', label: 'Provider' },
                  { id: 'url', label: 'Custom update URL' },
                ]}
              />
              {kind === 'provider' ? (
                <Field label="Provider" hint={view.providers.length > 0 ? 'As ddns-scripts names it' : 'The router listed none'}>
                  <Input value={provider} onChange={(e) => setProvider(e.target.value)} list={listId} placeholder="duckdns.org" />
                  <datalist id={listId}>
                    {view.providers.map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                </Field>
              ) : (
                <Field label="Update URL" hint="[USERNAME], [PASSWORD], [DOMAIN] and [IP] are filled in">
                  <Input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono" />
                  {plainUrl ? (
                    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-status-warning">
                      <Warning className="size-3.5" />
                      Plain HTTP: the password crosses the internet readable.
                    </p>
                  ) : null}
                </Field>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Name to update">
                  <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="home.example.com" />
                </Field>
                <Field label="User name">
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
                </Field>
                <Field
                  label="Password or token"
                  hint={service?.password.set ? 'Set; leave empty to keep it' : undefined}
                >
                  {view.secureTransport ? (
                    <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Set this in LuCI on the router; Perch keeps the router’s value.{' '}
                      <a href={PLAIN_HTTP_DOCS_URL} target="_blank" rel="noreferrer" className="underline">
                        Why
                      </a>
                    </p>
                  )}
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Check every (minutes)">
                  <Input value={check} onChange={(e) => setCheck(e.target.value)} inputMode="numeric" className="font-mono" />
                </Field>
                <Field label="Update anyway every (hours)" hint="0: only on a change">
                  <Input value={force} onChange={(e) => setForce(e.target.value)} inputMode="numeric" className="font-mono" />
                </Field>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs">Talk to the provider over HTTPS</span>
                <Switch checked={useHttps} onCheckedChange={setUseHttps} aria-label="HTTPS" />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs">Update the IPv6 address (AAAA) instead</span>
                <Switch checked={useIpv6} onCheckedChange={setUseIpv6} aria-label="IPv6" />
              </div>
              {save.error ? (
                <div className="space-y-2">
                  <ErrorLine message={syncRefusalMessage(save.error)} />
                  <IssueList issues={refusalIssues(save.error)} />
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
              <Button variant="outline" onClick={onClose} disabled={save.isPending}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={save.isPending || nameBad || !domain.trim()}>
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
