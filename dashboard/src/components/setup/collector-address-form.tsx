import { useState } from 'react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import type { CollectorStepResult } from '@/components/setup/collector-step-result'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fieldErrorsFromApi, useSetupCollector } from '@/hooks/use-setup'
import { ApiError } from '@/lib/api'
import type { SetupStatusResponse } from '@/types/setup'

type CollectorAddressFormProps = {
  status: SetupStatusResponse
  onAdded: (result: CollectorStepResult) => void
  onSessionExpired: () => void
}

/**
 * Registers a collector by address, for one that cannot announce itself here
 * (no route to this controller, announcing switched off, an older build). The
 * address is probed before saving; a failed probe still registers the row.
 */
export function CollectorAddressForm({ status, onAdded, onSessionExpired }: CollectorAddressFormProps) {
  const collector = useSetupCollector()
  const [name, setName] = useState(status.defaultCollectorName)
  const [baseUrl, setBaseUrl] = useState(status.suggestedCollectorUrl)
  const [apiKey, setApiKey] = useState('')
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(
    String(status.defaultPollIntervalSeconds),
  )
  const [formError, setFormError] = useState<string | null>(null)

  const fieldErrors = collector.error ? fieldErrorsFromApi(collector.error) : {}

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)

    try {
      const response = await collector.mutateAsync({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || null,
        pollIntervalSeconds: Number(pollIntervalSeconds),
      })
      onAdded({
        kind: 'added',
        name: response.collector.name,
        baseUrl: response.collector.baseUrl,
        pollIntervalSeconds: response.collector.pollIntervalSeconds,
        probe: response.probe,
      })
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) {
          onSessionExpired()
        } else if (error.status !== 422) {
          setFormError(error.message)
        }
      } else {
        setFormError('Failed to add the collector.')
      }
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border bg-card p-4">
      {formError ? <FormError message={formError} /> : null}
      <div className={formClassName()}>
        <Field label="Name" htmlFor="collector-name" error={fieldErrors.name}>
          <Input
            id="collector-name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded-md"
          />
        </Field>
        <Field
          label="Base URL"
          htmlFor="collector-base-url"
          hint="The collector's API, e.g. http://192.168.1.1:9800"
          error={fieldErrors.baseUrl}
        >
          <Input
            id="collector-base-url"
            type="url"
            required
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="rounded-md font-mono"
          />
        </Field>
        <Field
          label="API key"
          htmlFor="collector-api-key"
          hint="Only if the collector has an api_key configured"
          error={fieldErrors.apiKey}
        >
          <Input
            id="collector-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            className="rounded-md font-mono"
          />
        </Field>
        <Field
          label="Poll interval (seconds)"
          htmlFor="collector-poll-interval"
          hint="5–3600; default 5, which is also the bucket size on disk"
          error={fieldErrors.pollIntervalSeconds}
        >
          <Input
            id="collector-poll-interval"
            type="number"
            min={5}
            max={3600}
            required
            value={pollIntervalSeconds}
            onChange={(event) => setPollIntervalSeconds(event.target.value)}
            className="rounded-md"
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={collector.isPending}>
          {collector.isPending ? 'Probing & saving…' : 'Test & add'}
        </Button>
      </div>
    </form>
  )
}
