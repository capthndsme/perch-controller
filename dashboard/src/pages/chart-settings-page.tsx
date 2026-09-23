import { useState } from 'react'
import { CheckCircle } from '@phosphor-icons/react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageSpinner } from '@/components/ui/spinner'
import { fieldErrorsFromApi, useChartSettings, useUpdateChartSettings } from '@/hooks/use-settings'
import { ApiError } from '@/lib/api'
import type { ChartSettings, ChartSettingsView } from '@/types/settings'

type SettingKey = keyof ChartSettings

type FormState = Record<SettingKey, string>

function toFormState(settings: ChartSettings): FormState {
  return {
    minBucketSeconds: String(settings.minBucketSeconds),
    maxPoints: String(settings.maxPoints),
  }
}

/** The field as a whole number, or null while it is empty or not one. */
function parseWholeNumber(value: string): number | null {
  const parsed = Number(value)
  return value.trim() !== '' && Number.isInteger(parsed) ? parsed : null
}

/** Both fields, so a save stores what the form shows; null if either is not a whole number. */
function toPayload(form: FormState): ChartSettings | null {
  const payload: Partial<ChartSettings> = {}
  for (const key of Object.keys(form) as SettingKey[]) {
    const value = parseWholeNumber(form[key])
    if (value === null) return null
    payload[key] = value
  }
  return payload as ChartSettings
}

/** The widest window that still gets the finest bucket, for the typed values. */
function floorExample(form: FormState): string | null {
  const floor = parseWholeNumber(form.minBucketSeconds)
  const points = parseWholeNumber(form.maxPoints)
  if (floor === null || points === null || floor <= 0 || points <= 0) return null
  const seconds = floor * points
  const span =
    seconds >= 86400
      ? `${Math.round((seconds / 86400) * 10) / 10} days`
      : seconds >= 3600
        ? `${Math.round((seconds / 3600) * 10) / 10} hours`
        : `${Math.round(seconds / 60)} minutes`
  return `Windows up to about ${span} get ${floor} s buckets; wider ones step up to coarser buckets.`
}

export function ChartSettingsPage() {
  const query = useChartSettings()

  // Data first: a failed background refetch leaves the form, and any edits, in place.
  if (query.data) {
    return <ChartSettingsForm view={query.data} />
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

  return <PageSpinner label="Loading chart settings" />
}

function ChartSettingsForm({ view }: { view: ChartSettingsView }) {
  const update = useUpdateChartSettings()
  const [form, setForm] = useState<FormState>(() => toFormState(view.settings))
  const [formError, setFormError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const fieldErrors = update.error ? fieldErrorsFromApi(update.error) : {}
  const defaults = toFormState(view.defaults)
  const atDefaults = (Object.keys(defaults) as SettingKey[]).every((key) => form[key] === defaults[key])
  const example = floorExample(form)

  function settingProps(id: SettingKey) {
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
      setSuccessMessage('Chart settings saved.')
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 403) {
          setFormError('Only admins can update chart settings.')
        } else if (error.status !== 422) {
          setFormError(error.message)
        }
      } else {
        setFormError('Failed to save chart settings.')
      }
    }
  }

  return (
    <div className="w-full max-w-3xl">
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Charts</CardTitle>
          <CardDescription>
            How finely the server and destination traffic charts split a time window into buckets.
            Each bucket's rate is its bytes divided by its seconds. Changes apply from the next
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
              <h3 className="text-sm font-medium">Bucket size</h3>
              <SettingField
                {...settingProps('minBucketSeconds')}
                label="Finest bucket (seconds)"
                hint={`Applies where per-poll data exists: the last ${view.nativeRetentionDays} days of server traffic. Older windows use the stored 5-minute or hourly detail, and destinations are stored per hour.`}
              />
              <SettingField
                {...settingProps('maxPoints')}
                label="Most points per chart"
                hint="Wider windows get coarser buckets so a chart never draws more points than this."
              />
              {example ? (
                <p className="rounded-lg border bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
                  {example}
                </p>
              ) : null}
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

type SettingFieldProps = {
  id: SettingKey
  view: ChartSettingsView
  value: string
  error?: string
  onChange: (value: string) => void
  label: string
  hint: string
}

/** A whole-number input whose range and default come from the server's view. */
function SettingField({ id, view, value, error, onChange, label, hint }: SettingFieldProps) {
  const { min, max } = view.limits[id]
  return (
    <Field label={label} htmlFor={id} hint={`${hint} Default ${view.defaults[id]} (${min}–${max}).`} error={error}>
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
