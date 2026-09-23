import { useState } from 'react'
import { ArrowsClockwise, Coins, PencilSimple, Plugs, Plus, Prohibit, Warning } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
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
import { PageSpinner } from '@/components/ui/spinner'
import {
  AdminOnlyNotice,
  Checkbox,
  ConfirmDialog,
  ErrorNote,
  FormField,
  PortalSectionNav,
  QuotaInput,
} from '@/components/portal/portal-ui'
import { useConfirm } from '@/hooks/use-confirm'
import {
  useCreatePortalApiClient,
  useIsPortalAdmin,
  usePortalApiClients,
  usePortals,
  useRevokePortalApiClient,
  useRotatePortalApiClient,
  useUpdatePortalApiClient,
} from '@/hooks/use-portal'
import { formatMinutes, formatQuota, relativeTime, splitBytes, toBytes, vineFieldErrors, type QuotaUnit } from '@/lib/portal'
import type { Portal, PortalApiClient, PortalApiClientPayload, PortalApiScope } from '@/types/api'

/** `/portal/api-clients`: tokens for integrations that put devices online (the Paid Hotspot API). */
export function PortalApiClientsPage() {
  const { isAdmin, isPending } = useIsPortalAdmin()
  const clients = usePortalApiClients({ enabled: isAdmin })
  const portals = usePortals({ enabled: isAdmin })
  const [editing, setEditing] = useState<PortalApiClient | 'new' | null>(null)
  const [token, setToken] = useState<{ client: PortalApiClient; token: string; rotated: boolean } | null>(null)
  const rotate = useRotatePortalApiClient()
  const revoke = useRevokePortalApiClient()
  const confirmRotate = useConfirm<PortalApiClient>()
  const confirmRevoke = useConfirm<PortalApiClient>()

  if (isPending) return <PageSpinner label="Loading API clients" />

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        title="API clients"
        crumbs={[{ label: 'Guest portal', to: '/portal' }, { label: 'API clients' }]}
        description="Tokens for systems that put guests online on their own: coin-operated vending boxes, payment kiosks, a front desk."
        actions={
          isAdmin ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="size-3.5" />
              New API client
            </Button>
          ) : null
        }
      />
      <PortalSectionNav />
      {!isAdmin ? (
        <AdminOnlyNotice what="API clients" />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
          <Panel title="Clients" flush className="self-start">
            {clients.isPending ? <p className="px-4 pb-4 text-xs text-muted-foreground">Loading…</p> : null}
            {clients.error ? <ErrorNote error={clients.error} className="mx-4 mb-4" /> : null}
            {clients.data && clients.data.length === 0 ? (
              <div className="px-4 pb-4">
                <EmptyState icon={<Plugs className="size-6" />} title="No API clients" description="Create one per integration, so each has its own token, caps and audit trail." />
              </div>
            ) : null}
            {clients.data && clients.data.length > 0 ? (
              <ul className="divide-y divide-border border-t border-border">
                {clients.data.map((client) => (
                  <li key={client.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium">{client.name}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">{client.prefix}…</span>
                        {client.scopes.map((scope) => (
                          <Badge key={scope} variant="outline" className="rounded-sm text-muted-foreground">
                            {scope}
                          </Badge>
                        ))}
                        {client.revokedAt ? (
                          <Badge variant="outline" className="rounded-sm border-destructive/30 bg-destructive/10 text-destructive">
                            Revoked
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {portalNames(client.portalIds, portals.data ?? [])} · up to {formatMinutes(client.maxMinutesPerCall)} and{' '}
                        {formatQuota(client.maxBytesPerCall)} per call · {client.activeGrants}/{client.maxActiveGrants} grants
                      </p>
                      <p className="text-[11px] text-muted-foreground">Last used {relativeTime(client.lastUsedAt)}</p>
                    </div>
                    {!client.revokedAt ? (
                      <div className="flex shrink-0 gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => setEditing(client)}>
                          <PencilSimple className="size-3.5" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            rotate.reset()
                            confirmRotate.open(client)
                          }}
                        >
                          <ArrowsClockwise className="size-3.5" />
                          Rotate
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            revoke.reset()
                            confirmRevoke.open(client)
                          }}
                        >
                          <Prohibit className="size-3.5" />
                          Revoke
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Panel>
          <PaidHotspotApi portals={portals.data ?? []} />
        </div>
      )}

      {editing ? (
        <ApiClientDialog
          client={editing === 'new' ? null : editing}
          portals={portals.data ?? []}
          onClose={() => setEditing(null)}
          onCreated={(client, value) => setToken({ client, token: value, rotated: false })}
        />
      ) : null}
      {token ? <TokenDialog {...token} onClose={() => setToken(null)} /> : null}
      <ConfirmDialog
        {...confirmRotate.props}
        title={`New token for ${confirmRotate.target?.name ?? ''}?`}
        description="The current token stops working at once. Put the new one into the integration straight away."
        confirmLabel="Rotate token"
        pending={rotate.isPending}
        error={rotate.error}
        onConfirm={() => {
          if (!confirmRotate.target) return
          rotate.mutate(confirmRotate.target.id, {
            onSuccess: (result) => {
              confirmRotate.close()
              setToken({ ...result, rotated: true })
            },
          })
        }}
      />
      <ConfirmDialog
        {...confirmRevoke.props}
        title={`Revoke ${confirmRevoke.target?.name ?? ''}?`}
        description="Its token stops working at once. Guests it already put online keep their time; the client stays listed for the audit."
        confirmLabel="Revoke"
        destructive
        pending={revoke.isPending}
        error={revoke.error}
        onConfirm={() => {
          if (confirmRevoke.target) revoke.mutate(confirmRevoke.target.id, { onSuccess: () => confirmRevoke.close() })
        }}
      />
    </div>
  )
}

function portalNames(ids: number[], portals: Portal[]): string {
  return ids.map((id) => portals.find((p) => p.id === id)?.name ?? `portal ${id}`).join(', ') || 'no portal'
}

const CAP_DEFAULTS = { maxMinutesPerCall: 1440, maxBytesPerCall: 1e10, maxActiveGrants: 500 }

function ApiClientDialog({
  client,
  portals,
  onClose,
  onCreated,
}: {
  client: PortalApiClient | null
  portals: Portal[]
  onClose: () => void
  onCreated: (client: PortalApiClient, token: string) => void
}) {
  const create = useCreatePortalApiClient()
  const update = useUpdatePortalApiClient()
  const mutation = client ? update : create
  const [name, setName] = useState(client?.name ?? '')
  const [portalIds, setPortalIds] = useState<number[]>(client?.portalIds ?? (portals.length === 1 ? [portals[0].id] : []))
  const [scopes, setScopes] = useState<PortalApiScope[]>(client?.scopes ?? ['authorize', 'read'])
  const [maxMinutes, setMaxMinutes] = useState(String(client?.maxMinutesPerCall ?? CAP_DEFAULTS.maxMinutesPerCall))
  const [maxBytes, setMaxBytes] = useState<{ amount: string; unit: QuotaUnit }>(splitBytes(client?.maxBytesPerCall ?? CAP_DEFAULTS.maxBytesPerCall))
  const [maxGrants, setMaxGrants] = useState(String(client?.maxActiveGrants ?? CAP_DEFAULTS.maxActiveGrants))
  const [localError, setLocalError] = useState<string | null>(null)
  const fieldErrors = vineFieldErrors(mutation.error)

  function toggleScope(scope: PortalApiScope, on: boolean) {
    setScopes((current) => (on ? [...new Set([...current, scope])] : current.filter((s) => s !== scope)))
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setLocalError(null)
    if (portalIds.length === 0) return setLocalError('Choose at least one portal.')
    if (scopes.length === 0) return setLocalError('Choose at least one permission.')
    const payload: PortalApiClientPayload = {
      name: name.trim(),
      portalIds,
      scopes,
      maxMinutesPerCall: Number(maxMinutes),
      maxBytesPerCall: toBytes(maxBytes.amount, maxBytes.unit),
      maxActiveGrants: Number(maxGrants),
    }
    if (client) {
      update.mutate({ id: client.id, ...payload }, { onSuccess: onClose })
    } else {
      create.mutate(payload, {
        onSuccess: (result) => {
          onClose()
          onCreated(result.client, result.token)
        },
      })
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{client ? `Edit ${client.name}` : 'New API client'}</DialogTitle>
            <DialogDescription>
              A client acts only on its portals, within its caps, and only on the grants it made itself.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FormField label="Name" htmlFor="ac-name" error={fieldErrors.name} hint="What it is, e.g. “Coin box, lobby”.">
              <Input id="ac-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="rounded-md" />
            </FormField>
            <fieldset className="space-y-2">
              <legend className="mb-1.5 text-xs font-medium">Portals</legend>
              {portals.length === 0 ? <p className="text-muted-foreground">Create a portal first.</p> : null}
              {portals.map((portal) => (
                <Checkbox
                  key={portal.id}
                  id={`ac-portal-${portal.id}`}
                  checked={portalIds.includes(portal.id)}
                  onChange={(on) => setPortalIds((ids) => (on ? [...ids, portal.id] : ids.filter((i) => i !== portal.id)))}
                  label={portal.name}
                />
              ))}
              {fieldErrors.portalIds ? <p className="text-xs text-destructive">{fieldErrors.portalIds}</p> : null}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="mb-1.5 text-xs font-medium">Permissions</legend>
              <Checkbox
                id="ac-scope-authorize"
                checked={scopes.includes('authorize')}
                onChange={(on) => toggleScope('authorize', on)}
                label="authorize"
                description="Put a device online, add time or data, take it off again."
              />
              <Checkbox
                id="ac-scope-read"
                checked={scopes.includes('read')}
                onChange={(on) => toggleScope('read', on)}
                label="read"
                description="Ask what a device has left (its own grants only)."
              />
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label="Max minutes per call" htmlFor="ac-minutes" error={fieldErrors.maxMinutesPerCall} hint="1–10080.">
                <Input id="ac-minutes" inputMode="numeric" value={maxMinutes} onChange={(e) => setMaxMinutes(e.target.value)} className="rounded-md" />
              </FormField>
              <FormField label="Max data per call" htmlFor="ac-bytes" error={fieldErrors.maxBytesPerCall}>
                <QuotaInput id="ac-bytes" {...maxBytes} onChange={setMaxBytes} placeholder="10" />
              </FormField>
              <FormField label="Max active grants" htmlFor="ac-grants" error={fieldErrors.maxActiveGrants} hint="1–5000.">
                <Input id="ac-grants" inputMode="numeric" value={maxGrants} onChange={(e) => setMaxGrants(e.target.value)} className="rounded-md" />
              </FormField>
            </div>
            {localError ? <p className="text-xs text-destructive">{localError}</p> : null}
            <ErrorNote error={mutation.error && Object.keys(fieldErrors).length === 0 ? mutation.error : null} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : client ? 'Save' : 'Create and show token'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The token, once: it is stored only as a hash. */
function TokenDialog({ client, token, rotated, onClose }: { client: PortalApiClient; token: string; rotated: boolean; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{rotated ? `New token for ${client.name}` : `${client.name} is ready`}</DialogTitle>
          <DialogDescription>Copy the token now. Perch keeps only a fingerprint of it and cannot show it again.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 font-mono text-xs break-all select-all">{token}</code>
            <CopyButton value={token} label="Copy token" ariaLabel="Copy the API token" className="shrink-0" />
          </div>
          <p className="flex items-start gap-2 text-muted-foreground">
            <Warning className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
            Anyone with this token can put devices online on {client.portalIds.length === 1 ? 'its portal' : 'its portals'} within its caps.
            Keep it in the integration’s configuration only; rotate it if it leaks.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>I have copied it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Integrations explainer with a curl example (placeholders only). */
function PaidHotspotApi({ portals }: { portals: Portal[] }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://<controller>:8080'
  const portalId = portals[0]?.id ?? 1
  const example = [
    `curl -X POST ${origin}/api/v1/portal/authorizations \\`,
    `  -H 'Authorization: Bearer perch_pa_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"portalId": ${portalId}, "mac": "02:00:00:aa:bb:cc", "minutes": 30, "externalRef": "payment-000123"}'`,
  ].join('\n')
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          <Coins className="size-4" />
          Paid Hotspot API
        </span>
      }
      description="Let a paid-hotspot integration (a coin-operated vending box, a payment kiosk) sell time or data."
      className="self-start"
    >
      <ol className="list-decimal space-y-1.5 pl-4 text-xs text-muted-foreground">
        <li>Create an API client for the box, with the portal it serves and caps that match what it sells.</li>
        <li>
          Give the portal a custom template that shows the guest’s device (<code className="font-mono">{'{{client_mac}}'}</code>)
          and talks to the box; list the box’s origin under the portal’s “Origins the page may call”.
        </li>
        <li>
          When a guest pays, the box calls the authorize API with its token, the device’s MAC, what was paid, and its
          payment id as <code className="font-mono">externalRef</code>.
        </li>
      </ol>
      <div className="mt-3 overflow-hidden rounded-md border border-border">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-2.5 py-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Example</span>
          <CopyButton value={example} ariaLabel="Copy the curl example" />
        </div>
        <pre className="p-2.5 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">{example}</pre>
      </div>
      <ul className="mt-3 space-y-1 text-[11px] text-muted-foreground">
        <li>
          <strong className="text-foreground">Always send externalRef.</strong> The same payment id sent twice answers
          “replayed” and credits nothing, so a retried call never pays out twice.
        </li>
        <li>
          By default a call adds to what the device already bought; <code className="font-mono">"mode": "replace"</code>{' '}
          starts over. Paid time waits in the device’s queue while a voucher runs, and never runs down there.
        </li>
        <li>Offline gateway? The call is still accepted and answered with delivery “pending”: the device goes online when the gateway is back.</li>
        <li>
          Also: <code className="font-mono">GET</code> and <code className="font-mono">DELETE /api/v1/portal/authorizations/&lt;mac&gt;?portalId=…</code>
          {' '}to read or end the device’s grant.
        </li>
      </ul>
    </Panel>
  )
}
