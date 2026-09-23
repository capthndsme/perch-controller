import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight } from '@phosphor-icons/react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { SetupLayout } from '@/components/setup/setup-layout'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { fieldErrorsFromApi, useLogin } from '@/hooks/use-auth'
import { ApiError } from '@/lib/api'

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const login = useLogin()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const from = (location.state as { from?: string } | null)?.from ?? '/'

  const fieldErrors = login.error ? fieldErrorsFromApi(login.error) : {}

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)

    try {
      await login.mutateAsync({ email: email.trim(), password })
      navigate(from, { replace: true })
    } catch (error) {
      if (error instanceof ApiError && error.status !== 422) {
        setFormError(error.message)
      }
    }
  }

  return (
    <SetupLayout>
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Sign in</CardTitle>
          <CardDescription>
            Use your admin or operator account to access the dashboard.
          </CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit}>
          <CardContent className="pt-6">
            {formError ? <FormError message={formError} /> : null}
            <div className={formClassName()}>
              <Field label="Email" htmlFor="email" error={fieldErrors.email}>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="rounded-md"
                />
              </Field>
              <Field label="Password" htmlFor="password" error={fieldErrors.password}>
                <Input
                  id="password"
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
          <CardFooter className="justify-end border-t bg-muted/20">
            <Button type="submit" disabled={login.isPending}>
              {login.isPending ? 'Signing in…' : 'Sign in'}
              {!login.isPending ? <ArrowRight className="size-3.5" /> : null}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </SetupLayout>
  )
}
