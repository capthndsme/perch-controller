import { useId } from 'react'
import { Link } from 'react-router-dom'
import { Panel } from '@/components/ui/panel'
import { Switch } from '@/components/ui/switch'
import { useDeviceWatch, useUpdateDeviceWatch } from '@/hooks/use-alerts'
import { useProfile } from '@/hooks/use-auth'
import { ApiError } from '@/lib/api'

/**
 * "Alerts" on the device page (design README §5): alert when this device goes offline, or when it connects
 * (`PUT /alerts/watches/devices/:mac`). Admins switch; everyone sees the state. A controller without
 * alerts answers 404, and the card stays away.
 */
export function WatchSwitches({ mac }: { mac: string }) {
  const isAdmin = useProfile().data?.role === 'admin'
  const watch = useDeviceWatch(mac)
  const update = useUpdateDeviceWatch(mac)
  const id = useId()

  if (!mac || (watch.error instanceof ApiError && watch.error.status === 404)) return null
  const value = watch.data ?? { mac, label: null, offline: false, arrival: false }
  const disabled = !isAdmin || watch.isPending || update.isPending

  return (
    <Panel
      title="Alerts"
      description={
        isAdmin
          ? 'Offline follows the same presence rules as the device list.'
          : 'Offline follows the same presence rules as the device list. Only admins change these.'
      }
      actions={
        isAdmin ? (
          <Link to="/settings/alerts?type=device.offline" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            Rule
          </Link>
        ) : null
      }
    >
      <div className="space-y-3">
        <label htmlFor={`${id}-off`} className="flex items-center justify-between gap-4">
          <span className="text-xs">Alert when this device goes offline</span>
          <Switch
            id={`${id}-off`}
            checked={value.offline}
            disabled={disabled}
            onCheckedChange={(offline) => update.mutate({ offline, arrival: value.arrival })}
          />
        </label>
        <label htmlFor={`${id}-on`} className="flex items-center justify-between gap-4">
          <span className="text-xs">Alert when it connects</span>
          <Switch
            id={`${id}-on`}
            checked={value.arrival}
            disabled={disabled}
            onCheckedChange={(arrival) => update.mutate({ offline: value.offline, arrival })}
          />
        </label>
        {update.error ? <p className="text-xs text-destructive">{update.error.message}</p> : null}
      </div>
    </Panel>
  )
}
