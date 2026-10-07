import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
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
import { Checkbox, DurationInput, ErrorNote, FormField, QuotaInput } from '@/components/portal/portal-ui'
import { usePriceTables } from '@/hooks/use-hotspot'
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
import {
  errorDetail,
  kbpsToMbpsText,
  mbpsToKbps,
  selectClassName,
  splitBytes,
  splitMinutes,
  textareaClassName,
  toBytes,
  toMinutes,
  vineFieldErrors,
  type DurationUnit,
  type QuotaUnit,
} from '@/lib/portal'
import type {
  Portal,
  PortalClickThroughSettings,
  PortalDeskSettings,
  PortalPayload,
  PortalPaymentSettings,
} from '@/types/api'

const PAYMENT_DEFAULTS: PortalPaymentSettings = { priceTableId: null, idleTimeoutSeconds: 60 }
const DESK_DEFAULTS: PortalDeskSettings = { priceTableId: null, codeLength: 8 }
const CLICK_THROUGH_DEFAULTS: PortalClickThroughSettings = {
  minutes: 30,
  quotaBytes: null,
  downKbps: null,
  upKbps: null,
  windowHours: 24,
  perWindow: 1,
  terms: '',
}

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
  const priceTables = usePriceTables()

  const [name, setName] = useState(portal?.name ?? 'Guest Wi-Fi')
  // A new portal starts on the default gateway (the same pick as every gateway page).
  const defaultGateway = useDefaultGatewayId({ enabled: !portal })
  const [gatewayChoice, setGatewayText] = useState<string | null>(portal ? String(portal.gatewayId) : null)
  const gatewayText = gatewayChoice ?? (defaultGateway.data != null ? String(defaultGateway.data) : '')
  const [networkText, setNetworkText] = useState(portal?.network.perchId ?? '')
  const [voucher, setVoucher] = useState(portal?.methods.voucher ?? true)
  const [password, setPassword] = useState(portal?.methods.password ?? false)
  const [payment, setPayment] = useState(portal?.methods.payment ?? false)
  const [clickThrough, setClickThrough] = useState(portal?.methods.clickThrough ?? false)
  const [desk, setDesk] = useState(portal?.methods.desk ?? false)
  const deskSettings = portal?.desk ?? DESK_DEFAULTS
  const [deskTableId, setDeskTableId] = useState(deskSettings.priceTableId ? String(deskSettings.priceTableId) : '')
  const [deskCodeLength, setDeskCodeLength] = useState(String(deskSettings.codeLength))
  const paymentSettings = portal?.payment ?? PAYMENT_DEFAULTS
  const [priceTableId, setPriceTableId] = useState(paymentSettings.priceTableId ? String(paymentSettings.priceTableId) : '')
  const [idleTimeout, setIdleTimeout] = useState(String(paymentSettings.idleTimeoutSeconds))
  const ct = portal?.clickThrough ?? CLICK_THROUGH_DEFAULTS
  const [ctDuration, setCtDuration] = useState<{ amount: string; unit: DurationUnit }>(splitMinutes(ct.minutes))
  const [ctQuota, setCtQuota] = useState<{ amount: string; unit: QuotaUnit }>(splitBytes(ct.quotaBytes))
  const [ctDown, setCtDown] = useState(kbpsToMbpsText(ct.downKbps))
  const [ctUp, setCtUp] = useState(kbpsToMbpsText(ct.upKbps))
  const [ctWindowHours, setCtWindowHours] = useState(String(ct.windowHours))
  const [ctPerWindow, setCtPerWindow] = useState(String(ct.perWindow))
  const [ctTerms, setCtTerms] = useState(ct.terms)
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
      methods: { voucher, password, payment, clickThrough, desk },
      cspConnectSrc: origins,
      privacyNotice: privacy.trim() || null,
    }
    const paymentBody: PortalPaymentSettings = {
      priceTableId: priceTableId ? Number(priceTableId) : null,
      idleTimeoutSeconds: Number(idleTimeout),
    }
    const clickBody: PortalClickThroughSettings = {
      minutes: toMinutes(ctDuration.amount, ctDuration.unit) ?? Number.NaN,
      quotaBytes: toBytes(ctQuota.amount, ctQuota.unit) ?? null,
      downKbps: mbpsToKbps(ctDown) ?? null,
      upKbps: mbpsToKbps(ctUp) ?? null,
      windowHours: Number(ctWindowHours),
      perWindow: Number(ctPerWindow),
      terms: ctTerms.trim(),
    }
    const deskBody: PortalDeskSettings = {
      priceTableId: deskTableId ? Number(deskTableId) : null,
      codeLength: Number(deskCodeLength),
    }
    // A method's settings travel when it is on (or were changed while off, in an edit).
    if (payment || (portal && JSON.stringify(paymentBody) !== JSON.stringify(portal.payment))) body.payment = paymentBody
    if (clickThrough) body.clickThrough = clickBody
    if (desk || (portal?.desk && JSON.stringify(deskBody) !== JSON.stringify(portal.desk))) body.desk = deskBody
    if (!editing) body.gatewayId = gatewayId ?? undefined
    if (templateId === 'none') body.templateId = null
    else if (templateId !== 'default') body.templateId = Number(templateId)
    if (portal) {
      // PATCH only what changed: every change bumps the portal's revision.
      if (body.name === portal.name) delete body.name
      if (body.networkPerchId === portal.network.perchId) delete body.networkPerchId
      if (
        body.methods?.voucher === portal.methods.voucher &&
        body.methods?.password === portal.methods.password &&
        body.methods?.payment === portal.methods.payment &&
        body.methods?.clickThrough === portal.methods.clickThrough &&
        body.methods?.desk === Boolean(portal.methods.desk)
      ) {
        delete body.methods
      }
      if (JSON.stringify(body.payment) === JSON.stringify(portal.payment)) delete body.payment
      if (JSON.stringify(body.desk) === JSON.stringify(portal.desk)) delete body.desk
      if (JSON.stringify(body.clickThrough) === JSON.stringify(portal.clickThrough)) delete body.clickThrough
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
    if (!voucher && !password && !payment && !clickThrough && !desk) {
      setLocalError('Offer at least one way to get online.')
      return
    }
    if (payment && !priceTableId) {
      setLocalError('Paid access needs a price table.')
      return
    }
    if (desk) {
      if (!deskTableId) {
        setLocalError('Desk sales need a price table to sell from.')
        return
      }
      const length = Number(deskCodeLength)
      if (!Number.isInteger(length) || length < 8 || length > 16) {
        setLocalError('Desk codes are 8 to 16 characters long.')
        return
      }
    }
    if (clickThrough) {
      const minutes = toMinutes(ctDuration.amount, ctDuration.unit)
      if (minutes === undefined || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        setLocalError('Free access lasts between 1 minute and 24 hours.')
        return
      }
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
              <legend className="mb-1.5 text-xs font-medium">How guests get online</legend>
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
              <Checkbox
                id="portal-payment"
                checked={payment}
                onChange={setPayment}
                label="Paid access (coin terminals)"
                description="Guests pick a coin terminal on the page, pay, and get what the price table says. The gateway runs the checkout, so it works while the controller is unreachable."
              />
              <Checkbox
                id="portal-clickthrough"
                checked={clickThrough}
                onChange={setClickThrough}
                label="Free access after accepting terms (click-through)"
                description="A short, capped session for anyone who accepts the terms, a limited number of times per device."
              />
              <Checkbox
                id="portal-desk"
                checked={desk}
                onChange={setDesk}
                label="Desk sales (Sell Mode)"
                description="Front-desk staff sell codes for cash from a phone (Sell Mode). Guests type the code on the page, like a voucher."
              />
            </fieldset>

            {payment ? (
              <fieldset className="space-y-3 rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-medium">Paid access</legend>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label="Price table"
                    htmlFor="portal-price-table"
                    error={fieldErrors['payment.priceTableId']}
                    hint={
                      priceTables.data && priceTables.data.length === 0 ? (
                        <>
                          No price table yet:{' '}
                          <Link to="/portal/price-tables" className="underline underline-offset-2" onClick={onClose}>
                            create one first
                          </Link>
                          .
                        </>
                      ) : (
                        'Terminals sell at these rates unless they have their own table.'
                      )
                    }
                  >
                    <select
                      id="portal-price-table"
                      className={selectClassName}
                      value={priceTableId}
                      onChange={(e) => setPriceTableId(e.target.value)}
                    >
                      <option value="">Choose…</option>
                      {(priceTables.data ?? []).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} · {t.currency}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField
                    label="Walk-away timeout (seconds)"
                    htmlFor="portal-idle"
                    error={fieldErrors['payment.idleTimeoutSeconds']}
                    hint="15–600. With no new coin for this long a checkout closes; money already paid is credited to the guest."
                  >
                    <Input
                      id="portal-idle"
                      inputMode="numeric"
                      value={idleTimeout}
                      onChange={(e) => setIdleTimeout(e.target.value)}
                      className="rounded-md"
                    />
                  </FormField>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Add the coin boxes under{' '}
                  <Link to="/portal/terminals" className="underline underline-offset-2" onClick={onClose}>
                    Terminals
                  </Link>
                  . After paying, guests get a reference code that moves their time to another phone.
                </p>
              </fieldset>
            ) : null}

            {desk ? (
              <fieldset className="space-y-3 rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-medium">Desk sales</legend>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label="Price table"
                    htmlFor="portal-desk-table"
                    error={fieldErrors['desk.priceTableId']}
                    hint={
                      priceTables.data && priceTables.data.length === 0 ? (
                        <>
                          No price table yet:{' '}
                          <Link to="/portal/price-tables" className="underline underline-offset-2" onClick={onClose}>
                            create one first
                          </Link>
                          .
                        </>
                      ) : (
                        'Each rate is one button in Sell Mode. It can differ from the coin terminals’ table.'
                      )
                    }
                  >
                    <select
                      id="portal-desk-table"
                      className={selectClassName}
                      value={deskTableId}
                      onChange={(e) => setDeskTableId(e.target.value)}
                    >
                      <option value="">Choose…</option>
                      {(priceTables.data ?? []).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} · {t.currency}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField
                    label="Code length"
                    htmlFor="portal-desk-length"
                    error={fieldErrors['desk.codeLength']}
                    hint="8–16 characters (8 reads as XXXX-XXXX). Not shorter: a code stays valid until its time runs out, so every sold code can be guessed at."
                  >
                    <Input
                      id="portal-desk-length"
                      inputMode="numeric"
                      value={deskCodeLength}
                      onChange={(e) => setDeskCodeLength(e.target.value)}
                      className="rounded-md"
                    />
                  </FormField>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Admins and Wi-Fi vendors (Settings → Users) sell from{' '}
                  <Link to="/sell" className="underline underline-offset-2" onClick={onClose}>
                    Sell Mode
                  </Link>
                  . Sales show up under Payments with the seller’s name.
                </p>
              </fieldset>
            ) : null}

            {clickThrough ? (
              <fieldset className="space-y-3 rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-medium">Click-through</legend>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label="Free time" htmlFor="portal-ct-minutes" error={fieldErrors['clickThrough.minutes']} hint="Up to 24 hours.">
                    <DurationInput id="portal-ct-minutes" {...ctDuration} onChange={setCtDuration} placeholder="30" />
                  </FormField>
                  <FormField label="Data cap" htmlFor="portal-ct-quota" error={fieldErrors['clickThrough.quotaBytes']}>
                    <QuotaInput id="portal-ct-quota" {...ctQuota} onChange={setCtQuota} />
                  </FormField>
                  <FormField label="Download Mbps" htmlFor="portal-ct-down" error={fieldErrors['clickThrough.downKbps']}>
                    <Input id="portal-ct-down" inputMode="decimal" placeholder="No cap" value={ctDown} onChange={(e) => setCtDown(e.target.value)} className="rounded-md" />
                  </FormField>
                  <FormField label="Upload Mbps" htmlFor="portal-ct-up" error={fieldErrors['clickThrough.upKbps']}>
                    <Input id="portal-ct-up" inputMode="decimal" placeholder="No cap" value={ctUp} onChange={(e) => setCtUp(e.target.value)} className="rounded-md" />
                  </FormField>
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">How often</p>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <Input
                      aria-label="Times per window"
                      inputMode="numeric"
                      value={ctPerWindow}
                      onChange={(e) => setCtPerWindow(e.target.value)}
                      className="h-8 w-16 rounded-md"
                    />
                    <span>time(s) per device in any</span>
                    <Input
                      aria-label="Window in hours"
                      inputMode="numeric"
                      value={ctWindowHours}
                      onChange={(e) => setCtWindowHours(e.target.value)}
                      className="h-8 w-16 rounded-md"
                    />
                    <span>hours</span>
                  </div>
                  {fieldErrors['clickThrough.perWindow'] || fieldErrors['clickThrough.windowHours'] ? (
                    <p className="text-xs text-destructive">
                      {fieldErrors['clickThrough.perWindow'] ?? fieldErrors['clickThrough.windowHours']}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      1–24 times in 1–720 hours. Counted per MAC address: a phone that picks a new private address gets a new
                      allowance.
                    </p>
                  )}
                </div>
                <FormField
                  label="Terms guests accept"
                  htmlFor="portal-ct-terms"
                  error={fieldErrors['clickThrough.terms']}
                  hint="Shown above the Accept button. Up to 4000 characters."
                >
                  <textarea
                    id="portal-ct-terms"
                    className={textareaClassName}
                    rows={4}
                    maxLength={4000}
                    value={ctTerms}
                    placeholder="e.g. Free Wi-Fi for 30 minutes. Be kind; no illegal use."
                    onChange={(e) => setCtTerms(e.target.value)}
                  />
                </FormField>
              </fieldset>
            ) : null}

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
