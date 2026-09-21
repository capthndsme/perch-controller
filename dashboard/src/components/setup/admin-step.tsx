import { useState } from 'react'
import { ArrowRight } from '@phosphor-icons/react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { fieldErrorsFromApi, useSetupAdmin } from '@/hooks/use-setup'
import { ApiError } from '@/lib/api'

export function AdminStep() {
  const admin = useSetupAdmin()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const fieldErrors = admin.error ? fieldErrorsFromApi(admin.error) : {}

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)

    try {
      await admin.mutateAsync({
        fullName: fullName.trim() || null,
        email: email.trim(),
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
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="border-b">
        <CardTitle className="text-lg">Create admin account</CardTitle>
        <CardDescription>
          This account owns the instance. Public signup is disabled once setup
          finishes.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="pt-6">
          {formError ? <FormError message={formError} /> : null}
          <div className={formClassName()}>
            <Field label="Full name" htmlFor="fullName" error={fieldErrors.fullName}>
              <Input
                id="fullName"
                autoComplete="name"
                placeholder="Ada Lovelace"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                className="rounded-md"
              />
            </Field>
            <Field label="Email" htmlFor="email" error={fieldErrors.email}>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                placeholder="admin@home.lan"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="rounded-md"
              />
            </Field>
            <Field
              label="Password"
              htmlFor="password"
              hint="8–32 characters"
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
              label="Confirm password"
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
        <CardFooter className="justify-end gap-2 border-t bg-muted/20">
          <Button type="submit" disabled={admin.isPending}>
            {admin.isPending ? 'Creating…' : 'Continue'}
            {!admin.isPending ? <ArrowRight className="size-3.5" /> : null}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
