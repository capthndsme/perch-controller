import { useState } from 'react'
import { CheckCircle } from '@phosphor-icons/react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageSpinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ErrorNote, FormField } from '@/components/portal/portal-ui'
import { usePortalSettings, useUpdatePortalSettings } from '@/hooks/use-portal'
import { ApiError } from '@/lib/api'
import { vineFieldErrors } from '@/lib/portal'
import type { PortalSettings, PortalSettingsView } from '@/types/api'

type IntKey = Exclude<keyof PortalSettings, 'offlineRedemption'>

type FieldSpec = { key: IntKey; label: string; unit: string; hint: string }

const GROUPS: Array<{ title: string; description: string; fields: FieldSpec[] }> = [
  {
    title: 'History',
    description: 'Guest sessions, ended grants and portal events are personal data (RA 10173): keep them no longer than you need.',
    fields: [{ key: 'sessionRetentionDays', label: 'Keep history for', unit: 'days', hint: 'Voucher totals are kept.' }],
  },
  {
    title: 'On the gateway',
    description: 'How often the router checks limits and reports usage.',
    fields: [
      { key: 'enforceIntervalSeconds', label: 'Check limits every', unit: 's', hint: 'A guest can overrun by up to this much.' },
      { key: 'usageIntervalSeconds', label: 'Report usage every', unit: 's', hint: 'How fresh the Guests list is.' },
      { key: 'deviceUnseenEvictMinutes', label: 'Free a portal user’s device slot after', unit: 'min unseen', hint: 'When a login is at its device limit.' },
    ],
  },
  {
    title: 'Wrong codes and passwords',
    description: 'Failures allowed before a guest (or the whole portal) has to wait.',
    fields: [
      { key: 'guestFailuresPerDevicePerMinute', label: 'Per device, per minute', unit: 'tries', hint: 'Counted on the gateway.' },
      { key: 'guestFailuresPerDevicePerHour', label: 'Per device, per hour', unit: 'tries', hint: 'Counted on the gateway.' },
      { key: 'guestFailuresPerPortalPerMinute', label: 'Per portal, per minute', unit: 'tries', hint: 'All guests together.' },
      { key: 'controllerFailuresPerDevicePer15Minutes', label: 'Password sign-ins per device, 15 min', unit: 'tries', hint: 'Counted by the controller.' },
      { key: 'controllerFailuresPerUsernamePer15Minutes', label: 'Password sign-ins per username, 15 min', unit: 'tries', hint: 'Counted by the controller.' },
    ],
  },
  {
    title: 'Abuse limits',
    description: 'Rates for guests who have not signed in yet, and for integrations.',
    fields: [
      { key: 'preauthDnsPerDevicePerMinute', label: 'DNS queries before sign-in', unit: 'per min', hint: 'Stops DNS tunnelling around the portal.' },
      { key: 'apiRequestsPerClientPerMinute', label: 'API requests per client', unit: 'per min', hint: 'For each API client (Paid Hotspot API).' },
    ],
  },
]

type FormState = Record<IntKey, string> & { offlineRedemption: boolean }

function toForm(settings: PortalSettings): FormState {
  const out = { offlineRedemption: settings.offlineRedemption } as FormState
  for (const key of Object.keys(settings) as Array<keyof PortalSettings>) {
    if (key !== 'offlineRedemption') out[key] = String(settings[key])
  }
  return out
}

/** `/settings/portal`: the guest portal tunables (portal.md §8). */
export function PortalSettingsPage() {
  const query = usePortalSettings()
  if (query.data) return <PortalSettingsForm view={query.data} />
  if (query.error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-destructive">
          {query.error instanceof ApiError && query.error.status === 403 ? 'Only admins can view this settings page.' : query.error.message}
        </p>
      </div>
    )
  }
  return <PageSpinner label="Loading guest portal settings" />
}

function PortalSettingsForm({ view }: { view: PortalSettingsView }) {
  const update = useUpdatePortalSettings()
  const [form, setForm] = useState<FormState>(() => toForm(view.settings))
  const [saved, setSaved] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const fieldErrors = vineFieldErrors(update.error)
  const defaults = toForm(view.defaults)
  const atDefaults = (Object.keys(defaults) as Array<keyof FormState>).every((key) => form[key] === defaults[key])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setSaved(false)
    setForm((current) => ({ ...current, [key]: value }))
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setLocalError(null)
    const payload: Partial<PortalSettings> = { offlineRedemption: form.offlineRedemption }
    for (const key of Object.keys(view.limits) as IntKey[]) {
      const value = Number(form[key])
      if (form[key].trim() === '' || !Number.isInteger(value)) {
        setLocalError('Enter a whole number in every field.')
        return
      }
      payload[key] = value
    }
    update.mutate(payload, {
      onSuccess: (data) => {
        setForm(toForm(data.settings))
        setSaved(true)
      },
    })
  }

  function field(spec: FieldSpec) {
    const limit = view.limits[spec.key]
    return (
      <FormField
        key={spec.key}
        label={spec.label}
        htmlFor={spec.key}
        error={fieldErrors[spec.key]}
        hint={`${spec.hint} ${limit.min}–${limit.max}; default ${view.defaults[spec.key]}.`}
      >
        <div className="flex items-center gap-2">
          <Input
            id={spec.key}
            inputMode="numeric"
            value={form[spec.key]}
            onChange={(e) => set(spec.key, e.target.value)}
            className="w-28 rounded-md"
          />
          <span className="text-xs text-muted-foreground">{spec.unit}</span>
        </div>
      </FormField>
    )
  }

  return (
    <div className="w-full max-w-3xl">
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Guest portal</CardTitle>
          <CardDescription>
            Settings shared by every portal. Saving sends them to each gateway that runs one (when it is online).
          </CardDescription>
        </CardHeader>
        <form onSubmit={submit}>
          <CardContent className="space-y-6 pt-6">
            {saved ? (
              <Alert className="rounded-lg border-primary/20 bg-primary/5">
                <CheckCircle className="size-4 text-primary" />
                <AlertTitle>Saved</AlertTitle>
                <AlertDescription>Gateways pick the new settings up on their next sync.</AlertDescription>
              </Alert>
            ) : null}
            {GROUPS.map((group) => (
              <section key={group.title} className="space-y-3">
                <div>
                  <h2 className="text-sm font-medium">{group.title}</h2>
                  <p className="text-xs text-muted-foreground">{group.description}</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">{group.fields.map(field)}</div>
              </section>
            ))}
            <section className="space-y-3">
              <div>
                <h2 className="text-sm font-medium">Controller outages</h2>
                <p className="text-xs text-muted-foreground">
                  The gateway can redeem vouchers on its own while it cannot reach the controller. It only holds codes
                  bound to its own portals, so a code can never be used twice.
                </p>
              </div>
              <label className="flex items-center gap-2.5 text-xs">
                <Switch
                  checked={form.offlineRedemption}
                  onCheckedChange={(next) => set('offlineRedemption', next)}
                  aria-label="Redeem vouchers offline"
                />
                <span className="font-medium">Redeem vouchers while the controller is unreachable</span>
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                {field({ key: 'offlineVoucherLimit', label: 'Vouchers each gateway holds', unit: 'codes', hint: 'In-use codes first, then the newest batches.' })}
              </div>
            </section>
            {localError ? <p className="text-xs text-destructive">{localError}</p> : null}
            <ErrorNote error={update.error && Object.keys(fieldErrors).length === 0 ? update.error : null} />
          </CardContent>
          <CardFooter className="mt-6 justify-between gap-2 border-t bg-muted/20">
            <Button
              type="button"
              variant="ghost"
              disabled={atDefaults}
              onClick={() => {
                update.reset()
                setSaved(false)
                setForm(defaults)
              }}
            >
              Reset to defaults
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
