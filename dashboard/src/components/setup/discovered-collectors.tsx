import { useState } from 'react'
import { Broadcast, CaretDown, CaretRight, PlugsConnected, Prohibit, WarningCircle } from '@phosphor-icons/react'
import { Fact } from '@/components/collectors/fact'
import { LoopbackNotice } from '@/components/security/loopback-notice'
import { PlainHttpNotice } from '@/components/security/plain-http'
import { Field, FormError } from '@/components/setup/form-field'
import type { CollectorStepResult } from '@/components/setup/collector-step-result'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { fieldErrorsFromApi, useSetupAdoptCollector } from '@/hooks/use-setup'
import { useVersion } from '@/hooks/use-version'
import { API_URL, ApiError, apiErrorCode } from '@/lib/api'
import {
  announcedAddressDiffers,
  COLLECTOR_KEY_FINGERPRINT_COMMAND,
  collectorServerUrlCommands,
  formatDurationSince,
  formatKeyFingerprint,
  formatLastSeen,
} from '@/lib/collectors'
import { isPlainHttpUrl } from '@/lib/transport-security'
import type { Collector } from '@/types/api'
import type { SetupAdoptPayload } from '@/types/setup'

type DiscoveredCollectorsProps = {
  candidates: Collector[]
  discoveryEnabled: boolean
  /** First load still running. */
  loading: boolean
  loadError: string | null
  onAdopted: (result: CollectorStepResult) => void
  onSessionExpired: () => void
}

/**
 * Collectors that announced themselves to this controller and wait for
 * adoption, or, while there are none, what to run on a router so it does.
 */
export function DiscoveredCollectors({
  candidates,
  discoveryEnabled,
  loading,
  loadError,
  onAdopted,
  onSessionExpired,
}: DiscoveredCollectorsProps) {
  const [showInstructions, setShowInstructions] = useState(false)

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Broadcast className="size-4 text-primary" />
          Discovered on your network
        </h3>
        {candidates.length > 0 ? (
          <Badge variant="secondary">{candidates.length} waiting</Badge>
        ) : null}
      </div>

      {loadError ? <FormError message={loadError} /> : null}

      {!discoveryEnabled ? (
        <Alert className="rounded-lg">
          <Prohibit className="size-4" />
          <AlertTitle>Discovery is switched off</AlertTitle>
          <AlertDescription>
            Collectors cannot announce themselves to this controller. Add one by address below, or
            skip and switch discovery on later under Settings → Collectors.
          </AlertDescription>
        </Alert>
      ) : null}

      {candidates.length > 0 ? (
        <>
          <div className="space-y-3">
            {candidates.map((collector) => (
              <CandidateCard
                key={collector.id}
                collector={collector}
                onAdopted={onAdopted}
                onSessionExpired={onSessionExpired}
              />
            ))}
          </div>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={showInstructions}
            onClick={() => setShowInstructions((current) => !current)}
          >
            {showInstructions ? (
              <CaretDown className="size-3" />
            ) : (
              <CaretRight className="size-3" />
            )}
            Point another router at this controller
          </button>
          {showInstructions ? <ServerUrlInstructions /> : null}
        </>
      ) : discoveryEnabled ? (
        <div className="space-y-3 rounded-lg border border-dashed p-4">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-3.5" />
            {loading ? 'Checking for collectors…' : 'Waiting for collectors to announce themselves…'}
          </p>
          <ServerUrlInstructions />
          <p className="text-[11px] text-muted-foreground">
            No router to install on? <code className="font-mono">docker compose --profile collector up -d</code>{' '}
            runs a collector on this host instead; it announces itself here the same way.
          </p>
        </div>
      ) : null}
    </section>
  )
}

/** The commands that make an OpenWrt router with the package announce here. */
function ServerUrlInstructions() {
  const controllerUrl = API_URL || window.location.origin
  const commands = collectorServerUrlCommands(controllerUrl)

  return (
    <div className="space-y-2">
      <CollectorPackageInstall />
      <p className="text-xs text-muted-foreground">
        The package starts right away. Then point it at this controller, as root on the router:
      </p>
      {isPlainHttpUrl(controllerUrl) ? (
        <PlainHttpNotice>
          The router will talk to the controller over plain HTTP. Anyone who can intercept traffic
          on this network could read what it reports, copy its credentials and pose as the
          controller. Put the controller and the router&apos;s management interface on a management
          VLAN that client devices can&apos;t reach, or serve the controller over HTTPS.
        </PlainHttpNotice>
      ) : null}
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
        {commands}
      </pre>
      <LoopbackNotice url={controllerUrl} device="a router" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          It shows up here a few seconds after the restart.
        </p>
        <CopyButton value={commands} label="Copy commands" ariaLabel="Copy the router commands" />
      </div>
    </div>
  )
}

const COLLECTOR_OPENWRT_DOCS_URL = 'https://github.com/capthndsme/perch-collector/tree/main/openwrt'

/**
 * Step one on the router: the perch-collector package this controller pairs
 * with. OpenWrt 24.10 uses opkg (.ipk), 25.12 apk (.apk); DISTRIB_ARCH picks
 * the package architecture.
 */
function CollectorPackageInstall() {
  const version = useVersion().data
  if (!version) return null
  const docsLink = (
    <a
      href={COLLECTOR_OPENWRT_DOCS_URL}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 hover:text-foreground"
    >
      other setups
    </a>
  )
  if (version.collectorVersion === 'latest') {
    return (
      <p className="text-xs text-muted-foreground">
        To add an OpenWrt router, install the perch-collector package from its{' '}
        <a
          href={version.collectorReleaseUrl.replace(/\/download\/?$/, '')}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          latest release
        </a>{' '}
        ({docsLink}).
      </p>
    )
  }
  const base = version.collectorReleaseUrl.replace(/\/+$/, '')
  const file = `perch-collector_${version.collectorVersion}-r1_\${DISTRIB_ARCH}`
  const opkg = `opkg update && . /etc/openwrt_release && opkg install ${base}/${file}.ipk`
  const apk =
    `apk update && . /etc/openwrt_release && wget -O /tmp/perch-collector.apk ${base}/${file}.apk` +
    ' && apk add --allow-untrusted /tmp/perch-collector.apk'
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        To add an OpenWrt router, install perch-collector {version.collectorVersion} on it as root
        ({docsLink}):
      </p>
      {[
        { label: 'OpenWrt 24.10 (opkg)', command: opkg },
        { label: 'OpenWrt 25.12 (apk)', command: apk },
      ].map(({ label, command }) => (
        <div key={label} className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-medium">{label}</p>
            <CopyButton value={command} ariaLabel={`Copy the ${label} install command`} />
          </div>
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
            {command}
          </pre>
        </div>
      ))}
    </div>
  )
}

/** "connected for 12 min", "connected just now", "not connected". */
function socketNote(collector: Collector): string {
  if (!collector.connection?.online) return 'not connected'
  const since = formatDurationSince(collector.connection.connectedAt)
  if (since === null) return 'connected'
  return since === 'just now' ? 'connected just now' : `connected for ${since}`
}

type CandidateCardProps = {
  collector: Collector
  onAdopted: (result: CollectorStepResult) => void
  onSessionExpired: () => void
}

function CandidateCard({ collector, onAdopted, onSessionExpired }: CandidateCardProps) {
  const adopt = useSetupAdoptCollector()
  const [name, setName] = useState(collector.hostname ?? collector.name)
  const [apiKey, setApiKey] = useState('')
  const [keyMismatch, setKeyMismatch] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fieldErrors = adopt.error ? fieldErrorsFromApi(adopt.error) : {}
  // The announce normally carries the key; without it the admin supplies one.
  const needsKey = !collector.hasApiKey
  const claimsAnotherAddress = announcedAddressDiffers(collector)
  const fingerprint = formatKeyFingerprint(collector.apiKeyFingerprint)
  const idPrefix = `candidate-${collector.id}`
  const socket = collector.transport === 'agent'

  async function submit(acceptKeyChange: boolean) {
    setError(null)

    const payload: SetupAdoptPayload = {}
    const trimmedName = name.trim()
    if (trimmedName) payload.name = trimmedName
    const trimmedKey = apiKey.trim()
    if (needsKey && trimmedKey) payload.apiKey = trimmedKey
    if (acceptKeyChange) payload.acceptKeyChange = true

    try {
      const result = await adopt.mutateAsync({ id: collector.id, payload })
      onAdopted({
        kind: 'adopted',
        name: result.collector.name,
        baseUrl: result.collector.baseUrl,
        transport: result.collector.transport,
        address: result.collector.connection?.address ?? null,
        pollIntervalSeconds: result.collector.pollIntervalSeconds,
        probe: result.probe,
      })
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        onSessionExpired()
        return
      }
      const code = apiErrorCode(cause)
      if (code === 'collector_api_key_mismatch') {
        setKeyMismatch(true)
        return
      }
      if (code === 'collector_not_pending') {
        setError('This collector was adopted in the meantime.')
        return
      }
      if (code === 'collector_not_found') {
        setError('This collector is no longer waiting for adoption.')
        return
      }
      // Plain validation failures render next to their field.
      if (cause instanceof ApiError && cause.status === 422) return
      setError(cause instanceof ApiError ? cause.message : 'Failed to adopt the collector.')
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    void submit(false)
  }

  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {socket ? (
            <PlugsConnected className="size-3.5 text-primary" />
          ) : (
            <Broadcast className="size-3.5 text-primary" />
          )}
          {collector.hostname ?? collector.name}
        </p>
        <span className="text-[11px] text-muted-foreground">
          {socket ? socketNote(collector) : `announced ${formatLastSeen(collector.lastAnnounceAt)}`}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {socket ? (
          <Fact label="Connected from" mono>
            {collector.connection?.address ?? '—'}
          </Fact>
        ) : (
          <Fact label="Polled at" mono>
            {collector.baseUrl ?? '—'}
          </Fact>
        )}
        <Fact label="Capture interface">{collector.captureInterface ?? '—'}</Fact>
        <Fact label="Version">{collector.version ?? '—'}</Fact>
        {claimsAnotherAddress ? (
          <Fact label="It reports" mono>
            {collector.announcedBaseUrl}
          </Fact>
        ) : null}
        <Fact label="Key fingerprint" mono>
          {fingerprint}
        </Fact>
      </div>

      {claimsAnotherAddress ? (
        <p className="text-[11px] text-muted-foreground">
          The server polls the address the announce came from. If that is the wrong one (NAT,
          port-forward reflection), adopt it and then edit the address under Settings → Collectors.
        </p>
      ) : null}

      {collector.apiKeyFingerprint ? (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">
            To check the key, run this on the router. It should print{' '}
            <span className="font-mono">{fingerprint}</span>.
          </p>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 rounded-sm bg-muted px-1.5 py-1 font-mono text-[11px] break-all">
              {COLLECTOR_KEY_FINGERPRINT_COMMAND}
            </code>
            <CopyButton
              value={COLLECTOR_KEY_FINGERPRINT_COMMAND}
              ariaLabel="Copy the fingerprint command"
            />
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          It announced no API key. Paste the key below if the collector expects one.
        </p>
      )}

      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1">
          <Field label="Name" htmlFor={`${idPrefix}-name`} error={fieldErrors.name}>
            <Input
              id={`${idPrefix}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="rounded-md"
            />
          </Field>
        </div>
        {needsKey ? (
          <div className="min-w-40 flex-1">
            <Field label="API key (optional)" htmlFor={`${idPrefix}-key`} error={fieldErrors.apiKey}>
              <Input
                id={`${idPrefix}-key`}
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value)
                  setKeyMismatch(false)
                }}
                className="rounded-md font-mono"
              />
            </Field>
          </div>
        ) : null}
        <Button type="submit" size="sm" disabled={adopt.isPending}>
          {adopt.isPending ? 'Adopting…' : 'Adopt'}
        </Button>
      </form>

      {keyMismatch ? (
        <Alert className="rounded-lg border-destructive/20 bg-destructive/5">
          <WarningCircle className="size-4 text-destructive" />
          <AlertTitle>That key does not match</AlertTitle>
          <AlertDescription>
            <p>
              The collector announced fingerprint <span className="font-mono">{fingerprint}</span>,
              and the key you typed hashes to something else. Check for a typo, or adopt with it
              anyway if you know the key changed.
            </p>
            <div className="mt-2">
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
    </div>
  )
}
