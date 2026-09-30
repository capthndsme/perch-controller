import { useId, useState } from 'react'
import { ArrowRight, CheckCircle, Eye, GitMerge, ShieldCheck, Warning } from '@phosphor-icons/react'
import { ErrorLine, ToneBadge } from '@/components/gateway-config/bits'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ApModeDialog } from '@/components/wifi-config/ap-mode-card'
import { BandChips } from '@/components/wifi-config/network-status'
import { PassphraseRows } from '@/components/wifi-config/passphrase-card'
import { SecurityChip } from '@/components/wifi-config/security-chip'
import { EditorSheet } from '@/components/wifi-config/sheet'
import { useDialog } from '@/hooks/use-dialog'
import { useAcceptAdoption, useAdoption, useUpdateApConfig } from '@/hooks/use-wifi-config'
import { apiErrorCode } from '@/lib/api'
import { formatAgo } from '@/lib/gateway-config'
import {
  AP_MODE_META,
  BAND_LABEL,
  countryName,
  countryOptions,
  ENABLE_READ_COMMAND,
  plural,
  wifiRefusalMessage,
} from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type {
  AdoptionAccept,
  AdoptionProposal,
  AdoptionResult,
  AdoptionView,
  ApConfig,
  ApMode,
  CountryPolicy,
} from '@/types/wifi-config'

const STEPS = ['Access points', 'Networks', 'Country', 'Passphrases', 'Managed'] as const

const CHOICE_LABEL: Record<string, string> = {
  hidden: 'Hidden',
  isolate: 'Client isolation',
  enabled: 'Broadcasting',
  'roaming.ft': 'Fast roaming (802.11r)',
  'roaming.rrm': 'Neighbour reports (802.11k)',
  'roaming.btm': 'BSS transition (802.11v)',
  'advanced.pmf': 'Protected management frames',
  'advanced.multicastToUnicast': 'Multicast to unicast',
  'advanced.maxClients': 'Max clients',
  'advanced.dtimPeriod': 'DTIM period',
}

const WARNING_TEXT: Record<AdoptionProposal['warnings'][number], string> = {
  open_on_lan: 'Open network on your LAN',
  ssid_key_mismatch: 'Same name, different passphrase on some access points: kept apart',
  owe_unsupported_elsewhere: 'Some access points cannot run OWE',
  orphans_skipped: 'Some interfaces were skipped',
}

const SKIP_TEXT: Record<AdoptionView['skipped'][number]['reason'], (n: number, ap: string) => string> = {
  orphan: (n, ap) => `${plural(n, 'interface')} on ${ap} ${n === 1 ? 'is' : 'are'} ignored: they belong to a radio that no longer exists. Tidy them up in LuCI.`,
  unmodeled: (n, ap) => `${plural(n, 'interface')} on ${ap} ${n === 1 ? 'is' : 'are'} not WiFi networks Perch manages (client mode, mesh): left alone.`,
  ambiguous: (n, ap) => `${plural(n, 'interface')} on ${ap} share a name on one radio: fix it in LuCI, then Perch can adopt them.`,
}

function valueText(value: unknown): string {
  if (value === true) return 'On'
  if (value === false) return 'Off'
  if (value === null || value === undefined) return 'Default'
  return String(value)
}

type ProposalEdit = { name: string; mergeInto: string | null; exclude: boolean; choices: Record<string, number> }

function editOf(p: AdoptionProposal): ProposalEdit {
  return {
    name: p.name,
    mergeInto: null,
    // An interface that is off everywhere (a leftover "OpenWrt") is proposed as not adopted.
    exclude: p.exclude ?? (!p.template.enabled && p.members.every((m) => !m.radioEnabled || m.overrides.enabled === false)),
    choices: Object.fromEntries(p.choices.map((c) => [c.field, 0])),
  }
}

function StepBar({ step }: { step: number }) {
  return (
    <ol className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]" aria-label="Steps">
      {STEPS.map((label, i) => (
        <li
          key={label}
          aria-current={i === step ? 'step' : undefined}
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap',
            i === step
              ? 'border-brand/50 bg-brand/10 text-foreground'
              : i < step
                ? 'border-status-good/40 text-muted-foreground'
                : 'border-border text-muted-foreground',
          )}
        >
          {i < step ? (
            <CheckCircle weight="fill" className="size-3.5 text-status-good" />
          ) : (
            <span className="font-mono tabular-nums">{i + 1}</span>
          )}
          {/* On a phone only the current step spells its name out. */}
          <span className={i === step ? '' : 'max-sm:sr-only'}>{label}</span>
        </li>
      ))}
    </ol>
  )
}

function ApReadRow({ ap, isAdmin }: { ap: ApConfig; isAdmin: boolean }) {
  const patch = useUpdateApConfig(ap.apId)
  const noAccess = ap.access === 'none' || ap.access === null
  return (
    <li className="space-y-2 px-3 py-2.5" data-testid="adopt-ap">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('size-1.5 rounded-full', ap.online ? 'bg-status-good' : 'bg-muted-foreground/50')} />
        <span className="text-[13px] font-medium">{ap.name}</span>
        <ToneBadge tone={AP_MODE_META[ap.mode].tone}>{AP_MODE_META[ap.mode].label}</ToneBadge>
        {ap.mode !== 'off' ? (
          <span className="text-[11px] text-muted-foreground">{ap.observedAt ? `read ${formatAgo(ap.observedAt)}` : 'reading…'}</span>
        ) : null}
        <span className="ml-auto">
          {ap.mode === 'off' && !noAccess && isAdmin ? (
            <Button size="sm" variant="outline" onClick={() => patch.mutate({ mode: 'observe' })} disabled={patch.isPending || !ap.online}>
              {patch.isPending ? <Spinner className="size-3.5" /> : <Eye />}
              Observe
            </Button>
          ) : ap.mode !== 'off' && ap.observedAt ? (
            <CheckCircle weight="fill" className="size-4 text-status-good" aria-label="Read" />
          ) : null}
        </span>
      </div>
      {ap.mode === 'off' && noAccess ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs">
          <span className="text-muted-foreground">WiFi access is off on this AP. Run on it:</span>
          <code className="font-mono text-[11px]">{ENABLE_READ_COMMAND}</code>
          <CopyButton value={ENABLE_READ_COMMAND} ariaLabel="Copy the command" />
        </div>
      ) : null}
      {!ap.capable ? <p className="text-xs text-muted-foreground">Update perch-apd on this access point first.</p> : null}
      <ErrorLine message={patch.error ? wifiRefusalMessage(patch.error) : null} />
    </li>
  )
}

function ProposalCard({
  proposal,
  edit,
  onEdit,
  others,
  apName,
}: {
  proposal: AdoptionProposal
  edit: ProposalEdit
  onEdit: (edit: ProposalEdit) => void
  others: AdoptionProposal[]
  apName: (apId: number) => string
}) {
  const nameId = useId()
  const mergeId = useId()
  const byAp = new Map<number, AdoptionProposal['members']>()
  for (const m of proposal.members) byAp.set(m.apId, [...(byAp.get(m.apId) ?? []), m])
  const mergeable = others.filter((o) => o.security === proposal.security && o.keyFingerprint === proposal.keyFingerprint)
  const merged = edit.mergeInto !== null

  return (
    <li
      className={cn('space-y-3 rounded-lg border p-3 transition-opacity duration-base', edit.exclude || merged ? 'border-dashed opacity-60' : 'border-border')}
      data-testid="adopt-proposal"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="font-mono text-[13px] font-semibold break-all">{proposal.ssid}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <SecurityChip security={proposal.security} />
            <BandChips bands={proposal.bands} />
            <ToneBadge tone="neutral">{proposal.apScope === 'all' ? 'All APs' : plural(byAp.size, 'AP')}</ToneBadge>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs">
          Adopt
          <Switch
            checked={!edit.exclude}
            onCheckedChange={(on) => onEdit({ ...edit, exclude: !on })}
            aria-label={`Adopt ${proposal.ssid}`}
          />
        </label>
      </div>

      {proposal.hints?.length ? (
        <p className="text-[11px] text-muted-foreground">{proposal.hints.join(' · ')}</p>
      ) : null}
      {proposal.warnings.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {proposal.warnings.map((w) => (
            <li key={w}>
              <ToneBadge tone="warning">
                <Warning aria-hidden weight="fill" className="size-3 text-status-warning" />
                {WARNING_TEXT[w]}
              </ToneBadge>
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="space-y-0.5 text-xs">
        {[...byAp.entries()].map(([apId, members]) => (
          <li key={apId} className="flex flex-wrap gap-x-1.5">
            <span className="font-medium">{apName(apId)}</span>
            <span className="text-muted-foreground">
              {[...members]
                .sort((a, b) => (a.band ?? '').localeCompare(b.band ?? ''))
                .map((m) => `${m.band ? BAND_LABEL[m.band] : m.radio}${m.radioEnabled && m.overrides.enabled !== false ? '' : ' (off)'}`)
                .join(', ')}
            </span>
          </li>
        ))}
      </ul>

      {!edit.exclude && !merged ? (
        <>
          <div className="space-y-1">
            <label htmlFor={nameId} className="text-[11px] font-medium text-muted-foreground">
              Name in Perch
            </label>
            <Input id={nameId} value={edit.name} onChange={(e) => onEdit({ ...edit, name: e.target.value })} className="h-9" />
          </div>
          {proposal.choices.map((choice) => (
            <fieldset key={choice.field} className="space-y-1.5">
              <legend className="text-[11px] font-medium text-muted-foreground">
                {CHOICE_LABEL[choice.field] ?? choice.field}: the access points disagree
              </legend>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {choice.values.map((v, i) => (
                  <label
                    key={i}
                    className={cn(
                      'flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors duration-base sm:min-h-9',
                      edit.choices[choice.field] === i ? 'border-brand/60 bg-brand/5 ring-1 ring-brand/30' : 'border-border hover:bg-muted/40',
                    )}
                  >
                    <input
                      type="radio"
                      className="accent-[var(--brand)]"
                      name={`${proposal.key}-${choice.field}`}
                      checked={edit.choices[choice.field] === i}
                      onChange={() => onEdit({ ...edit, choices: { ...edit.choices, [choice.field]: i } })}
                    />
                    <span className="font-medium">{valueText(v.value)}</span>
                    <span className="truncate text-muted-foreground">{v.apIds.map(apName).join(', ')}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </>
      ) : null}

      {!edit.exclude && mergeable.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <GitMerge aria-hidden className="size-3.5 text-muted-foreground" />
          <label htmlFor={mergeId} className="text-muted-foreground">
            Merge into
          </label>
          <select
            id={mergeId}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs sm:flex-none dark:bg-input/30"
            value={edit.mergeInto ?? ''}
            onChange={(e) => onEdit({ ...edit, mergeInto: e.target.value || null })}
          >
            <option value="">Keep as its own network</option>
            {mergeable.map((o) => (
              <option key={o.key} value={o.key}>
                {o.ssid}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </li>
  )
}

function ManageRow({ ap }: { ap: ApConfig }) {
  const dialog = useDialog()
  const [target, setTarget] = useState<ApMode>('managed')
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2.5">
      <span className="text-[13px] font-medium">{ap.name}</span>
      <ToneBadge tone={AP_MODE_META[ap.mode].tone}>{AP_MODE_META[ap.mode].label}</ToneBadge>
      <span className="ml-auto">
        {ap.mode === 'managed' ? (
          <CheckCircle weight="fill" className="size-4 text-status-good" aria-label="Managed" />
        ) : (
          <Button
            size="sm"
            onClick={() => {
              setTarget('managed')
              dialog.show()
            }}
            disabled={!ap.online || ap.mode === 'off'}
          >
            <ShieldCheck weight="bold" />
            Switch to Managed
          </Button>
        )}
      </span>
      <ApModeDialog key={dialog.key} ap={ap} target={target} open={dialog.open} onOpenChange={dialog.setOpen} />
    </li>
  )
}

/**
 * Adoption (dashboard.md 1.5, controller.md 5.4): 1 the access points Perch
 * reads; 2 the networks it found, renamed, merged, excluded, with the
 * disagreements settled; 3 the country; Adopt — nothing on the access points
 * changes; 4 passphrases, typed once and checked against every AP
 * (optional); 5 switching access points to Managed, a separate explicit step.
 */
export function AdoptionWizard({
  open,
  onOpenChange,
  aps,
  isAdmin,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  aps: ApConfig[]
  isAdmin: boolean
}) {
  const adoption = useAdoption({ enabled: open })
  const accept = useAcceptAdoption()
  const [step, setStep] = useState(0)
  const [edits, setEdits] = useState<Record<string, ProposalEdit>>({})
  const [countryDefault, setCountryDefault] = useState<string | null | undefined>(undefined)
  const [countries, setCountries] = useState<Record<number, CountryPolicy>>({})
  const [result, setResult] = useState<AdoptionResult | null>(null)
  const [changed, setChanged] = useState(false)
  const view = adoption.data
  const proposals = view?.proposals ?? []
  const apName = (apId: number) => aps.find((a) => a.apId === apId)?.name ?? `AP ${apId}`
  const editFor = (p: AdoptionProposal) => edits[p.key] ?? editOf(p)
  const reading = aps.filter((a) => a.mode !== 'off' && a.observedAt)
  const suggested = view?.suggestedCountry ?? (() => {
    const counts = new Map<string, number>()
    for (const c of view?.countries ?? []) if (c.suggested) counts.set(c.suggested, (counts.get(c.suggested) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  })()
  const fleetCountry = countryDefault === undefined ? suggested : countryDefault
  const adopting = proposals.filter((p) => !editFor(p).exclude && editFor(p).mergeInto === null)

  async function adopt() {
    setChanged(false)
    const body: AdoptionAccept = {
      proposals: proposals
        .filter((p) => editFor(p).mergeInto === null)
        .map((p) => {
          const e = editFor(p)
          if (e.exclude) return { key: p.key, exclude: true }
          const merge = proposals.filter((o) => editFor(o).mergeInto === p.key && !editFor(o).exclude).map((o) => o.key)
          const choices = Object.fromEntries(p.choices.map((c) => [c.field, c.values[e.choices[c.field] ?? 0]?.value]))
          return {
            key: p.key,
            ...(e.name.trim() && e.name.trim() !== p.name ? { name: e.name.trim() } : {}),
            ...(merge.length ? { merge } : {}),
            ...(p.choices.length ? { choices } : {}),
          }
        }),
      countryDefault: fleetCountry,
      countries: Object.fromEntries(
        (view?.countries ?? []).map((c) => [c.apId, countries[c.apId] ?? { mode: 'fleet' as const }]),
      ),
    }
    try {
      const r = await accept.mutateAsync(body)
      setResult(r)
      setStep(3)
    } catch (e) {
      if (apiErrorCode(e) === 'adoption_changed') {
        setChanged(true)
        accept.reset()
        setStep(1)
        void adoption.refetch()
      }
    }
  }

  const unknownPassphrases = (result?.networks ?? []).filter((n) => n.passphrase.state === 'unknown')

  let body: React.ReactNode
  let footer: React.ReactNode
  if (step === 0) {
    body = (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Perch reads each access point’s WiFi configuration (passphrases never leave the access points). Observe changes
          nothing on them.
        </p>
        <ul className="divide-y divide-border/70 rounded-lg border border-border">
          {aps.map((ap) => (
            <ApReadRow key={ap.apId} ap={ap} isAdmin={isAdmin} />
          ))}
        </ul>
      </div>
    )
    footer = (
      <Button onClick={() => setStep(1)} disabled={reading.length === 0}>
        Next: networks
        <ArrowRight />
      </Button>
    )
  } else if (step === 1) {
    const skipped = new Map<string, number>()
    for (const s of view?.skipped ?? []) skipped.set(`${s.apId}:${s.reason}`, (skipped.get(`${s.apId}:${s.reason}`) ?? 0) + 1)
    body = adoption.isPending ? (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" /> Grouping what the access points broadcast…
      </p>
    ) : (
      <div className="space-y-3">
        {changed ? <ErrorLine message="The access points changed since this list was read: here is the new one." /> : null}
        <p className="text-xs text-muted-foreground">
          Interfaces with the same name, security and passphrase become one network. Adopting changes nothing on the access
          points.
        </p>
        {proposals.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing new to adopt.</p>
        ) : (
          <ul className="space-y-2">
            {proposals.map((p) => (
              <ProposalCard
                key={p.key}
                proposal={p}
                edit={editFor(p)}
                onEdit={(e) => setEdits((cur) => ({ ...cur, [p.key]: e }))}
                others={proposals.filter((o) => o.key !== p.key && editFor(o).mergeInto === null && !editFor(o).exclude)}
                apName={apName}
              />
            ))}
          </ul>
        )}
        {skipped.size > 0 ? (
          <ul className="space-y-1 rounded-md border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
            {[...skipped.entries()].map(([key, n]) => {
              const [apId, reason] = key.split(':') as [string, AdoptionView['skipped'][number]['reason']]
              return <li key={key}>{SKIP_TEXT[reason](n, apName(Number(apId)))}</li>
            })}
          </ul>
        ) : null}
      </div>
    )
    footer = (
      <>
        <Button variant="outline" onClick={() => setStep(0)}>
          Back
        </Button>
        <Button onClick={() => setStep(2)} disabled={adoption.isPending}>
          Next: country
          <ArrowRight />
        </Button>
      </>
    )
  } else if (step === 2) {
    body = (
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          One country per access point, written to every radio. It decides which channels and how much power are legal:
          pick where the access points are.
        </p>
        <div className="space-y-1.5 text-xs">
          <label htmlFor="adopt-fleet-country" className="block font-medium">
            Fleet default
          </label>
          <select
            id="adopt-fleet-country"
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-xs sm:w-72 dark:bg-input/30"
            value={fleetCountry ?? ''}
            onChange={(e) => setCountryDefault(e.target.value || null)}
          >
            <option value="">Leave each access point’s</option>
            {countryOptions().map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
          {suggested ? <p className="text-muted-foreground">Suggested from the time zone: {countryName(suggested)}.</p> : null}
        </div>
        <ul className="divide-y divide-border/70 rounded-lg border border-border">
          {(view?.countries ?? []).map((c) => {
            const policy = countries[c.apId] ?? { mode: 'fleet' }
            return (
              <li key={c.apId} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-xs">
                <span className="text-[13px] font-medium">{apName(c.apId)}</span>
                <span className="flex gap-1">
                  {(c.unset || c.values.length === 0 ? [...c.values, '—'] : c.values).map((v) => (
                    <ToneBadge key={v} tone="neutral">
                      <span className="font-mono">{v}</span>
                    </ToneBadge>
                  ))}
                </span>
                {c.values.length > 1 ? (
                  <ToneBadge tone="warning">
                    <Warning aria-hidden weight="fill" className="size-3 text-status-warning" />
                    Radios disagree
                  </ToneBadge>
                ) : null}
                <select
                  className="ml-auto h-9 rounded-md border border-input bg-transparent px-2 text-xs dark:bg-input/30"
                  value={policy.mode === 'fixed' ? `fixed:${policy.code}` : policy.mode}
                  onChange={(e) => {
                    const v = e.target.value
                    setCountries((cur) => ({
                      ...cur,
                      [c.apId]: v.startsWith('fixed:') ? { mode: 'fixed', code: v.slice(6) } : { mode: v as 'fleet' | 'router' },
                    }))
                  }}
                  aria-label={`Country for ${apName(c.apId)}`}
                >
                  <option value="fleet">Fleet default{fleetCountry ? ` (${fleetCountry})` : ''}</option>
                  <option value="router">Keep what it has</option>
                  {c.values
                    .filter((v) => v && v !== '—')
                    .map((v) => (
                      <option key={v} value={`fixed:${v}`}>
                        Fixed: {countryName(v)}
                      </option>
                    ))}
                </select>
              </li>
            )
          })}
        </ul>
        <ErrorLine message={accept.error && apiErrorCode(accept.error) !== 'adoption_changed' ? wifiRefusalMessage(accept.error) : null} />
      </div>
    )
    footer = (
      <>
        <Button variant="outline" onClick={() => setStep(1)} disabled={accept.isPending}>
          Back
        </Button>
        <Button onClick={adopt} disabled={accept.isPending || !isAdmin} data-testid="adopt-submit">
          {accept.isPending ? <Spinner className="size-3.5 text-current" /> : <CheckCircle weight="bold" />}
          Adopt {plural(adopting.length, 'network')}
        </Button>
      </>
    )
  } else if (step === 3) {
    body = (
      <div className="space-y-3">
        <p className="flex items-start gap-2 rounded-md border border-status-good/40 bg-status-good/10 px-2.5 py-2 text-xs">
          <CheckCircle weight="fill" className="mt-px size-4 shrink-0 text-status-good" />
          Adopted {plural(result?.networks.length ?? 0, 'network')}. Nothing changed on the access points.
          {result && result.divergences > 0 ? ` ${plural(result.divergences, 'difference')} left to review under Sync.` : ''}
        </p>
        {unknownPassphrases.length === 0 ? (
          <p className="text-xs text-muted-foreground">No passphrase to enter.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Optional: type each network’s passphrase once so Perch can extend it to new access points or show it later.
              You can do this any time from the network’s page.
            </p>
            <ul className="space-y-3">
              {unknownPassphrases.map((n) => (
                <li key={n.id} className="space-y-1 rounded-lg border border-border">
                  <p className="px-4 pt-3 font-mono text-[13px] font-semibold">{n.ssid}</p>
                  <PassphraseRows
                    network={n}
                    needed
                    value=""
                    onValueChange={() => undefined}
                    editing={false}
                    onEditingChange={() => undefined}
                    isAdmin={isAdmin}
                    showError={false}
                    apName={apName}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    )
    footer = (
      <Button onClick={() => setStep(4)}>
        {unknownPassphrases.length > 0 ? 'Next (or skip)' : 'Next'}
        <ArrowRight />
      </Button>
    )
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Perch now mirrors the networks. To change them from Perch, switch each access point to Managed: it asks for your
          password and needs write access on the access point. Until then nothing is ever written.
        </p>
        <ul className="divide-y divide-border/70 rounded-lg border border-border">
          {aps
            .filter((ap) => ap.mode !== 'off')
            .map((ap) => (
              <ManageRow key={ap.apId} ap={ap} />
            ))}
        </ul>
      </div>
    )
    footer = <Button onClick={() => onOpenChange(false)}>Done</Button>
  }

  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      wide
      tall
      title="Adopt your WiFi networks"
      description={<StepBar step={step} />}
      footer={footer}
    >
      {body}
    </EditorSheet>
  )
}
