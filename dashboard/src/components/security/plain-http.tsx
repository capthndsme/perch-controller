import { useState, type ReactNode } from 'react'
import { LockOpen, X } from '@phosphor-icons/react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { isDashboardPlainHttp, PLAIN_HTTP_DOCS_URL } from '@/lib/transport-security'
import { cn } from '@/lib/utils'

const AGENT_BODY =
  "These devices will talk to the controller over plain HTTP. Anyone who can intercept traffic on this network could read what they report, copy their credentials and pose as the controller. Put the controller and your access points on a management VLAN that client devices can't reach, or serve the controller over HTTPS."

const DISMISSED_KEY = 'perch-plain-http-notice-dismissed'

type PlainHttpNoticeProps = {
  /** Replaces the default body, which is written for agent install commands. */
  children?: ReactNode
  /** Shows a close button. */
  onDismiss?: () => void
  className?: string
}

/**
 * "Unencrypted connection": plain HTTP works, but only belongs on a
 * management VLAN. Shown next to install commands that use an http:// URL and
 * on the Settings pages when the dashboard itself is served over HTTP.
 */
export function PlainHttpNotice({ children, onDismiss, className }: PlainHttpNoticeProps) {
  return (
    <Alert className={cn('rounded-lg border-status-warning/40 bg-status-warning/5', className)}>
      {/* The alert paints its icons with currentColor; `!` keeps the warning tone. */}
      <LockOpen className="size-4 text-status-warning!" />
      <AlertTitle>Unencrypted connection</AlertTitle>
      <AlertDescription>
        <p>{children ?? AGENT_BODY}</p>
        <p>
          <a href={PLAIN_HTTP_DOCS_URL} target="_blank" rel="noreferrer">
            Learn more
          </a>
        </p>
      </AlertDescription>
      {onDismiss ? (
        <AlertAction>
          <Button type="button" size="xs" variant="ghost" onClick={onDismiss} aria-label="Dismiss">
            <X className="size-3.5" />
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  )
}

/** A device whose traffic with the controller is plain HTTP. */
export function UnencryptedBadge({ title }: { title: string }) {
  return (
    <Badge
      variant="outline"
      className="border-status-warning/50 bg-status-warning/10"
      title={title}
      aria-label={`Unencrypted. ${title}`}
    >
      <LockOpen aria-hidden className="text-status-warning" />
      Unencrypted
    </Badge>
  )
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1')
  } catch {
    // per-viewer convenience only
  }
}

/** Top of the Settings pages while the dashboard itself is served over plain HTTP. */
export function DashboardPlainHttpNotice() {
  const [dismissed, setDismissed] = useState(readDismissed)
  if (dismissed || !isDashboardPlainHttp()) return null
  return (
    <PlainHttpNotice
      onDismiss={() => {
        setDismissed(true)
        writeDismissed()
      }}
    >
      This dashboard is served over plain HTTP, so your sign-in and everything on these pages
      cross the network unencrypted. A management VLAN protects the agents, not this browser: open
      the dashboard only from a device on that VLAN (or over a VPN into it), or serve the controller
      over HTTPS.
    </PlainHttpNotice>
  )
}

/** One line under the sign-in and setup forms when the page came over plain HTTP. */
export function PlainHttpPageNote({ className }: { className?: string }) {
  if (!isDashboardPlainHttp()) return null
  return (
    <p className={cn('text-center text-[11px] text-muted-foreground', className)}>
      <LockOpen aria-hidden className="mr-1 inline size-3.5 -translate-y-px text-status-warning" />
      This page is not encrypted: open it only from the management VLAN, or serve the controller
      over HTTPS.
    </p>
  )
}
