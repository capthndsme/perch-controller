import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowCounterClockwise,
  CaretRight,
  CheckCircle,
  Circle,
  ClockCounterClockwise,
  Crown,
  ShieldCheck,
  WarningCircle,
} from '@phosphor-icons/react'
import { ErrorLine, PasswordField, ToneBadge } from '@/components/gateway-config/bits'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ApAuthoritativeDialog } from '@/components/wifi-config/ap-get-in-sync'
import { Callout, CountGrid } from '@/components/wifi-config/rows'
import { useDialog } from '@/hooks/use-dialog'
import { useApRejoin, useDismissApRejoin, useUpdateApConfig } from '@/hooks/use-wifi-config'
import { apiErrorCode } from '@/lib/api'
import { formatAgo, type Tone } from '@/lib/gateway-config'
import {
  AP_MODE_META,
  AP_WRITE_BLOCK_TEXT,
  ENABLE_WRITE_COMMAND,
  FLEET_STATE_META,
  plural,
  wifiRefusalMessage,
  writeStateBadge,
} from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type { ApConfig, ApMode } from '@/types/wifi-config'

function Check({ ok, children }: { ok: boolean | null; children: ReactNode }) {
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
 * Changing an AP's Wi-Fi mode (dashboard.md 1.4, the gateway's
 * mode-dialogs pattern): Observe reads only; Managed needs write access on
 * the AP, a secure (or paired) connection, the boot guard, and the admin's
 * password; Off always works.
 */
export function ApModeDialog({
  ap,
  target,
  open,
  onOpenChange,
}: {
  ap: ApConfig
  target: ApMode
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const patch = useUpdateApConfig(ap.apId)
  const [password, setPassword] = useState('')
  const managed = target === 'managed'
  const code = apiErrorCode(patch.error)
  const secureOk = ap.secure === true && ap.transportOk !== false ? true : ap.pairing?.state === 'paired'

  async function submit() {
    try {
      await patch.mutateAsync({ mode: target, ...(managed ? { currentPassword: password } : {}) })
      onOpenChange(false)
    } catch {
      // shown below
    }
  }

  const title =
    target === 'managed'
      ? `Manage WiFi on ${ap.name}`
      : target === 'observe'
        ? ap.mode === 'managed'
          ? 'Back to observe only'
          : `Observe ${ap.name}`
        : 'Stop reading this access point'
  const description =
    target === 'managed'
      ? 'Perch applies its networks and radios here, two-way with LuCI.'
      : target === 'observe'
        ? ap.mode === 'managed'
          ? 'Perch stops writing and mirrors the access point again.'
          : 'Perch reads the WiFi configuration and logs changes. Nothing is written.'
        : 'Perch stops reading the WiFi configuration. History stays.'

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
                <li>
                  First, Perch takes the networks it adopted into its ledger on the access point (no WiFi change).
                </li>
                <li>
                  Every change applies with a safety net: the access point keeps a restore point and rolls back by itself
                  unless it reconnects, its networks come up, and it checks in.
                </li>
                <li>Edits in LuCI keep flowing back. Authoritative Mode stays off until you turn it on.</li>
              </ul>
              <div className="space-y-1.5">
                <p className="section-label">Requirements</p>
                <ul className="space-y-1.5">
                  <Check ok={ap.online}>The access point’s agent is connected</Check>
                  <Check ok={ap.access === 'write'}>
                    The access point allows writes (<code className="font-mono">{ENABLE_WRITE_COMMAND}</code>)
                  </Check>
                  <Check ok={secureOk}>
                    {ap.secure === true ? 'Verified TLS between the access point and Perch' : 'Plain HTTP: needs a pairing'}
                  </Check>
                  <Check ok={ap.writeBlockedReason !== 'guard_missing'}>The boot guard is installed</Check>
                </ul>
                {ap.writeBlockedReason && ap.writeBlockedReason !== 'offline' ? (
                  <p className="text-muted-foreground">{AP_WRITE_BLOCK_TEXT[ap.writeBlockedReason]}</p>
                ) : null}
              </div>
              <PasswordField
                value={password}
                onChange={setPassword}
                autoFocus
                error={code === 'invalid_password' ? wifiRefusalMessage(patch.error) : null}
              />
            </>
          ) : target === 'observe' && ap.mode === 'managed' ? (
            <p className="text-muted-foreground">
              Authoritative Mode turns off and changes not applied yet stay as drafts. In observe mode the access point
              always wins.
            </p>
          ) : target === 'observe' ? (
            <p className="text-muted-foreground">
              Needs the access point’s WiFi access at <code>read</code> or <code>write</code>. Perch then offers to adopt
              the networks it finds.
            </p>
          ) : (
            <p className="text-muted-foreground">Nothing on the access point changes.</p>
          )}
          {code !== 'invalid_password' ? <ErrorLine message={patch.error ? wifiRefusalMessage(patch.error) : null} /> : null}
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
            {managed ? 'Manage WiFi' : `Switch to ${AP_MODE_META[target].label.toLowerCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function healthTone(ap: ApConfig): { tone: Tone; label: string } {
  if (!ap.health) return { tone: 'neutral', label: 'Health not checked' }
  if (ap.health.pending) return { tone: 'warning', label: 'Health: settling' }
  if (ap.health.ok) return { tone: 'good', label: 'Healthy' }
  return { tone: 'critical', label: `${ap.health.problems.length} health problem${ap.health.problems.length === 1 ? '' : 's'}` }
}

/** The rejoin offer of a reset access point (decision D7): never automatic. */
function RejoinOffer({ ap, isAdmin }: { ap: ApConfig; isAdmin: boolean }) {
  const rejoin = useApRejoin(ap.apId)
  const dismiss = useDismissApRejoin(ap.apId)
  const offer = ap.rejoinOffer!
  return (
    <Callout
      tone="serious"
      icon={<ClockCounterClockwise weight="bold" className="size-4 text-status-serious" />}
      title={offer.reason === 'rejoined' ? 'This access point joined again' : 'This access point was reset'}
      action={
        isAdmin ? (
          <>
            <Button size="sm" onClick={() => rejoin.mutate('fleet')} disabled={rejoin.isPending}>
              Use the current settings
            </Button>
            {offer.revision !== null ? (
              <Button size="sm" variant="outline" onClick={() => rejoin.mutate('revision')} disabled={rejoin.isPending}>
                Restore revision {offer.revision}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>
              Dismiss
            </Button>
          </>
        ) : null
      }
    >
      Its WiFi no longer matches what Perch applied ({formatAgo(offer.detectedAt)}). Put Perch’s settings back on it?
      <ErrorLine message={rejoin.error || dismiss.error ? wifiRefusalMessage(rejoin.error ?? dismiss.error) : null} />
    </Callout>
  )
}

/** The counts in one line for the Sync list: what needs attention, else "In sync". */
function CountSummary({ ap }: { ap: ApConfig }) {
  const c = ap.counts
  const items: Array<{ label: string; tone: Tone }> = []
  if (c.conflicts) items.push({ label: plural(c.conflicts, 'conflict'), tone: 'critical' })
  if (c.drift) items.push({ label: `${c.drift} drifted`, tone: 'serious' })
  if (c.divergences) items.push({ label: `${c.divergences} changed on the AP`, tone: 'serious' })
  if (c.ahead) items.push({ label: plural(c.ahead, 'draft'), tone: 'info' })
  if (c.orphans) items.push({ label: `${c.orphans} orphaned`, tone: 'neutral' })
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {items.map((item) => (
        <ToneBadge key={item.label} tone={item.tone}>
          {item.label}
        </ToneBadge>
      ))}
      <span>
        {plural(c.synced, 'section')} synced{c.unmodeled ? `, ${c.unmodeled} not modeled` : ''}
      </span>
    </p>
  )
}

/**
 * One access point on the Sync page (dashboard.md 1.4): mode Off / Observe /
 * Managed, Authoritative Mode, the write state (with the command that enables
 * writes on the AP), health, the counts and a rejoin offer.
 */
export function ApModeCard({ ap, isAdmin, detailLink = true }: { ap: ApConfig; isAdmin: boolean; detailLink?: boolean }) {
  const [target, setTarget] = useState<ApMode | null>(null)
  const modeDialog = useDialog()
  const authDialog = useDialog()
  const patch = useUpdateApConfig(ap.apId)
  const write = writeStateBadge(ap)
  const health = healthTone(ap)
  const lockedManaged = ap.mode === 'off' || (ap.mode === 'observe' && ap.observedAt === null)

  return (
    <section className="card-surface flex flex-col gap-3 p-4" data-testid="ap-mode-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold">
            <span
              aria-label={ap.online ? 'Online' : 'Offline'}
              className={cn('size-2 shrink-0 rounded-full', ap.online ? 'bg-status-good' : 'bg-muted-foreground/50')}
            />
            {ap.name}
            {ap.authoritative ? (
              <Crown weight="fill" aria-label="Authoritative Mode" className="size-3.5 text-status-warning" />
            ) : null}
          </h2>
          <p className="text-xs text-muted-foreground">
            {ap.agentVersion ? `perch-apd ${ap.agentVersion}` : 'perch-apd'}
            {ap.mode !== 'off' ? ` · ${ap.observedAt ? `read ${formatAgo(ap.observedAt)}` : 'not read yet'} · revision ${ap.headRevision}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {detailLink ? (
            <Button asChild size="sm" variant="ghost" className="-my-1 order-last">
              <Link to={`/wifi/sync/${ap.apId}`} aria-label={`Details of ${ap.name}`}>
                Details
                <CaretRight />
              </Link>
            </Button>
          ) : null}
          <ToneBadge tone={write.tone}>{write.label}</ToneBadge>
          {ap.mode !== 'off' ? (
            <ToneBadge tone={health.tone} dot>
              {health.label}
            </ToneBadge>
          ) : null}
          {ap.mode !== 'off' && ap.fleetState !== 'in_line' && ap.fleetState !== 'unknown' ? (
            <ToneBadge tone={FLEET_STATE_META[ap.fleetState].tone}>{FLEET_STATE_META[ap.fleetState].label}</ToneBadge>
          ) : null}
        </div>
      </div>

      {write.command ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs">
          <span className="text-muted-foreground">On the access point:</span>
          <code className="min-w-0 flex-1 font-mono text-[11px] break-all">{write.command}</code>
          <CopyButton value={write.command} ariaLabel="Copy the command" />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          size="xs"
          ariaLabel={`WiFi mode of ${ap.name}`}
          value={ap.mode}
          onChange={(mode) => {
            if (!isAdmin || mode === ap.mode || (mode === 'managed' && lockedManaged)) return
            setTarget(mode)
            modeDialog.show()
          }}
          options={(['off', 'observe', 'managed'] as const).map((mode) => ({
            id: mode,
            label: AP_MODE_META[mode].label,
            title: mode === 'managed' && lockedManaged ? 'Observe first: Managed is offered once Perch has read it.' : AP_MODE_META[mode].hint,
          }))}
        />
        {ap.mode === 'managed' ? (
          <label className="flex items-center gap-2 text-xs">
            <Crown weight={ap.authoritative ? 'fill' : 'regular'} className={cn('size-4', ap.authoritative ? 'text-status-warning' : 'text-muted-foreground')} />
            Authoritative
            <Switch
              checked={ap.authoritative}
              disabled={!isAdmin || patch.isPending}
              onCheckedChange={(on) => (on ? authDialog.show() : patch.mutate({ authoritative: false }))}
              aria-label="Authoritative Mode"
            />
          </label>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{AP_MODE_META[ap.mode].hint}</p>

      {ap.mode !== 'off' && detailLink ? (
        <CountSummary ap={ap} />
      ) : ap.mode !== 'off' ? (
        <CountGrid
          items={[
            { label: 'Drafts', value: ap.counts.ahead },
            { label: 'Conflicts', value: ap.counts.conflicts, alarm: true },
            { label: 'Drift', value: ap.counts.drift, alarm: true },
            { label: 'Changed on AP', value: ap.counts.divergences, alarm: true },
            { label: 'Orphans', value: ap.counts.orphans },
            { label: 'Synced', value: ap.counts.synced },
          ]}
        />
      ) : null}

      {ap.enforcement === 'suspended' ? (
        <p className="flex items-start gap-2 text-xs text-status-serious">
          <ArrowCounterClockwise weight="bold" className="mt-px size-3.5 shrink-0" />
          Enforcement is suspended after failed reverts: edits on the access point stay until you resume it.
        </p>
      ) : null}
      {ap.rejoinOffer ? <RejoinOffer ap={ap} isAdmin={isAdmin} /> : null}
      <ErrorLine message={patch.error ? wifiRefusalMessage(patch.error) : null} />


      {target ? (
        <ApModeDialog key={modeDialog.key} ap={ap} target={target} open={modeDialog.open} onOpenChange={modeDialog.setOpen} />
      ) : null}
      <ApAuthoritativeDialog key={`auth-${authDialog.key}`} ap={ap} open={authDialog.open} onOpenChange={authDialog.setOpen} />
    </section>
  )
}
