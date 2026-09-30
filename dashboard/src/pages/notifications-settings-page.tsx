import { Link } from 'react-router-dom'
import { CaretRight } from '@phosphor-icons/react'
import { PushDeviceCard } from '@/components/alerts/push-device-card'
import { PushDevicesList } from '@/components/alerts/push-devices-list'
import { WebhooksCard } from '@/components/alerts/webhooks-card'
import { PageHeader } from '@/components/layout/page-header'
import { useProfile } from '@/hooks/use-auth'
import { useThisDevice } from '@/hooks/use-push'

/**
 * Settings → Notifications (design README §5), for every user: this device (Web Push), the user's other
 * devices, and for admins the webhooks. On a plain-HTTP dashboard the push card explains why push cannot
 * work there and what does; no service worker is registered then.
 */
export function NotificationsSettingsPage() {
  const isAdmin = useProfile().data?.role === 'admin'
  const device = useThisDevice()
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <PageHeader
        title="Notifications"
        description="Where alerts reach you when you are not looking at Perch."
        crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Notifications' }]}
      />
      <PushDeviceCard device={device} isAdmin={isAdmin} />
      <PushDevicesList thisHash={device.state.kind === 'loading' ? undefined : device.thisHash} isAdmin={isAdmin} />
      {isAdmin ? <WebhooksCard /> : null}
      {isAdmin ? (
        <Link
          to="/settings/alerts"
          className="card-surface flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-base hover:bg-muted/40 active:bg-muted/70 active:duration-0"
        >
          <span className="min-w-0">
            <span className="block text-[13px] font-medium">Alert rules and quiet hours</span>
            <span className="block text-xs text-muted-foreground">
              What raises an alert, how long it must hold, what is sent, and when to stay quiet.
            </span>
          </span>
          <CaretRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      ) : null}
    </div>
  )
}
