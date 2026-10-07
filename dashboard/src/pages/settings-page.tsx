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
import { controllerVersionLabel, useVersion } from '@/hooks/use-version'
import { useAppStore, type Theme } from '@/stores/app-store'
import { ApiError } from '@/lib/api'
import { selectClassName } from '@/lib/portal'
import { cn } from '@/lib/utils'
import { readStartPage, startPagesFor, writeStartPage, type StartPageId } from '@/lib/start-page'

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
  const versionLabel = controllerVersionLabel(useVersion().data?.version)
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

      <ThisDeviceCard />

      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Notifications</CardTitle>
          <CardDescription>Get alerts on this phone or computer, even with Perch closed.</CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">Notifications</p>
              <p className="text-xs text-muted-foreground">
                Push to your devices{isAdmin ? ', and webhooks (ntfy, Home Assistant, Telegram…)' : ''}.
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to="/settings/notifications">Open</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <ChangePasswordCard />

      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Admin configuration</CardTitle>
          <CardDescription>
            Manage collectors, user accounts, hostname enrichment, OpenWrt WiFi source
            registration, presence thresholds, gateway observation, and chart detail.
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
                  <p className="text-sm font-medium">Alerts</p>
                  <p className="text-xs text-muted-foreground">
                    Rules for every alert type, quiet hours, the heartbeat and the push keys.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/alerts">Open</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Updates</p>
                  <p className="text-xs text-muted-foreground">
                    Update perch-apd and perch-collector on your devices: releases, rollouts, maintenance window.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/updates">Open</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">User accounts</p>
                  <p className="text-xs text-muted-foreground">
                    Manage admin, viewer and Wi-Fi vendor accounts and their roles.
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
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">WiFi management</p>
                  <p className="text-xs text-muted-foreground">
                    How WiFi changes are confirmed and rolled out to access points, and the fleet country.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/wifi-config">Open</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Presence</p>
                  <p className="text-xs text-muted-foreground">
                    When devices and WiFi clients count as connected, and how long an AP may stay
                    silent.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/presence">Open</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Gateway observation</p>
                  <p className="text-xs text-muted-foreground">
                    How long the router's past leases, neighbours and UPnP history are kept, and how
                    many router backups.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/gateway-observation">Open</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Gateway configuration</p>
                  <p className="text-xs text-muted-foreground">
                    How changes to managed gateways are confirmed, Authoritative Mode's grace delay, and writes
                    over plain HTTP.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/gateway-config">Open</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Gateway sync</p>
                  <p className="text-xs text-muted-foreground">
                    How the router verifies internet changes before they are kept, WAN edits under Authoritative
                    Mode, VPN peers and multi-WAN writes.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/gateway-sync">Open</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Charts</p>
                  <p className="text-xs text-muted-foreground">
                    Finest bucket and point cap of the server and destination traffic charts.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/charts">Open</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Guest portal</p>
                  <p className="text-xs text-muted-foreground">
                    History retention, sign-in rate limits, offline voucher redemption and the Paid Hotspot API rate.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/portal">Open</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Traffic shaping</p>
                  <p className="text-xs text-muted-foreground">
                    Lowest rates, bucket nesting and router memory for speed limits on managed gateways.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/traffic-shaping">Open</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Device groups</p>
                  <p className="text-xs text-muted-foreground">
                    The shared SSIDs that carry the groups’ Wi-Fi keys, and the access points’ confirm window.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/device-groups">Open</Link>
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

      {versionLabel ? <p className="text-[11px] text-muted-foreground">{versionLabel}</p> : null}
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

/**
 * Per-browser preferences (lib/start-page.ts): the page Perch opens on here.
 * A front-desk phone can open straight into Sell Mode.
 */
function ThisDeviceCard() {
  const profile = useProfile()
  const choices = startPagesFor(profile.data)
  const [startPage, setStartPage] = useState<StartPageId>(readStartPage)
  const value = choices.some((page) => page.id === startPage) ? startPage : 'dashboard'

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="border-b">
        <CardTitle className="text-lg">This device</CardTitle>
        <CardDescription>Kept in this browser only; other phones and computers keep their own.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 pt-6">
        <label htmlFor="start-page" className="block text-xs font-medium">
          Start page
        </label>
        <select
          id="start-page"
          className={cn(selectClassName, 'max-w-xs')}
          value={value}
          onChange={(event) => {
            const next = event.target.value as StartPageId
            setStartPage(next)
            writeStartPage(next)
          }}
        >
          {choices.map((page) => (
            <option key={page.id} value={page.id}>
              {page.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground">
          What Perch opens when it starts at its home address (a bookmark, the home-screen icon) or right after you
          sign in. Going back to the dashboard from inside Perch still shows the dashboard.
        </p>
      </CardContent>
    </Card>
  )
}
