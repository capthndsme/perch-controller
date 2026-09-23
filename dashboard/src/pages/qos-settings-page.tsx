import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle } from '@phosphor-icons/react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageSpinner } from '@/components/ui/spinner'
import { useQosSettings, useUpdateQosSettings } from '@/hooks/use-qos'
import { ApiError, fieldErrorsFromApi } from '@/lib/api'
import type { QosSettings, QosSettingsView } from '@/types/api'

type Key = keyof QosSettings
type FormState = Record<Key, string>

/**
 * Settings → Traffic shaping (`/settings/qos`, docs/gateway/qos.md 4.7).
 * Rates are typed in Mbit/s here like everywhere else in the dashboard and
 * stored in kbit/s; everything else is in the unit its label names.
 */
type FieldSpec = { key: Key; label: string; hint: string; unit: 'mbit' | 'plain' }

const SECTIONS: { title: string; note?: string; fields: FieldSpec[] }[] = [
  {
    title: 'Rates',
    fields: [
      { key: 'minWanKbit', unit: 'mbit', label: 'Lowest WAN queue rate (Mbit/s)', hint: 'A WAN queue below this is refused: too low a rate can cut the gateway off from the controller.' },
      { key: 'minDeviceKbit', unit: 'mbit', label: 'Lowest cap (Mbit/s)', hint: 'The smallest per-device or bucket rate a policy may set.' },
    ],
  },
  {
    title: 'Buckets and devices',
    fields: [
      { key: 'maxBucketDepth', unit: 'plain', label: 'Deepest bucket nesting', hint: '1 = no nesting; at most 4.' },
      { key: 'dynamicClassLimit', unit: 'plain', label: 'Network-default classes per gateway', hint: 'How many devices a network default can give their own class at once.' },
      { key: 'dynamicIdleMinutes', unit: 'plain', label: 'Free an idle network-default class after (minutes)', hint: 'A device that has gone quiet gives its class back after this long.' },
      { key: 'expiredKeepMinutes', unit: 'plain', label: 'Keep expired assignments listed for (minutes)', hint: 'They do nothing in that time; 0 deletes them at once.' },
    ],
  },
  {
    title: 'Router memory per device',
    note: 'Queue sizes on the router. The defaults fit small routers; raise them only on a gateway with memory to spare.',
    fields: [
      { key: 'leafFlows', unit: 'plain', label: 'Flows per device', hint: 'fq_codel flow buckets in each device class.' },
      { key: 'leafLimitPackets', unit: 'plain', label: 'Packets per device', hint: 'fq_codel packet limit in each device class.' },
      { key: 'leafMemoryKb', unit: 'plain', label: 'Memory per device (KB)', hint: 'fq_codel memory limit in each device class.' },
      { key: 'restMemlimitKb', unit: 'plain', label: 'Memory per shared bucket (KB)', hint: 'CAKE memory limit of each bucket’s shared part.' },
    ],
  },
  {
    title: 'Timing',
    fields: [
      { key: 'applyDebounceSeconds', unit: 'plain', label: 'Wait for more edits (seconds)', hint: 'Bucket and schedule changes wait this long before going to the router, so a burst of edits is one apply.' },
      { key: 'quotaPersistSeconds', unit: 'plain', label: 'Save quota usage every (seconds)', hint: 'How often the router’s quota counts are stored here.' },
    ],
  },
]

const ALL_FIELDS = SECTIONS.flatMap((s) => s.fields)

function display(spec: FieldSpec, value: number): string {
  return spec.unit === 'mbit' ? String(value / 1000) : String(value)
}

function toForm(settings: QosSettings): FormState {
  return Object.fromEntries(ALL_FIELDS.map((f) => [f.key, display(f, settings[f.key])])) as FormState
}

function toPayload(form: FormState): QosSettings | null {
  const out: Partial<QosSettings> = {}
  for (const f of ALL_FIELDS) {
    const n = Number(form[f.key].trim().replace(',', '.'))
    if (form[f.key].trim() === '' || !Number.isFinite(n)) return null
    const v = f.unit === 'mbit' ? Math.round(n * 1000) : n
    if (!Number.isInteger(v)) return null
    out[f.key] = v
  }
  return out as QosSettings
}

export function QosSettingsPage() {
  const query = useQosSettings()
  if (query.data) return <QosSettingsForm view={query.data} />
  if (query.error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-destructive">
          {query.error instanceof ApiError && query.error.status === 403 ? 'Only admins can view this settings page.' : query.error.message}
        </p>
      </div>
    )
  }
  return <PageSpinner label="Loading traffic shaping settings" />
}

function QosSettingsForm({ view }: { view: QosSettingsView }) {
  const update = useUpdateQosSettings()
  const [form, setForm] = useState<FormState>(() => toForm(view.settings))
  const [formError, setFormError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const fieldErrors = update.error ? fieldErrorsFromApi(update.error) : {}
  const defaults = toForm(view.defaults)
  const atDefaults = ALL_FIELDS.every((f) => form[f.key] === defaults[f.key])

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    setSaved(false)
    const payload = toPayload(form)
    if (!payload) {
      setFormError('Enter a number in every field (whole numbers, except the Mbit/s rates).')
      return
    }
    try {
      const next = await update.mutateAsync(payload)
      setForm(toForm(next.settings))
      setSaved(true)
    } catch (error) {
      if (error instanceof ApiError && error.status !== 422) setFormError(error.message)
      else if (!(error instanceof ApiError)) setFormError('Failed to save the traffic shaping settings.')
    }
  }

  return (
    <div className="w-full max-w-3xl">
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Traffic shaping</CardTitle>
          <CardDescription>
            Limits and router memory for speed limits on managed gateways. Caps themselves are set on the{' '}
            <Link to="/shaping" className="underline underline-offset-2">
              Traffic shaping page
            </Link>
            . Changes apply to the next plan sent to the router.
          </CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit}>
          <CardContent className="space-y-6 py-6">
            {formError ? <FormError message={formError} /> : null}
            {saved ? (
              <Alert className="rounded-lg border-primary/20 bg-primary/5">
                <CheckCircle className="size-4 text-primary" />
                <AlertTitle>Saved</AlertTitle>
                <AlertDescription>Traffic shaping settings saved.</AlertDescription>
              </Alert>
            ) : null}
            {SECTIONS.map((section, i) => (
              <section key={section.title} className={formClassName(i > 0 ? 'border-t pt-6' : undefined)}>
                <div className="space-y-1">
                  <h3 className="text-sm font-medium">{section.title}</h3>
                  {section.note ? <p className="text-xs text-muted-foreground">{section.note}</p> : null}
                </div>
                {section.fields.map((f) => {
                  const { min, max } = view.limits[f.key]
                  return (
                    <Field
                      key={f.key}
                      label={f.label}
                      htmlFor={`qos-${f.key}`}
                      hint={`${f.hint} Default ${display(f, view.defaults[f.key])} (${display(f, min)}–${display(f, max)}).`}
                      error={fieldErrors[f.key]}
                    >
                      <Input
                        id={`qos-${f.key}`}
                        inputMode={f.unit === 'mbit' ? 'decimal' : 'numeric'}
                        required
                        value={form[f.key]}
                        onChange={(e) => setForm((cur) => ({ ...cur, [f.key]: e.target.value }))}
                        className="rounded-md"
                      />
                    </Field>
                  )
                })}
              </section>
            ))}
          </CardContent>
          <CardFooter className="flex-wrap justify-end gap-2 border-t bg-muted/20">
            <Button
              type="button"
              variant="outline"
              disabled={update.isPending || atDefaults}
              onClick={() => {
                update.reset()
                setSaved(false)
                setFormError(null)
                setForm(defaults)
              }}
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
