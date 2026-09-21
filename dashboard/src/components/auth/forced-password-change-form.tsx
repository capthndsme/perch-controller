import { useState } from 'react'
import { ArrowRight, SignOut } from '@phosphor-icons/react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { fieldErrorsFromApi, useChangePassword, useLogout } from '@/hooks/use-auth'
import { useThemeEffect } from '@/hooks/use-theme'
import { ApiError } from '@/lib/api'

export function ForcedPasswordChangeForm() {
  useThemeEffect()
  const changePassword = useChangePassword()
  const logout = useLogout()

  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const fieldErrors = changePassword.error ? fieldErrorsFromApi(changePassword.error) : {}

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)

    try {
      await changePassword.mutateAsync({
        currentPassword,
        password,
        passwordConfirmation,
      })
    } catch (error) {
      if (error instanceof ApiError && error.status !== 422) {
        setFormError(error.message)
      }
    }
  }

  return (
    <div className="relative min-h-svh overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--color-primary)_0%,_transparent_45%)] opacity-[0.07]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,var(--color-muted)_120%)] opacity-30"
      />
      <div className="relative mx-auto flex min-h-svh w-full max-w-md flex-col justify-center px-4 py-10">
        <div className="mb-8 space-y-2 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Security policy
          </p>
          <h1 className="text-2xl font-medium tracking-tight">Change password required</h1>
          <p className="text-sm text-muted-foreground">
            Please update the temporary password set by your administrator.
          </p>
        </div>

        <Card className="rounded-xl shadow-sm">
          <CardHeader className="border-b">
            <CardTitle className="text-lg">Update password</CardTitle>
            <CardDescription>
              Choose a strong password to secure your account.
            </CardDescription>
          </CardHeader>
          <form onSubmit={onSubmit}>
            <CardContent className="pt-6">
              {formError ? <FormError message={formError} /> : null}
              <div className={formClassName()}>
                <Field
                  label="Current Password"
                  htmlFor="currentPassword"
                  error={fieldErrors.currentPassword}
                >
                  <Input
                    id="currentPassword"
                    type="password"
                    autoComplete="current-password"
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
                    autoComplete="new-password"
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
                    autoComplete="new-password"
                    required
                    value={passwordConfirmation}
                    onChange={(event) => setPasswordConfirmation(event.target.value)}
                    className="rounded-md"
                  />
                </Field>
              </div>
            </CardContent>
            <CardFooter className="flex items-center justify-between border-t bg-muted/20">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => logout.mutate()}
                disabled={logout.isPending}
              >
                <SignOut className="mr-1.5 size-3.5" />
                Sign out
              </Button>
              <Button type="submit" disabled={changePassword.isPending}>
                {changePassword.isPending ? 'Updating…' : 'Update password'}
                {!changePassword.isPending ? <ArrowRight className="size-3.5" /> : null}
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  )
}
