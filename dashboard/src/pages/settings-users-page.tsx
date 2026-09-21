import { useState } from 'react'
import { CheckCircle, Plus, Trash, User as UserIcon } from '@phosphor-icons/react'
import { Field, FormError, formClassName } from '@/components/setup/form-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useProfile, fieldErrorsFromApi } from '@/hooks/use-auth'
import { useCreateUser, useDeleteUser, useUpdateUserRole, useUsers } from '@/hooks/use-users'
import { ApiError } from '@/lib/api'

export function SettingsUsersPage() {
  const profile = useProfile()
  const usersQuery = useUsers()
  const createUser = useCreateUser()
  const updateRole = useUpdateUserRole()
  const deleteUser = useDeleteUser()

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [role, setRole] = useState('viewer')

  const [formError, setFormError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  const currentUser = profile.data
  const isAdmin = currentUser?.role === 'admin'

  if (profile.isPending || usersQuery.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading users…</p>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-destructive">Only admins can view this page.</p>
      </div>
    )
  }

  const fieldErrors = createUser.error ? fieldErrorsFromApi(createUser.error) : {}

  async function onCreateUser(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    setSuccessMessage(null)

    try {
      const newUser = await createUser.mutateAsync({
        fullName: fullName.trim() || null,
        email: email.trim(),
        password,
        passwordConfirmation,
        role,
      })
      setFullName('')
      setEmail('')
      setPassword('')
      setPasswordConfirmation('')
      setRole('viewer')
      setSuccessMessage(`User "${newUser.fullName || newUser.email}" successfully invited.`)
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 403) {
          setFormError('Only admins can create users.')
        } else if (error.status !== 422) {
          setFormError(error.message)
        }
      } else {
        setFormError('An unexpected error occurred.')
      }
    }
  }

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Invite User</CardTitle>
          <CardDescription>
            Create an account with a temporary password. The user will be required to change it on their first login.
          </CardDescription>
        </CardHeader>
        <form onSubmit={onCreateUser}>
          <CardContent className="pt-6">
            {formError ? <FormError message={formError} /> : null}
            {successMessage ? (
              <Alert className="rounded-lg border-primary/20 bg-primary/5">
                <CheckCircle className="size-4 text-primary" />
                <AlertTitle>Invited</AlertTitle>
                <AlertDescription>{successMessage}</AlertDescription>
              </Alert>
            ) : null}

            <div className={formClassName('grid gap-4 sm:grid-cols-2 space-y-0 pt-2')}>
              <Field label="Full Name" htmlFor="fullName" error={fieldErrors.fullName}>
                <Input
                  id="fullName"
                  type="text"
                  placeholder="e.g. John Doe"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="rounded-md"
                />
              </Field>

              <Field label="Email Address" htmlFor="email" error={fieldErrors.email}>
                <Input
                  id="email"
                  type="email"
                  placeholder="name@example.com"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded-md"
                />
              </Field>

              <Field label="Temporary Password" htmlFor="password" error={fieldErrors.password}>
                <Input
                  id="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="rounded-md"
                />
              </Field>

              <Field
                label="Confirm Temporary Password"
                htmlFor="passwordConfirmation"
                error={fieldErrors.passwordConfirmation}
              >
                <Input
                  id="passwordConfirmation"
                  type="password"
                  required
                  value={passwordConfirmation}
                  onChange={(e) => setPasswordConfirmation(e.target.value)}
                  className="rounded-md"
                />
              </Field>

              <Field label="Role" htmlFor="role" error={fieldErrors.role} hint="Viewers have read-only access to all dashboards.">
                <select
                  id="role"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
                >
                  <option value="viewer">Viewer (Read-only)</option>
                  <option value="admin">Admin (Full Access)</option>
                </select>
              </Field>
            </div>
          </CardContent>
          <CardFooter className="justify-end gap-2 border-t bg-muted/20">
            <Button type="submit" disabled={createUser.isPending}>
              <Plus className="size-3.5" />
              {createUser.isPending ? 'Inviting…' : 'Invite user'}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">User Accounts</h2>
        {usersQuery.error ? (
          <p className="text-sm text-destructive">{usersQuery.error.message}</p>
        ) : (
          <div className="grid gap-3">
            {(usersQuery.data ?? []).map((user) => {
              const isSelf = user.id === currentUser?.id
              return (
                <Card key={user.id} className="rounded-lg py-3">
                  <CardHeader className="flex flex-row items-center gap-3 px-4 pb-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {user.initials || <UserIcon className="size-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium leading-none block truncate">
                          {user.fullName || 'User'}
                        </span>
                        {isSelf ? <Badge variant="secondary">You</Badge> : null}
                        {user.mustChangePassword ? (
                          <Badge variant="outline" className="border-warning/30 bg-warning/5 text-warning text-[10px]">
                            Temp Password
                          </Badge>
                        ) : null}
                      </div>
                      <span className="text-xs text-muted-foreground block truncate mt-0.5">
                        {user.email}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={user.role}
                        onChange={(e) => updateRole.mutate({ id: user.id, role: e.target.value })}
                        disabled={isSelf || updateRole.isPending}
                        className="h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                  </CardHeader>
                  <CardContent className="px-4 py-1 text-xs text-muted-foreground flex justify-between items-center">
                    <span>
                      Created: {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}
                    </span>
                    {!isSelf && (
                      <div>
                        {confirmDeleteId === user.id ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-destructive font-medium">Confirm delete?</span>
                            <Button
                              variant="destructive"
                              size="xs"
                              disabled={deleteUser.isPending}
                              onClick={() => {
                                deleteUser.mutate(user.id)
                                setConfirmDeleteId(null)
                              }}
                            >
                              Yes
                            </Button>
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              No
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => setConfirmDeleteId(user.id)}
                          >
                            <Trash className="size-3.5" />
                            <span className="sr-only">Delete user</span>
                          </Button>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
