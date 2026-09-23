import { useState } from 'react'
import { ArrowRight } from '@phosphor-icons/react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { fieldErrorsFromApi, useSetupInstance } from '@/hooks/use-setup'
import { ApiError } from '@/lib/api'
import { getTimezoneOptions, guessTimezone } from '@/lib/timezones'
import { useAuthStore } from '@/stores/auth-store'

export function InstanceStep() {
  const instance = useSetupInstance()
  const clearSession = useAuthStore((state) => state.clearSession)
  const timezones = getTimezoneOptions()
  const [siteName, setSiteName] = useState('')
  const [timezone, setTimezone] = useState(guessTimezone)
  const [formError, setFormError] = useState<string | null>(null)

  const fieldErrors = instance.error ? fieldErrorsFromApi(instance.error) : {}

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)

    try {
      await instance.mutateAsync({
        siteName: siteName.trim(),
        timezone,
      })
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) {
          // The session is gone: the setup page asks the admin to sign in again.
          clearSession()
        } else if (error.status !== 422) {
          setFormError(error.message)
        }
      }
    }
  }

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="border-b">
        <CardTitle className="text-lg">Instance settings</CardTitle>
        <CardDescription>
          How this deployment appears in the UI and which timezone buckets use.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="pt-6">
          {formError ? <FormError message={formError} /> : null}
          <div className={formClassName()}>
            <Field label="Site name" htmlFor="siteName" error={fieldErrors.siteName}>
              <Input
                id="siteName"
                required
                placeholder="Home lab"
                value={siteName}
                onChange={(event) => setSiteName(event.target.value)}
                className="rounded-md"
              />
            </Field>
            <Field label="Timezone" htmlFor="timezone" error={fieldErrors.timezone}>
              <select
                id="timezone"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
              >
                {timezones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </CardContent>
        <CardFooter className="justify-end gap-2 border-t bg-muted/20">
          <Button type="submit" disabled={instance.isPending}>
            {instance.isPending ? 'Saving…' : 'Continue'}
            {!instance.isPending ? <ArrowRight className="size-3.5" /> : null}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
