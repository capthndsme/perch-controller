import { useId } from 'react'
import { BellRinging, BellSimpleSlash, PaperPlaneTilt } from '@phosphor-icons/react'
import { FiltersEditor } from '@/components/alerts/filters-editor'
import {
  DeniedPushNote,
  IosInstallNote,
  PlainHttpPushNote,
  UnsupportedPushNote,
} from '@/components/alerts/push-support'
import { TestResultLine } from '@/components/alerts/test-result'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Spinner } from '@/components/ui/spinner'
import { useTestPushSubscription, useUpdatePushSubscription, type useThisDevice } from '@/hooks/use-push'
import { formatAgo, PUSH_SERVICE_LABEL } from '@/lib/alerts'
import type { PushSubscriptionView } from '@/types/alerts'

/**
 * "This device" on Settings → Notifications (design README §5, delivery.md §1.6): the one button that
 * turns on Web Push for this browser, and once on, its name, filter, a test and "Turn off". Every state
 * that cannot push says why and what to do (plain HTTP, iOS outside the Home Screen, unsupported, blocked).
 */
export function PushDeviceCard({ device, isAdmin }: { device: ReturnType<typeof useThisDevice>; isAdmin: boolean }) {
  const state = device.state

  return (
    <Panel
      title="This device"
      description="Notifications on this phone or computer, even with Perch closed."
      actions={state.kind === 'on' ? <OnBadge row={state.row} /> : null}
    >
      {state.kind === 'insecure' ? (
        <PlainHttpPushNote isAdmin={isAdmin} />
      ) : state.kind === 'ios_needs_install' ? (
        <IosInstallNote />
      ) : state.kind === 'unsupported' ? (
        <UnsupportedPushNote />
      ) : state.kind === 'denied' ? (
        <DeniedPushNote />
      ) : state.kind === 'loading' ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" /> Checking this browser…
        </p>
      ) : state.kind === 'no_alerts' ? (
        <p className="text-xs text-muted-foreground">
          This controller has no alerts yet: they arrive with a newer version of Perch Network Controller.
        </p>
      ) : state.kind === 'error' ? (
        <p className="text-xs text-destructive">{state.message}</p>
      ) : state.kind === 'unavailable' ? (
        <p className="text-xs text-muted-foreground">
          {state.reason === 'delivery_disabled'
            ? 'Sending is switched off on this controller (ALERTS_DELIVERY=off), so push cannot be turned on here.'
            : isAdmin
              ? 'Push is unavailable: the controller cannot read its push keys (its APP_KEY changed). Regenerate them in Settings → Alerts.'
              : 'Push is unavailable on this controller right now. An admin can fix it in Settings → Alerts.'}
        </p>
      ) : state.kind === 'off' ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Get a notification here when something needs you: an access point going offline, the internet dropping, a
            change rolled back. The browser asks for permission first.
          </p>
          <Button size="lg" className="w-full sm:w-auto" onClick={device.enable} disabled={device.busy !== null}>
            {device.busy === 'enable' ? <Spinner className="text-current" /> : <BellRinging />}
            {device.busy === 'enable' ? 'Turning on…' : 'Notify this device'}
          </Button>
          {device.actionError ? <p className="text-xs text-destructive">{device.actionError}</p> : null}
        </div>
      ) : state.kind === 'on' ? (
        <DeviceOn
          row={state.row}
          busy={device.busy}
          onEnable={device.enable}
          onDisable={device.disable}
          error={device.actionError}
        />
      ) : null}
    </Panel>
  )
}

function OnBadge({ row }: { row: PushSubscriptionView }) {
  const text = row.state === 'gone' ? 'Stopped' : row.state === 'failing' ? 'Failing' : row.enabled ? 'On' : 'Paused'
  const tone =
    row.state === 'active' && row.enabled
      ? 'border-status-good/35 bg-status-good/10'
      : row.state === 'active'
        ? 'border-border bg-muted text-muted-foreground'
        : 'border-status-critical/35 bg-status-critical/10 text-status-critical'
  return <span className={`inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium ${tone}`}>{text}</span>
}

function DeviceOn({
  row,
  busy,
  onEnable,
  onDisable,
  error,
}: {
  row: PushSubscriptionView
  busy: 'enable' | 'disable' | null
  onEnable: () => void
  onDisable: () => void
  error: string | null
}) {
  const update = useUpdatePushSubscription()
  const test = useTestPushSubscription()
  const nameId = useId()

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Delivered through {PUSH_SERVICE_LABEL[row.pushService]}
        {row.lastSuccessAt ? `, last one ${formatAgo(row.lastSuccessAt)}` : ''}.
        {row.state !== 'active' && row.lastError ? <span className="block text-destructive">{row.lastError}</span> : null}
      </p>
      <div className="space-y-1.5">
        <label htmlFor={nameId} className="text-xs font-medium">
          Name
        </label>
        <Input
          key={`${row.id}-${row.label ?? ''}`}
          id={nameId}
          defaultValue={row.label ?? ''}
          placeholder={row.platform ?? 'This device'}
          maxLength={80}
          className="h-9 max-w-sm rounded-md"
          onBlur={(event) => {
            const label = event.target.value.trim() || null
            if (label !== row.label) update.mutate({ id: row.id, label })
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
      </div>
      <FiltersEditor
        idPrefix={`push-${row.id}`}
        value={row.filters}
        onChange={(filters) => update.mutate({ id: row.id, filters })}
      />
      {update.error ? <p className="text-xs text-destructive">{update.error.message}</p> : null}
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        {row.state === 'gone' ? (
          // The push service dropped it, or the controller's key changed: a fresh subscription fixes both.
          <Button onClick={onEnable} disabled={busy !== null}>
            <BellRinging />
            {busy === 'enable' ? 'Turning on…' : 'Turn on again'}
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => test.mutate(row.id)} disabled={test.isPending || row.state === 'gone'}>
          {test.isPending ? <Spinner /> : <PaperPlaneTilt />}
          Send a test
        </Button>
        <Button variant="ghost" onClick={onDisable} disabled={busy !== null}>
          <BellSimpleSlash />
          {busy === 'disable' ? 'Turning off…' : 'Turn off'}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <TestResultLine kind="push" data={test.data} error={test.error} />
    </div>
  )
}
