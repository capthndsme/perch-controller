import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle, Handshake, LinkBreak, LockKey, ShieldCheck, WarningCircle } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog, ErrorLine, FactRow, PasswordField, ToneBadge } from '@/components/gateway-config/bits'
import { useDialog } from '@/hooks/use-dialog'
import {
  useGatewayConfigSettings,
  useClearSignKey,
  useConfirmPairing,
  useSetSignKey,
  useStartPairing,
  useUnpair,
} from '@/hooks/use-gateways'
import { useNow } from '@/hooks/use-now'
import { apiErrorCode } from '@/lib/api'
import { formatCountdown, formatDateTime, refusalMessage, secondsUntil } from '@/lib/gateway-config'
import type { Gateway, GatewayPairing } from '@/types/gateway-config'

/**
 * Pairing (owner decision 29, config-plane.md section 4.4): on a plain-HTTP
 * gateway with both opt-ins, controller and router agree on a signing key
 * over the socket; both show a 6-digit code, the admin types the router's
 * code here and confirms on the router. TLS gateways need none of this.
 */
export function PairingPanel({ gateway, isAdmin }: { gateway: Gateway; isAdmin: boolean }) {
  const tls = gateway.secure === true && gateway.transportOk !== false
  const pairing = gateway.pairing

  if (tls) {
    return (
      <Panel title="Write security" description="How Perch’s writes reach the router.">
        <p className="flex items-start gap-2 text-xs">
          <ShieldCheck weight="fill" className="mt-px size-4 shrink-0 text-status-good" />
          <span>
            This gateway talks to the controller over verified TLS: writes travel encrypted and need no pairing.
          </span>
        </p>
      </Panel>
    )
  }

  return (
    <Panel
      title="Pairing"
      description="Plain HTTP: writes are signed with a key only the controller and the router hold."
      actions={pairing ? <PairingBadge pairing={pairing} /> : <ToneBadge tone="neutral">Not paired</ToneBadge>}
    >
      <div className="space-y-3 text-xs">
        <OptIns gateway={gateway} isAdmin={isAdmin} />
        {!pairing || pairing.state === 'expired' || pairing.state === 'failed' ? (
          <NotPaired gateway={gateway} pairing={pairing} isAdmin={isAdmin} />
        ) : pairing.state === 'awaiting_confirmation' || pairing.state === 'awaiting_router' ? (
          <Pairing gateway={gateway} pairing={pairing} isAdmin={isAdmin} />
        ) : (
          <Paired gateway={gateway} pairing={pairing} isAdmin={isAdmin} />
        )}
        {isAdmin && gateway.signingKey === 'config_sign_key' ? <SignKey gateway={gateway} /> : null}
      </div>
    </Panel>
  )
}

function PairingBadge({ pairing }: { pairing: GatewayPairing }) {
  switch (pairing.state) {
    case 'paired':
      return <ToneBadge tone="good" dot>Paired</ToneBadge>
    case 'lost':
      return <ToneBadge tone="critical" dot>Pairing lost</ToneBadge>
    case 'expired':
      return <ToneBadge tone="neutral">Expired</ToneBadge>
    case 'failed':
      return <ToneBadge tone="critical">Failed</ToneBadge>
    default:
      return <ToneBadge tone="warning" dot>Pairing…</ToneBadge>
  }
}

function OptIns({ gateway, isAdmin }: { gateway: Gateway; isAdmin: boolean }) {
  const settings = useGatewayConfigSettings({ enabled: isAdmin })
  const routerOk = gateway.allowInsecure === true
  // Admins read the controller's switch; for others it shows only when it blocks.
  const controllerOk = settings.data
    ? settings.data.settings.allowInsecureTransport
    : gateway.writeBlockedReason === 'insecure_transport' && routerOk
      ? false
      : null
  const controllerBlocked = controllerOk === false
  return (
    <div className="rounded-md border border-border p-2.5">
      <p className="section-label mb-1.5">Opt-ins (both needed)</p>
      <ul className="space-y-1">
        <li className="flex items-start gap-2">
          {controllerBlocked ? (
            <WarningCircle weight="fill" className="mt-px size-3.5 shrink-0 text-status-serious" />
          ) : controllerOk ? (
            <CheckCircle weight="fill" className="mt-px size-3.5 shrink-0 text-status-good" />
          ) : (
            <CheckCircle weight="fill" className="mt-px size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span>
            Controller: <em>Allow writes over plain HTTP</em> in{' '}
            <Link to="/settings/gateway-config" className="underline underline-offset-2">
              Settings → Gateway config
            </Link>
          </span>
        </li>
        <li className="flex items-start gap-2">
          {routerOk ? (
            <CheckCircle weight="fill" className="mt-px size-3.5 shrink-0 text-status-good" />
          ) : (
            <WarningCircle weight="fill" className="mt-px size-3.5 shrink-0 text-status-serious" />
          )}
          <span>
            Router: <code className="font-mono">uci set perch-collector.main.config_allow_insecure=1</code>{' '}
            {gateway.allowInsecure === null ? '(not reported yet)' : routerOk ? '(set)' : '(not set)'}
          </span>
        </li>
      </ul>
    </div>
  )
}

function NotPaired({ gateway, pairing, isAdmin }: { gateway: Gateway; pairing: GatewayPairing | null; isAdmin: boolean }) {
  const dialog = useDialog()
  const start = useStartPairing(gateway.id)
  const [password, setPassword] = useState('')

  async function submit() {
    try {
      await start.mutateAsync(password)
      dialog.setOpen(false)
    } catch {
      // shown in the dialog
    }
  }

  return (
    <div className="space-y-2">
      {pairing?.state === 'expired' ? (
        <p className="text-muted-foreground">The last pairing expired before both sides confirmed it.</p>
      ) : pairing?.state === 'failed' ? (
        <p className="text-status-critical">
          The last pairing failed{pairing.reason ? ` (${pairing.reason.replace(/_/g, ' ')})` : ''}. Three wrong codes end
          a pairing; if the codes never matched, someone may be between the controller and the router.
        </p>
      ) : (
        <p className="text-muted-foreground">
          Pairing runs a key agreement over the agent’s socket. The key never crosses the network, and both sides show
          the same 6-digit code: you compare them, so a man in the middle has one guess in a million.
        </p>
      )}
      {isAdmin ? (
        <Button size="sm" onClick={() => { setPassword(''); start.reset(); dialog.show() }} disabled={!gateway.online}>
          <Handshake weight="bold" />
          {pairing ? 'Pair again' : 'Start pairing'}
        </Button>
      ) : null}
      <ConfirmDialog
        open={dialog.open}
        onOpenChange={dialog.setOpen}
        title="Pair with the router"
        description="Perch and the router agree on a signing key and each show a 6-digit code."
        confirmLabel="Start pairing"
        pending={start.isPending}
        error={start.error && apiErrorCode(start.error) !== 'invalid_password' ? refusalMessage(start.error) : null}
        onConfirm={submit}
      >
        <PasswordField
          value={password}
          onChange={setPassword}
          autoFocus
          error={apiErrorCode(start.error) === 'invalid_password' ? refusalMessage(start.error) : null}
        />
      </ConfirmDialog>
    </div>
  )
}

function Pairing({ gateway, pairing, isAdmin }: { gateway: Gateway; pairing: GatewayPairing; isAdmin: boolean }) {
  const now = useNow()
  const confirm = useConfirmPairing(gateway.id)
  const unpair = useUnpair(gateway.id)
  const [code, setCode] = useState('')
  const left = secondsUntil(pairing.expiresAt, now)
  const sas = pairing.sas ?? '······'
  const pretty = `${sas.slice(0, 3)} ${sas.slice(3)}`
  const adminDone = pairing.adminConfirmedAt !== null
  const routerDone = pairing.routerConfirmedAt !== null
  const command = `perch-collector pair confirm ${pairing.sas ?? '<code>'}`

  return (
    <div className="space-y-3" data-testid="pairing-code">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
        <div>
          <p className="section-label">Code on this controller</p>
          <p className="font-mono text-4xl font-semibold tracking-[0.2em] tabular-nums sm:text-5xl" aria-label={`Pairing code ${sas.split('').join(' ')}`}>
            {pretty}
          </p>
        </div>
        {left !== null ? (
          <p className="text-muted-foreground">
            Expires in <span className="font-mono tabular-nums text-foreground">{formatCountdown(left)}</span>
          </p>
        ) : null}
      </div>

      <ol className="space-y-3">
        <li className="space-y-1.5">
          <p className="flex items-center gap-2 font-medium">
            {routerDone ? <CheckCircle weight="fill" className="size-4 text-status-good" /> : <span className="grid size-4 place-items-center rounded-full border text-[10px]">1</span>}
            On the router: check its code and confirm there
          </p>
          <p className="text-muted-foreground">
            In a shell on the router, <code className="font-mono">perch-collector pair status</code> shows the router’s
            code. If it is the same as the one above, confirm with:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[11px]">{command}</code>
            <CopyButton value={command} ariaLabel="Copy the confirm command" />
          </div>
          <p className="text-muted-foreground">If the codes differ, cancel: someone may be between the controller and the router.</p>
        </li>
        <li className="space-y-1.5">
          <p className="flex items-center gap-2 font-medium">
            {adminDone ? <CheckCircle weight="fill" className="size-4 text-status-good" /> : <span className="grid size-4 place-items-center rounded-full border text-[10px]">2</span>}
            Here: type the code the router shows
          </p>
          {adminDone ? (
            <p className="text-muted-foreground">Done. {routerDone ? '' : 'Waiting for the router’s confirmation…'}</p>
          ) : isAdmin ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                confirm.mutate(code)
              }}
            >
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                aria-label="The router's code"
                className="h-9 w-36 font-mono text-lg tracking-[0.3em]"
              />
              <Button type="submit" size="sm" disabled={code.length !== 6 || confirm.isPending}>
                {confirm.isPending ? <Spinner className="size-3.5 text-current" /> : null}
                Confirm code
              </Button>
              {pairing.attemptsLeft < 3 ? (
                <span className="text-muted-foreground">{pairing.attemptsLeft} attempt(s) left</span>
              ) : null}
            </form>
          ) : (
            <p className="text-muted-foreground">An admin types the code.</p>
          )}
          <ErrorLine message={confirm.error ? refusalMessage(confirm.error) : null} />
        </li>
      </ol>
      {isAdmin ? (
        <Button size="xs" variant="ghost" onClick={() => unpair.mutate()} disabled={unpair.isPending}>
          Cancel pairing
        </Button>
      ) : null}
    </div>
  )
}

function Paired({ gateway, pairing, isAdmin }: { gateway: Gateway; pairing: GatewayPairing; isAdmin: boolean }) {
  const dialog = useDialog()
  const unpair = useUnpair(gateway.id)
  const lost = pairing.state === 'lost'
  return (
    <div className="space-y-2">
      {lost ? (
        <p className="flex items-start gap-2 text-status-critical">
          <WarningCircle weight="fill" className="mt-px size-4 shrink-0" />
          The router no longer has the key (a factory reset or a reinstall). Remove this pairing and pair again.
        </p>
      ) : (
        <p className="flex items-start gap-2">
          <LockKey weight="fill" className="mt-px size-4 shrink-0 text-status-good" />
          Writes are signed with the paired key. Signing protects integrity and replay; the traffic itself is still
          readable on the network.
        </p>
      )}
      <div className="divide-y divide-border/70">
        <FactRow label="Key id">
          <span className="font-mono">{pairing.keyId}</span>
        </FactRow>
        <FactRow label="Paired">{formatDateTime(pairing.pairedAt)}</FactRow>
      </div>
      {isAdmin ? (
        <Button size="sm" variant="outline" onClick={() => { unpair.reset(); dialog.show() }}>
          <LinkBreak weight="bold" />
          {lost ? 'Remove pairing' : 'Unpair'}
        </Button>
      ) : null}
      <ConfirmDialog
        open={dialog.open}
        onOpenChange={dialog.setOpen}
        title={lost ? 'Remove the lost pairing?' : 'Unpair the router?'}
        description={
          lost
            ? 'The controller forgets the key; pair again afterwards.'
            : 'The router drops the key and Perch can no longer write over plain HTTP until you pair again.'
        }
        confirmLabel={lost ? 'Remove' : 'Unpair'}
        destructive
        pending={unpair.isPending}
        error={unpair.error ? refusalMessage(unpair.error) : null}
        onConfirm={async () => {
          try {
            await unpair.mutateAsync()
            dialog.setOpen(false)
          } catch {
            // shown
          }
        }}
      />
    </div>
  )
}

/** A router configured with its own `config_sign_key` (instead of a pairing). */
function SignKey({ gateway }: { gateway: Gateway }) {
  const set = useSetSignKey(gateway.id)
  const clear = useClearSignKey(gateway.id)
  const [key, setKey] = useState('')
  const [password, setPassword] = useState('')
  return (
    <div className="space-y-2 rounded-md border border-border p-2.5">
      <p className="font-medium">Router sign key</p>
      <p className="text-muted-foreground">
        This router signs with its own <code className="font-mono">config_sign_key</code>.{' '}
        {gateway.hasSignKey ? 'The controller holds it.' : 'Enter the same key here (stored encrypted, never shown again).'}
      </p>
      {gateway.hasSignKey ? (
        <Button size="xs" variant="outline" onClick={() => clear.mutate()} disabled={clear.isPending}>
          Forget the key
        </Button>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            set.mutate({ key, currentPassword: password })
          }}
        >
          <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="16 to 512 characters" aria-label="Sign key" autoComplete="off" />
          <PasswordField value={password} onChange={setPassword} />
          <Button type="submit" size="xs" disabled={key.length < 16 || password === '' || set.isPending}>
            Save key
          </Button>
        </form>
      )}
      <ErrorLine message={(set.error ?? clear.error) ? refusalMessage(set.error ?? clear.error) : null} />
    </div>
  )
}
