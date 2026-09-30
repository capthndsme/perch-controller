import type { ReactNode } from 'react'
import { Export, LockOpen, PlusSquare, Prohibit, Warning } from '@phosphor-icons/react'
import { PLAIN_HTTP_DOCS_URL } from '@/lib/transport-security'
import { cn } from '@/lib/utils'

/**
 * Why this browser cannot take pushes, and what to do instead (design README §0.3–§0.4). Shown by the
 * Notifications page's "This device" card in place of the button.
 */

function Note({ icon, title, children, tone = 'muted' }: { icon: ReactNode; title: string; children: ReactNode; tone?: 'muted' | 'warning' }) {
  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border p-3 text-xs',
        tone === 'warning' ? 'border-status-warning/40 bg-status-warning/5' : 'border-border bg-muted/30',
      )}
    >
      <p className="flex items-center gap-2 text-[13px] font-medium">
        {icon}
        {title}
      </p>
      <div className="space-y-2 text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">{children}</div>
    </div>
  )
}

/** A plain-HTTP dashboard: browsers allow push only on HTTPS; what works instead, in order. */
export function PlainHttpPushNote({ isAdmin }: { isAdmin: boolean }) {
  return (
    <Note icon={<LockOpen className="size-4 text-status-warning" />} title="Push notifications need HTTPS" tone="warning">
      <p>
        This dashboard is served over plain HTTP. Browsers only let a page receive push notifications over HTTPS (or on
        localhost): that is a browser rule, and there is no setting around it. What works on this install instead:
      </p>
      <ol className="list-decimal space-y-1.5 pl-4">
        <li>
          <strong>The inbox and the bell</strong> in this dashboard, always.
        </li>
        <li>
          <strong>ntfy</strong>, self-hosted on your network or ntfy.sh: its Android app notifies you straight from a
          self-hosted server, even while the internet is down.
        </li>
        <li>
          <strong>Home Assistant</strong> (its phone app notifies you), <strong>Gotify</strong>, <strong>Telegram</strong>,{' '}
          <strong>Discord</strong> or <strong>Slack</strong>.
          {isAdmin ? ' Add one under Webhooks below.' : ' An admin adds them under Webhooks.'}
        </li>
        <li>
          <strong>HTTPS for the controller</strong>: a reverse proxy with a real certificate (a DNS challenge works for
          names only used at home) or a Tailscale HTTPS name.{' '}
          <a href={PLAIN_HTTP_DOCS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            How
          </a>
        </li>
      </ol>
    </Note>
  )
}

/** iPhone or iPad in a Safari tab: push only exists in the Home Screen app. */
export function IosInstallNote() {
  return (
    <Note icon={<PlusSquare className="size-4 text-brand" />} title="Add Perch to your Home Screen first">
      <p>On iPhone and iPad, notifications work for web apps opened from the Home Screen (iOS 16.4 or later).</p>
      <ol className="list-decimal space-y-1.5 pl-4">
        <li>
          In Safari, tap <strong>Share</strong> <Export aria-label="(the share icon)" className="inline size-3.5 -translate-y-px" />{' '}
          in the toolbar.
        </li>
        <li>
          Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
        </li>
        <li>
          Open <strong>Perch</strong> from the Home Screen, sign in, and come back to Settings → Notifications to tap{' '}
          <strong>Notify this device</strong> there.
        </li>
      </ol>
    </Note>
  )
}

export function UnsupportedPushNote() {
  return (
    <Note icon={<Prohibit className="size-4 text-muted-foreground" />} title="This browser cannot receive push notifications">
      <p>
        Chrome, Edge, Firefox and Safari (macOS 13 or later, iOS 16.4 or later from the Home Screen) can. In Brave, turn
        on “Use Google services for push messaging” in its settings first.
      </p>
    </Note>
  )
}

export function DeniedPushNote() {
  return (
    <Note icon={<Warning className="size-4 text-status-warning" />} title="Notifications are blocked for this site">
      <p>
        The browser remembers that notifications were refused here, so Perch cannot ask again. Allow them in the site
        settings (the icon left of the address, then Notifications), or on a phone in the system settings for this
        browser or the Perch app, then reload this page.
      </p>
    </Note>
  )
}
