import { useState } from 'react'
import { ArrowRight } from '@phosphor-icons/react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useSetupLogin } from '@/hooks/use-setup'
import { ApiError, apiErrorCode } from '@/lib/api'

/** Why a setup sign-in failed, in words. */
function signInErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not reach the controller. Try again.'
  const code = apiErrorCode(error)
  if (error.status === 429) {
    const body = error.body as { retryAfterSeconds?: unknown } | null
    const seconds = typeof body?.retryAfterSeconds === 'number' ? body.retryAfterSeconds : null
    if (seconds === null) return 'Too many attempts. Try again later.'
    const minutes = Math.max(1, Math.ceil(seconds / 60))
    return `Too many attempts. Try again in ${minutes} min.`
  }
  if (error.status === 401 || code === 'invalid_credentials') {
    return 'Email or password is wrong. Use the admin account created in step 1.'
  }
  if (code === 'setup_complete') return 'Setup is already complete. Reload the page to sign in.'
  return error.message
}

/**
 * Shown when setup is past step 1 but this browser holds no setup session
 * (tab closed, another browser, cleared storage). The admin account from
 * step 1 continues the wizard; nothing is reset.
 */
export function SetupSignIn() {
  const login = useSetupLogin()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    try {
      await login.mutateAsync({ email: email.trim(), password })
    } catch (error) {
      setFormError(signInErrorMessage(error))
    }
  }

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="border-b">
        <CardTitle className="text-lg">Sign in to continue setup</CardTitle>
        <CardDescription>
          The admin account already exists. Sign in with the email and password from step 1 to
          pick up where setup left off.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="pt-6">
          {formError ? <FormError message={formError} /> : null}
          <div className={formClassName()}>
            <Field label="Email" htmlFor="setupEmail">
              <Input
                id="setupEmail"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="rounded-md"
              />
            </Field>
            <Field label="Password" htmlFor="setupPassword">
              <Input
                id="setupPassword"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="rounded-md"
              />
            </Field>
          </div>
        </CardContent>
        <CardFooter className="justify-end gap-2 border-t bg-muted/20">
          <Button type="submit" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Continue setup'}
            {!login.isPending ? <ArrowRight className="size-3.5" /> : null}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
