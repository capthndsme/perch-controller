import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle } from '@phosphor-icons/react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageSpinner } from '@/components/ui/spinner'
import { useDeviceGroupSettings, useUpdateDeviceGroupSettings } from '@/hooks/use-device-groups'
import { ApiError, fieldErrorsFromApi } from '@/lib/api'
import { textareaClassName } from '@/lib/portal'
import type { DeviceGroupSettingsView } from '@/types/device-groups'

/**
 * Settings → Device groups (docs/gateway/device-groups.md section 8): the
 * shared SSIDs the groups' Wi-Fi keys and bindings apply to, and how long an
 * access point waits for the controller's confirm before it rolls back.
 */
export function DeviceGroupsSettingsPage() {
  const query = useDeviceGroupSettings()
  if (query.data) return <SettingsForm view={query.data} />
  if (query.error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-destructive">
          {query.error instanceof ApiError && query.error.status === 403 ? 'Only admins can view this settings page.' : query.error.message}
        </p>
      </div>
    )
  }
  return <PageSpinner label="Loading device group settings" />
}

function SettingsForm({ view }: { view: DeviceGroupSettingsView }) {
  const update = useUpdateDeviceGroupSettings()
  const [ssids, setSsids] = useState(view.settings.ssids.join('\n'))
  const [confirm, setConfirm] = useState(String(view.settings.confirmSeconds))
  const [saved, setSaved] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const fieldErrors = update.error ? fieldErrorsFromApi(update.error) : {}
  const { min, max } = view.limits.confirmSeconds

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaved(false)
    setFormError(null)
    const list = ssids
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const seconds = Number(confirm)
    if (!Number.isInteger(seconds)) {
      setFormError('The confirm window is a whole number of seconds.')
      return
    }
    try {
      const next = await update.mutateAsync({ ssids: list, confirmSeconds: seconds })
      setSsids(next.settings.ssids.join('\n'))
      setConfirm(String(next.settings.confirmSeconds))
      setSaved(true)
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Failed to save the device group settings.')
    }
  }

  return (
    <div className="w-full max-w-3xl">
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Device groups</CardTitle>
          <CardDescription>
            Where the groups’ Wi-Fi keys and bindings go on the access points. The groups themselves are on the{' '}
            <Link to="/groups" className="underline underline-offset-2">
              Device groups page
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit}>
          <CardContent className="space-y-6 py-6">
            {formError ? <FormError message={formError} /> : null}
            {saved ? (
              <Alert className="rounded-lg border-primary/20 bg-primary/5">
                <CheckCircle className="size-4 text-primary" />
                <AlertTitle>Saved</AlertTitle>
                <AlertDescription>The access points get the change within a few seconds.</AlertDescription>
              </Alert>
            ) : null}
            <section className={formClassName()}>
              <Field
                label="Shared SSIDs"
                htmlFor="dg-ssids"
                hint={`One per line, exactly as the access points broadcast them (at most ${view.limits.ssids.max}). Each needs a WPA-PSK or SAE passphrase of its own: that is the onboarding key, the group keys are extra.`}
                error={fieldErrors.ssids}
              >
                <textarea id="dg-ssids" rows={4} value={ssids} onChange={(e) => setSsids(e.target.value)} className={textareaClassName} />
              </Field>
              <Field
                label="Confirm window (seconds)"
                htmlFor="dg-confirm"
                hint={`An access point that does not hear back from the controller this long after a change rolls it back. Default ${view.defaults.confirmSeconds} (${min}–${max}).`}
                error={fieldErrors.confirmSeconds}
              >
                <Input id="dg-confirm" inputMode="numeric" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </Field>
            </section>
          </CardContent>
          <CardFooter className="justify-end border-t">
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
