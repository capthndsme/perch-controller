import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle } from '@phosphor-icons/react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { fieldErrorsFromApi, useChangePassword, useProfile } from '@/hooks/use-auth'
import { useCollectors } from '@/hooks/use-collectors'
import { useAppStore, type Theme } from '@/stores/app-store'
import { ApiError } from '@/lib/api'

const THEMES: Theme[] = ['light', 'dark', 'system']

function labelForTheme(theme: Theme): string {
  if (theme === 'light') return 'Light'
  if (theme === 'dark') return 'Dark'
  return 'System'
}

export function SettingsPage() {
  const profile = useProfile()
  const theme = useAppStore((state) => state.theme)
  const setTheme = useAppStore((state) => state.setTheme)
  const isAdmin = profile.data?.role === 'admin'
  const collectors = useCollectors({ enabled: isAdmin })
  const pendingCollectors =
    collectors.data?.filter((collector) => collector.lifecycle === 'pending').length ?? 0

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Personal preferences and admin configuration in one place.
        </p>
      </div>

      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Appearance</CardTitle>
          <CardDescription>Choose the interface theme for this browser.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-6">
          <p className="text-xs text-muted-foreground">Theme</p>
          <div className="flex flex-wrap items-center gap-2">
            {THEMES.map((value) => (
              <Button
                key={value}
                type="button"
                variant={theme === value ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => setTheme(value)}
              >
                {labelForTheme(value)}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <ChangePasswordCard />

      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Admin configuration</CardTitle>
          <CardDescription>
            Manage collectors, user accounts, hostname enrichment, and OpenWrt WiFi source
            registration.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-6">
          {isAdmin ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    Collectors
                    {pendingCollectors > 0 ? (
                      <Badge variant="secondary">{pendingCollectors} pending</Badge>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Adopt collectors that connect on their own, register polled ones, and check their health.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/collectors">Open</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">User accounts</p>
                  <p className="text-xs text-muted-foreground">
                    Manage admin and viewer user credentials and roles.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/users">Open</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Hostname enrichment</p>
                  <p className="text-xs text-muted-foreground">
                    Configure command-based hostname resolution from OpenWrt data.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/hostname-enrichment">Open</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">WiFi sources</p>
                  <p className="text-xs text-muted-foreground">
                    Add APs with Perch AP Daemon join tokens, or register Prometheus endpoints.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/wifi-sources">Open</Link>
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Admin-only settings are hidden for your role.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ChangePasswordCard() {
  const changePassword = useChangePassword()
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const fieldErrors = changePassword.error ? fieldErrorsFromApi(changePassword.error) : {}

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    setSuccessMessage(null)

    try {
      await changePassword.mutateAsync({
        currentPassword,
        password,
        passwordConfirmation,
      })
      setCurrentPassword('')
      setPassword('')
      setPasswordConfirmation('')
      setSuccessMessage('Password updated successfully.')
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status !== 422) {
          setFormError(error.message)
        }
      } else {
        setFormError('Failed to change password.')
      }
    }
  }

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="border-b">
        <CardTitle className="text-lg">Change password</CardTitle>
        <CardDescription>Update your account password.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-4 pt-6">
          {formError ? <FormError message={formError} /> : null}
          {successMessage ? (
            <Alert className="rounded-lg border-primary/20 bg-primary/5">
              <CheckCircle className="size-4 text-primary" />
              <AlertTitle>Saved</AlertTitle>
              <AlertDescription>{successMessage}</AlertDescription>
            </Alert>
          ) : null}

          <div className={formClassName()}>
            <Field
              label="Current Password"
              htmlFor="currentPassword"
              error={fieldErrors.currentPassword}
            >
              <Input
                id="currentPassword"
                type="password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                className="rounded-md"
              />
            </Field>

            <Field
              label="New Password"
              htmlFor="password"
              error={fieldErrors.password}
            >
              <Input
                id="password"
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="rounded-md"
              />
            </Field>

            <Field
              label="Confirm New Password"
              htmlFor="passwordConfirmation"
              error={fieldErrors.passwordConfirmation}
            >
              <Input
                id="passwordConfirmation"
                type="password"
                required
                value={passwordConfirmation}
                onChange={(event) => setPasswordConfirmation(event.target.value)}
                className="rounded-md"
              />
            </Field>
          </div>
        </CardContent>
        <CardFooter className="justify-end border-t bg-muted/20">
          <Button type="submit" disabled={changePassword.isPending}>
            {changePassword.isPending ? 'Updating…' : 'Update password'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
