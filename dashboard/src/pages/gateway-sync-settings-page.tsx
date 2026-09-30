import { useState } from 'react'
import { CheckCircle, Warning } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { PageSpinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useGatewaySyncSettings, useUpdateGatewaySyncSettings } from '@/hooks/use-gateway-sync'
import { ApiError } from '@/lib/api'
import type { ConfirmMode } from '@/types/gateway-config'
import type {
  GatewaySyncNumericKey,
  GatewaySyncSettings,
  GatewaySyncSettingsPatch,
  GatewaySyncSettingsView,
} from '@/types/gateway-sync'

/**
 * `/settings/gateway-sync` (design gateway-sync dashboard.md 8, rest.md 11): how
 * the router verifies an internet change, the WAN confirm window, Authoritative
 * Mode for WAN edits, WireGuard staleness and step-up, UPnP events and the
 * multi-WAN switch. The Presence page's form: values with their range and
 * default, one Save, "Reset to defaults" fills the form only.
 */

type NumberForm = Record<GatewaySyncNumericKey, string>

const NUMERIC_KEYS: GatewaySyncNumericKey[] = [
  'checkTcpPort',
  'checkTimeoutDhcpSeconds',
  'checkTimeoutStaticSeconds',
  'checkTimeoutPppoeSeconds',
  'checkTimeoutMobileSeconds',
  'checkTimeoutOtherSeconds',
  'wanConfirmTimeoutSeconds',
  'transitionRetentionDays',
  'wgPeerStaleMinutes',
]

type FormState = {
  numbers: NumberForm
  checkTargets: string
  checkResolveName: string
  wanConfirmMode: ConfirmMode
  authoritativeWan: 'import' | 'enforce'
  wgStepUp: boolean
  upnpOpenedEvents: boolean
  multiWanWrites: boolean
}

function toForm(s: GatewaySyncSettings): FormState {
  return {
    numbers: Object.fromEntries(NUMERIC_KEYS.map((k) => [k, String(s[k])])) as NumberForm,
    checkTargets: s.checkTargets.join(', '),
    checkResolveName: s.checkResolveName,
    wanConfirmMode: s.wanConfirmMode,
    authoritativeWan: s.authoritativeWan,
    wgStepUp: s.wgStepUp,
    upnpOpenedEvents: s.upnpOpenedEvents,
    multiWanWrites: s.multiWanWrites,
  }
}

function targetsOf(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

function sameForm(a: FormState, b: FormState): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function GatewaySyncSettingsPage() {
  const query = useGatewaySyncSettings()
  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <PageHeader
        title="Gateway sync"
        description="How the router verifies internet changes, and the limits of WAN, VPN and UPnP management."
        crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Gateway sync' }]}
      />
      {query.data ? (
        <SettingsForm view={query.data} />
      ) : query.error ? (
        <p className="text-sm text-destructive">
          {query.error instanceof ApiError && query.error.status === 403
            ? 'Only admins can view this settings page.'
            : query.error.message}
        </p>
      ) : (
        <PageSpinner label="Loading gateway sync settings" />
      )}
    </div>
  )
}

function SettingsForm({ view }: { view: GatewaySyncSettingsView }) {
  const update = useUpdateGatewaySyncSettings()
  const [form, setForm] = useState<FormState>(() => toForm(view.settings))
  const [password, setPassword] = useState('')
  const [error, setError] = useState<{ field: string | null; message: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const defaults = toForm(view.defaults)
  const turningOnMultiWan = form.multiWanWrites && !view.settings.multiWanWrites

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setSaved(false)
    setForm((current) => ({ ...current, [key]: value }))
  }
  const setNumber = (key: GatewaySyncNumericKey, value: string) => {
    setSaved(false)
    setForm((current) => ({ ...current, numbers: { ...current.numbers, [key]: value } }))
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSaved(false)
    const patch: GatewaySyncSettingsPatch = {
      checkTargets: targetsOf(form.checkTargets),
      checkResolveName: form.checkResolveName.trim(),
      wanConfirmMode: form.wanConfirmMode,
      authoritativeWan: form.authoritativeWan,
      wgStepUp: form.wgStepUp,
      upnpOpenedEvents: form.upnpOpenedEvents,
      multiWanWrites: form.multiWanWrites,
    }
    for (const key of NUMERIC_KEYS) {
      const value = Number(form.numbers[key])
      if (form.numbers[key].trim() === '' || !Number.isInteger(value)) {
        setError({ field: key, message: 'Enter a whole number.' })
        return
      }
      patch[key] = value
    }
    if (turningOnMultiWan) patch.currentPassword = password
    try {
      const next = await update.mutateAsync(patch)
      setForm(toForm(next.settings))
      setPassword('')
      setSaved(true)
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as { field?: string; error?: string } | undefined
        setError({
          field: typeof body?.field === 'string' ? body.field : body?.error === 'invalid_password' ? 'currentPassword' : null,
          message: e.message,
        })
      } else {
        setError({ field: null, message: 'Saving failed.' })
      }
    }
  }

  const fieldError = (field: string) => (error?.field === field ? error.message : undefined)
  const numberField = (key: GatewaySyncNumericKey, label: string, hint: string) => (
    <NumberField
      key={key}
      id={key}
      label={label}
      hint={hint}
      value={form.numbers[key]}
      limits={view.limits[key]}
      fallback={view.defaults[key] as number}
      error={fieldError(key)}
      onChange={(value) => setNumber(key, value)}
    />
  )

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="border-b">
        <CardTitle className="text-lg">Gateway sync</CardTitle>
        <CardDescription>
          Applies to every managed gateway. An internet change is kept only after the router has
          checked it can still reach these targets.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-6 py-6">
          {error && !error.field ? <FormError message={error.message} /> : null}
          {saved ? (
            <Alert className="rounded-lg border-primary/20 bg-primary/5">
              <CheckCircle className="size-4 text-primary" />
              <AlertTitle>Saved</AlertTitle>
              <AlertDescription>Gateway sync settings saved.</AlertDescription>
            </Alert>
          ) : null}

          <section className={formClassName()}>
            <h3 className="text-sm font-medium">Internet checks</h3>
            <Field
              label="Check targets"
              htmlFor="checkTargets"
              hint={`Addresses the router must reach after an internet change, comma separated. $gateway is the WAN's own next hop. Default ${view.defaults.checkTargets.join(', ')}.`}
              error={fieldError('checkTargets')}
            >
              <Input
                id="checkTargets"
                value={form.checkTargets}
                onChange={(e) => set('checkTargets', e.target.value)}
                className="rounded-md font-mono text-sm"
                spellCheck={false}
              />
            </Field>
            {numberField('checkTcpPort', 'TCP port of the reach check', 'Where no ping gets through, the router tries this port.')}
            <Field
              label="Name to resolve"
              htmlFor="checkResolveName"
              hint={`The router asks a fresh name under it, so a cached answer never passes. Empty turns the DNS check off. Default ${view.defaults.checkResolveName || 'off'}.`}
              error={fieldError('checkResolveName')}
            >
              <Input
                id="checkResolveName"
                value={form.checkResolveName}
                onChange={(e) => set('checkResolveName', e.target.value)}
                className="rounded-md font-mono text-sm"
                spellCheck={false}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              {numberField('checkTimeoutDhcpSeconds', 'DHCP uplink (seconds)', 'Time the checks get after the change.')}
              {numberField('checkTimeoutStaticSeconds', 'Static uplink (seconds)', 'Time the checks get after the change.')}
              {numberField('checkTimeoutPppoeSeconds', 'PPPoE uplink (seconds)', 'PPPoE takes longer to dial.')}
              {numberField('checkTimeoutMobileSeconds', 'Mobile uplink (seconds)', 'A modem takes longest to register.')}
              {numberField('checkTimeoutOtherSeconds', 'Other uplinks (seconds)', 'Any other protocol.')}
            </div>
          </section>

          <section className={formClassName('border-t pt-6')}>
            <h3 className="text-sm font-medium">Internet changes</h3>
            {numberField(
              'wanConfirmTimeoutSeconds',
              'Confirm window (seconds)',
              'How long the router waits for the change to be kept before it restores the previous config. The router may cap it.',
            )}
            <ChoiceRow
              label="Who confirms"
              hint="Router alone: the change stays once the checks pass and the controller hears from the router again. With you: you also press Keep changes."
            >
              <Segmented
                value={form.wanConfirmMode}
                onChange={(v) => set('wanConfirmMode', v)}
                ariaLabel="Who confirms internet changes"
                options={[
                  { id: 'agent', label: 'Router alone' },
                  { id: 'admin_and_agent', label: 'Router and you' },
                ]}
              />
            </ChoiceRow>
            <ChoiceRow
              label="Router edits in Authoritative Mode"
              hint="Import: a change made on the router (LuCI) to the WAN is taken over, even in Authoritative Mode, so a provider's fix is never undone. Enforce: it is reverted like any other drift."
            >
              <Segmented
                value={form.authoritativeWan}
                onChange={(v) => set('authoritativeWan', v)}
                ariaLabel="Router edits of the WAN in Authoritative Mode"
                options={[
                  { id: 'import', label: 'Import' },
                  { id: 'enforce', label: 'Enforce' },
                ]}
              />
            </ChoiceRow>
            {numberField('transitionRetentionDays', 'Keep WAN history (days)', 'Up and down transitions of the WANs.')}
          </section>

          <section className={formClassName('border-t pt-6')}>
            <h3 className="text-sm font-medium">VPN and UPnP</h3>
            {numberField('wgPeerStaleMinutes', 'WireGuard peer offline after (minutes)', 'A peer without a handshake for this long shows offline.')}
            <SwitchRow
              id="wgStepUp"
              label="Password for new VPN access"
              hint="A new WireGuard interface or peer is a way into the network: ask for your password first."
              checked={form.wgStepUp}
              onChange={(v) => set('wgStepUp', v)}
            />
            <SwitchRow
              id="upnpOpenedEvents"
              label="Record opened UPnP ports as alerts"
              hint="Every port a device opens becomes an alert (off: they stay in the UPnP list only)."
              checked={form.upnpOpenedEvents}
              onChange={(v) => set('upnpOpenedEvents', v)}
            />
          </section>

          <section className={formClassName('border-t pt-6')}>
            <h3 className="text-sm font-medium">Multi-WAN</h3>
            <SwitchRow
              id="multiWanWrites"
              label="Let Perch edit multi-WAN (mwan3)"
              hint="Off by default: Perch shows mwan3 but never writes it, so the balancing that keeps your internet up stays as you set it. Turning it on needs your password, and the router must also allow it."
              checked={form.multiWanWrites}
              onChange={(v) => set('multiWanWrites', v)}
            />
            {turningOnMultiWan ? (
              <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Warning className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  <span>
                    The router keeps mwan3 read-only until it lists it too: add{' '}
                    <code className="font-mono">list managed_config 'mwan3'</code> to{' '}
                    <code className="font-mono">/etc/config/perch-collector</code> and restart
                    perch-collector.
                  </span>
                </p>
                <Field label="Your password" htmlFor="currentPassword" error={fieldError('currentPassword')}>
                  <Input
                    id="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="rounded-md"
                  />
                </Field>
              </div>
            ) : null}
          </section>
        </CardContent>
        <CardFooter className="flex-wrap justify-end gap-2 border-t bg-muted/20">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setError(null)
              setSaved(false)
              setForm(defaults)
            }}
            disabled={update.isPending || sameForm(form, defaults)}
          >
            Reset to defaults
          </Button>
          <Button type="submit" disabled={update.isPending || (turningOnMultiWan && password === '')}>
            {update.isPending ? 'Saving…' : 'Save settings'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function NumberField(props: {
  id: string
  label: string
  hint: string
  value: string
  limits: { min: number; max: number }
  fallback: number
  error?: string
  onChange: (value: string) => void
}) {
  return (
    <Field
      label={props.label}
      htmlFor={props.id}
      hint={`${props.hint} Default ${props.fallback} (${props.limits.min}–${props.limits.max}).`}
      error={props.error}
    >
      <Input
        id={props.id}
        type="number"
        inputMode="numeric"
        required
        min={props.limits.min}
        max={props.limits.max}
        step={1}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="rounded-md"
      />
    </Field>
  )
}

function ChoiceRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="space-y-1">
        <p className="text-xs font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function SwitchRow(props: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor={props.id} className="text-xs font-medium">
          {props.label}
        </Label>
        <p className="text-xs text-muted-foreground">{props.hint}</p>
      </div>
      <Switch id={props.id} checked={props.checked} onCheckedChange={props.onChange} aria-label={props.label} />
    </div>
  )
}
