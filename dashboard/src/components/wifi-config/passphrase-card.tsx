import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowsSplit,
  CheckCircle,
  Eye,
  EyeSlash,
  Info,
  Key,
  MagicWand,
  PencilSimple,
  XCircle,
} from '@phosphor-icons/react'
import { ErrorLine } from '@/components/gateway-config/bits'
import { PlainHttpPassphraseNote } from '@/components/wifi-config/plain-http-note'
import { Callout, SettingRow } from '@/components/wifi-config/rows'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useNow } from '@/hooks/use-now'
import { useRevealPassphrase, useSetPassphrase } from '@/hooks/use-wifi-config'
import { apiErrorCode } from '@/lib/api'
import { refusalField } from '@/lib/gateway-config'
import { generatePassphrase, passphraseProblem, REVEAL_SECONDS, wifiRefusalMessage } from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type { PassphraseMatch, WifiNetwork } from '@/types/wifi-config'

/** A passphrase input with show/hide, generate and the rules under it. */
export function PassphraseInput({
  value,
  onChange,
  disabled,
  autoFocus,
  showError,
  label = 'Passphrase',
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  autoFocus?: boolean
  /** Show the rule that fails (after a save attempt, or once typed). */
  showError?: boolean
  label?: string
}) {
  const id = useId()
  const [visible, setVisible] = useState(false)
  const problem = passphraseProblem(value)
  const invalid = showError && problem !== null
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            id={id}
            type={visible ? 'text' : 'password'}
            value={value}
            autoFocus={autoFocus}
            disabled={disabled}
            autoComplete="new-password"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={invalid || undefined}
            className="h-9 pr-9 font-mono"
            placeholder="8–63 characters"
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide passphrase' : 'Show passphrase'}
            className="absolute inset-y-0 right-0 grid w-9 place-items-center text-muted-foreground transition-colors hover:text-foreground"
          >
            {visible ? <EyeSlash className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={disabled}
          onClick={() => {
            onChange(generatePassphrase())
            setVisible(true)
          }}
          title="Generate a 20-character passphrase without look-alike characters"
        >
          <MagicWand />
          Generate
        </Button>
      </div>
      <p className={cn('text-[11px]', invalid ? 'text-destructive' : 'text-muted-foreground')}>
        {invalid ? problem : `${value.length} characters · 8–63 printable characters, or 64 hex digits.`}
      </p>
    </div>
  )
}

function MatchList({ matches, apName }: { matches: PassphraseMatch[]; apName: (apId: number) => string }) {
  return (
    <ul className="grid gap-1 sm:grid-cols-2" data-testid="passphrase-matches">
      {matches.map((m) => (
        <li key={`${m.apId}-${m.radio}`} className="flex items-center gap-1.5 text-xs">
          {m.match ? (
            <CheckCircle weight="fill" className="size-4 shrink-0 text-status-good" />
          ) : (
            <XCircle weight="fill" className="size-4 shrink-0 text-status-critical" />
          )}
          <span>
            {apName(m.apId)} <span className="font-mono text-[11px] text-muted-foreground">{m.radio}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/** A known passphrase: dots, Reveal (admin, re-hides after 30 s), Change. */
function KnownPassphrase({
  network,
  isAdmin,
  onChange,
}: {
  network: WifiNetwork
  isAdmin: boolean
  onChange: () => void
}) {
  const reveal = useRevealPassphrase()
  const [shown, setShown] = useState<{ value: string; until: number } | null>(null)
  const now = useNow(1000, shown !== null)
  const left = shown ? Math.ceil((shown.until - now) / 1000) : 0
  const visible = shown !== null && left > 0
  if (shown && left <= 0) setShown(null)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <code
          className={cn(
            'min-h-9 flex-1 rounded-md border border-border bg-muted/30 px-2.5 py-2 font-mono text-[13px] break-all',
            !visible && 'tracking-[0.2em] text-muted-foreground',
          )}
          data-testid="passphrase-value"
        >
          {visible ? shown.value : '••••••••••••'}
        </code>
        {isAdmin ? (
          <div className="flex gap-2">
            {visible ? (
              <>
                <CopyButton value={shown.value} ariaLabel="Copy the passphrase" className="h-9 px-2.5" />
                <Button variant="outline" size="lg" onClick={() => setShown(null)}>
                  <EyeSlash />
                  Hide ({left} s)
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="lg"
                disabled={reveal.isPending}
                onClick={() =>
                  reveal.mutate(network.id, {
                    onSuccess: (data) => setShown({ value: data.passphrase, until: Date.now() + REVEAL_SECONDS * 1000 }),
                  })
                }
              >
                {reveal.isPending ? <Spinner className="size-3.5" /> : <Eye />}
                Reveal
              </Button>
            )}
            <Button variant="outline" size="lg" onClick={onChange}>
              <PencilSimple />
              Change
            </Button>
          </div>
        ) : null}
      </div>
      {reveal.error ? <ErrorLine message={wifiRefusalMessage(reveal.error)} /> : null}
      {isAdmin ? (
        <p className="text-[11px] text-muted-foreground">Revealing is recorded in the access points’ activity.</p>
      ) : null}
    </div>
  )
}

/**
 * An adopted network whose passphrase Perch has never seen (decision D13):
 * the admin types it once; Perch checks it against every access point's
 * fingerprint. All match → stored, nothing changes on the APs. Some differ →
 * the list says which, and "Store anyway" pushes it to those.
 */
function UnknownPassphrase({
  network,
  apName,
  onStored,
}: {
  network: WifiNetwork
  apName: (apId: number) => string
  onStored?: (matches: PassphraseMatch[]) => void
}) {
  const setPassphrase = useSetPassphrase()
  const [value, setValue] = useState('')
  const [tried, setTried] = useState(false)
  const code = apiErrorCode(setPassphrase.error)
  const mismatches = code === 'passphrase_mismatch' ? (refusalField<PassphraseMatch[]>(setPassphrase.error, 'matches') ?? []) : []
  const done = setPassphrase.data

  function submit(force: boolean) {
    setTried(true)
    if (passphraseProblem(value)) return
    // The row turns into the "known" view once the network refreshes: the page says it worked.
    setPassphrase.mutateAsync({ id: network.id, passphrase: value, force }).then(
      (result) => onStored?.(result.matches),
      () => undefined,
    )
  }

  if (done) {
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-xs font-medium">
          <CheckCircle weight="fill" className="size-4 text-status-good" />
          Stored. Perch manages this network’s passphrase from now on.
        </p>
        <MatchList matches={done.matches} apName={apName} />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <Callout tone="info" icon={<Key weight="bold" className="size-4 text-primary" />} title="Enter the current passphrase once">
        Perch never reads passphrases from the access points. Type it here and Perch checks it against each of them;
        until then the network can be edited but not extended to another access point or radio.
      </Callout>
      <PassphraseInput value={value} onChange={setValue} showError={tried} label="Current passphrase" />
      <PlainHttpPassphraseNote />
      {mismatches.length > 0 ? (
        <div className="space-y-2 rounded-md border border-status-critical/40 bg-status-critical/5 p-2.5">
          <p className="text-xs font-medium">That passphrase does not match everywhere:</p>
          <MatchList matches={mismatches} apName={apName} />
          <p className="text-xs text-muted-foreground">
            Store anyway only if this is the passphrase you want everywhere: the access points marked with a cross get it
            with the next rollout, and their devices must re-enter it.
          </p>
          <Button size="sm" variant="destructive" onClick={() => submit(true)} disabled={setPassphrase.isPending}>
            Store anyway
          </Button>
        </div>
      ) : (
        <ErrorLine message={setPassphrase.error ? wifiRefusalMessage(setPassphrase.error) : null} />
      )}
      <Button size="sm" onClick={() => submit(false)} disabled={setPassphrase.isPending || value.length === 0}>
        {setPassphrase.isPending ? <Spinner className="size-3.5 text-current" /> : <CheckCircle weight="bold" />}
        Check on the access points
      </Button>
    </div>
  )
}

/**
 * The Security group's passphrase row, by state (dashboard.md 1.2): a new
 * or newly protected network types one; `set` shows dots with Reveal and
 * Change; `unknown` asks for it once; `mixed` points at the divergence.
 */
export function PassphraseRows({
  network,
  needed,
  value,
  onValueChange,
  editing,
  onEditingChange,
  isAdmin,
  showError,
  apName,
  onStored,
}: {
  network: WifiNetwork | null
  /** The chosen security mode takes a passphrase. */
  needed: boolean
  value: string
  onValueChange: (value: string) => void
  editing: boolean
  onEditingChange: (editing: boolean) => void
  isAdmin: boolean
  showError: boolean
  apName: (apId: number) => string
  /** A typed passphrase was checked and stored (the unknown state). */
  onStored?: (matches: PassphraseMatch[]) => void
}) {
  // Kept after a check: the row turns into the "known" view when the network refreshes, and says so.
  const [stored, setStored] = useState<PassphraseMatch[] | null>(null)
  if (!needed) return null
  const state = network?.passphrase.state ?? 'none'
  const handleStored = (matches: PassphraseMatch[]) => {
    setStored(matches)
    onStored?.(matches)
  }

  if (state === 'none' || editing) {
    return (
      <SettingRow
        label={state === 'none' ? 'Passphrase' : 'New passphrase'}
        description={
          state === 'none'
            ? 'What devices type to join.'
            : 'Replaces the passphrase on every access point that carries this network.'
        }
        stack
      >
        <div className="space-y-2">
          <PassphraseInput value={value} onChange={onValueChange} disabled={!isAdmin} showError={showError} autoFocus={editing} />
          <PlainHttpPassphraseNote />
          {editing ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onValueChange('')
                onEditingChange(false)
              }}
            >
              Keep the current passphrase
            </Button>
          ) : null}
        </div>
      </SettingRow>
    )
  }

  if (state === 'set') {
    return (
      <SettingRow label="Passphrase" description="Stored encrypted in Perch." stack>
        {stored ? (
          <div className="mb-3 space-y-2 rounded-md border border-status-good/40 bg-status-good/10 p-2.5" role="status">
            <p className="flex items-center gap-2 text-xs font-medium">
              <CheckCircle weight="fill" className="size-4 text-status-good" />
              {stored.every((m) => m.match)
                ? 'Stored: it matches every access point. Nothing changes on them.'
                : 'Stored. The access points marked with a cross get it with the next rollout.'}
            </p>
            <MatchList matches={stored} apName={apName} />
          </div>
        ) : null}
        <KnownPassphrase network={network!} isAdmin={isAdmin} onChange={() => onEditingChange(true)} />
      </SettingRow>
    )
  }

  if (state === 'mixed') {
    return (
      <SettingRow label="Passphrase" stack>
        <Callout
          tone="serious"
          icon={<ArrowsSplit weight="bold" className="size-4 text-status-serious" />}
          title="The access points disagree on this network’s passphrase"
          action={
            <Button asChild size="sm" variant="outline">
              <Link to={`/wifi/sync?network=${network!.id}#divergences`}>Review</Link>
            </Button>
          }
        >
          One of them was changed outside Perch. Pick one for all, or set a new one.
        </Callout>
        {isAdmin ? (
          <Button className="mt-2" size="sm" variant="outline" onClick={() => onEditingChange(true)}>
            <PencilSimple />
            Set a new passphrase for all
          </Button>
        ) : null}
      </SettingRow>
    )
  }

  // unknown
  return (
    <SettingRow label="Passphrase" stack>
      {isAdmin ? (
        <div className="space-y-2">
          <UnknownPassphrase network={network!} apName={apName} onStored={handleStored} />
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => onEditingChange(true)}
          >
            <Info aria-hidden className="size-3" />
            Set a new passphrase instead
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Not known to Perch yet: an admin enters it once.</p>
      )}
    </SettingRow>
  )
}
