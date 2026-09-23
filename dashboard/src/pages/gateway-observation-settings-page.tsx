import { useState } from 'react'
import { CheckCircle } from '@phosphor-icons/react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageSpinner } from '@/components/ui/spinner'
import {
  fieldErrorsFromApi,
  useGatewayObservationSettings,
  useUpdateGatewayObservationSettings,
} from '@/hooks/use-settings'
import { ApiError } from '@/lib/api'
import type { GatewayObservationSettings, GatewayObservationSettingsView } from '@/types/settings'

type SettingKey = keyof GatewayObservationSettings
type FormState = Record<SettingKey, string>

const KEYS: SettingKey[] = ['hostRetentionDays', 'upnpEventRetentionDays', 'backupsKept']

function toFormState(settings: GatewayObservationSettings): FormState {
  return {
    hostRetentionDays: String(settings.hostRetentionDays),
    upnpEventRetentionDays: String(settings.upnpEventRetentionDays),
    backupsKept: String(settings.backupsKept),
  }
}

/** Every field as a whole number, or null if any is not one. */
function toPayload(form: FormState): GatewayObservationSettings | null {
  const payload: Partial<GatewayObservationSettings> = {}
  for (const key of KEYS) {
    const parsed = Number(form[key])
    if (form[key].trim() === '' || !Number.isInteger(parsed)) return null
    payload[key] = parsed
  }
  return payload as GatewayObservationSettings
}

/** Settings → Gateway observation (docs/gateway/observation.md §6). */
export function GatewayObservationSettingsPage() {
  const query = useGatewayObservationSettings()

  if (query.data) return <GatewayObservationSettingsForm view={query.data} />

  if (query.error) {
    const message =
      query.error instanceof ApiError && query.error.status === 403
        ? 'Only admins can view this settings page.'
        : query.error instanceof ApiError && query.error.status === 404
          ? 'This controller has no gateway observation settings yet: update Perch Network Controller.'
          : query.error.message
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-destructive">{message}</p>
      </div>
    )
  }

  return <PageSpinner label="Loading gateway observation settings" />
}

function GatewayObservationSettingsForm({ view }: { view: GatewayObservationSettingsView }) {
  const update = useUpdateGatewayObservationSettings()
  const [form, setForm] = useState<FormState>(() => toFormState(view.settings))
  const [formError, setFormError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const fieldErrors = update.error ? fieldErrorsFromApi(update.error) : {}
  const defaults = toFormState(view.defaults)
  const atDefaults = KEYS.every((key) => form[key] === defaults[key])

  function fieldProps(id: SettingKey) {
    const { min, max } = view.limits[id]
    return {
      id,
      min,
      max,
      value: form[id],
      error: fieldErrors[id],
      defaultValue: view.defaults[id],
      onChange: (value: string) => setForm((current) => ({ ...current, [id]: value })),
    }
  }

  function resetToDefaults() {
    update.reset()
    setFormError(null)
    setSuccessMessage(null)
    setForm(defaults)
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    setSuccessMessage(null)
    const payload = toPayload(form)
    if (!payload) {
      setFormError('Enter a whole number in every field.')
      return
    }
    try {
      const saved = await update.mutateAsync(payload)
      setForm(toFormState(saved.settings))
      setSuccessMessage('Gateway observation settings saved. They apply from the next daily clean-up (03:50).')
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 403) setFormError('Only admins can update these settings.')
        else if (error.status !== 422) setFormError(error.message)
      } else {
        setFormError('Failed to save the settings.')
      }
    }
  }

  return (
    <div className="w-full max-w-3xl">
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Gateway observation</CardTitle>
          <CardDescription>
            How long Perch keeps what the router reported once it stops reporting it, and how many
            router backups it keeps. Current leases, neighbours and UPnP mappings are always the
            router's latest report; these only bound the history.
          </CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit}>
          <CardContent className="space-y-6 py-6">
            {formError ? <FormError message={formError} /> : null}
            {successMessage ? (
              <Alert className="rounded-lg border-primary/20 bg-primary/5">
                <CheckCircle className="size-4 text-primary" />
                <AlertTitle>Saved</AlertTitle>
                <AlertDescription>{successMessage}</AlertDescription>
              </Alert>
            ) : null}

            <section className={formClassName()}>
              <h3 className="text-sm font-medium">Retention</h3>
              <NumberField
                {...fieldProps('hostRetentionDays')}
                label="Hosts no longer listed (days)"
                hint="A device whose lease ended and that left the neighbour table keeps its row (last gateway sighting, network) this long, so Last seen and presence still know it. The UPnP mappings of a gateway that stopped reporting UPnP follow the same limit."
              />
              <NumberField
                {...fieldProps('upnpEventRetentionDays')}
                label="UPnP history (days)"
                hint="Every port a device opened or closed through UPnP."
              />
            </section>

            <section className={formClassName('border-t pt-6')}>
              <h3 className="text-sm font-medium">Backups</h3>
              <NumberField
                {...fieldProps('backupsKept')}
                label="Backups kept per gateway"
                hint="The newest ones are kept; older ones are deleted when a new backup is taken. Each is at most 8 MiB, stored encrypted in the controller's database."
              />
            </section>
          </CardContent>
          <CardFooter className="flex-wrap justify-end gap-2 border-t bg-muted/20">
            <Button type="button" variant="outline" onClick={resetToDefaults} disabled={update.isPending || atDefaults}>
              Reset to defaults
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save settings'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}

type NumberFieldProps = {
  id: SettingKey
  label: string
  hint: string
  value: string
  error?: string
  min: number
  max: number
  defaultValue: number
  onChange: (value: string) => void
}

function NumberField({ id, label, hint, value, error, min, max, defaultValue, onChange }: NumberFieldProps) {
  return (
    <Field label={label} htmlFor={id} hint={`${hint} Default ${defaultValue} (${min}–${max}).`} error={error}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        required
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md"
      />
    </Field>
  )
}
