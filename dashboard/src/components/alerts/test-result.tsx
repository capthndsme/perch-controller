import { CheckCircle, XCircle } from '@phosphor-icons/react'
import { apiErrorCode, ApiError } from '@/lib/api'
import { PUSH_SERVICE_LABEL } from '@/lib/alerts'
import { cn } from '@/lib/utils'
import type { DestinationTestResponse } from '@/types/alerts'

function errorText(error: unknown): string {
  switch (apiErrorCode(error)) {
    case 'test_rate_limited':
      return 'One test every 10 seconds: try again in a moment.'
    case 'subscription_gone':
      return 'The push service no longer knows this subscription. Turn notifications off and on again on that device.'
    case 'delivery_disabled':
      return 'Sending is switched off on this controller (ALERTS_DELIVERY=off).'
    case 'webhook_needs_secret':
      return 'Its secret cannot be read any more (the controller’s key changed): enter the token or URL again, or rotate the signing secret.'
    default:
      return error instanceof ApiError || error instanceof Error ? error.message : 'The test could not be sent.'
  }
}

/**
 * The answer of a test button, inline under it: accepted (with status, service and time taken) or why not.
 * `kind` push adds the hint that "sent" only means the push service took it.
 */
export function TestResultLine({
  data,
  error,
  kind,
  className,
}: {
  data: DestinationTestResponse | undefined
  error: unknown
  kind: 'push' | 'webhook'
  className?: string
}) {
  if (!data && !error) return null
  const result = data?.result
  const ok = result?.outcome === 'sent'
  const text = error
    ? errorText(error)
    : ok
      ? [
          `Sent: ${result.pushService ? PUSH_SERVICE_LABEL[result.pushService] : 'the receiver'} answered ${result.statusCode ?? 'OK'} in ${result.durationMs} ms.`,
          kind === 'push' ? 'If nothing appears, check the notification settings for this site or app on that device.' : null,
        ]
          .filter(Boolean)
          .join(' ')
      : `Not delivered${result?.statusCode ? ` (${result.statusCode})` : ''}: ${result?.error ?? 'no answer'}.`
  return (
    <p role="status" className={cn('flex items-start gap-1.5 text-xs', ok ? 'text-foreground' : 'text-destructive', className)}>
      {ok ? (
        <CheckCircle weight="fill" className="mt-px size-3.5 shrink-0 text-status-good" />
      ) : (
        <XCircle weight="fill" className="mt-px size-3.5 shrink-0" />
      )}
      <span>
        {text}
        {!error && result?.responseExcerpt ? (
          <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">{result.responseExcerpt}</span>
        ) : null}
      </span>
    </p>
  )
}
