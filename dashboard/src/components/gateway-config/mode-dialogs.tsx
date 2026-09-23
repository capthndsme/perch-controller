import { useState } from 'react'
import { CheckCircle, Circle, ShieldCheck, WarningCircle } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { ErrorLine, PasswordField } from '@/components/gateway-config/bits'
import { usePatchGateway } from '@/hooks/use-gateways'
import { apiErrorCode } from '@/lib/api'
import { MODE_META, refusalMessage, WRITE_BLOCK_TEXT } from '@/lib/gateway-config'
import { cn } from '@/lib/utils'
import type { Gateway, GatewayMode } from '@/types/gateway-config'

function Check({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      {ok === true ? (
        <CheckCircle weight="fill" className="mt-px size-4 shrink-0 text-status-good" />
      ) : ok === false ? (
        <WarningCircle weight="fill" className="mt-px size-4 shrink-0 text-status-serious" />
      ) : (
        <Circle className="mt-px size-4 shrink-0 text-muted-foreground" />
      )}
      <span>{children}</span>
    </li>
  )
}

/**
 * Mode change (plan 1 section 2): off → observe needs router read access,
 * → managed needs write access, a secure (or paired) transport and the admin's
 * password; → off always works.
 */
export function ModeDialog({
  gateway,
  target,
  open,
  onOpenChange,
}: {
  gateway: Gateway
  target: GatewayMode
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const patch = usePatchGateway(gateway.id)
  const [password, setPassword] = useState('')
  const managed = target === 'managed'
  const code = apiErrorCode(patch.error)

  const secureOk =
    gateway.secure === true && gateway.transportOk !== false
      ? true
      : gateway.pairing?.state === 'paired' || gateway.signingKey === 'config_sign_key'
        ? true
        : false

  async function submit() {
    try {
      await patch.mutateAsync({ mode: target, ...(managed ? { currentPassword: password } : {}) })
      onOpenChange(false)
    } catch {
      // shown below
    }
  }

  let title: string
  let description: string
  if (target === 'managed') {
    title = 'Enable full management'
    description = `Perch will manage ${gateway.name}’s configuration two-way.`
  } else if (target === 'observe') {
    title = gateway.mode === 'managed' ? 'Back to observe only' : 'Start observing'
    description =
      gateway.mode === 'managed'
        ? 'Perch stops writing to the router and mirrors it again.'
        : `Perch reads ${gateway.name}’s configuration and mirrors it. Nothing is written.`
  } else {
    title = 'Turn the config plane off'
    description = 'Perch stops reading the router’s configuration. History stays.'
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {managed ? (
            <>
              <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                <li>Every section Perch models syncs; you can exclude single sections afterwards.</li>
                <li>Router edits (LuCI, uci, ssh) keep flowing back into Perch. A clash becomes a conflict for you to resolve.</li>
                <li>
                  Every change applies with a safety net: the router keeps a restore point and rolls back by itself unless
                  the agent reconnects and you keep the changes.
                </li>
                <li>Authoritative Mode stays off until you turn it on separately.</li>
              </ul>
              <div className="space-y-1.5">
                <p className="section-label">Requirements</p>
                <ul className="space-y-1.5">
                  <Check ok={gateway.online}>The gateway’s agent is connected</Check>
                  <Check ok={gateway.agentAccess === 'write'}>
                    The router allows writes (<code className="font-mono">config_access &apos;write&apos;</code>)
                  </Check>
                  <Check ok={secureOk}>
                    {gateway.secure === true
                      ? 'Verified TLS between router and controller'
                      : 'Plain HTTP: both opt-ins and a pairing (see Pairing below)'}
                  </Check>
                </ul>
                {gateway.writeBlockedReason && gateway.writeBlockedReason !== 'offline' ? (
                  <p className="text-muted-foreground">{WRITE_BLOCK_TEXT[gateway.writeBlockedReason]}</p>
                ) : null}
              </div>
              <PasswordField
                value={password}
                onChange={setPassword}
                autoFocus
                error={code === 'invalid_password' ? refusalMessage(patch.error) : null}
              />
            </>
          ) : target === 'observe' && gateway.mode === 'managed' ? (
            <p className="text-muted-foreground">
              Authoritative Mode turns off and drafts that were not applied are dropped: in observe mode the router always
              wins.
            </p>
          ) : target === 'observe' ? (
            <p className="text-muted-foreground">
              Needs the router’s <code className="font-mono">config_access</code> at <code>read</code> or{' '}
              <code>write</code>. Once Perch holds the observed configuration you can enable full management.
            </p>
          ) : (
            <p className="text-muted-foreground">
              Nothing on the router changes. Authoritative Mode turns off; a change still being applied must finish first.
            </p>
          )}
          {code !== 'invalid_password' ? <ErrorLine message={patch.error ? refusalMessage(patch.error) : null} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={patch.isPending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={patch.isPending || (managed && password === '')}
            variant={target === 'off' ? 'destructive' : 'default'}
          >
            {patch.isPending ? <Spinner className="size-3.5 text-current" /> : managed ? <ShieldCheck weight="bold" /> : null}
            {managed ? 'Enable management' : `Switch to ${MODE_META[target].label.toLowerCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The three modes as a row of choices; `onPick` opens the matching dialog. */
export function ModeChooser({
  gateway,
  onPick,
  disabled,
}: {
  gateway: Gateway
  onPick: (mode: GatewayMode) => void
  disabled?: boolean
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Mode">
      {(['off', 'observe', 'managed'] as const).map((mode) => {
        const current = gateway.mode === mode
        // Managed is offered once Perch holds observed data (decisions 7 and 26), or when already managed.
        const locked = mode === 'managed' && !current && !(gateway.mode === 'observe' && gateway.observedAt)
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={current}
            disabled={disabled || current || locked}
            onClick={() => onPick(mode)}
            className={cn(
              'rounded-lg border p-3 text-left text-xs transition-colors',
              current ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
              (disabled || locked) && !current && 'cursor-not-allowed opacity-60',
            )}
          >
            <span className="flex items-center justify-between text-sm font-medium">
              {MODE_META[mode].label}
              {current ? <CheckCircle weight="fill" className="size-4 text-primary" /> : null}
            </span>
            <span className="mt-1 block text-muted-foreground">
              {locked
                ? gateway.mode === 'off'
                  ? 'Observe first: full management is offered once Perch holds the router’s configuration.'
                  : 'Waiting for the first configuration read.'
                : MODE_META[mode].hint}
            </span>
          </button>
        )
      })}
    </div>
  )
}
