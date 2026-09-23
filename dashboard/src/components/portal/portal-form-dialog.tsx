import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Warning } from '@phosphor-icons/react'
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
import { Checkbox, ErrorNote, FormField } from '@/components/portal/portal-ui'
import {
  useCreatePortal,
  usePortalGateways,
  usePortalNetworks,
  usePortals,
  usePortalTemplates,
  useUpdatePortal,
} from '@/hooks/use-portal'
import { useDefaultGatewayId } from '@/hooks/use-gateways'
import { apiErrorCode } from '@/lib/api'
import { errorDetail, selectClassName, textareaClassName, vineFieldErrors } from '@/lib/portal'
import type { Portal, PortalPayload } from '@/types/api'

type PortalFormDialogProps = {
  /** Edit this portal; create a new one without. */
  portal?: Portal
  onClose: () => void
}

/**
 * Create or edit a portal: gateway + network (decision 19: one portal per
 * network, several per gateway), sign-in methods, page template, the origins
 * a custom page may call, and the privacy notice. A network the gateway
 * reaches the controller through is refused (422 `network_hosts_controller`)
 * unless the admin confirms with `force`.
 */
export function PortalFormDialog({ portal, onClose }: PortalFormDialogProps) {
  const navigate = useNavigate()
  const editing = Boolean(portal)
  const create = useCreatePortal()
  const update = useUpdatePortal()
  const mutation = editing ? update : create
  const gateways = usePortalGateways()
  const portals = usePortals()
  const templates = usePortalTemplates()

  const [name, setName] = useState(portal?.name ?? 'Guest Wi-Fi')
  // A new portal starts on the default gateway (the same pick as every gateway page).
  const defaultGateway = useDefaultGatewayId({ enabled: !portal })
  const [gatewayChoice, setGatewayText] = useState<string | null>(portal ? String(portal.gatewayId) : null)
  const gatewayText = gatewayChoice ?? (defaultGateway.data != null ? String(defaultGateway.data) : '')
  const [networkText, setNetworkText] = useState(portal?.network.perchId ?? '')
  const [voucher, setVoucher] = useState(portal?.methods.voucher ?? true)
  const [password, setPassword] = useState(portal?.methods.password ?? false)
  const [templateId, setTemplateId] = useState<string>(
    portal ? (portal.templateId === null ? 'none' : String(portal.templateId)) : 'default',
  )
  const [csp, setCsp] = useState((portal?.cspConnectSrc ?? []).join('\n'))
  const [privacy, setPrivacy] = useState(portal?.privacyNotice ?? '')
  const [forceNeeded, setForceNeeded] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  // Gateways: the config plane's list; without it, those of existing portals.
  const gatewayOptions = useMemo(() => {
    if (gateways.data) return gateways.data
    const seen = new Map<number, { id: number; name: string; online: boolean }>()
    for (const p of portals.data ?? []) {
      if (!seen.has(p.gatewayId)) {
        seen.set(p.gatewayId, { id: p.gatewayId, name: p.gateway?.name ?? `Gateway ${p.gatewayId}`, online: Boolean(p.gateway?.online) })
      }
    }
    return [...seen.values()]
  }, [gateways.data, portals.data])
  const gatewayListKnown = gateways.data != null
  const gatewayId = gatewayText.trim() === '' ? null : Number(gatewayText)
  const networks = usePortalNetworks(gatewayId !== null && Number.isInteger(gatewayId) ? gatewayId : null)
  const taken = new Set(
    (portals.data ?? [])
      .filter((p) => p.gatewayId === gatewayId && p.id !== portal?.id)
      .map((p) => p.network.perchId),
  )
  const fieldErrors = vineFieldErrors(mutation.error)

  function payload(force: boolean): PortalPayload {
    const origins = csp
      .split(/[\s,]+/)
      .map((o) => o.trim())
      .filter(Boolean)
    const body: PortalPayload = {
      name: name.trim(),
      networkPerchId: networkText.trim(),
      methods: { voucher, password },
      cspConnectSrc: origins,
      privacyNotice: privacy.trim() || null,
    }
    if (!editing) body.gatewayId = gatewayId ?? undefined
    if (templateId === 'none') body.templateId = null
    else if (templateId !== 'default') body.templateId = Number(templateId)
    if (portal) {
      // PATCH only what changed: every change bumps the portal's revision.
      if (body.name === portal.name) delete body.name
      if (body.networkPerchId === portal.network.perchId) delete body.networkPerchId
      if (body.methods?.voucher === portal.methods.voucher && body.methods?.password === portal.methods.password) {
        delete body.methods
      }
      if (JSON.stringify(body.cspConnectSrc) === JSON.stringify(portal.cspConnectSrc)) delete body.cspConnectSrc
      if (body.privacyNotice === portal.privacyNotice) delete body.privacyNotice
      if (body.templateId === portal.templateId) delete body.templateId
    }
    if (force) body.force = true
    return body
  }

  function submit(force: boolean) {
    setLocalError(null)
    if (!editing && (gatewayId === null || !Number.isInteger(gatewayId))) {
      setLocalError('Choose the gateway.')
      return
    }
    if (!networkText.trim()) {
      setLocalError('Choose the network the portal sits on.')
      return
    }
    if (!voucher && !password) {
      setLocalError('Offer at least one way to sign in.')
      return
    }
    const onError = (error: unknown) => {
      if (apiErrorCode(error) === 'network_hosts_controller') {
        setForceNeeded(errorDetail<string>(error, 'network') ?? networkText)
      }
    }
    if (editing && portal) {
      update.mutate({ id: portal.id, ...payload(force) }, { onSuccess: onClose, onError })
    } else {
      create.mutate(payload(force), {
        onSuccess: (result) => {
          onClose()
          navigate(`/portal/portals/${result.portal.id}`)
        },
        onError,
      })
    }
  }

  const showError = mutation.error && apiErrorCode(mutation.error) !== 'network_hosts_controller'

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            submit(false)
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${portal?.name}` : 'New guest portal'}</DialogTitle>
            <DialogDescription>
              A portal puts a sign-in page in front of one network of a gateway. Each network can have one portal;
              a gateway can have several.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FormField label="Name" htmlFor="portal-name" error={fieldErrors.name} hint="Shown to guests on the sign-in page.">
              <Input id="portal-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="rounded-md" />
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Gateway"
                htmlFor="portal-gateway"
                error={fieldErrors.gatewayId}
                hint={editing ? 'A portal stays on its gateway.' : undefined}
              >
                {gatewayListKnown || gatewayOptions.length > 0 ? (
                  <select
                    id="portal-gateway"
                    className={selectClassName}
                    value={gatewayText}
                    disabled={editing}
                    onChange={(e) => {
                      setGatewayText(e.target.value)
                      setNetworkText('')
                    }}
                  >
                    <option value="">Choose…</option>
                    {gatewayOptions.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                        {g.online ? '' : ' (offline)'}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id="portal-gateway"
                    inputMode="numeric"
                    placeholder="Gateway id"
                    value={gatewayText}
                    disabled={editing}
                    onChange={(e) => setGatewayText(e.target.value)}
                    className="rounded-md"
                  />
                )}
              </FormField>

              <FormField
                label="Network"
                htmlFor="portal-network"
                error={fieldErrors.networkPerchId}
                hint={
                  networks.data === null
                    ? 'This controller cannot list the gateway’s networks yet: type the network’s id.'
                    : editing
                      ? 'Choosing another network moves the portal there.'
                      : 'Usually a separate guest network, never the one you manage the gateway from.'
                }
              >
                {networks.data ? (
                  <select
                    id="portal-network"
                    className={selectClassName}
                    value={networkText}
                    onChange={(e) => setNetworkText(e.target.value)}
                  >
                    <option value="">Choose…</option>
                    {networks.data.map((n) => (
                      <option key={n.perchId} value={n.perchId} disabled={taken.has(n.perchId)}>
                        {n.label || n.name}
                        {n.ipaddr ? ` · ${n.ipaddr}` : ''}
                        {n.purpose && n.purpose !== 'custom' ? ` · ${n.purpose}` : ''}
                        {taken.has(n.perchId) ? ' (has a portal)' : n.management ? ' (manages the gateway)' : ''}
                      </option>
                    ))}
                    {portal && !networks.data.some((n) => n.perchId === portal.network.perchId) ? (
                      <option value={portal.network.perchId}>{portal.network.name ?? portal.network.perchId}</option>
                    ) : null}
                  </select>
                ) : (
                  <Input
                    id="portal-network"
                    placeholder={gatewayId === null ? 'Choose the gateway first' : networks.isPending ? 'Loading…' : 'Network id'}
                    value={networkText}
                    disabled={gatewayId === null}
                    onChange={(e) => setNetworkText(e.target.value)}
                    className="rounded-md font-mono"
                  />
                )}
              </FormField>
            </div>

            <fieldset className="space-y-2">
              <legend className="mb-1.5 text-xs font-medium">Sign-in methods</legend>
              <Checkbox
                id="portal-voucher"
                checked={voucher}
                onChange={setVoucher}
                label="Voucher codes"
                description="Printed or handed-out codes. The gateway can redeem them even while the controller is unreachable."
              />
              <Checkbox
                id="portal-password"
                checked={password}
                onChange={setPassword}
                label="Username and password"
                description="Portal users you create under Portal users. Needs the controller to be reachable."
              />
            </fieldset>

            <FormField label="Page template" htmlFor="portal-template" error={fieldErrors.templateId}>
              <select id="portal-template" className={selectClassName} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                {!editing ? <option value="default">Built-in (default)</option> : null}
                {(templates.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.builtin ? ' (built-in)' : ''}
                  </option>
                ))}
                <option value="none">None (the gateway’s compiled-in pages)</option>
              </select>
            </FormField>

            <FormField
              label="Origins the page may call"
              htmlFor="portal-csp"
              error={fieldErrors.cspConnectSrc ?? fieldErrors['cspConnectSrc.0']}
              hint="For a custom page that talks to a paid-hotspot box on the guest network: one origin per line, e.g. http://192.168.x.x:8080 (no path). At most 16."
            >
              <textarea
                id="portal-csp"
                className={textareaClassName}
                rows={2}
                value={csp}
                placeholder="None"
                onChange={(e) => setCsp(e.target.value)}
              />
            </FormField>

            <FormField
              label="Privacy notice"
              htmlFor="portal-privacy"
              error={fieldErrors.privacyNotice}
              hint="Shown on the sign-in page. Say what you keep about guests (MAC, name, usage) and for how long."
            >
              <textarea
                id="portal-privacy"
                className={textareaClassName}
                rows={3}
                maxLength={2000}
                value={privacy}
                onChange={(e) => setPrivacy(e.target.value)}
              />
            </FormField>

            {forceNeeded ? (
              <div role="alert" className="space-y-2 rounded-md border border-status-warning/50 bg-status-warning/10 p-3">
                <p className="flex items-start gap-2 font-medium">
                  <Warning className="mt-0.5 size-4 shrink-0 text-status-warning" />
                  The gateway reaches this controller through “{forceNeeded}”.
                </p>
                <p className="text-muted-foreground">
                  A portal there puts the controller’s own connection behind the sign-in page and can cut the gateway
                  off from it. Only continue if you know that path is exempt.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="destructive" disabled={mutation.isPending} onClick={() => submit(true)}>
                    {editing ? 'Save anyway' : 'Create anyway'}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setForceNeeded(null)}>
                    Pick another network
                  </Button>
                </div>
              </div>
            ) : null}
            {localError ? <p className="text-xs text-destructive">{localError}</p> : null}
            {showError ? <ErrorNote error={mutation.error} /> : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : editing ? 'Save' : 'Create portal'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
