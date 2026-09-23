import { useState } from 'react'
import type { ReactNode } from 'react'
import { Key, Plus, WarningCircle } from '@phosphor-icons/react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { InstallCommands } from '@/components/wifi/install-commands'
import {
  useApAgentInstallInfo,
  useApJoinTokens,
  useCreateApJoinToken,
  useRevealApJoinToken,
  useRevokeApJoinToken,
} from '@/hooks/use-ap-agents'
import { ApiError } from '@/lib/api'
import {
  JOIN_TOKEN_EXPIRY_OPTIONS,
  apiErrorCode,
  expiryHours,
  formatTokenExpiry,
  formatTokenUses,
  joinTokenStatusDotClass,
  joinTokenStatusLabel,
  type JoinTokenExpiryId,
} from '@/lib/ap-agents'
import { formatLastSeen } from '@/lib/collectors'
import type { ApJoinToken, ApJoinTokenStatus, CreateApJoinTokenResponse } from '@/types/api'

const TOKEN_GRID =
  'grid grid-cols-2 gap-x-3 gap-y-1.5 md:grid-cols-[minmax(0,1.6fr)_6rem_4.5rem_7rem_6.5rem_11rem] md:items-center'

function TokenStatusBadge({ status }: { status: ApJoinTokenStatus }) {
  return (
    <Badge variant={status === 'revoked' ? 'destructive' : 'outline'}>
      <span
        aria-hidden
        className={`mr-1 inline-block size-2 rounded-full ${joinTokenStatusDotClass(status)}`}
      />
      {joinTokenStatusLabel(status)}
    </Badge>
  )
}

/** A table cell that carries its own column label below `md`, where the header is hidden. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 text-xs tabular-nums">
      <span className="mr-1 text-muted-foreground md:hidden">{label}</span>
      {children}
    </div>
  )
}

function tokenName(token: ApJoinToken): string {
  return token.label ?? `${token.prefix}…`
}

/**
 * Settings → WiFi sources: join tokens for Perch AP Daemon (`perch-apd`)
 * (docs/ap-controller.md §4.1-4.2). Creating a token shows its install
 * commands right away; "Install command" on an active token shows them again.
 */
export function ApAgentsSection() {
  const tokens = useApJoinTokens({ refreshInterval: 15_000 })
  const installInfo = useApAgentInstallInfo()
  const create = useCreateApJoinToken()
  const reveal = useRevealApJoinToken()
  const revoke = useRevokeApJoinToken()

  const [label, setLabel] = useState('')
  const [expiry, setExpiry] = useState<JoinTokenExpiryId>('24h')
  const [singleUse, setSingleUse] = useState(false)
  const [created, setCreated] = useState<CreateApJoinTokenResponse | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [showRevoked, setShowRevoked] = useState(false)
  const [revealed, setRevealed] = useState<Record<number, string>>({})
  const [openInstallId, setOpenInstallId] = useState<number | null>(null)
  const [confirmRevokeId, setConfirmRevokeId] = useState<number | null>(null)
  const [rowError, setRowError] = useState<{ id: number; message: string } | null>(null)
  /** Revoking can hide the row, so its confirmation is shown above the list. */
  const [notice, setNotice] = useState<string | null>(null)

  const rows = tokens.data ?? []
  const revokedCount = rows.filter((token) => token.status === 'revoked').length
  const visible = showRevoked ? rows : rows.filter((token) => token.status !== 'revoked')
  const installError = installInfo.error ? installInfo.error.message : null

  async function onCreate(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    try {
      const result = await create.mutateAsync({
        label: label.trim() || null,
        expiresInHours: expiryHours(expiry),
        maxUses: singleUse ? 1 : null,
      })
      setCreated(result)
      setLabel('')
    } catch (cause) {
      setFormError(cause instanceof ApiError ? cause.message : 'Could not create the token.')
    }
  }

  async function onInstallCommand(token: ApJoinToken) {
    setRowError(null)
    setNotice(null)
    if (openInstallId === token.id) {
      setOpenInstallId(null)
      return
    }
    // The token just created shows its commands above: move them to its row
    // instead of showing the same block twice.
    if (created?.joinToken.id === token.id) {
      const createdToken = created.token
      setCreated(null)
      setRevealed((current) => ({ ...current, [token.id]: createdToken }))
      setOpenInstallId(token.id)
      return
    }
    if (revealed[token.id]) {
      setOpenInstallId(token.id)
      return
    }
    try {
      const result = await reveal.mutateAsync(token.id)
      setRevealed((current) => ({ ...current, [token.id]: result.token }))
      setOpenInstallId(token.id)
    } catch (cause) {
      setRowError({
        id: token.id,
        message:
          apiErrorCode(cause) === 'join_token_inactive'
            ? 'This token is no longer active.'
            : cause instanceof ApiError
              ? cause.message
              : 'Could not show the token.',
      })
    }
  }

  async function onRevoke(token: ApJoinToken) {
    setRowError(null)
    setNotice(null)
    try {
      await revoke.mutateAsync(token.id)
      setConfirmRevokeId(null)
      if (openInstallId === token.id) setOpenInstallId(null)
      setRevealed((current) => {
        const next = { ...current }
        delete next[token.id]
        return next
      })
      if (created?.joinToken.id === token.id) setCreated(null)
      setNotice(`Revoked ${tokenName(token)}. APs that already joined keep working.`)
    } catch (cause) {
      setConfirmRevokeId(null)
      setRowError({
        id: token.id,
        message: cause instanceof ApiError ? cause.message : 'Could not revoke the token.',
      })
    }
  }

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="border-b">
        <CardTitle className="text-lg">Access point agents (perch-apd)</CardTitle>
        <CardDescription>
          Install Perch AP Daemon on each OpenWrt AP. It replaces prometheus-node-exporter-lua for
          metrics and lets this dashboard kick clients, locate and reboot the AP without SSH. Create
          a join token, run its install command on the AP, done.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pt-6">
        <form onSubmit={onCreate} className="space-y-3">
          <p className="text-sm font-medium">New join token</p>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Label (optional)</span>
              <Input
                value={label}
                maxLength={80}
                placeholder="e.g. Upstairs APs"
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Expires after</span>
              <Segmented
                size="xs"
                ariaLabel="Token expiry"
                value={expiry}
                onChange={setExpiry}
                options={JOIN_TOKEN_EXPIRY_OPTIONS.map((option) => ({
                  id: option.id,
                  label: option.label,
                }))}
                className="w-fit"
              />
            </div>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Single use</span>
              <div className="flex h-8 items-center gap-2 rounded-md border px-3">
                <Switch checked={singleUse} onCheckedChange={setSingleUse} aria-label="Single use" />
                <span className="text-xs text-muted-foreground">{singleUse ? 'One AP' : 'Any number'}</span>
              </div>
            </label>
          </div>
          {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={create.isPending}>
              <Plus className="size-3.5" />
              {create.isPending ? 'Creating…' : 'Create token'}
            </Button>
          </div>
        </form>

        {created ? (
          <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Key className="size-3.5 text-primary" />
                  Token created{created.joinToken.label ? `: ${created.joinToken.label}` : ''}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Expires {formatTokenExpiry(created.joinToken.expiresAt)} ·{' '}
                  {created.joinToken.maxUses === 1 ? 'single use' : 'any number of APs'}. While it is
                  active, “Install command” in the list below shows it again.
                </p>
              </div>
              <Button type="button" size="xs" variant="ghost" onClick={() => setCreated(null)}>
                Done
              </Button>
            </div>
            <InstallCommands
              token={created.token}
              info={installInfo.data}
              infoLoading={installInfo.isPending}
              infoError={installError}
            />
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Join tokens</p>
            {revokedCount > 0 ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch
                  checked={showRevoked}
                  onCheckedChange={setShowRevoked}
                  aria-label="Show revoked tokens"
                />
                Show revoked ({revokedCount})
              </label>
            ) : null}
          </div>

          {notice ? <p className="text-xs text-primary">{notice}</p> : null}

          {tokens.isPending ? (
            <p className="text-xs text-muted-foreground">Loading join tokens…</p>
          ) : tokens.error && !tokens.data ? (
            <p className="text-xs text-destructive">{tokens.error.message}</p>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={<Key className="size-5" />}
              title={rows.length === 0 ? 'No join tokens yet' : 'No active tokens'}
              description={
                rows.length === 0
                  ? 'Create one above, then run its install command on the AP.'
                  : `${revokedCount} revoked ${revokedCount === 1 ? 'token is' : 'tokens are'} hidden.`
              }
            />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <div className={`${TOKEN_GRID} hidden border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground md:grid`}>
                <span>Token</span>
                <span>Status</span>
                <span>Uses</span>
                <span>Expires</span>
                <span>Last used</span>
                <span className="sr-only">Actions</span>
              </div>
              <div className="divide-y divide-border">
                {visible.map((token) => {
                  const revealing = reveal.isPending && reveal.variables === token.id
                  const installOpen = openInstallId === token.id && Boolean(revealed[token.id])
                  return (
                    <div key={token.id}>
                      <div className={`${TOKEN_GRID} px-3 py-2.5`}>
                        <div className="col-span-2 min-w-0 md:col-span-1">
                          <p className="truncate text-xs font-medium">
                            {token.label ?? <span className="text-muted-foreground">No label</span>}
                          </p>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">
                            {token.prefix}…
                            {token.createdBy ? (
                              <span className="font-sans"> · by {token.createdBy.email}</span>
                            ) : null}
                          </p>
                        </div>
                        <div className="col-span-2 md:col-span-1">
                          <TokenStatusBadge status={token.status} />
                        </div>
                        <Cell label="Uses">{formatTokenUses(token)}</Cell>
                        <Cell label="Expires">{formatTokenExpiry(token.expiresAt)}</Cell>
                        <Cell label="Last used">{formatLastSeen(token.lastUsedAt)}</Cell>
                        <div className="col-span-2 flex flex-wrap gap-2 md:col-span-1 md:justify-end">
                          {token.status === 'active' ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              disabled={revealing}
                              onClick={() => void onInstallCommand(token)}
                            >
                              {revealing ? 'Loading…' : installOpen ? 'Hide command' : 'Install command'}
                            </Button>
                          ) : null}
                          {token.status !== 'revoked' ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="destructive"
                              onClick={() => setConfirmRevokeId(token.id)}
                            >
                              Revoke
                            </Button>
                          ) : null}
                        </div>
                      </div>

                      {confirmRevokeId === token.id ? (
                        <div className="px-3 pb-3">
                          <Alert className="rounded-lg border-destructive/20 bg-destructive/5">
                            <WarningCircle className="size-4 text-destructive" />
                            <AlertTitle>Revoke {tokenName(token)}?</AlertTitle>
                            <AlertDescription>
                              <p>APs that already joined keep working. Nobody can join with it any more.</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="destructive"
                                  disabled={revoke.isPending}
                                  onClick={() => void onRevoke(token)}
                                >
                                  {revoke.isPending ? 'Revoking…' : 'Revoke'}
                                </Button>
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="outline"
                                  onClick={() => setConfirmRevokeId(null)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </AlertDescription>
                          </Alert>
                        </div>
                      ) : null}

                      {rowError?.id === token.id ? (
                        <p className="px-3 pb-2.5 text-xs text-destructive">{rowError.message}</p>
                      ) : null}

                      {installOpen ? (
                        <div className="border-t border-border bg-muted/10 p-3">
                          <InstallCommands
                            token={revealed[token.id]}
                            info={installInfo.data}
                            infoLoading={installInfo.isPending}
                            infoError={installError}
                          />
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
