import { Link, useParams } from 'react-router-dom'
import { ArrowRight, MagnifyingGlass, SealCheck, SpeakerSimpleSlash } from '@phosphor-icons/react'
import { AlertActions } from '@/components/alerts/alert-actions'
import { AlertStateChip } from '@/components/alerts/alert-row'
import { AlertTimeline, FactList } from '@/components/alerts/alert-timeline'
import { DeliveryList } from '@/components/alerts/delivery-list'
import { SeverityIcon } from '@/components/alerts/severity-icon'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { PageSpinner } from '@/components/ui/spinner'
import { useAlert, useAlertCatalogue, useDeleteMute } from '@/hooks/use-alerts'
import { useProfile } from '@/hooks/use-auth'
import { useNow } from '@/hooks/use-now'
import { ApiError } from '@/lib/api'
import { safeAppPath } from '@/lib/alert-badge'
import {
  alertDurationSeconds,
  formatDuration,
  formatWhen,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  subjectActionLabel,
  subjectText,
} from '@/lib/alerts'
import { cn } from '@/lib/utils'
import type { AlertDetailView, Rule } from '@/types/alerts'

/**
 * One alert (design README §5): what, since when, the facts, the timeline, who was notified; for admins
 * acknowledge, resolve, mute and the rule. A tapped notification lands here (`/alerts/<id>`).
 */
export function AlertPage() {
  const { id } = useParams()
  const numeric = id && /^\d+$/.test(id) ? Number(id) : null
  const query = useAlert(numeric)
  const catalogue = useAlertCatalogue()
  const isAdmin = useProfile().data?.role === 'admin'
  const now = useNow(30_000)

  const notFound = numeric === null || (query.error instanceof ApiError && query.error.status === 404)
  if (notFound) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <PageHeader title="Alert not found" crumbs={[{ label: 'Alerts', to: '/alerts' }, { label: 'Not found' }]} />
        <EmptyState
          icon={<MagnifyingGlass className="size-6" />}
          title="This alert does not exist (any more)"
          description={
            <>
              Resolved alerts are kept for 180 days by default.{' '}
              <Link to="/alerts" className="underline underline-offset-2">
                Back to the inbox
              </Link>
            </>
          }
        />
      </div>
    )
  }
  if (!query.data) {
    if (query.error) return <p className="text-sm text-destructive">{query.error.message}</p>
    return <PageSpinner label="Loading the alert" />
  }

  const alert = query.data
  const type = catalogue.data?.types.find((t) => t.type === alert.type)
  const subjectPath = safeAppPath(alert.path)
  const duration = formatDuration(alertDurationSeconds(alert, now))
  const since = alert.openedAt ?? alert.firstRaisedAt

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Alerts', to: '/alerts' }, { label: `#${alert.id}` }]}
        title={
          <span className="flex items-start gap-2.5">
            <SeverityIcon severity={alert.severity} quiet={alert.state === 'resolved'} className="mt-0.5 size-6" />
            <span>{alert.title}</span>
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium',
              SEVERITY_TONE[alert.severity].chip,
            )}
          >
            {SEVERITY_LABEL[alert.severity]}
          </span>
          <AlertStateChip alert={alert} />
          {alert.quietResolve ? (
            <span className="text-xs text-muted-foreground">Short blip: cleared within its hold</span>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {alert.kind === 'notice'
              ? formatWhen(since)
              : alert.resolvedAt
                ? `${formatWhen(since)} – ${formatWhen(alert.resolvedAt)} · ${duration}`
                : `Since ${formatWhen(since)} · ${duration}`}
          </span>
        </div>
      </PageHeader>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        {subjectPath ? (
          <Button asChild size="lg" className="w-full sm:w-auto">
            <Link to={subjectPath}>
              {subjectActionLabel(alert.subject.kind, subjectPath)}
              <ArrowRight />
            </Link>
          </Button>
        ) : null}
        {isAdmin ? <AlertActions alert={alert} type={type} /> : null}
      </div>

      <StatusNotes alert={alert} isAdmin={isAdmin} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="What happened" description={subjectText(alert.subject)}>
            <div className="space-y-3">
              {alert.body ? <p className="text-[13px] leading-relaxed">{alert.body}</p> : null}
              {alert.data ? <FactList data={alert.data} /> : null}
              {alert.eventCount > 1 ? (
                <p className="text-[11px] text-muted-foreground">
                  {alert.eventCount} reports
                  {alert.transitions > 0 ? ` · ${alert.transitions} times back and forth` : ''} · last{' '}
                  {formatWhen(alert.lastEventAt)}
                </p>
              ) : null}
            </div>
          </Panel>
          <Panel title="Timeline" description="Newest first.">
            <AlertTimeline events={alert.events} />
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Who was notified" flush>
            {alert.deliveries.length > 0 ? (
              <div className="pb-1">
                <DeliveryList deliveries={alert.deliveries} canOpen={isAdmin} />
              </div>
            ) : (
              <p className="px-4 pb-4 text-xs text-muted-foreground">{notSentReason(alert)}</p>
            )}
          </Panel>
          <Panel
            title="Rule"
            description={type ? type.label : alert.type}
            actions={
              isAdmin ? (
                <Button asChild size="xs" variant="ghost">
                  <Link to={`/settings/alerts?type=${encodeURIComponent(alert.type)}`}>Edit</Link>
                </Button>
              ) : null
            }
          >
            <RuleSummary rule={alert.rule} kind={alert.kind} />
          </Panel>
        </div>
      </div>
    </div>
  )
}

/** Acknowledged, muted, resolved by hand: one line each, with Unmute for admins. */
function StatusNotes({ alert, isAdmin }: { alert: AlertDetailView; isAdmin: boolean }) {
  const unmute = useDeleteMute()
  const mute = alert.mutedBy
  if (!alert.acknowledged && !mute && !alert.resolvedBy) return null
  return (
    <div className="flex flex-col gap-2">
      {alert.acknowledged ? (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
          <SealCheck className="mt-px size-4 shrink-0 text-brand" />
          <span>
            Acknowledged{alert.acknowledged.by ? ` by ${alert.acknowledged.by.name}` : ''} at{' '}
            {formatWhen(alert.acknowledged.at)}
            {alert.acknowledged.note ? <span className="text-muted-foreground">: {alert.acknowledged.note}</span> : null}
          </span>
        </p>
      ) : null}
      {mute ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
          <p className="flex items-start gap-2">
            <SpeakerSimpleSlash className="mt-px size-4 shrink-0 text-muted-foreground" />
            <span>
              {mute.reason === 'maintenance' ? 'Maintenance window' : 'Muted'}{' '}
              {mute.until ? `until ${formatWhen(mute.until)}` : 'until unmuted'}
              {mute.createdBy ? ` by ${mute.createdBy.name}` : mute.source ? ` (${mute.source})` : ''}
              {mute.note ? <span className="text-muted-foreground">: {mute.note}</span> : null}
            </span>
          </p>
          {isAdmin && mute.reason === 'manual' ? (
            <Button size="xs" variant="outline" disabled={unmute.isPending} onClick={() => unmute.mutate(mute.id)}>
              Unmute
            </Button>
          ) : null}
        </div>
      ) : null}
      {alert.resolvedBy ? (
        <p className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          Resolved by hand by {alert.resolvedBy.name}.
        </p>
      ) : null}
    </div>
  )
}

function notSentReason(alert: AlertDetailView): string {
  if (alert.muted) return 'Nothing was sent: this alert is muted.'
  if (!alert.rule.notify) return 'Nothing was sent: this type only goes to the inbox (its rule does not notify).'
  if (alert.state === 'pending') return 'Nothing sent yet: Perch waits for it to hold before notifying.'
  if (alert.quietResolve) return 'Nothing was sent: it cleared before its hold ended.'
  return 'Nothing was sent: no device or webhook takes this severity or category.'
}

function RuleSummary({ rule, kind }: { rule: Rule; kind: AlertDetailView['kind'] }) {
  const lines: string[] = []
  if (!rule.enabled) lines.push('Off: new events of this type are ignored.')
  else if (!rule.notify) lines.push('Inbox only: nothing is sent.')
  if (kind === 'condition') {
    lines.push(rule.holdSeconds > 0 ? `Notifies once it has held ${formatDuration(rule.holdSeconds)}.` : 'Notifies at once.')
    if (rule.notifyRecovery)
      lines.push(`Recovery notice after ${formatDuration(rule.recoveryHoldSeconds)} clear.`)
    if (rule.flapThreshold > 0)
      lines.push(`Flapping after ${rule.flapThreshold} changes in ${rule.flapWindowMinutes} min.`)
    if (rule.repeatMinutes > 0) lines.push(`Reminds every ${formatDuration(rule.repeatMinutes * 60)} until acknowledged.`)
  } else if (rule.dedupeMinutes > 0) {
    lines.push(`Repeats within ${formatDuration(rule.dedupeMinutes * 60)} are merged.`)
  }
  if (rule.groupSeconds > 0) lines.push(`Grouped over ${formatDuration(rule.groupSeconds)}.`)
  const channels = [rule.push ? 'push' : null, rule.webhooks ? 'webhooks' : null].filter(Boolean)
  lines.push(channels.length ? `Sent by ${channels.join(' and ')}.` : 'No channel is on.')
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  )
}
