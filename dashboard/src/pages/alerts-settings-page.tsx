import { Link, useSearchParams } from 'react-router-dom'
import { CaretRight } from '@phosphor-icons/react'
import {
  DeliveryOffBanner,
  GeneralSettingsCard,
  PushKeysCard,
  QuietHoursCard,
  TestAlertCard,
} from '@/components/alerts/alert-settings-cards'
import { RulesList } from '@/components/alerts/rules-list'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { PageSpinner } from '@/components/ui/spinner'
import { useAlertSettings } from '@/hooks/use-alert-settings'
import { useAlertCatalogue } from '@/hooks/use-alerts'
import { useProfile } from '@/hooks/use-auth'
import { ApiError } from '@/lib/api'
import type { Category } from '@/types/alerts'

/**
 * Settings → Alerts (design README §5), admin only: a test, quiet hours, the rules of every alert type
 * (`?type=` opens one, so "Edit rule" on an alert lands in its drawer), links and limits, the push keys.
 */
export function AlertsSettingsPage() {
  const isAdmin = useProfile().data?.role === 'admin'
  const query = useAlertSettings({ enabled: isAdmin })
  const catalogue = useAlertCatalogue()
  const [search, setSearch] = useSearchParams()
  const openType = search.get('type')

  const header = (
    <PageHeader
      title="Alerts"
      description="What raises an alert, what is sent, and when to stay quiet."
      crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Alerts' }]}
    />
  )

  if (!isAdmin) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        {header}
        <p className="text-sm text-muted-foreground">
          Only admins change alert rules.{' '}
          <Link to="/settings/notifications" className="underline underline-offset-2">
            Your notifications
          </Link>
        </p>
      </div>
    )
  }
  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        {header}
        <EmptyState title="This controller has no alerts" description="They arrive with a newer version of Perch Network Controller." />
      </div>
    )
  }
  if (!query.data) {
    if (query.error) return <p className="text-sm text-destructive">{query.error.message}</p>
    return <PageSpinner label="Loading alert settings" />
  }

  const view = query.data
  const categoryLabels: Partial<Record<Category, string>> = Object.fromEntries(
    (catalogue.data?.categories ?? []).map((category) => [category.key, category.label]),
  )

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      {header}
      {!view.deliveryEnabled ? <DeliveryOffBanner /> : null}
      <Link
        to="/settings/notifications"
        className="card-surface flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-base hover:bg-muted/40 active:bg-muted/70 active:duration-0"
      >
        <span className="min-w-0">
          <span className="block text-[13px] font-medium">Notifications</span>
          <span className="block text-xs text-muted-foreground">Push on this device and others, and webhooks.</span>
        </span>
        <CaretRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>
      <TestAlertCard deliveryEnabled={view.deliveryEnabled} />
      <QuietHoursCard view={view} />
      <section className="space-y-3">
        <div className="space-y-0.5">
          <h2 className="text-sm font-semibold">Rules</h2>
          <p className="text-xs text-muted-foreground">
            Everything is recorded in the inbox; a rule decides whether and how it is sent. Tap one for its timing.
          </p>
        </div>
        <RulesList
          view={view}
          categoryLabels={categoryLabels}
          openType={openType}
          onOpenType={(type) =>
            setSearch(
              (current) => {
                const next = new URLSearchParams(current)
                if (type) next.set('type', type)
                else next.delete('type')
                return next
              },
              { replace: true },
            )
          }
        />
      </section>
      <GeneralSettingsCard view={view} />
      <PushKeysCard view={view} />
    </div>
  )
}
