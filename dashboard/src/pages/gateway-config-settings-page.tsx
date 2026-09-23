import { useState } from 'react'
import { CheckCircle } from '@phosphor-icons/react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { PageSpinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useGatewayConfigSettings, useUpdateGatewayConfigSettings } from '@/hooks/use-gateways'
import { ApiError, fieldErrorsFromApi } from '@/lib/api'
import type {
  ConfirmMode,
  GatewayConfigNumericKey,
  GatewayConfigSettings,
  GatewayConfigSettingsView,
} from '@/types/gateway-config'

type Group = { title: string; description: string; fields: Array<{ key: GatewayConfigNumericKey; label: string; unit: string; hint: string }> }

const GROUPS: Group[] = [
  {
    title: 'Applying changes',
    description: 'How long the router waits for a confirmation before it restores the previous configuration.',
    fields: [
      { key: 'confirmTimeoutSeconds', label: 'Confirm window', unit: 's', hint: 'Capped again by the router’s own maximum.' },
      {
        key: 'managementConfirmTimeoutSeconds',
        label: 'Confirm window, management path',
        unit: 's',
        hint: 'Changes to the network Perch reaches the router through get their own, longer window (the router allows no less than 5 minutes).',
      },
      { key: 'queueExpiryHours', label: 'Queued change expires after', unit: 'h', hint: 'A change waiting for an offline gateway.' },
    ],
  },
  {
    title: 'Watching the router',
    description: 'How quickly router edits reach Perch.',
    fields: [
      { key: 'watchSeconds', label: 'Check for edits every', unit: 's', hint: 'The fallback poll; LuCI and uci edits usually arrive at once.' },
      { key: 'importDebounceSeconds', label: 'Wait for edits to settle', unit: 's', hint: 'Several quick edits import as one.' },
    ],
  },
  {
    title: 'Authoritative Mode',
    description: 'What happens to router edits when Perch’s configuration wins.',
    fields: [
      { key: 'authoritativeRevertDelaySeconds', label: 'Revert router edits after', unit: 's', hint: 'The grace delay: time to accept an edit instead.' },
      { key: 'enforcementMaxFailures', label: 'Suspend after failed reverts', unit: '', hint: 'Within the window below.' },
      { key: 'enforcementWindowMinutes', label: 'Failure window', unit: 'min', hint: '' },
    ],
  },
  {
    title: 'History',
    description: 'How much Perch keeps.',
    fields: [
      { key: 'keepRevisions', label: 'Revisions per gateway', unit: '', hint: 'The newest one confirmed working is always kept.' },
      { key: 'auditRetentionDays', label: 'Keep activity for', unit: 'days', hint: '' },
    ],
  },
  {
    title: 'Local state on the gateway',
    description: 'Where the collector keeps state that must survive a reboot, and how often it writes it.',
    fields: [
      { key: 'localStateFlushSecondsFlash', label: 'Snapshot interval on flash', unit: 's', hint: 'SPI or NAND flash wears out: batch writes.' },
      { key: 'localStateFlushSecondsDisk', label: 'Snapshot interval on disks', unit: 's', hint: 'eMMC, USB, SATA; 0 = write through.' },
    ],
  },
]

type FormState = Record<GatewayConfigNumericKey, string> & {
  confirmMode: ConfirmMode
  allowInsecureTransport: boolean
  localStatePath: string
}

function toForm(s: GatewayConfigSettings): FormState {
  const form = { confirmMode: s.confirmMode, allowInsecureTransport: s.allowInsecureTransport, localStatePath: s.localStatePath } as FormState
  for (const g of GROUPS) for (const f of g.fields) form[f.key] = String(s[f.key])
  return form
}

/** Settings → Gateway config (config-plane.md section 11). */
export function GatewayConfigSettingsPage() {
  const query = useGatewayConfigSettings()
  if (query.data) return <SettingsForm view={query.data} />
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
  return <PageSpinner label="Loading gateway settings" />
}

function SettingsForm({ view }: { view: GatewayConfigSettingsView }) {
  const update = useUpdateGatewayConfigSettings()
  const [form, setForm] = useState<FormState>(() => toForm(view.settings))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const fieldErrors = update.error ? fieldErrorsFromApi(update.error) : {}

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSaved(false)
    const payload: Partial<GatewayConfigSettings> = {
      confirmMode: form.confirmMode,
      allowInsecureTransport: form.allowInsecureTransport,
      localStatePath: form.localStatePath.trim(),
    }
    for (const g of GROUPS) {
      for (const f of g.fields) {
        const n = Number(form[f.key])
        if (form[f.key].trim() === '' || !Number.isInteger(n)) {
          setError('Enter a whole number in every field.')
          return
        }
        ;(payload as Record<string, number>)[f.key] = n
      }
    }
    try {
      const next = await update.mutateAsync(payload)
      setForm(toForm(next.settings))
      setSaved(true)
    } catch (e) {
      if (e instanceof ApiError && e.status !== 422) setError(e.message)
    }
  }

  return (
    <div className="w-full max-w-3xl">
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Gateway configuration</CardTitle>
          <CardDescription>
            How Perch applies changes to managed gateways, watches router edits and enforces Authoritative Mode. Online
            gateways pick up changes right away.
          </CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit}>
          <CardContent className={formClassName('space-y-6 pt-6')}>
            {error ? <FormError message={error} /> : null}

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Confirming a change</h3>
              <Segmented
                size="xs"
                ariaLabel="Confirm mode"
                value={form.confirmMode}
                onChange={(v) => setForm((f) => ({ ...f, confirmMode: v }))}
                options={[
                  { id: 'admin_and_agent', label: 'Agent + Keep changes' },
                  { id: 'agent', label: 'Agent only' },
                ]}
              />
              <p className="text-xs text-muted-foreground">
                {form.confirmMode === 'admin_and_agent'
                  ? 'Like LuCI: after the agent reconnects, an admin presses Keep changes. Queued changes and Authoritative reverts always confirm on the agent alone.'
                  : 'A change is kept as soon as the agent reconnects on a fresh connection and checks in.'}
              </p>
            </section>

            {GROUPS.map((group) => (
              <section key={group.title} className="space-y-3">
                <div>
                  <h3 className="text-sm font-medium">{group.title}</h3>
                  <p className="text-xs text-muted-foreground">{group.description}</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {group.fields.map((f) => {
                    const limit = view.limits[f.key]
                    return (
                      <Field
                        key={f.key}
                        label={`${f.label}${f.unit ? ` (${f.unit})` : ''}`}
                        htmlFor={f.key}
                        hint={`${f.hint ? `${f.hint} ` : ''}${limit.min}–${limit.max}, default ${view.defaults[f.key]}.`}
                        error={fieldErrors[f.key]}
                      >
                        <Input
                          id={f.key}
                          inputMode="numeric"
                          value={form[f.key]}
                          onChange={(e) => setForm((cur) => ({ ...cur, [f.key]: e.target.value }))}
                        />
                      </Field>
                    )
                  })}
                  {group.title === 'Local state on the gateway' ? (
                    <Field
                      label="State path on the router"
                      htmlFor="localStatePath"
                      hint={`An absolute path; default ${view.defaults.localStatePath}.`}
                      error={fieldErrors.localStatePath}
                    >
                      <Input
                        id="localStatePath"
                        className="font-mono"
                        value={form.localStatePath}
                        onChange={(e) => setForm((cur) => ({ ...cur, localStatePath: e.target.value }))}
                      />
                    </Field>
                  ) : null}
                </div>
              </section>
            ))}

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Writes over plain HTTP</h3>
              <label className="flex items-start gap-3 text-xs">
                <Switch
                  checked={form.allowInsecureTransport}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, allowInsecureTransport: v }))}
                  aria-label="Allow writes over plain HTTP"
                />
                <span>
                  <span className="block font-medium">Allow writes over plain HTTP</span>
                  <span className="text-muted-foreground">
                    The controller’s half of the opt-in. A gateway also needs <code className="font-mono">config_allow_insecure</code>{' '}
                    on the router and a pairing; writes are then signed. Signing protects integrity, not confidentiality:
                    keep such gateways on a management VLAN.
                  </span>
                </span>
              </label>
            </section>

            {saved ? (
              <Alert className="rounded-lg">
                <CheckCircle className="size-4" />
                <AlertTitle>Saved</AlertTitle>
                <AlertDescription>Gateway settings saved.</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={() => setForm(toForm(view.defaults))}>
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
