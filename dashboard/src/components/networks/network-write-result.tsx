import { Link } from 'react-router-dom'
import { ArrowsClockwise, CheckCircle, Info, ShieldWarning, Warning, WarningCircle } from '@phosphor-icons/react'
import { APPLY_STATE_LABELS, applyChangesPath } from '@/lib/networks'
import { cn } from '@/lib/utils'
import type { NetworkIssue, NetworkWrite } from '@/types/networks'

/** Validation issues, errors first. Warnings never block a write. */
export function IssueList({ issues, className }: { issues: NetworkIssue[]; className?: string }) {
  if (issues.length === 0) return null
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  return (
    <ul className={cn('space-y-1.5', className)}>
      {sorted.map((issue, i) => (
        <li
          key={`${issue.code}-${issue.perchId ?? ''}-${issue.option ?? ''}-${i}`}
          className={cn(
            'flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs',
            issue.severity === 'error'
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-status-warning/30 bg-status-warning/10 text-foreground',
          )}
        >
          {issue.severity === 'error' ? (
            <WarningCircle className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <Warning className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
          )}
          <span className="min-w-0">
            {issue.message}
            {issue.section || issue.option ? (
              <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                {[issue.config, issue.section].filter(Boolean).join('.')}
                {issue.option ? ` · ${issue.option}` : ''}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * What a network write did: the conversion of an untagged bridge (when it
 * happened), the warnings, and the apply it started. The confirm itself is the
 * app-wide apply banner's job; this links to the gateway's pending changes.
 */
export function NetworkWriteResult({ result, gatewayId }: { result: NetworkWrite; gatewayId: number }) {
  const apply = result.apply
  return (
    <div className="space-y-3">
      {result.converted ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
          <ArrowsClockwise className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="space-y-1">
            <p className="font-medium">
              {result.converted.bridge} now filters VLANs; its existing members are VLAN {result.converted.untaggedVlan}.
            </p>
            <p className="text-muted-foreground">
              Moved to {result.converted.bridge}.{result.converted.untaggedVlan}:{' '}
              <span className="font-mono">{result.converted.moved.join(', ') || 'nothing'}</span>. The ports keep
              carrying those networks untagged, so nothing plugged in notices.
            </p>
          </div>
        </div>
      ) : null}

      <IssueList issues={result.issues} />

      {apply ? (
        <div className="flex items-start gap-2 rounded-md border border-border p-2.5 text-xs">
          {apply.state === 'confirmed' ? (
            <CheckCircle className="mt-0.5 size-4 shrink-0 text-status-good" />
          ) : apply.protected ? (
            <ShieldWarning className="mt-0.5 size-4 shrink-0 text-status-warning" />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          )}
          <div className="space-y-1">
            <p className="font-medium">Apply: {APPLY_STATE_LABELS[apply.state]}</p>
            <p className="text-muted-foreground">
              {apply.protected
                ? `This change touches the path the gateway uses to reach Perch, so it goes out on its own with a longer confirm window (${Math.round(apply.confirmTimeoutSeconds / 60)} min). If the gateway does not come back, the router rolls it back by itself.`
                : `The router keeps the change once it reconnects and it is confirmed (within ${apply.confirmTimeoutSeconds} s); otherwise it rolls back by itself.`}{' '}
              Follow it in the banner at the top.
            </p>
            <Link to={applyChangesPath(gatewayId)} className="inline-block text-primary underline underline-offset-2">
              See the changes and applies
            </Link>
          </div>
        </div>
      ) : result.applyError ? (
        <div className="flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 p-2.5 text-xs">
          <Warning className="mt-0.5 size-4 shrink-0 text-status-warning" />
          <div className="space-y-1">
            <p className="font-medium">Saved as a draft; no apply started.</p>
            <p className="text-muted-foreground">{result.applyError.message}</p>
            <Link to={applyChangesPath(gatewayId)} className="inline-block text-primary underline underline-offset-2">
              Open the pending changes
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  )
}
