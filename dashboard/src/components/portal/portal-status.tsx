import { ArrowCircleUp, CloudSlash, Hourglass, WarningCircle } from '@phosphor-icons/react'
import { Badge } from '@/components/ui/badge'
import { DeliveryBadge, Fact } from '@/components/portal/portal-ui'
import { portalHealth, relativeTime } from '@/lib/portal'
import { cn } from '@/lib/utils'
import type { Portal } from '@/types/api'

const ENFORCEMENT_LABELS: Record<Portal['enforcement'], string> = {
  perch_nft: 'Perch (nftables)',
  opennds: 'openNDS',
}

const TONE_CLASSES = {
  good: 'border-status-good/30 bg-status-good/10 text-status-good',
  warning: 'border-status-warning/40 bg-status-warning/10 text-foreground',
  bad: 'border-destructive/30 bg-destructive/10 text-destructive',
  muted: 'border-border bg-muted text-muted-foreground',
} as const

export function PortalHealthBadge({ portal }: { portal: Portal }) {
  const health = portalHealth(portal)
  return (
    <Badge variant="outline" className={cn('rounded-sm', TONE_CLASSES[health.tone])}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {health.label}
    </Badge>
  )
}

/**
 * Notices a portal needs before anything else: a collector that cannot run
 * portals ("update the collector"), a gateway that is offline (changes wait
 * for it), and the issues the router reported.
 */
export function PortalNotices({ portal }: { portal: Portal }) {
  const notices: Array<{ key: string; icon: typeof WarningCircle; tone: 'bad' | 'warning' | 'muted'; title: string; text: string }> = []
  const gateway = portal.gateway
  if (gateway?.portalCapable === false) {
    notices.push({
      key: 'capable',
      icon: ArrowCircleUp,
      tone: 'bad',
      title: 'Update the collector on this gateway',
      text: 'The perch-collector running on the gateway does not support the guest portal. Install a current perch-collector package on the router; the portal starts on its own once it reconnects.',
    })
  } else if (gateway && gateway.portalCapable === null) {
    notices.push({
      key: 'capable-unknown',
      icon: Hourglass,
      tone: 'muted',
      title: 'Waiting for the gateway',
      text: 'The gateway has not said yet whether it can run a portal. This clears when its collector connects.',
    })
  }
  if (gateway && !gateway.online) {
    notices.push({
      key: 'offline',
      icon: CloudSlash,
      tone: 'warning',
      title: 'Gateway offline',
      text: 'Changes are kept and delivered when the gateway is back. Guests already online stay online, and the gateway keeps redeeming the vouchers it holds.',
    })
  }
  for (const [index, issue] of portal.status.issues.entries()) {
    notices.push({ key: `issue-${index}`, icon: WarningCircle, tone: 'warning', title: 'Reported by the gateway', text: issue })
  }
  if (notices.length === 0) return null
  return (
    <div className="space-y-2">
      {notices.map((notice) => (
        <div
          key={notice.key}
          role="status"
          className={cn(
            'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs',
            notice.tone === 'bad'
              ? 'border-destructive/30 bg-destructive/5'
              : notice.tone === 'warning'
                ? 'border-status-warning/40 bg-status-warning/5'
                : 'border-border bg-muted/30',
          )}
        >
          <notice.icon
            className={cn(
              'mt-0.5 size-4 shrink-0',
              notice.tone === 'bad' ? 'text-destructive' : notice.tone === 'warning' ? 'text-status-warning' : 'text-muted-foreground',
            )}
          />
          <div className="space-y-0.5">
            <p className="font-medium">{notice.title}</p>
            <p className="text-muted-foreground">{notice.text}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Clients and router facts, compact (card) or as a fact grid (detail header). */
export function PortalStatusFacts({ portal }: { portal: Portal }) {
  const { status } = portal
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
      <Fact label="Online">{status.clients.authenticated}</Fact>
      <Fact label="Waiting / idle">
        {status.clients.pending} / {status.clients.paused}
      </Fact>
      <Fact label="Queued">{status.clients.queued}</Fact>
      <Fact label="Enforcement">{ENFORCEMENT_LABELS[portal.enforcement]}</Fact>
      <Fact label="Sign-in page">
        {status.fas === 'ok' ? 'Serving' : status.fas === 'misconfigured' ? 'Misconfigured' : 'Unknown'}
        {status.listen ? <span className="ml-1 font-mono text-[11px] text-muted-foreground">{status.listen}</span> : null}
      </Fact>
      <Fact label="Configuration">
        <span className="inline-flex items-center gap-1.5">
          rev {status.revision}
          {status.appliedRevision !== null && status.appliedRevision !== status.revision ? (
            <span className="text-muted-foreground">(router: {status.appliedRevision})</span>
          ) : null}
          <DeliveryBadge delivery={status.delivery} />
        </span>
      </Fact>
      <Fact label="Last report">{relativeTime(status.lastReportAt)}</Fact>
      <Fact label="Last configured">{relativeTime(status.lastConfiguredAt)}</Fact>
    </dl>
  )
}

