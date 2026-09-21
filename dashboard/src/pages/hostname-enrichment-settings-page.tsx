import { useMemo, useState } from 'react'
import { CheckCircle, WarningCircle } from '@phosphor-icons/react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  fieldErrorsFromApi,
  useHostnameEnrichmentSettings,
  useUpdateHostnameEnrichmentSettings,
} from '@/hooks/use-settings'
import { ApiError } from '@/lib/api'
import {
  HOSTNAME_ENRICHMENT_MODE,
  type HostnameEnrichmentSettings,
  type HostnameEnrichmentTransport,
} from '@/types/settings'

type FormState = {
  enabled: boolean
  transport: HostnameEnrichmentTransport
  leaseFilePath: string
  refreshSeconds: string
  timeoutMs: string
  lxcContainerName: string
  sshHost: string
  sshPort: string
  sshUsername: string
  sshPrivateKeyPath: string
}

function toFormState(settings: HostnameEnrichmentSettings): FormState {
  return {
    enabled: settings.enabled,
    transport: settings.transport,
    leaseFilePath: settings.leaseFilePath,
    refreshSeconds: String(settings.refreshSeconds),
    timeoutMs: String(settings.timeoutMs),
    lxcContainerName: settings.transport === 'lxc' ? settings.lxc.containerName : 'openwrt',
    sshHost: settings.transport === 'ssh' ? settings.ssh.host : '192.168.0.1',
    sshPort: settings.transport === 'ssh' ? String(settings.ssh.port) : '22',
    sshUsername: settings.transport === 'ssh' ? settings.ssh.username : 'root',
    sshPrivateKeyPath: settings.transport === 'ssh' ? (settings.ssh.privateKeyPath ?? '') : '',
  }
}

function parseIntegerOr(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : fallback
}

function toPayload(form: FormState): HostnameEnrichmentSettings {
  const shared = {
    enabled: form.enabled,
    mode: HOSTNAME_ENRICHMENT_MODE,
    transport: form.transport,
    leaseFilePath: form.leaseFilePath.trim() || '/tmp/dhcp.leases',
    refreshSeconds: parseIntegerOr(form.refreshSeconds, 0),
    timeoutMs: parseIntegerOr(form.timeoutMs, 0),
  } as const

  if (form.transport === 'lxc') {
    return {
      ...shared,
      transport: 'lxc',
      lxc: {
        containerName: form.lxcContainerName.trim(),
      },
    }
  }

  return {
    ...shared,
    transport: 'ssh',
    ssh: {
      host: form.sshHost.trim(),
      port: parseIntegerOr(form.sshPort, 0),
      username: form.sshUsername.trim(),
      privateKeyPath: form.sshPrivateKeyPath.trim() || undefined,
    },
  }
}

export function HostnameEnrichmentSettingsPage() {
  const query = useHostnameEnrichmentSettings()
  if (query.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading hostname enrichment settings…</p>
      </div>
    )
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

  if (!query.data) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading hostname enrichment settings…</p>
      </div>
    )
  }

  return <HostnameEnrichmentSettingsForm initialSettings={query.data} />
}

function HostnameEnrichmentSettingsForm({
  initialSettings,
}: {
  initialSettings: HostnameEnrichmentSettings
}) {
  const update = useUpdateHostnameEnrichmentSettings()
  const [form, setForm] = useState<FormState>(() => toFormState(initialSettings))
  const [formError, setFormError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const fieldErrors = update.error ? fieldErrorsFromApi(update.error) : {}

  const commandPreview = useMemo(() => {
    const leaseFilePath = form.leaseFilePath.trim() || '/tmp/dhcp.leases'

    if (form.transport === 'lxc') {
      const container = form.lxcContainerName.trim() || 'openwrt'
      return `lxc exec ${container} -- cat ${leaseFilePath}`
    }

    const host = form.sshHost.trim() || '<host>'
    const username = form.sshUsername.trim() || '<user>'
    const port = form.sshPort.trim() || '22'
    return `ssh -p ${port} ${username}@${host} cat ${leaseFilePath}`
  }, [form])

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    setSuccessMessage(null)

    try {
      const saved = await update.mutateAsync(toPayload(form))
      setForm(toFormState(saved))
      setSuccessMessage('Hostname enrichment settings saved.')
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 403) {
          setFormError('Only admins can update hostname enrichment settings.')
        } else if (error.status !== 422) {
          setFormError(error.message)
        }
      }
    }
  }

  return (
    <div className="w-full max-w-3xl">
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Hostname enrichment</CardTitle>
          <CardDescription>
            Configure how Perch resolves MAC addresses to hostnames from DHCP leases and OpenWrt static host mappings.
          </CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit}>
          <CardContent className="space-y-4 pt-6">
            {formError ? <FormError message={formError} /> : null}
            {successMessage ? (
              <Alert className="rounded-lg border-primary/20 bg-primary/5">
                <CheckCircle className="size-4 text-primary" />
                <AlertTitle>Saved</AlertTitle>
                <AlertDescription>{successMessage}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Enable hostname enrichment</p>
                <p className="text-xs text-muted-foreground">
                  Runs command-based hostname lookups on your configured schedule.
                </p>
                {fieldErrors.enabled ? (
                  <p className="text-xs text-destructive">{fieldErrors.enabled}</p>
                ) : null}
              </div>
              <Switch
                id="hostnameEnrichmentEnabled"
                checked={form.enabled}
                onCheckedChange={(next) => setForm((current) => ({ ...current, enabled: next }))}
              />
            </div>

            <div className={formClassName()}>
              <Field label="Mode" htmlFor="hostnameMode">
                <Input
                  id="hostnameMode"
                  value="Command execution"
                  readOnly
                  className="rounded-md bg-muted/30 text-muted-foreground"
                />
              </Field>

              <Field label="Transport" htmlFor="transport" error={fieldErrors.transport}>
                <select
                  id="transport"
                  value={form.transport}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      transport: event.target.value as HostnameEnrichmentTransport,
                    }))
                  }
                  className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
                >
                  <option value="lxc">LXC command execution</option>
                  <option value="ssh">SSH command execution</option>
                </select>
              </Field>

              <Field
                label="Lease file path"
                htmlFor="leaseFilePath"
                hint="Default OpenWrt dnsmasq lease file."
                error={fieldErrors.leaseFilePath}
              >
                <Input
                  id="leaseFilePath"
                  value={form.leaseFilePath}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, leaseFilePath: event.target.value }))
                  }
                  className="rounded-md font-mono"
                />
              </Field>

              <Field
                label="Refresh interval (seconds)"
                htmlFor="refreshSeconds"
                hint="How often to refresh hostname mappings (5-3600)."
                error={fieldErrors.refreshSeconds}
              >
                <Input
                  id="refreshSeconds"
                  type="number"
                  min={5}
                  max={3600}
                  value={form.refreshSeconds}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, refreshSeconds: event.target.value }))
                  }
                  className="rounded-md"
                />
              </Field>

              <Field
                label="Command timeout (ms)"
                htmlFor="timeoutMs"
                hint="Maximum command execution time before timeout (500-15000)."
                error={fieldErrors.timeoutMs}
              >
                <Input
                  id="timeoutMs"
                  type="number"
                  min={500}
                  max={15000}
                  value={form.timeoutMs}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, timeoutMs: event.target.value }))
                  }
                  className="rounded-md"
                />
              </Field>

              {form.transport === 'lxc' ? (
                <Field
                  label="LXC container name"
                  htmlFor="lxcContainerName"
                  hint="Example: openwrt"
                  error={fieldErrors['lxc.containerName'] || fieldErrors.lxc}
                >
                  <Input
                    id="lxcContainerName"
                    value={form.lxcContainerName}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, lxcContainerName: event.target.value }))
                    }
                    className="rounded-md font-mono"
                  />
                </Field>
              ) : (
                <>
                  <Field label="SSH host" htmlFor="sshHost" error={fieldErrors['ssh.host']}>
                    <Input
                      id="sshHost"
                      value={form.sshHost}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, sshHost: event.target.value }))
                      }
                      className="rounded-md font-mono"
                    />
                  </Field>
                  <Field label="SSH port" htmlFor="sshPort" error={fieldErrors['ssh.port']}>
                    <Input
                      id="sshPort"
                      type="number"
                      min={1}
                      max={65535}
                      value={form.sshPort}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, sshPort: event.target.value }))
                      }
                      className="rounded-md"
                    />
                  </Field>
                  <Field label="SSH username" htmlFor="sshUsername" error={fieldErrors['ssh.username']}>
                    <Input
                      id="sshUsername"
                      value={form.sshUsername}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, sshUsername: event.target.value }))
                      }
                      className="rounded-md font-mono"
                    />
                  </Field>
                  <Field
                    label="Private key path"
                    htmlFor="sshPrivateKeyPath"
                    hint="Optional path on the metrics-be host."
                    error={fieldErrors['ssh.privateKeyPath']}
                  >
                    <Input
                      id="sshPrivateKeyPath"
                      value={form.sshPrivateKeyPath}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          sshPrivateKeyPath: event.target.value,
                        }))
                      }
                      className="rounded-md font-mono"
                    />
                  </Field>
                </>
              )}
            </div>

            <Alert className="rounded-lg border-border bg-muted/20">
              <WarningCircle className="size-4" />
              <AlertTitle>Command preview</AlertTitle>
              <AlertDescription>
                <p className="mb-2">
                  Metrics also attempts <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs">uci show dhcp</code>{' '}
                  to pick up static host mappings.
                </p>
                <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs">
                  {commandPreview}
                </code>
              </AlertDescription>
            </Alert>
          </CardContent>
          <CardFooter className="justify-end gap-2 border-t bg-muted/20">
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save settings'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
