import { useState } from 'react'
import { CheckCircle, Plus, Waves } from '@phosphor-icons/react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ApAgentsSection } from '@/components/wifi/ap-agents-section'
import { WifiSourceCard } from '@/components/wifi/wifi-source-card'
import {
  useCreateWifiSource,
  useProbeWifiSourceDraft,
  useWifiSources,
  type UpsertWifiSourcePayload,
} from '@/hooks/use-wifi'
import { ApiError } from '@/lib/api'

const INITIAL_FORM: UpsertWifiSourcePayload = {
  name: '',
  friendlyName: '',
  metricsUrl: 'http://192.168.1.17:9100/metrics',
  pollIntervalSeconds: 15,
  enabled: true,
  enableTwoWayCommands: false,
  sshHost: '',
  sshPort: 22,
  sshUsername: 'root',
  sshPrivateKey: '',
}

export function WifiSourcesSettingsPage() {
  // Refreshed so an AP that just ran its install command shows up, and agent
  // badges follow connects and disconnects, without reloading the page.
  const sources = useWifiSources({ includeDisabled: true, refreshInterval: 10_000 })
  const create = useCreateWifiSource()
  const probeDraft = useProbeWifiSourceDraft()
  const [form, setForm] = useState<UpsertWifiSourcePayload>(INITIAL_FORM)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onCreate(event: React.FormEvent) {
    event.preventDefault()
    setMessage(null)
    setError(null)
    try {
      await create.mutateAsync({
        ...form,
        friendlyName: form.friendlyName?.trim() || null,
        sshHost: form.sshHost?.trim() || null,
        sshUsername: form.sshUsername?.trim() || null,
        sshPrivateKey: form.sshPrivateKey?.trim() || null,
      })
      setForm(INITIAL_FORM)
      setMessage('WiFi source created.')
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : 'Failed to create WiFi source.'
      setError(message)
    }
  }

  async function onFetchInfo() {
    setMessage(null)
    setError(null)
    const metricsUrl = form.metricsUrl.trim()
    if (!metricsUrl) {
      setError('Enter a metrics URL first.')
      return
    }

    try {
      const { probe, suggestedName } = await probeDraft.mutateAsync({ metricsUrl })
      if (!probe.ok) {
        setError(probe.error ?? 'Could not fetch OpenWrt info from this metrics URL.')
        return
      }

      const shouldPrefillName = form.name.trim().length === 0
      if (suggestedName && shouldPrefillName) {
        setForm((current) => ({ ...current, name: suggestedName }))
      }

      if (suggestedName) {
        setMessage(
          shouldPrefillName
            ? `Fetched OpenWrt info. Name set to "${suggestedName}".`
            : `Fetched OpenWrt info. Detected node name "${suggestedName}".`
        )
      } else {
        setMessage('Fetched OpenWrt info, but no node name was exposed by the exporter.')
      }
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : 'Failed to fetch WiFi source info.'
      setError(message)
    }
  }

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">WiFi sources</h1>
        <p className="text-muted-foreground">
          The access points this dashboard reads WiFi data from: agents that joined with a token,
          and Prometheus endpoints registered by URL.
        </p>
      </div>

      <ApAgentsSection />

      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Add a source by URL</CardTitle>
          <CardDescription>
            Register an OpenWrt Prometheus endpoint (prometheus-node-exporter-lua) that exposes
            WiFi metrics, for APs without the agent.
          </CardDescription>
        </CardHeader>
        <form onSubmit={onCreate}>
          <CardContent className="space-y-4 pt-6">
            {message ? (
              <Alert className="rounded-lg border-primary/20 bg-primary/5">
                <CheckCircle className="size-4 text-primary" />
                <AlertTitle>Success</AlertTitle>
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            ) : null}
            {error ? (
              <Alert className="rounded-lg border-destructive/20 bg-destructive/5">
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">Name</span>
                <Input
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  required
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">Friendly name</span>
                <Input
                  value={form.friendlyName ?? ''}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, friendlyName: event.target.value }))
                  }
                />
              </label>
              <label className="space-y-1 md:col-span-2">
                <span className="text-xs text-muted-foreground">Metrics URL</span>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={form.metricsUrl}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, metricsUrl: event.target.value }))
                    }
                    required
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={probeDraft.isPending || !form.metricsUrl.trim()}
                    onClick={onFetchInfo}
                    className="sm:w-auto"
                  >
                    <Waves className="size-3.5" />
                    {probeDraft.isPending ? 'Fetching…' : 'Fetch info'}
                  </Button>
                </div>
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">Poll interval (seconds)</span>
                <Input
                  type="number"
                  min={5}
                  max={3600}
                  value={form.pollIntervalSeconds ?? 15}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      pollIntervalSeconds: Number(event.target.value),
                    }))
                  }
                  required
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">Enable source</span>
                <div className="flex h-8 items-center rounded-md border px-3">
                  <Switch
                    checked={form.enabled ?? true}
                    onCheckedChange={(next) => setForm((current) => ({ ...current, enabled: next }))}
                  />
                </div>
              </label>
              <label className="space-y-1 md:col-span-2">
                <span className="text-xs text-muted-foreground">Enable two-way commands (SSH)</span>
                <div className="flex h-8 items-center rounded-md border px-3">
                  <Switch
                    checked={form.enableTwoWayCommands ?? false}
                    onCheckedChange={(next) =>
                      setForm((current) => ({ ...current, enableTwoWayCommands: next }))
                    }
                  />
                </div>
              </label>
              {form.enableTwoWayCommands ? (
                <>
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">SSH host</span>
                    <Input
                      value={form.sshHost ?? ''}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, sshHost: event.target.value }))
                      }
                      className="font-mono"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">SSH port</span>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={form.sshPort ?? 22}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, sshPort: Number(event.target.value) }))
                      }
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">SSH username</span>
                    <Input
                      value={form.sshUsername ?? ''}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, sshUsername: event.target.value }))
                      }
                      className="font-mono"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">SSH private key path</span>
                    <Input
                      value={form.sshPrivateKey ?? ''}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, sshPrivateKey: event.target.value }))
                      }
                      className="font-mono"
                    />
                  </label>
                </>
              ) : null}
            </div>
          </CardContent>
          <CardFooter className="justify-end gap-2 border-t bg-muted/20">
            <Button type="submit" disabled={create.isPending}>
              <Plus className="size-3.5" />
              {create.isPending ? 'Adding…' : 'Add source'}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Registered sources</h2>
        {sources.isPending ? (
          <p className="text-sm text-muted-foreground">Loading WiFi sources…</p>
        ) : sources.error && !sources.data ? (
          <p className="text-sm text-destructive">{sources.error.message}</p>
        ) : (
          <>
            {/* A failed background refresh keeps the last list on screen. */}
            {sources.error ? (
              <p className="text-xs text-destructive">Refresh failed: {sources.error.message}</p>
            ) : null}
            {(sources.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No sources yet. Create a join token above, or add one by URL.
              </p>
            ) : (
              <div className="grid gap-3">
                {(sources.data ?? []).map((source) => (
                  <WifiSourceCard key={source.id} source={source} />
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
