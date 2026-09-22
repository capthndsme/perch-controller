import { useState } from 'react'
import {
  ArrowsClockwise,
  Broadcast,
  CaretDown,
  CaretRight,
  CheckCircle,
  Globe,
  HardDrives,
  PencilSimple,
  Plus,
  PlugsConnected,
  Prohibit,
  Trash,
  WarningCircle,
  Waves,
} from '@phosphor-icons/react'
import { UnencryptedBadge } from '@/components/security/plain-http'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  useAdoptCollector,
  useCollectorDiscovery,
  useCollectors,
  useCreateCollector,
  useDeleteCollector,
  useDismissCollector,
  useProbeCollector,
  useProbeCollectorDraft,
  useUpdateCollector,
  useUpdateCollectorDiscovery,
  type AdoptCollectorPayload,
  type UpsertCollectorPayload,
} from '@/hooks/use-collectors'
import { ApiError, apiErrorCode, fieldErrorsFromApi } from '@/lib/api'
import { collectorUnencryptedReason } from '@/lib/transport-security'
import { Fact } from '@/components/collectors/fact'
import {
  announcedAddressDiffers,
  COLLECTOR_KEY_FINGERPRINT_COMMAND,
  collectorAddressLine,
  collectorConnectionLine,
  collectorFailureNote,
  collectorGatewayLabel,
  collectorHealth,
  collectorHealthDotClass,
  collectorHealthLabel,
  collectorIntervalLabel,
  collectorLifecycleLabel,
  collectorProbeSummary,
  collectorPurgeCommand,
  collectorSourceHint,
  collectorSourceLabel,
  collectorTransportHint,
  collectorTransportLabel,
  formatKeyFingerprint,
  formatLastSeen,
  type CollectorHealth,
} from '@/lib/collectors'
import { wanSourceHint } from '@/lib/gateway'
import type { Collector, CollectorGatewayReport, CollectorTransport } from '@/types/api'

const DEFAULT_POLL_INTERVAL_SECONDS = 5
const MIN_POLL_INTERVAL_SECONDS = 5
const MAX_POLL_INTERVAL_SECONDS = 3600

type HistoryCounts = { bucketRows: number; identityRows: number }

/** Counts carried by a `409 collector_has_history` (identities may exist with zero buckets). */
function historyFromError(error: unknown): HistoryCounts | null {
  if (!(error instanceof ApiError)) return null
  const body = error.body
  if (typeof body !== 'object' || body === null) return null
  const { bucketRows, identityRows } = body as { bucketRows?: unknown; identityRows?: unknown }
  if (typeof bucketRows !== 'number') return null
  return { bucketRows, identityRows: typeof identityRows === 'number' ? identityRows : 0 }
}

/** True for a plain Vine validation failure, whose messages render per field. */
function isFieldValidationError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 422 && apiErrorCode(error) === null
}

function actionErrorMessage(error: unknown, fallback: string): string {
  const code = apiErrorCode(error)
  if (code === 'collector_not_found') return 'This collector no longer exists.'
  if (code === 'collector_not_pending') return 'This collector has already been adopted.'
  if (code === 'collector_base_url_in_use') {
    return 'Another collector is already registered at that address.'
  }
  if (error instanceof ApiError) {
    if (error.status === 403) return 'Only admins can manage collectors.'
    return error.message
  }
  return fallback
}

function parsePollInterval(value: string): number | null {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return null
  if (parsed < MIN_POLL_INTERVAL_SECONDS || parsed > MAX_POLL_INTERVAL_SECONDS) return null
  return parsed
}

const POLL_INTERVAL_ERROR = `Poll interval must be between ${MIN_POLL_INTERVAL_SECONDS} and ${MAX_POLL_INTERVAL_SECONDS} seconds.`

function HealthBadge({ health }: { health: CollectorHealth }) {
  return (
    <Badge variant="outline">
      <span
        aria-hidden
        className={`mr-1 inline-block size-2 rounded-full ${collectorHealthDotClass(health)}`}
      />
      {collectorHealthLabel(health)}
    </Badge>
  )
}

/** Socket (it dials in and pushes) or Polled (we fetch from its HTTP API). */
function TransportBadge({ transport }: { transport: CollectorTransport }) {
  const Icon = transport === 'agent' ? PlugsConnected : ArrowsClockwise
  return (
    <Badge variant="outline" title={collectorTransportHint(transport)}>
      <Icon aria-hidden className="size-3" />
      {collectorTransportLabel(transport)}
    </Badge>
  )
}

/** Plain HTTP between this collector and the controller, if it is. */
function CollectorUnencryptedBadge({ collector }: { collector: Collector }) {
  const reason = collectorUnencryptedReason(collector)
  if (reason === null) return null
  return (
    <UnencryptedBadge
      title={
        reason === 'poll'
          ? 'Polled over plain HTTP: keep the controller and this collector on a management VLAN.'
          : 'Plain HTTP: keep the controller and this collector on a management VLAN.'
      }
    />
  )
}

/** This collector runs on the router and reports its gateway stats. */
function GatewayBadge({ gateway }: { gateway: CollectorGatewayReport }) {
  const hint = wanSourceHint(gateway.wanSource)
  return (
    <Badge
      variant="outline"
      title={`Reports the router's conntrack, WAN rate and load${hint ? `; WAN interfaces ${hint}` : ''}. Last report ${formatLastSeen(gateway.reportedAt)}.`}
    >
      <Globe aria-hidden className="size-3" />
      {collectorGatewayLabel(gateway)}
    </Badge>
  )
}

/**
 * The card's subtitle: a socket collector's session (online dot + "Connected
 * from 192.168.1.1 for 12 min"), a polled collector's address.
 */
function CollectorSubtitle({ collector }: { collector: Collector }) {
  if (collector.transport !== 'agent') {
    return (
      <CardDescription className="font-mono text-[11px]">{collectorAddressLine(collector)}</CardDescription>
    )
  }
  const online = collector.connection?.online ?? false
  // A dismissed collector is expected to be gone; red would read as a fault.
  const dot =
    collector.lifecycle === 'dismissed'
      ? 'bg-muted-foreground/50'
      : online
        ? 'bg-status-good'
        : 'bg-status-critical'
  return (
    <CardDescription className="flex items-center gap-1.5 text-[11px]">
      <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${dot}`} />
      <span className={online ? 'text-foreground' : undefined}>
        {collectorConnectionLine(collector.connection, collector.lastSeenAt)}
      </span>
    </CardDescription>
  )
}

/**
 * `409 collector_has_history`: the API refuses to cascade a delete across the
 * thirteen bucket tables. Name the safe action and the deliberate one.
 */
function HistoryBlockedAlert({
  collector,
  rows,
  disabling,
  onDisable,
  onClose,
}: {
  collector: Collector
  rows: HistoryCounts | null
  disabling?: boolean
  onDisable?: () => void
  onClose: () => void
}) {
  return (
    <Alert className="rounded-lg border-destructive/20 bg-destructive/5">
      <WarningCircle className="size-4 text-destructive" />
      <AlertTitle>This collector has recorded traffic</AlertTitle>
      <AlertDescription>
        <p>
          {rows !== null
            ? `${rows.bucketRows.toLocaleString()} traffic rows and ${rows.identityRows.toLocaleString()} device identities still belong to ${collector.name}.`
            : `Traffic rows still belong to ${collector.name}.`}{' '}
          Deleting the collector would destroy them, so the API refused.
          {onDisable ? ' Disable it to stop collecting and keep every chart it has filled.' : ''}
        </p>
        <p>
          To purge it deliberately, run{' '}
          <code className="font-mono">{collectorPurgeCommand(collector.id)}</code> on the server.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {onDisable ? (
            <Button type="button" size="xs" disabled={disabling} onClick={onDisable}>
              Disable instead
            </Button>
          ) : null}
          <Button type="button" size="xs" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

/**
 * Section 2.4's announce feature switch. It is the only control here that is
 * not about one collector, so it sits above the list.
 */
function DiscoverySettingsRow() {
  const discovery = useCollectorDiscovery()
  const update = useUpdateCollectorDiscovery()
  const [error, setError] = useState<string | null>(null)

  const announceEnabled = discovery.data?.announceEnabled ?? false
  const unavailable = Boolean(discovery.error)

  async function onToggle(next: boolean) {
    setError(null)
    try {
      await update.mutateAsync({ announceEnabled: next })
    } catch (cause) {
      setError(actionErrorMessage(cause, 'Failed to change collector discovery.'))
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div className="max-w-2xl space-y-1">
        <p className="text-sm font-medium">Collector discovery</p>
        <p className="text-xs text-muted-foreground">
          Lets a collector that knows this controller's URL introduce itself, over its socket or an
          announce, so it turns up under Pending adoption instead of being typed in by hand.
          Adoption is always manual — no data is taken and no key is used until you adopt it.
        </p>
        <p className="text-xs text-muted-foreground">
          When off, announces and socket connections from collectors that are not adopted are
          refused (403) and no new pending rows appear. Collectors you have already adopted keep
          reporting either way.
        </p>
        {unavailable ? (
          <p className="text-xs text-muted-foreground">
            This setting could not be read, so the switch is unavailable.
          </p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
      <Switch
        id="collector-discovery"
        aria-label="Let collectors announce themselves"
        checked={announceEnabled}
        disabled={discovery.isPending || unavailable || update.isPending}
        onCheckedChange={(next) => void onToggle(next)}
      />
    </div>
  )
}

export function CollectorsSettingsPage() {
  const collectors = useCollectors({ includeDismissed: true })
  const [showDismissed, setShowDismissed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const rows = collectors.data ?? []
  const pending = rows.filter((row) => row.lifecycle === 'pending')
  const registered = rows.filter((row) => row.lifecycle === 'adopted')
  const dismissed = rows.filter((row) => row.lifecycle === 'dismissed')

  /**
   * A failed poll must not take the page away: the list we already have is
   * still true, and an open form may be holding typed input. Show the failure,
   * keep the content.
   */
  const loadError = collectors.error
    ? collectors.error instanceof ApiError && collectors.error.status === 403
      ? 'Only admins can manage collectors.'
      : collectors.error.message
    : null

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Collectors</h1>
        <p className="text-muted-foreground">
          Every device, protocol and byte on this dashboard comes from a collector (Perch Network
          Collector). Adopt the ones that connect or announce themselves, register polled ones by
          address, and check their health.
        </p>
      </div>

      {loadError ? (
        <Alert className="rounded-lg border-destructive/20 bg-destructive/5">
          <WarningCircle className="size-4 text-destructive" />
          <AlertTitle>
            {collectors.data ? 'This list may be out of date' : 'Could not load collectors'}
          </AlertTitle>
          <AlertDescription>
            {loadError}
            {collectors.data
              ? ' Showing the last list that loaded; it refreshes on the next poll.'
              : ''}
          </AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert className="rounded-lg border-primary/20 bg-primary/5">
          <CheckCircle className="size-4 text-primary" />
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <DiscoverySettingsRow />

      {pending.length > 0 ? (
        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">Pending adoption</h2>
            <p className="text-xs text-muted-foreground">
              These collectors introduced themselves to this controller. No data is taken and no
              key is used until you adopt one.
            </p>
          </div>
          <div className="grid gap-3">
            {pending.map((collector) => (
              <PendingCollectorCard
                key={collector.id}
                collector={collector}
                onNotice={setNotice}
              />
            ))}
          </div>
        </section>
      ) : null}

      <AddCollectorCard />

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Registered collectors</h2>
        {collectors.isPending ? (
          <p className="text-sm text-muted-foreground">Loading collectors…</p>
        ) : registered.length > 0 ? (
          <div className="grid gap-3">
            {registered.map((collector) => (
              <RegisteredCollectorCard
                key={collector.id}
                collector={collector}
                onNotice={setNotice}
              />
            ))}
          </div>
        ) : loadError ? null : (
          <EmptyState
            title="No collectors registered"
            description="Add a polled one above, or set this controller's URL as server_url on a Perch Network Collector: it connects and shows up under Pending adoption."
            icon={<HardDrives className="size-5" />}
          />
        )}
      </section>

      {dismissed.length > 0 ? (
        <section className="space-y-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit px-1 text-muted-foreground"
            aria-expanded={showDismissed}
            aria-controls="collectors-dismissed-list"
            onClick={() => setShowDismissed((current) => !current)}
          >
            {showDismissed ? <CaretDown className="size-3.5" /> : <CaretRight className="size-3.5" />}
            Dismissed ({dismissed.length})
          </Button>
          {showDismissed ? (
            <div id="collectors-dismissed-list" className="grid gap-3">
              {dismissed.map((collector) => (
                <DismissedCollectorCard
                  key={collector.id}
                  collector={collector}
                  onNotice={setNotice}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

type CreateFormState = {
  name: string
  baseUrl: string
  apiKey: string
  pollIntervalSeconds: string
  enabled: boolean
}

const INITIAL_CREATE_FORM: CreateFormState = {
  name: '',
  baseUrl: 'http://127.0.0.1:9800',
  apiKey: '',
  pollIntervalSeconds: String(DEFAULT_POLL_INTERVAL_SECONDS),
  enabled: true,
}

function AddCollectorCard() {
  const create = useCreateCollector()
  const probeDraft = useProbeCollectorDraft()
  const [form, setForm] = useState<CreateFormState>(INITIAL_CREATE_FORM)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fieldErrors = create.error ? fieldErrorsFromApi(create.error) : {}

  async function onTest() {
    setMessage(null)
    setError(null)

    const baseUrl = form.baseUrl.trim()
    if (!baseUrl) {
      setError('Enter a collector address first.')
      return
    }

    try {
      const apiKey = form.apiKey.trim()
      const { probe, suggestedName } = await probeDraft.mutateAsync({
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
      })

      if (!probe.ok) {
        setError(probe.error ?? 'The collector did not answer.')
        return
      }

      const shouldPrefillName = form.name.trim().length === 0
      if (suggestedName && shouldPrefillName) {
        setForm((current) => ({ ...current, name: suggestedName }))
      }

      const detail = collectorProbeSummary(probe)
      setMessage(
        suggestedName && shouldPrefillName
          ? `Collector answered (${detail}). Name set to “${suggestedName}”.`
          : `Collector answered (${detail}).`
      )
    } catch (cause) {
      setError(actionErrorMessage(cause, 'Failed to reach the collector.'))
    }
  }

  async function onCreate(event: React.FormEvent) {
    event.preventDefault()
    setMessage(null)
    setError(null)

    const pollIntervalSeconds = parsePollInterval(form.pollIntervalSeconds)
    if (pollIntervalSeconds === null) {
      setError(POLL_INTERVAL_ERROR)
      return
    }

    const payload: UpsertCollectorPayload = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      pollIntervalSeconds,
      enabled: form.enabled,
    }
    const apiKey = form.apiKey.trim()
    if (apiKey) payload.apiKey = apiKey

    try {
      const result = await create.mutateAsync(payload)
      setForm(INITIAL_CREATE_FORM)
      const detail = collectorProbeSummary(result.probe)
      setMessage(
        result.probe && !result.probe.ok
          ? `Added ${result.collector.name}, but the probe failed: ${detail}`
          : `Added ${result.collector.name} (${detail ?? 'not probed'}).`
      )
    } catch (cause) {
      if (isFieldValidationError(cause)) return
      setError(actionErrorMessage(cause, 'Failed to add the collector.'))
    }
  }

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="border-b">
        <CardTitle className="text-lg">Add a collector</CardTitle>
        <CardDescription>
          Point the controller at a collector's HTTP API to poll it. It is probed once before it is
          saved, and a failed probe still saves the collector. Collectors that connect on their own
          appear under Pending adoption instead.
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
          {error ? <FormError message={error} /> : null}

          <div className={formClassName('grid gap-4 sm:grid-cols-2 space-y-0')}>
            <Field label="Name" htmlFor="collector-name" error={fieldErrors.name}>
              <Input
                id="collector-name"
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="e.g. mirror-box"
                required
              />
            </Field>

            <Field
              label="Poll interval (seconds)"
              htmlFor="collector-poll-interval"
              error={fieldErrors.pollIntervalSeconds}
            >
              <Input
                id="collector-poll-interval"
                type="number"
                min={MIN_POLL_INTERVAL_SECONDS}
                max={MAX_POLL_INTERVAL_SECONDS}
                value={form.pollIntervalSeconds}
                onChange={(event) =>
                  setForm((current) => ({ ...current, pollIntervalSeconds: event.target.value }))
                }
                required
              />
            </Field>

            <div className="sm:col-span-2">
              <Field label="Address" htmlFor="collector-base-url" error={fieldErrors.baseUrl}>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="collector-base-url"
                    value={form.baseUrl}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, baseUrl: event.target.value }))
                    }
                    required
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={probeDraft.isPending || !form.baseUrl.trim()}
                    onClick={onTest}
                    className="sm:w-auto"
                  >
                    <Waves className="size-3.5" />
                    {probeDraft.isPending ? 'Testing…' : 'Test'}
                  </Button>
                </div>
              </Field>
            </div>

            <Field
              label="API key"
              htmlFor="collector-api-key"
              hint="Optional — only if the collector has api_key configured."
              error={fieldErrors.apiKey}
            >
              <Input
                id="collector-api-key"
                type="password"
                autoComplete="new-password"
                value={form.apiKey}
                onChange={(event) =>
                  setForm((current) => ({ ...current, apiKey: event.target.value }))
                }
              />
            </Field>

            <Field label="Enable polling" htmlFor="collector-enabled">
              <div className="flex h-8 items-center rounded-md border px-3">
                <Switch
                  id="collector-enabled"
                  checked={form.enabled}
                  onCheckedChange={(next) => setForm((current) => ({ ...current, enabled: next }))}
                />
              </div>
            </Field>
          </div>
        </CardContent>
        <CardFooter className="justify-end gap-2 border-t bg-muted/20">
          <Button type="submit" disabled={create.isPending}>
            <Plus className="size-3.5" />
            {create.isPending ? 'Adding…' : 'Add collector'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function PendingCollectorCard({
  collector,
  onNotice,
}: {
  collector: Collector
  /** Lifecycle changes unmount this card, so confirmations belong to the page. */
  onNotice: (message: string) => void
}) {
  const probe = useProbeCollector()
  const dismiss = useDismissCollector()
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onProbe() {
    setMessage(null)
    setError(null)
    try {
      const result = await probe.mutateAsync(collector.id)
      const detail = collectorProbeSummary(result.probe)
      if (result.probe && !result.probe.ok) {
        setError(`Probe failed: ${detail}`)
      } else {
        setMessage(`Collector answered (${detail ?? 'no detail'}).`)
      }
    } catch (cause) {
      setError(actionErrorMessage(cause, 'Failed to probe the collector.'))
    }
  }

  async function onDismiss() {
    setMessage(null)
    setError(null)
    try {
      await dismiss.mutateAsync(collector.id)
      onNotice(`Dismissed ${collector.name}. It will not come back as pending.`)
    } catch (cause) {
      setError(actionErrorMessage(cause, 'Failed to dismiss the collector.'))
    }
  }

  const claimsAnotherAddress = announcedAddressDiffers(collector)

  return (
    <Card className="rounded-lg border-primary/30 bg-primary/5 py-3">
      <CardHeader className="px-3 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <Broadcast className="size-3.5 text-primary" />
            {collector.name}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{collectorLifecycleLabel(collector.lifecycle)}</Badge>
            <TransportBadge transport={collector.transport} />
            <CollectorUnencryptedBadge collector={collector} />
            <Badge variant="outline">{collectorSourceLabel(collector.source)}</Badge>
          </div>
        </div>
        <CollectorSubtitle collector={collector} />
      </CardHeader>
      <CardContent className="space-y-3 px-3 text-xs">
        <div className="grid gap-3 sm:grid-cols-3">
          <Fact label="Hostname">{collector.hostname ?? '—'}</Fact>
          <Fact label="Version">{collector.version ?? '—'}</Fact>
          <Fact label="Capture interface">{collector.captureInterface ?? '—'}</Fact>
          <Fact label="Key fingerprint" mono>
            {formatKeyFingerprint(collector.apiKeyFingerprint)}
          </Fact>
          <Fact label="Last announce">{formatLastSeen(collector.lastAnnounceAt)}</Fact>
          {claimsAnotherAddress ? (
            <Fact label="It reported" mono>
              {collector.announcedBaseUrl}
            </Fact>
          ) : null}
        </div>

        {claimsAnotherAddress ? (
          <p className="text-[11px] text-muted-foreground">
            The server polls the address the announce came from, not the one the collector reported.
          </p>
        ) : null}

        {collector.hasApiKey ? (
          <p className="text-[11px] text-muted-foreground">
            Compare the fingerprint with{' '}
            <code className="font-mono">{COLLECTOR_KEY_FINGERPRINT_COMMAND}</code> on the collector
            before adopting.
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            This collector announced no API key. Paste one when adopting if it expects
            authentication.
          </p>
        )}

        {message ? <p className="text-primary">{message}</p> : null}
        {error ? <p className="text-destructive">{error}</p> : null}

        {adoptOpen ? (
          <AdoptCollectorForm
            collector={collector}
            formId={`adopt-form-${collector.id}`}
            onCancel={() => setAdoptOpen(false)}
            onAdopted={(adoptedMessage) => {
              setAdoptOpen(false)
              onNotice(adoptedMessage)
            }}
          />
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap justify-end gap-2 px-3">
        <Button
          size="sm"
          aria-expanded={adoptOpen}
          aria-controls={`adopt-form-${collector.id}`}
          onClick={() => {
            setMessage(null)
            setError(null)
            setAdoptOpen((current) => !current)
          }}
        >
          {adoptOpen ? 'Close' : 'Adopt'}
        </Button>
        <Button variant="outline" size="sm" disabled={probe.isPending} onClick={onProbe}>
          <Waves className="size-3.5" />
          {probe.isPending ? 'Probing…' : 'Probe'}
        </Button>
        <Button variant="outline" size="sm" disabled={dismiss.isPending} onClick={onDismiss}>
          <Prohibit className="size-3.5" />
          {dismiss.isPending ? 'Dismissing…' : 'Dismiss'}
        </Button>
      </CardFooter>
    </Card>
  )
}

function AdoptCollectorForm({
  collector,
  formId,
  onAdopted,
  onCancel,
}: {
  collector: Collector
  formId: string
  onAdopted: (message: string) => void
  onCancel: () => void
}) {
  const adopt = useAdoptCollector()
  const [name, setName] = useState(collector.name)
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(
    String(collector.pollIntervalSeconds)
  )
  const [apiKey, setApiKey] = useState('')
  const [keyMismatch, setKeyMismatch] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fieldErrors = adopt.error ? fieldErrorsFromApi(adopt.error) : {}

  async function submit(acceptKeyChange: boolean) {
    setError(null)

    const interval = parsePollInterval(pollIntervalSeconds)
    if (interval === null) {
      setError(POLL_INTERVAL_ERROR)
      return
    }

    const payload: AdoptCollectorPayload = { pollIntervalSeconds: interval }
    const trimmedName = name.trim()
    if (trimmedName && trimmedName !== collector.name) payload.name = trimmedName
    const trimmedKey = apiKey.trim()
    if (trimmedKey) payload.apiKey = trimmedKey
    if (acceptKeyChange) payload.acceptKeyChange = true

    try {
      const result = await adopt.mutateAsync({ id: collector.id, payload })
      const detail = collectorProbeSummary(result.probe)
      const socket = result.collector.transport === 'agent'
      onAdopted(
        result.probe && !result.probe.ok
          ? socket
            ? `Adopted ${result.collector.name}. It starts pushing as soon as it is connected (${detail}).`
            : `Adopted ${result.collector.name}, but the probe failed: ${detail}`
          : socket
            ? `Adopted ${result.collector.name} (${detail ?? 'not probed'}). It was told to start pushing.`
            : `Adopted ${result.collector.name} (${detail ?? 'not probed'}). Polling starts on the next tick.`
      )
    } catch (cause) {
      if (apiErrorCode(cause) === 'collector_api_key_mismatch') {
        setKeyMismatch(true)
        return
      }
      if (isFieldValidationError(cause)) return
      setError(actionErrorMessage(cause, 'Failed to adopt the collector.'))
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    void submit(false)
  }

  return (
    <form id={formId} onSubmit={onSubmit} className="space-y-3 rounded-md border bg-card p-3">
      <div className="space-y-1">
        <p className="text-xs font-medium">Adopt {collector.name}</p>
        <p className="text-[11px] text-muted-foreground">
          {collector.apiKeyFingerprint ? (
            <>
              Announced fingerprint{' '}
              <span className="font-mono">
                {formatKeyFingerprint(collector.apiKeyFingerprint)}
              </span>
              {collector.hasApiKey
                ? ' — the announced key is already stored. Leave the field empty to keep it.'
                : '.'}
            </>
          ) : collector.lifecycle === 'dismissed' ? (
            'The stored key was cleared when this collector was dismissed. Paste it again if it expects authentication.'
          ) : collector.hasApiKey ? (
            'A key is stored for this collector. Leave the field empty to keep it.'
          ) : (
            'No key was announced. Paste one if this collector expects authentication.'
          )}
        </p>
      </div>

      <div className={formClassName('grid gap-3 sm:grid-cols-3 space-y-0')}>
        <Field label="Name" htmlFor={`adopt-${collector.id}-name`} error={fieldErrors.name}>
          <Input
            id={`adopt-${collector.id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label={collectorIntervalLabel(collector.transport)}
          htmlFor={`adopt-${collector.id}-interval`}
          error={fieldErrors.pollIntervalSeconds}
        >
          <Input
            id={`adopt-${collector.id}-interval`}
            type="number"
            min={MIN_POLL_INTERVAL_SECONDS}
            max={MAX_POLL_INTERVAL_SECONDS}
            value={pollIntervalSeconds}
            onChange={(event) => setPollIntervalSeconds(event.target.value)}
          />
        </Field>
        <Field
          label="API key"
          htmlFor={`adopt-${collector.id}-key`}
          error={fieldErrors.apiKey}
        >
          <Input
            id={`adopt-${collector.id}-key`}
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value)
              setKeyMismatch(false)
            }}
          />
        </Field>
      </div>

      {keyMismatch ? (
        <Alert className="rounded-lg border-destructive/20 bg-destructive/5">
          <WarningCircle className="size-4 text-destructive" />
          <AlertTitle>That key does not match</AlertTitle>
          <AlertDescription>
            <p>
              The collector announced fingerprint{' '}
              <span className="font-mono">
                {formatKeyFingerprint(collector.apiKeyFingerprint)}
              </span>
              , and the key you typed hashes to something else. Check for a typo — or adopt with it
              anyway if you know the key changed.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={adopt.isPending}
                onClick={() => void submit(true)}
              >
                Adopt with this key
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? <FormError message={error} /> : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={adopt.isPending}>
          {adopt.isPending ? 'Adopting…' : 'Adopt'}
        </Button>
      </div>
    </form>
  )
}

function RegisteredCollectorCard({
  collector,
  onNotice,
}: {
  collector: Collector
  /** Remove and Dismiss unmount this card, so their confirmations go page-level. */
  onNotice: (message: string) => void
}) {
  const probe = useProbeCollector()
  const update = useUpdateCollector()
  const destroy = useDeleteCollector()
  const dismiss = useDismissCollector()

  const [editOpen, setEditOpen] = useState(false)
  const [confirm, setConfirm] = useState<'remove' | 'dismiss' | null>(null)
  const [historyRows, setHistoryRows] = useState<HistoryCounts | null>(null)
  const [historyBlocked, setHistoryBlocked] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const health = collectorHealth(collector)
  const failureNote = collectorFailureNote(collector.lastStatus)
  const sourceHint = collectorSourceHint(collector.source, collector.transport)

  function resetNotices() {
    setMessage(null)
    setError(null)
  }

  async function onProbe() {
    resetNotices()
    try {
      const result = await probe.mutateAsync(collector.id)
      const detail = collectorProbeSummary(result.probe)
      if (result.probe && !result.probe.ok) {
        setError(`Probe failed: ${detail}`)
      } else {
        setMessage(`Collector answered (${detail ?? 'no detail'}).`)
      }
    } catch (cause) {
      setError(actionErrorMessage(cause, 'Failed to probe the collector.'))
    }
  }

  async function setEnabled(enabled: boolean) {
    resetNotices()
    try {
      // Disabling needs no round trip to a collector we are switching off.
      await update.mutateAsync({
        id: collector.id,
        payload: { enabled },
        ...(enabled ? {} : { probe: false }),
      })
      setConfirm(null)
      setHistoryBlocked(false)
      const socket = collector.transport === 'agent'
      setMessage(
        enabled
          ? socket
            ? 'Enabled. The collector was told to resume pushing.'
            : 'Polling enabled. The next tick picks it up.'
          : socket
            ? 'Disabled. The collector was told to pause; its history is kept and still charts.'
            : 'Polling disabled. Its history is kept and still charts.'
      )
    } catch (cause) {
      setError(
        actionErrorMessage(
          cause,
          enabled
            ? collector.transport === 'agent'
              ? 'Failed to enable the collector.'
              : 'Failed to enable polling.'
            : collector.transport === 'agent'
              ? 'Failed to disable the collector.'
              : 'Failed to disable polling.'
        )
      )
    }
  }

  async function onRemove() {
    resetNotices()
    try {
      await destroy.mutateAsync(collector.id)
      // Close before the refetch lands, or a second click deletes a gone row.
      setConfirm(null)
      onNotice(`Removed ${collector.name}.`)
    } catch (cause) {
      if (apiErrorCode(cause) === 'collector_has_history') {
        setHistoryRows(historyFromError(cause))
        setHistoryBlocked(true)
        setConfirm(null)
        return
      }
      setConfirm(null)
      setError(actionErrorMessage(cause, 'Failed to remove the collector.'))
    }
  }

  async function onDismiss() {
    resetNotices()
    try {
      await dismiss.mutateAsync(collector.id)
      setConfirm(null)
      onNotice(`Dismissed ${collector.name}. No more data is taken from it and its key was cleared.`)
    } catch (cause) {
      setConfirm(null)
      setError(actionErrorMessage(cause, 'Failed to dismiss the collector.'))
    }
  }

  return (
    <Card className="rounded-lg py-3">
      <CardHeader className="px-3 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">{collector.name}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <HealthBadge health={health} />
            <TransportBadge transport={collector.transport} />
            <CollectorUnencryptedBadge collector={collector} />
            <Badge variant="outline">{collector.pollIntervalSeconds}s</Badge>
            <Badge variant="outline">{collectorSourceLabel(collector.source)}</Badge>
          </div>
        </div>
        <CollectorSubtitle collector={collector} />
      </CardHeader>
      <CardContent className="space-y-3 px-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          {collector.gateway ? <GatewayBadge gateway={collector.gateway} /> : null}
          <Badge variant="outline">{collector.enabled ? 'Enabled' : 'Disabled'}</Badge>
          {collector.captureInterface ? (
            <Badge variant="outline">{collector.captureInterface}</Badge>
          ) : null}
          {collector.version ? <Badge variant="outline">v{collector.version}</Badge> : null}
          {collector.hostname ? <Badge variant="outline">{collector.hostname}</Badge> : null}
          <Badge variant="outline">
            {collector.hasApiKey
              ? `Key ${formatKeyFingerprint(collector.apiKeyFingerprint)}`
              : 'No key'}
          </Badge>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Fact label="Last seen">{formatLastSeen(collector.lastSeenAt)}</Fact>
          <Fact label="Last announce">{formatLastSeen(collector.lastAnnounceAt)}</Fact>
          {announcedAddressDiffers(collector) ? (
            <Fact label="It reported" mono>
              {collector.announcedBaseUrl}
            </Fact>
          ) : null}
          {collector.gateway ? (
            <Fact label="Gateway report">{formatLastSeen(collector.gateway.reportedAt)}</Fact>
          ) : null}
          {collector.transport === 'agent' && collector.baseUrl ? (
            <Fact label="Its HTTP API" mono>
              {collector.baseUrl}
            </Fact>
          ) : null}
        </div>

        {sourceHint ? <p className="text-[11px] text-muted-foreground">{sourceHint}</p> : null}

        {collector.lastStatus?.error ? (
          <p className="text-destructive">
            {collector.lastStatus.error}
            {failureNote ? ` (${failureNote})` : null}
          </p>
        ) : null}

        {message ? <p className="text-primary">{message}</p> : null}
        {error ? <p className="text-destructive">{error}</p> : null}

        {editOpen ? (
          <EditCollectorForm
            collector={collector}
            formId={`edit-form-${collector.id}`}
            onCancel={() => setEditOpen(false)}
            onSaved={(savedMessage) => {
              setEditOpen(false)
              setMessage(savedMessage)
            }}
          />
        ) : null}

        {confirm === 'remove' ? (
          <Alert className="rounded-lg border-destructive/20 bg-destructive/5">
            <WarningCircle className="size-4 text-destructive" />
            <AlertTitle>Remove {collector.name}?</AlertTitle>
            <AlertDescription>
              <p>
                Removing a collector destroys everything recorded under it.
                {collector.enabled
                  ? ' Disabling stops data collection and keeps every chart it has already filled.'
                  : ' It is already disabled, so no data is collected — only the history would go.'}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {collector.enabled ? (
                  <Button
                    type="button"
                    size="xs"
                    disabled={update.isPending}
                    onClick={() => void setEnabled(false)}
                  >
                    Disable instead
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="xs"
                  variant="destructive"
                  disabled={destroy.isPending}
                  onClick={onRemove}
                >
                  {destroy.isPending ? 'Removing…' : collector.enabled ? 'Remove anyway' : 'Remove'}
                </Button>
                <Button type="button" size="xs" variant="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {confirm === 'dismiss' ? (
          <Alert className="rounded-lg border-destructive/20 bg-destructive/5">
            <WarningCircle className="size-4 text-destructive" />
            <AlertTitle>Dismiss {collector.name}?</AlertTitle>
            <AlertDescription>
              <p>
                Dismissing stops data collection, forgets the stored API key and hides the
                collector{collector.transport === 'agent' ? ', and closes its socket' : ''}. Its
                history is kept, and a collector that keeps checking in will not reappear as pending.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="destructive"
                  disabled={dismiss.isPending}
                  onClick={onDismiss}
                >
                  {dismiss.isPending ? 'Dismissing…' : 'Dismiss'}
                </Button>
                <Button type="button" size="xs" variant="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {historyBlocked ? (
          <HistoryBlockedAlert
            collector={collector}
            rows={historyRows}
            disabling={update.isPending}
            onDisable={collector.enabled ? () => void setEnabled(false) : undefined}
            onClose={() => {
              setHistoryBlocked(false)
              setHistoryRows(null)
            }}
          />
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap justify-end gap-2 px-3">
        <Button variant="outline" size="sm" disabled={probe.isPending} onClick={onProbe}>
          <Waves className="size-3.5" />
          {probe.isPending ? 'Probing…' : 'Probe'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={update.isPending}
          onClick={() => void setEnabled(!collector.enabled)}
        >
          {collector.enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={editOpen}
          aria-controls={`edit-form-${collector.id}`}
          onClick={() => {
            resetNotices()
            setEditOpen((current) => !current)
          }}
        >
          <PencilSimple className="size-3.5" />
          {editOpen ? 'Close' : 'Edit'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={dismiss.isPending}
          onClick={() => {
            resetNotices()
            setConfirm('dismiss')
          }}
        >
          <Prohibit className="size-3.5" />
          Dismiss
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={destroy.isPending}
          onClick={() => {
            resetNotices()
            setConfirm('remove')
          }}
        >
          <Trash className="size-3.5" />
          Remove
        </Button>
      </CardFooter>
    </Card>
  )
}

function EditCollectorForm({
  collector,
  formId,
  onSaved,
  onCancel,
}: {
  collector: Collector
  formId: string
  onSaved: (message: string) => void
  onCancel: () => void
}) {
  const update = useUpdateCollector()
  // A socket collector is not polled: its address is shown, never edited or sent back.
  const socket = collector.transport === 'agent'
  const [name, setName] = useState(collector.name)
  const [baseUrl, setBaseUrl] = useState(collector.baseUrl ?? '')
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(
    String(collector.pollIntervalSeconds)
  )
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fieldErrors = update.error ? fieldErrorsFromApi(update.error) : {}

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    const interval = parsePollInterval(pollIntervalSeconds)
    if (interval === null) {
      setError(POLL_INTERVAL_ERROR)
      return
    }

    // Partial update: send only what actually changed, so saving an unrelated
    // field never counts as re-pointing an announced collector's address.
    const payload: Partial<UpsertCollectorPayload> = {}
    const trimmedName = name.trim()
    if (trimmedName !== collector.name) payload.name = trimmedName
    const trimmedBaseUrl = baseUrl.trim()
    if (!socket && trimmedBaseUrl && trimmedBaseUrl !== collector.baseUrl) {
      payload.baseUrl = trimmedBaseUrl
    }
    if (interval !== collector.pollIntervalSeconds) payload.pollIntervalSeconds = interval
    const trimmedKey = apiKey.trim()
    // Omitted keeps the stored key; `null` clears it.
    if (trimmedKey) payload.apiKey = trimmedKey
    else if (clearApiKey) payload.apiKey = null

    try {
      const result = await update.mutateAsync({ id: collector.id, payload })
      const detail = collectorProbeSummary(result.probe)
      const takenOver = (result.warnings ?? []).includes('announced_address_taken_over')
      onSaved(
        takenOver
          ? `Saved (${detail ?? 'not probed'}). The address is yours now: announces keep updating this collector's details but no longer move it.`
          : `Saved (${detail ?? 'not probed'}).`
      )
    } catch (cause) {
      if (isFieldValidationError(cause)) return
      setError(actionErrorMessage(cause, 'Failed to save the collector.'))
    }
  }

  return (
    <form id={formId} onSubmit={onSubmit} className="space-y-3 rounded-md border bg-card p-3">
      <p className="text-xs font-medium">Edit {collector.name}</p>

      <div className={formClassName('grid gap-3 sm:grid-cols-2 space-y-0')}>
        <Field label="Name" htmlFor={`edit-${collector.id}-name`} error={fieldErrors.name}>
          <Input
            id={`edit-${collector.id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field
          label={collectorIntervalLabel(collector.transport)}
          htmlFor={`edit-${collector.id}-interval`}
          error={fieldErrors.pollIntervalSeconds}
        >
          <Input
            id={`edit-${collector.id}-interval`}
            type="number"
            min={MIN_POLL_INTERVAL_SECONDS}
            max={MAX_POLL_INTERVAL_SECONDS}
            value={pollIntervalSeconds}
            onChange={(event) => setPollIntervalSeconds(event.target.value)}
            required
          />
        </Field>
        <div className="sm:col-span-2">
          {socket ? (
            <Field
              label="Address"
              htmlFor={`edit-${collector.id}-base-url`}
              hint="This collector connects to the controller over a WebSocket and is not polled, so there is no address to edit."
            >
              <Input
                id={`edit-${collector.id}-base-url`}
                value={collectorAddressLine(collector)}
                readOnly
                disabled
                className="font-mono"
              />
            </Field>
          ) : (
            <Field
              label="Address"
              htmlFor={`edit-${collector.id}-base-url`}
              hint={
                collector.source === 'env'
                  ? 'COLLECTOR_URL owns this address and restores it on the next server restart.'
                  : undefined
              }
              error={fieldErrors.baseUrl}
            >
              <Input
                id={`edit-${collector.id}-base-url`}
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                required
                className="font-mono"
              />
            </Field>
          )}
        </div>
        <Field
          label="New API key"
          htmlFor={`edit-${collector.id}-key`}
          hint="Leave empty to keep the stored key."
          error={fieldErrors.apiKey}
        >
          <Input
            id={`edit-${collector.id}-key`}
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>
        {collector.hasApiKey ? (
          <Field label="Clear the stored key" htmlFor={`edit-${collector.id}-clear-key`}>
            <div className="flex h-8 items-center rounded-md border px-3">
              <Switch
                id={`edit-${collector.id}-clear-key`}
                checked={clearApiKey}
                disabled={apiKey.trim().length > 0}
                onCheckedChange={setClearApiKey}
              />
            </div>
          </Field>
        ) : null}
      </div>

      {error ? <FormError message={error} /> : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  )
}

function DismissedCollectorCard({
  collector,
  onNotice,
}: {
  collector: Collector
  /** Adopt and Remove unmount this card, so their confirmations go page-level. */
  onNotice: (message: string) => void
}) {
  const destroy = useDeleteCollector()
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [historyRows, setHistoryRows] = useState<HistoryCounts | null>(null)
  const [historyBlocked, setHistoryBlocked] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onRemove() {
    setError(null)
    try {
      await destroy.mutateAsync(collector.id)
      // Close before the refetch lands, or a second click deletes a gone row.
      setConfirmRemove(false)
      onNotice(`Removed ${collector.name}.`)
    } catch (cause) {
      if (apiErrorCode(cause) === 'collector_has_history') {
        setHistoryRows(historyFromError(cause))
        setHistoryBlocked(true)
        setConfirmRemove(false)
        return
      }
      setConfirmRemove(false)
      setError(actionErrorMessage(cause, 'Failed to remove the collector.'))
    }
  }

  return (
    <Card className="rounded-lg py-3 opacity-90">
      <CardHeader className="px-3 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm text-muted-foreground">{collector.name}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{collectorLifecycleLabel(collector.lifecycle)}</Badge>
            <TransportBadge transport={collector.transport} />
            <Badge variant="outline">{collectorSourceLabel(collector.source)}</Badge>
          </div>
        </div>
        <CollectorSubtitle collector={collector} />
      </CardHeader>
      <CardContent className="space-y-3 px-3 text-xs">
        <div className="grid gap-3 sm:grid-cols-3">
          <Fact label="Hostname">{collector.hostname ?? '—'}</Fact>
          <Fact label="Last announce">{formatLastSeen(collector.lastAnnounceAt)}</Fact>
          <Fact label="Last seen">{formatLastSeen(collector.lastSeenAt)}</Fact>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Dismissed collectors are never used. When one checks in again it only refreshes this row
          quietly, so it does not come back as pending. Adopting asks for its API key again.
        </p>

        {error ? <p className="text-destructive">{error}</p> : null}

        {adoptOpen ? (
          <AdoptCollectorForm
            collector={collector}
            formId={`adopt-form-${collector.id}`}
            onCancel={() => setAdoptOpen(false)}
            onAdopted={(adoptedMessage) => {
              setAdoptOpen(false)
              onNotice(adoptedMessage)
            }}
          />
        ) : null}

        {confirmRemove ? (
          <Alert className="rounded-lg border-destructive/20 bg-destructive/5">
            <WarningCircle className="size-4 text-destructive" />
            <AlertTitle>Remove {collector.name}?</AlertTitle>
            <AlertDescription>
              <p>
                This deletes the row. If the collector ever recorded traffic, the API refuses and
                points at the purge command instead.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="destructive"
                  disabled={destroy.isPending}
                  onClick={onRemove}
                >
                  {destroy.isPending ? 'Removing…' : 'Remove'}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => setConfirmRemove(false)}
                >
                  Cancel
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {historyBlocked ? (
          <HistoryBlockedAlert
            collector={collector}
            rows={historyRows}
            onClose={() => {
              setHistoryBlocked(false)
              setHistoryRows(null)
            }}
          />
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap justify-end gap-2 px-3">
        <Button
          variant="outline"
          size="sm"
          aria-expanded={adoptOpen}
          aria-controls={`adopt-form-${collector.id}`}
          onClick={() => {
            setError(null)
            setAdoptOpen((current) => !current)
          }}
        >
          {adoptOpen ? 'Close' : 'Adopt'}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={destroy.isPending}
          onClick={() => {
            setError(null)
            setConfirmRemove(true)
          }}
        >
          <Trash className="size-3.5" />
          Remove
        </Button>
      </CardFooter>
    </Card>
  )
}
