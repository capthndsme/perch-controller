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
  usePresenceSettings,
  useUpdatePresenceSettings,
} from '@/hooks/use-settings'
import { ApiError } from '@/lib/api'
import type { PresenceSettingsView, PresenceThresholds } from '@/types/settings'

type ThresholdKey = keyof PresenceThresholds

type FormState = Record<ThresholdKey, string>

function toFormState(settings: PresenceThresholds): FormState {
  return {
    lanQuietMinutes: String(settings.lanQuietMinutes),
    wifiTrailingTrafficMinutes: String(settings.wifiTrailingTrafficMinutes),
    apStaleIntervals: String(settings.apStaleIntervals),
    apStaleMinSeconds: String(settings.apStaleMinSeconds),
    nowRateIntervals: String(settings.nowRateIntervals),
  }
}

/** The field as a whole number, or null while it is empty or not one. */
function parseWholeNumber(value: string): number | null {
  const parsed = Number(value)
  return value.trim() !== '' && Number.isInteger(parsed) ? parsed : null
}

/** All five fields, so a save stores what the form shows; null if any is not a whole number. */
function toPayload(form: FormState): PresenceThresholds | null {
  const payload: Partial<PresenceThresholds> = {}
  for (const key of Object.keys(form) as ThresholdKey[]) {
    const value = parseWholeNumber(form[key])
    if (value === null) return null
    payload[key] = value
  }
  return payload as PresenceThresholds
}

/** The AP silence rule worked out for the typed values; null until both are whole numbers. */
function silenceExample(form: FormState): string | null {
  const intervals = parseWholeNumber(form.apStaleIntervals)
  const minSeconds = parseWholeNumber(form.apStaleMinSeconds)
  if (intervals === null || minSeconds === null) return null
  // The server's rule: max(missed reports × report interval, minimum).
  const silentAfter = (reportSeconds: number) => Math.max(intervals * reportSeconds, minSeconds)
  return `An AP reporting every 5 s is silent after ${silentAfter(5)} s; every 60 s, after ${silentAfter(60)} s.`
}

export function PresenceSettingsPage() {
  const query = usePresenceSettings()

  // Data first: a failed background refetch leaves the form, and any edits, in place.
  if (query.data) {
    return <PresenceSettingsForm view={query.data} />
  }

  if (query.error) {
    const message =
      query.error instanceof ApiError && query.error.status === 403
        ? 'Only admins can view this settings page.'
        : query.error.message

    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-destructive">{message}</p>
      </div>
    )
  }

  return <PageSpinner label="Loading presence settings" />
}

function PresenceSettingsForm({ view }: { view: PresenceSettingsView }) {
  const update = useUpdatePresenceSettings()
  const [form, setForm] = useState<FormState>(() => toFormState(view.settings))
  const [formError, setFormError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const fieldErrors = update.error ? fieldErrorsFromApi(update.error) : {}
  const defaults = toFormState(view.defaults)
  const atDefaults = (Object.keys(defaults) as ThresholdKey[]).every(
    (key) => form[key] === defaults[key],
  )
  const example = silenceExample(form)

  function thresholdProps(id: ThresholdKey) {
    return {
      id,
      view,
      value: form[id],
      error: fieldErrors[id],
      onChange: (value: string) => setForm((current) => ({ ...current, [id]: value })),
    }
  }

  /** Fills the form only; Save applies it. */
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
      setSuccessMessage('Presence settings saved.')
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 403) {
          setFormError('Only admins can update presence settings.')
        } else if (error.status !== 422) {
          setFormError(error.message)
        }
      } else {
        setFormError('Failed to save presence settings.')
      }
    }
  }

  return (
    <div className="w-full max-w-3xl">
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Presence</CardTitle>
          <CardDescription>
            How Perch decides whether a device is connected right now. Changes apply from the next
            refresh.
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
              <h3 className="text-sm font-medium">Devices</h3>
              <ThresholdField
                {...thresholdProps('lanQuietMinutes')}
                label="Wired timeout (minutes)"
                hint="A device not on a Perch access point (Ethernet or Wired / unknown in the device list) reads Connected while the collector saw its traffic within this time; after that, Disconnected."
              />
              <ThresholdField
                {...thresholdProps('wifiTrailingTrafficMinutes')}
                label="Traffic after leaving WiFi (minutes)"
                hint="After a device leaves WiFi, the gateway keeps sending to it for a few minutes (up to 7 measured). Traffic within this time of its last WiFi sighting still belongs to that visit (Last seen on WiFi); later traffic means it came back another way, such as a cable or an AP Perch does not read (Wired / unknown). A larger value also delays noticing a device that moved to a cable. Devices marked Ethernet skip this."
              />
            </section>

            <section className={formClassName('border-t pt-6')}>
              <div className="space-y-1">
                <h3 className="text-sm font-medium">Access points</h3>
                <p className="text-xs text-muted-foreground">
                  An access point that has not reported for the longer of these two times counts
                  as silent: it is flagged in Settings → WiFi sources and its clients stop counting
                  as connected.
                </p>
              </div>
              <ThresholdField
                {...thresholdProps('apStaleIntervals')}
                label="Silent after (missed reports)"
                hint="Counted in the AP's own report interval."
              />
              <ThresholdField
                {...thresholdProps('apStaleMinSeconds')}
                label="Silent after at least (seconds)"
                hint="A floor for APs that report often, so a short gap does not flag them."
              />
              {example ? (
                <p className="rounded-lg border bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
                  {example}
                </p>
              ) : null}
              <div className="space-y-1">
                <p className="text-xs font-medium">
                  Client idle limit: {view.wifiIdleSeconds} seconds (fixed)
                </p>
                <p className="text-xs text-muted-foreground">
                  A client its AP still lists stops counting as connected after this long idle. It
                  is fixed because the client-count history is stored with it.
                </p>
              </div>
            </section>

            <section className={formClassName('border-t pt-6')}>
              <h3 className="text-sm font-medium">Traffic rates</h3>
              <ThresholdField
                {...thresholdProps('nowRateIntervals')}
                label="Down now / Up now cut-off (intervals)"
                hint="The device list's Down now / Up now rates read 0 once a device's latest traffic sample is more than this many sample intervals before the end of the window (5 s samples on short windows; 5 min, 1 h or 1 day on long ones)."
              />
            </section>
          </CardContent>
          <CardFooter className="flex-wrap justify-end gap-2 border-t bg-muted/20">
            <Button
              type="button"
              variant="outline"
              onClick={resetToDefaults}
              disabled={update.isPending || atDefaults}
            >
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

type ThresholdFieldProps = {
  id: ThresholdKey
  view: PresenceSettingsView
  value: string
  error?: string
  onChange: (value: string) => void
  label: string
  hint: string
}

/** A whole-number input whose range and default come from the server's view. */
function ThresholdField({ id, view, value, error, onChange, label, hint }: ThresholdFieldProps) {
  const { min, max } = view.limits[id]
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={`${hint} Default ${view.defaults[id]} (${min}–${max}).`}
      error={error}
    >
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
