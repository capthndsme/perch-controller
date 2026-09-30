import { useId, useMemo, useState } from 'react'
import { Link, useBlocker, useNavigate } from 'react-router-dom'
import { ArrowsClockwise, ChartLine, Eye, Trash, UsersThree, Warning, WarningCircle } from '@phosphor-icons/react'
import { ConfirmDialog, ErrorLine, IssueList } from '@/components/gateway-config/bits'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { BindingChip } from '@/components/wifi-config/binding-chip'
import { ImpactSheet, PassphraseChangeNote } from '@/components/wifi-config/impact-preview'
import { ApOverridesSheet } from '@/components/wifi-config/network-ap-overrides'
import { BindingSection } from '@/components/wifi-config/network-binding'
import { BroadcastSection, type BroadcastApRow } from '@/components/wifi-config/network-broadcast'
import { RoamingSection } from '@/components/wifi-config/network-roaming'
import { SecuritySection, type CarryingAp } from '@/components/wifi-config/network-security'
import { BandChips, NetworkStatusPill } from '@/components/wifi-config/network-status'
import { PassphraseRows } from '@/components/wifi-config/passphrase-card'
import { Callout, OverrideMarker, SettingRow, SettingsGroup } from '@/components/wifi-config/rows'
import { SecurityChip } from '@/components/wifi-config/security-chip'
import { useDialog } from '@/hooks/use-dialog'
import { useRetained } from '@/hooks/use-retained'
import {
  useApConfigDetails,
  useCreateNetwork,
  useDeleteNetwork,
  useRolloutPreview,
  useStartRollout,
  useUpdateNetwork,
  useUpdateNetworkAp,
} from '@/hooks/use-wifi-config'
import { apiErrorCode } from '@/lib/api'
import {
  bindingWantsIsolation,
  BANDS,
  hostapdFeatures,
  isSecurityDowngrade,
  passphraseProblem,
  plural,
  SECURITY_META,
  securityNeedsPassphrase,
  ssidBytes,
  ssidProblem,
  wifiRefusalMessage,
} from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type {
  Advanced,
  ApConfig,
  Band,
  ImpactPreview,
  NetworkApPut,
  NetworkCreate,
  NetworkPatch,
  Roaming,
  WifiBinding,
  WifiNetwork,
  WifiNetworkAp,
  WifiRadio,
  WifiRollout,
  WifiSecurity,
} from '@/types/wifi-config'

type Draft = {
  ssid: string
  /** The name in Perch; empty = the SSID. */
  label: string
  enabled: boolean
  security: WifiSecurity
  /** A newly typed passphrase ('' = keep the stored one). */
  passphrase: string
  editingPassphrase: boolean
  hidden: boolean
  isolate: boolean
  /** The admin touched client isolation (a guest network then stops pre-ticking it). */
  isolateTouched: boolean
  binding: WifiBinding
  bands: Band[]
  apScope: 'all' | 'selected'
  /** APs switched on under `selected`. */
  selected: number[]
  /** APs switched off under `all`. */
  excluded: number[]
  roaming: Roaming
  advanced: Advanced
  /** Per-AP settings edited in this session, written on Save. */
  apEdits: Record<number, NetworkApPut>
}

const DEFAULT_ADVANCED: Advanced = { pmf: 'default', multicastToUnicast: null, maxClients: null, dtimPeriod: null }

function draftOf(network: WifiNetwork | null, defaults: { fastRoaming: boolean }): Draft {
  if (!network) {
    return {
      ssid: '',
      label: '',
      enabled: true,
      security: 'wpa2',
      passphrase: '',
      editingPassphrase: false,
      hidden: false,
      isolate: false,
      isolateTouched: false,
      binding: { kind: 'lan' },
      bands: ['2g', '5g'],
      apScope: 'all',
      selected: [],
      excluded: [],
      roaming: { ft: defaults.fastRoaming, mobilityDomain: null, rrm: false, btm: false },
      advanced: DEFAULT_ADVANCED,
      apEdits: {},
    }
  }
  const b = network.binding
  const binding: WifiBinding =
    b.kind === 'vlan'
      ? { kind: 'vlan', vlanId: b.vlanId, gatewayId: b.gatewayId, networkPerchId: b.networkPerchId }
      : { kind: b.kind }
  return {
    ssid: network.ssid,
    label: network.name === network.ssid ? '' : network.name,
    enabled: network.enabled,
    security: network.security,
    passphrase: '',
    editingPassphrase: false,
    hidden: network.hidden,
    isolate: network.isolate,
    isolateTouched: true,
    binding,
    bands: [...network.bands],
    apScope: network.apScope,
    selected: network.aps.filter((ap) => ap.included === true || (network.apScope === 'selected' && ap.carried)).map((ap) => ap.apId),
    excluded: network.aps.filter((ap) => ap.included === false).map((ap) => ap.apId),
    roaming: { ...network.roaming },
    advanced: { ...network.advanced },
    apEdits: {},
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function isIncluded(draft: Draft, apId: number): boolean {
  return draft.apScope === 'selected' ? draft.selected.includes(apId) : !draft.excluded.includes(apId)
}

function customisedEdit(edit: Pick<NetworkApPut, 'bands' | 'radios' | 'overrides' | 'radioOverrides'> | null | undefined) {
  if (!edit) return false
  return (
    (edit.bands ?? null) !== null ||
    (edit.radios ?? null) !== null ||
    Object.keys(edit.overrides ?? {}).length > 0 ||
    Object.keys(edit.radioOverrides ?? {}).length > 0
  )
}

/** "Different on Porch AP" / "Different on 2 APs" for APs whose value differs. */
function differentOn(names: string[]): string | null {
  if (names.length === 0) return null
  return names.length === 1 ? `Different on ${names[0]}` : `Different on ${names.length} APs`
}

type SaveError = { message: string; issues?: WifiNetwork['issues'] }

/**
 * The network editor (dashboard.md 1.2): General, Security, Network,
 * Broadcasting, Roaming, Advanced, in grouped rows like UniFi's WiFi
 * settings. Every per-AP override shows where it applies. Save writes the
 * change as a draft (`?apply=0`), then asks for the impact preview; Apply
 * starts the rollout, Keep as draft leaves the access points alone.
 */
export function NetworkEditor({
  network,
  aps,
  radios,
  rollout,
  isAdmin,
  fastRoamingDefault,
}: {
  network: WifiNetwork | null
  aps: ApConfig[]
  radios: WifiRadio[]
  rollout: WifiRollout | null
  isAdmin: boolean
  fastRoamingDefault: boolean
}) {
  const navigate = useNavigate()
  const isNew = network === null
  const [draft, setDraft] = useState(() => draftOf(network, { fastRoaming: fastRoamingDefault }))
  const [initial, setInitial] = useState(draft)
  const [seenRevision, setSeenRevision] = useState(network?.revision ?? 0)
  const [tried, setTried] = useState(false)
  const [error, setError] = useState<SaveError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedId, setSavedId] = useState<number | null>(network?.id ?? null)
  const [preview, setPreview] = useState<ImpactPreview | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewNotes, setPreviewNotes] = useState<{ passphrase: boolean; downgrade: WifiSecurity | null }>({
    passphrase: false,
    downgrade: null,
  })
  const [customizing, setCustomizing] = useState<number | null>(null)
  const shownCustomizing = useRetained(customizing)
  const [customizeKey, setCustomizeKey] = useState(0)
  const removeDialog = useDialog()

  const create = useCreateNetwork()
  const update = useUpdateNetwork()
  const putAp = useUpdateNetworkAp()
  const previewMutation = useRolloutPreview()
  const start = useStartRollout()
  const remove = useDeleteNetwork()

  const dirty = !same({ ...draft, isolateTouched: null }, { ...initial, isolateTouched: null })
  const readOnly = !isAdmin

  // A newer revision from the server replaces an untouched form; an edited one keeps the edit.
  const changedElsewhere = network !== null && network.revision !== seenRevision
  if (changedElsewhere && !dirty && !saving) {
    const next = draftOf(network, { fastRoaming: fastRoamingDefault })
    setDraft(next)
    setInitial(next)
    setSeenRevision(network.revision)
  }

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !saving && isAdmin && currentLocation.pathname !== nextLocation.pathname,
  )

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))

  // ── The access points ──
  const apRows: BroadcastApRow[] = useMemo(() => {
    const byId = new Map<number, WifiNetworkAp>((network?.aps ?? []).map((ap) => [ap.apId, ap]))
    const list = aps.filter((ap) => ap.mode !== 'off' || byId.has(ap.apId))
    return list
      .map((ap) => {
        const saved = byId.get(ap.apId) ?? null
        const edit = draft.apEdits[ap.apId]
        return {
          apId: ap.apId,
          name: ap.name,
          online: ap.online,
          mode: ap.mode,
          included: isIncluded(draft, ap.apId),
          saved,
          customised: customisedEdit(edit ?? saved),
          bands: BANDS.filter((b) => radios.some((r) => r.apId === ap.apId && r.present && r.band === b)),
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [aps, network, draft, radios])

  const carryingIds = apRows.filter((r) => r.included && r.mode !== 'off').map((r) => r.apId)
  const details = useApConfigDetails(carryingIds)
  const carrying: CarryingAp[] = carryingIds.map((apId, i) => ({
    apId,
    name: apRows.find((r) => r.apId === apId)?.name ?? `AP ${apId}`,
    features: hostapdFeatures(details[i]?.data?.capabilities),
  }))
  const apName = (apId: number) => aps.find((ap) => ap.apId === apId)?.name ?? `AP ${apId}`
  const availableBands = BANDS.filter((b) => radios.some((r) => r.present && r.band === b))

  // ── Where per-AP values differ (markers) ──
  const effectiveAp = (row: BroadcastApRow) => {
    const edit = draft.apEdits[row.apId]
    return {
      bands: edit && 'bands' in edit ? (edit.bands ?? null) : (row.saved?.bands ?? null),
      overrides: edit?.overrides ?? row.saved?.overrides ?? {},
    }
  }
  const includedRows = apRows.filter((r) => r.included)
  const markerFor = (pick: (row: BroadcastApRow) => boolean) => differentOn(includedRows.filter(pick).map((r) => r.name))
  const bandsMarker = markerFor((r) => {
    const b = effectiveAp(r).bands
    return b !== null && !same([...b].sort(), [...draft.bands].sort())
  })
  const flagMarker = (key: 'enabled' | 'hidden' | 'isolate', value: boolean) =>
    markerFor((r) => {
      const o = effectiveAp(r).overrides[key]
      return o !== undefined && o !== value
    })

  // ── Validation ──
  const needsPassphrase = securityNeedsPassphrase(draft.security)
  const passphraseState = network?.passphrase.state ?? 'none'
  const typingPassphrase = needsPassphrase && (passphraseState === 'none' || draft.editingPassphrase)
  const problems: string[] = []
  const ssidError = ssidProblem(draft.ssid)
  if (ssidError) problems.push(ssidError)
  if (draft.label.length > 64) problems.push('The name in Perch is at most 64 characters.')
  if (typingPassphrase && passphraseProblem(draft.passphrase)) problems.push(passphraseProblem(draft.passphrase)!)
  if (draft.bands.length === 0) problems.push('Pick at least one band.')
  if (draft.advanced.pmf === 'disabled' && draft.security === 'wpa3') problems.push('WPA3 needs protected management frames.')
  if (draft.binding.kind === 'vlan' && (draft.binding.vlanId < 1 || draft.binding.vlanId > 4094)) problems.push('A VLAN id is 1–4094.')
  if (draft.apScope === 'selected' && draft.selected.length === 0) problems.push('Switch on at least one access point.')
  const numberProblem = (value: number | null, max: number, label: string) =>
    value !== null && (!Number.isInteger(value) || value < 1 || value > max) ? `${label}: 1–${max}.` : null
  const maxProblem = numberProblem(draft.advanced.maxClients, 512, 'Max clients')
  const dtimProblem = numberProblem(draft.advanced.dtimPeriod, 255, 'DTIM period')
  if (maxProblem) problems.push(maxProblem)
  if (dtimProblem) problems.push(dtimProblem)

  // ── Save ──
  function bodyOf(d: Draft): NetworkCreate {
    return {
      name: d.label.trim() || d.ssid,
      ssid: d.ssid,
      enabled: d.enabled,
      security: d.security as NetworkCreate['security'],
      ...(needsPassphrase && d.passphrase ? { passphrase: d.passphrase } : {}),
      hidden: d.hidden,
      isolate: d.isolate,
      binding: d.binding,
      bands: BANDS.filter((b) => d.bands.includes(b)),
      apScope: d.apScope,
      ...(d.apScope === 'selected' ? { apIds: [...d.selected].sort((a, b) => a - b) } : {}),
      roaming: { ft: d.roaming.ft, rrm: d.roaming.rrm, btm: d.roaming.btm },
      advanced: d.advanced,
    }
  }

  function patchOf(from: Draft, to: Draft): NetworkPatch {
    const a = bodyOf(from)
    const b = bodyOf(to)
    const patch: NetworkPatch = {}
    for (const key of Object.keys(b) as Array<keyof NetworkCreate>) {
      if (!same(a[key], b[key])) (patch as Record<string, unknown>)[key] = b[key]
    }
    if (to.passphrase && needsPassphrase) patch.passphrase = to.passphrase
    return patch
  }

  /** Per-AP writes: edited overrides, and inclusion changes under "All". */
  function apWrites(from: Draft, to: Draft): Array<{ apId: number; body: NetworkApPut }> {
    const writes = new Map<number, NetworkApPut>()
    for (const [id, edit] of Object.entries(to.apEdits)) writes.set(Number(id), { ...edit })
    if (to.apScope === 'all') {
      for (const row of apRows) {
        const was = from.apScope === 'all' ? !from.excluded.includes(row.apId) : true
        const now = !to.excluded.includes(row.apId)
        if (was !== now || (from.apScope !== 'all' && !now)) {
          writes.set(row.apId, { ...(writes.get(row.apId) ?? {}), included: now ? null : false })
        }
      }
    }
    return [...writes.entries()].map(([apId, body]) => ({ apId, body }))
  }

  async function openPreview(id: number, notes: typeof previewNotes) {
    setPreview(null)
    setPreviewNotes(notes)
    try {
      const result = await previewMutation.mutateAsync({ networkIds: [id] })
      setPreview(result)
      setPreviewOpen(true)
    } catch (e) {
      if (apiErrorCode(e) === 'nothing_to_apply') {
        setNotice('Saved. Nothing changes on the access points.')
        if (isNew) navigate(`/wifi/networks/${id}`, { replace: true })
      } else {
        setError({ message: `Saved as a draft, but the preview failed: ${wifiRefusalMessage(e)}` })
      }
    }
  }

  async function save() {
    setTried(true)
    setError(null)
    setNotice(null)
    if (problems.length > 0) return
    setSaving(true)
    const passphraseChanged = !isNew && needsPassphrase && draft.passphrase !== '' && passphraseState !== 'none'
    const downgrade = network !== null && isSecurityDowngrade(network.security, draft.security) ? network.security : null
    try {
      let id: number
      if (network === null) {
        const result = await create.mutateAsync({ body: bodyOf(draft), apply: false })
        if (!result.object) throw new Error('The controller did not return the new network.')
        id = result.object.id
      } else {
        id = network.id
        const patch = patchOf(initial, draft)
        if (Object.keys(patch).length > 0) await update.mutateAsync({ id, patch, apply: false })
      }
      setSavedId(id)
      for (const write of apWrites(initial, draft)) {
        await putAp.mutateAsync({ id, apId: write.apId, body: write.body, apply: false })
      }
      const clean = { ...draft, passphrase: '', editingPassphrase: false, apEdits: {} }
      setDraft(clean)
      setInitial(clean)
      setTried(false)
      await openPreview(id, { passphrase: passphraseChanged, downgrade })
    } catch (e) {
      const issues = (e as { body?: { issues?: WifiNetwork['issues'] } })?.body?.issues
      setError({ message: wifiRefusalMessage(e), issues })
    } finally {
      setSaving(false)
    }
  }

  async function applyNow() {
    if (savedId === null) return
    try {
      const started = await start.mutateAsync({ networkIds: [savedId] })
      setPreviewOpen(false)
      setNotice(`Rolling out to ${plural(started.steps.length, 'access point')}, one at a time.`)
      if (isNew) navigate(`/wifi/networks/${savedId}`, { replace: true })
    } catch {
      // shown in the sheet
    }
  }

  function keepDraft() {
    setPreviewOpen(false)
    setNotice('Saved as a draft. Nothing changed on the access points: apply it from here when you are ready.')
    if (isNew && savedId !== null) navigate(`/wifi/networks/${savedId}`, { replace: true })
  }

  function discard() {
    setDraft(initial)
    setTried(false)
    setError(null)
  }

  const title = network === null ? 'New network' : network.name
  const customRow = apRows.find((r) => r.apId === shownCustomizing) ?? null
  const unmanaged = aps.length > 0 && !aps.some((ap) => ap.mode === 'managed')
  const ssidId = useId()
  const labelId = useId()
  const pendingDraft = network !== null && !dirty && (network.status === 'ahead' || network.status === 'partial')

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={title}
        crumbs={[{ label: 'WiFi networks', to: '/wifi/networks' }, { label: isNew ? 'New' : network.name }]}
        description={
          isNew
            ? 'A network the access points broadcast. Saved first, then applied to one access point at a time.'
            : network.ssid !== network.name
              ? `Broadcast as “${network.ssid}”`
              : undefined
        }
        actions={
          !isNew ? (
            <Button asChild variant="outline" size="sm">
              <Link to={`/wifi/ssids/${encodeURIComponent(network.ssid)}`}>
                <ChartLine />
                Traffic
              </Link>
            </Button>
          ) : null
        }
      >
        {!isNew ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <NetworkStatusPill network={network} rollout={rollout} />
            <SecurityChip security={network.security} />
            <BindingChip binding={network.binding} />
            <BandChips bands={network.bands} />
            {network.counts.clients !== null ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <UsersThree aria-hidden className="size-3.5" />
                {plural(network.counts.clients, 'client')}
              </span>
            ) : null}
          </div>
        ) : null}
      </PageHeader>

      {notice ? (
        <p role="status" className="rounded-md border border-status-good/40 bg-status-good/10 px-3 py-2 text-xs">
          {notice}
        </p>
      ) : null}
      {pendingDraft && isAdmin ? (
        <Callout
          tone="info"
          icon={<ArrowsClockwise weight="bold" className="size-4 text-primary" />}
          title="Saved, not applied yet"
          action={
            <Button size="sm" onClick={() => openPreview(network.id, { passphrase: false, downgrade: null })} disabled={previewMutation.isPending}>
              {previewMutation.isPending ? <Spinner className="size-3.5 text-current" /> : <Eye />}
              Review and apply
            </Button>
          }
        >
          This network has changes the access points do not carry yet.
        </Callout>
      ) : null}
      {changedElsewhere && dirty ? (
        <p className="flex items-start gap-2 rounded-md border border-status-warning/50 bg-status-warning/10 px-3 py-2 text-xs">
          <Warning weight="fill" className="mt-px size-3.5 shrink-0 text-status-warning" />
          Someone saved this network while you were editing. Saving now keeps your version of the fields you changed.
        </p>
      ) : null}
      {unmanaged ? (
        <Callout tone="neutral" title="No access point is managed yet">
          Changes are saved in Perch and go out once you switch access points to Managed under{' '}
          <Link to="/wifi/sync" className="underline underline-offset-2">
            Sync
          </Link>
          .
        </Callout>
      ) : null}
      {network && network.issues.length > 0 ? <IssueList issues={network.issues} /> : null}
      {draft.security === 'open' && draft.binding.kind === 'lan' ? (
        <div id="open-on-lan" className="scroll-mt-24">
          <Callout
            tone="warning"
            icon={<WarningCircle weight="fill" className="size-4 text-status-warning" />}
            title="Open network on your LAN"
          >
            Anyone in range can join without a passphrase and reach every device on your main network. For guests, bind it to
            a guest VLAN with the guest portal and client isolation instead (Network below): a separate change you apply on
            purpose.
          </Callout>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[180px_minmax(0,760px)]">
        <nav aria-label="Sections of the network" className="hidden xl:block">
          <ul className="sticky top-20 space-y-0.5 text-xs">
            {[
              ['general', 'General'],
              ['security', 'Security'],
              ['network', 'Network'],
              ['broadcast', 'Broadcasting'],
              ['roaming', 'Roaming'],
              ['advanced', 'Advanced'],
            ].map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="block rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors duration-base hover:bg-muted hover:text-foreground"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-col gap-6">
          <SettingsGroup title="General" id="general">
            <SettingRow label="Network name (SSID)" htmlFor={ssidId} description="What devices see in their WiFi list." stack>
              <div className="space-y-1">
                <Input
                  id={ssidId}
                  value={draft.ssid}
                  disabled={readOnly}
                  onChange={(event) => set('ssid', event.target.value)}
                  aria-invalid={(tried && ssidError !== null) || ssidBytes(draft.ssid) > 32 || undefined}
                  className="h-9 text-[13px]"
                  placeholder="Home"
                  autoFocus={isNew}
                />
                <p
                  className={cn(
                    'text-[11px] tabular-nums',
                    (tried && ssidError) || ssidBytes(draft.ssid) > 32 ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {(tried && ssidError) || ssidBytes(draft.ssid) > 32 ? ssidError : `${ssidBytes(draft.ssid)} / 32 bytes`}
                </p>
              </div>
            </SettingRow>
            <SettingRow
              label="Name in Perch"
              htmlFor={labelId}
              description="Optional; the SSID when empty. Shown in lists and charts."
              stack
            >
              <Input
                id={labelId}
                value={draft.label}
                disabled={readOnly}
                onChange={(event) => set('label', event.target.value)}
                className="h-9 text-[13px]"
                placeholder={draft.ssid || 'Same as the SSID'}
              />
            </SettingRow>
            <SettingRow
              label="Broadcasting"
              description={draft.enabled ? 'On the air on the access points below.' : 'Off everywhere: kept in Perch, not broadcast.'}
              marker={flagMarker('enabled', draft.enabled) ? <OverrideMarker>{flagMarker('enabled', draft.enabled)}</OverrideMarker> : null}
              control={<Switch checked={draft.enabled} disabled={readOnly} onCheckedChange={(v) => set('enabled', v)} aria-label="Broadcasting" />}
            />
          </SettingsGroup>

          <SecuritySection
            value={draft.security}
            initial={network?.security ?? null}
            onChange={(security) => set('security', security)}
            carrying={carrying}
            pmf={draft.advanced.pmf}
            onPmfChange={(pmf) => set('advanced', { ...draft.advanced, pmf })}
            disabled={readOnly}
          >
            <PassphraseRows
              network={network}
              needed={needsPassphrase}
              value={draft.passphrase}
              onValueChange={(value) => set('passphrase', value)}
              editing={draft.editingPassphrase}
              onEditingChange={(editing) => setDraft((d) => ({ ...d, editingPassphrase: editing, passphrase: editing ? d.passphrase : '' }))}
              isAdmin={isAdmin}
              showError={tried}
              apName={apName}
            />
          </SecuritySection>

          <BindingSection
            value={draft.binding}
            onChange={(binding) => set('binding', binding)}
            onPickNetwork={(n) => {
              if (!draft.isolateTouched && bindingWantsIsolation(n.purpose, false)) set('isolate', true)
            }}
            aps={network?.aps ?? []}
            disabled={readOnly}
          />

          <BroadcastSection
            bands={draft.bands}
            onBandsChange={(bands) => set('bands', bands)}
            availableBands={availableBands.length > 0 ? availableBands : ['2g', '5g']}
            bandsMarker={bandsMarker}
            apScope={draft.apScope}
            onScopeChange={(apScope) =>
              setDraft((d) => ({
                ...d,
                apScope,
                selected: apScope === 'selected' ? apRows.filter((r) => isIncluded(d, r.apId)).map((r) => r.apId) : d.selected,
                excluded: apScope === 'all' ? [] : d.excluded,
              }))
            }
            rows={apRows}
            onToggleAp={(apId, on) =>
              setDraft((d) =>
                d.apScope === 'selected'
                  ? { ...d, selected: on ? [...d.selected, apId] : d.selected.filter((x) => x !== apId) }
                  : { ...d, excluded: on ? d.excluded.filter((x) => x !== apId) : [...d.excluded, apId] },
              )
            }
            onCustomize={(apId) => {
              setCustomizeKey((k) => k + 1)
              setCustomizing(apId)
            }}
            disabled={readOnly}
          />

          <RoamingSection roaming={draft.roaming} onChange={(roaming) => set('roaming', roaming)} carrying={carrying} disabled={readOnly} />

          <SettingsGroup title="Advanced" id="advanced">
            <SettingRow
              label="Hide network name"
              description="Devices join by typing the name. It does not make the network more secure."
              marker={flagMarker('hidden', draft.hidden) ? <OverrideMarker>{flagMarker('hidden', draft.hidden)}</OverrideMarker> : null}
              control={<Switch checked={draft.hidden} disabled={readOnly} onCheckedChange={(v) => set('hidden', v)} aria-label="Hide network name" />}
            />
            <SettingRow
              label="Client isolation"
              description="Devices on this network cannot reach each other, only the internet. Right for guests."
              marker={flagMarker('isolate', draft.isolate) ? <OverrideMarker>{flagMarker('isolate', draft.isolate)}</OverrideMarker> : null}
              control={
                <Switch
                  checked={draft.isolate}
                  disabled={readOnly}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, isolate: v, isolateTouched: true }))}
                  aria-label="Client isolation"
                />
              }
            />
            <SettingRow label="Multicast to unicast" description="Converts multicast (casting, discovery) to per-device frames." stack>
              <Segmented
                size="xs"
                ariaLabel="Multicast to unicast"
                value={draft.advanced.multicastToUnicast === null ? 'default' : draft.advanced.multicastToUnicast ? 'on' : 'off'}
                onChange={(v) =>
                  !readOnly && set('advanced', { ...draft.advanced, multicastToUnicast: v === 'default' ? null : v === 'on' })
                }
                options={[
                  { id: 'default', label: 'Default' },
                  { id: 'on', label: 'On' },
                  { id: 'off', label: 'Off' },
                ]}
                className="w-fit"
              />
            </SettingRow>
            <NumberRow
              label="Max clients"
              description="Per radio. Empty = no limit."
              value={draft.advanced.maxClients}
              onChange={(maxClients) => set('advanced', { ...draft.advanced, maxClients })}
              disabled={readOnly}
              problem={tried ? maxProblem : null}
            />
            <NumberRow
              label="DTIM period"
              description="How often sleeping devices wake for broadcasts. Empty = the default (2)."
              value={draft.advanced.dtimPeriod}
              onChange={(dtimPeriod) => set('advanced', { ...draft.advanced, dtimPeriod })}
              disabled={readOnly}
              problem={tried ? dtimProblem : null}
            />
            <SettingRow
              label="Device group keys"
              description={
                <>
                  Per-device passphrases for{' '}
                  <Link to="/groups" className="underline underline-offset-2">
                    device groups
                  </Link>{' '}
                  on this network. Coming once device groups move onto WiFi management.
                </>
              }
              disabled
              control={<Switch checked={network?.groups ?? false} disabled onCheckedChange={() => undefined} aria-label="Device group keys" />}
            />
          </SettingsGroup>

          {!isNew && isAdmin ? (
            <SettingsGroup title="Remove">
              <SettingRow
                label="Remove this network"
                description="Every access point stops broadcasting it, one at a time. Devices on it disconnect."
                control={
                  <Button variant="destructive" size="sm" onClick={removeDialog.show}>
                    <Trash />
                    Remove
                  </Button>
                }
              />
            </SettingsGroup>
          ) : null}

          {isAdmin && (dirty || isNew || error) ? (
            <div
              className={cn(
                'sticky bottom-[calc(var(--bottom-nav-height)+0.75rem)] z-20 lg:bottom-4',
                'transition-[translate,opacity] duration-base ease-out starting:translate-y-3 starting:opacity-0 motion-reduce:starting:translate-y-0',
              )}
            >
              <div className="card-surface space-y-2 px-3 py-2.5 shadow-lg" data-testid="save-bar">
                {error ? (
                  <div className="space-y-1.5">
                    <ErrorLine message={error.message} />
                    {error.issues?.length ? <IssueList issues={error.issues} /> : null}
                  </div>
                ) : tried && problems.length > 0 ? (
                  <ErrorLine message={problems[0] + (problems.length > 1 ? ` (and ${problems.length - 1} more)` : '')} />
                ) : null}
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {isNew ? 'Not saved yet' : dirty ? 'Unsaved changes' : 'Saved'}
                  </p>
                  {!isNew && dirty ? (
                    <Button variant="ghost" size="lg" onClick={discard} disabled={saving}>
                      Discard
                    </Button>
                  ) : null}
                  <Button size="lg" onClick={save} disabled={saving || (!dirty && !isNew)} data-testid="network-save">
                    {saving ? <Spinner className="size-3.5 text-current" /> : null}
                    {isNew ? 'Create' : 'Save'}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {customRow ? (
        <ApOverridesSheet
          key={customizeKey}
          open={customizing !== null}
          onOpenChange={(open) => !open && setCustomizing(null)}
          apName={customRow.name}
          saved={customRow.saved}
          edit={draft.apEdits[customRow.apId] ?? null}
          radios={radios.filter((r) => r.apId === customRow.apId && r.present)}
          defaults={{
            enabled: draft.enabled,
            hidden: draft.hidden,
            isolate: draft.isolate,
            bands: draft.bands,
            maxClients: draft.advanced.maxClients,
            dtimPeriod: draft.advanced.dtimPeriod,
            apNetworkBinding: draft.binding.kind === 'ap_network',
          }}
          apNetworks={(details[carryingIds.indexOf(customRow.apId)]?.data?.capabilities?.networks ?? []).map((n) => n.name)}
          disabled={readOnly}
          onDone={(edit) => setDraft((d) => ({ ...d, apEdits: { ...d.apEdits, [customRow.apId]: edit } }))}
        />
      ) : null}

      <ImpactSheet
        open={previewOpen}
        onOpenChange={(open) => (open ? setPreviewOpen(true) : keepDraft())}
        title={isNew ? `Apply ${draft.ssid || 'the new network'}?` : `Apply the changes to ${network.name}?`}
        preview={preview}
        notes={
          <>
            {previewNotes.passphrase ? <PassphraseChangeNote ssid={network?.ssid ?? draft.ssid} /> : null}
            {previewNotes.downgrade ? (
              <p className="flex items-start gap-2 rounded-md border border-status-serious/50 bg-status-serious/10 px-2.5 py-2 text-xs font-medium">
                <Warning weight="fill" className="mt-px size-3.5 shrink-0 text-status-serious" />
                Security goes down from {SECURITY_META[previewNotes.downgrade].label} to {SECURITY_META[draft.security].label}.
              </p>
            ) : null}
          </>
        }
        applying={start.isPending}
        error={start.error ? wifiRefusalMessage(start.error) : null}
        onApply={applyNow}
        onKeepDraft={keepDraft}
      />

      <ConfirmDialog
        open={removeDialog.open}
        onOpenChange={removeDialog.setOpen}
        title={`Remove ${network?.name ?? 'this network'}?`}
        description="Every access point stops broadcasting it, one at a time. Devices on it disconnect and need another network."
        confirmLabel="Remove network"
        destructive
        pending={remove.isPending}
        error={remove.error ? wifiRefusalMessage(remove.error) : null}
        onConfirm={() =>
          network &&
          remove.mutate({ id: network.id }, { onSuccess: () => navigate('/wifi/networks', { replace: true }) })
        }
      />

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => !open && blocker.state === 'blocked' && blocker.reset()}
        title="Leave without saving?"
        description="Your changes to this network are not saved."
        confirmLabel="Discard changes"
        destructive
        onConfirm={() => blocker.state === 'blocked' && blocker.proceed()}
      />
    </div>
  )
}

function NumberRow({
  label,
  description,
  value,
  onChange,
  disabled,
  problem,
}: {
  label: string
  description: string
  value: number | null
  onChange: (value: number | null) => void
  disabled: boolean
  problem: string | null
}) {
  const id = useId()
  return (
    <SettingRow
      label={label}
      description={problem ? <span className="text-destructive">{problem}</span> : description}
      htmlFor={id}
      control={
        <Input
          id={id}
          inputMode="numeric"
          className="h-9 w-24 font-mono"
          value={value ?? ''}
          disabled={disabled}
          placeholder="Default"
          aria-invalid={problem ? true : undefined}
          onChange={(event) => {
            const digits = event.target.value.replace(/[^\d]/g, '')
            onChange(digits === '' ? null : Number(digits))
          }}
        />
      }
    />
  )
}
