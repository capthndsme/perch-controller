import { ApiError, apiErrorCode } from '@/lib/api'
import type { Tone } from '@/lib/gateway-config'
import type {
  ApConfig,
  ApMode,
  ApFleetState,
  ApWriteBlockedReason,
  Band,
  DivergenceResolution,
  HostapdFeature,
  RolloutKind,
  RolloutState,
  WifiBinding,
  WifiCapabilities,
  WifiDivergence,
  WifiNetwork,
  WifiNetworkStatus,
  WifiRadio,
  WifiRollout,
  WifiRolloutStep,
  WifiSecurity,
  WifiSlotState,
} from '@/types/wifi-config'

/**
 * Pure helpers of the Wi-Fi management pages (docs/design/wifi/dashboard.md):
 * labels, tones, refusal messages, passphrase rules, channel and power
 * presets, the rollout step phases. The gateway's `lib/gateway-config.ts`
 * keeps the shared ones (tones, time formatting, diff labels).
 */

// ── Bands ───────────────────────────────────────────────────────────────────

export const BANDS: readonly Band[] = ['2g', '5g', '6g']

export const BAND_LABEL: Record<Band, string> = { '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz' }

/** `2.4 · 5 GHz` for a set of bands, in band order. */
export function bandsText(bands: readonly Band[] | null | undefined): string {
  const sorted = BANDS.filter((b) => bands?.includes(b))
  if (sorted.length === 0) return 'No band'
  if (sorted.length === 1) return BAND_LABEL[sorted[0]]
  return `${sorted.map((b) => BAND_LABEL[b].replace(' GHz', '')).join(' · ')} GHz`
}

export function sortBands(bands: readonly Band[]): Band[] {
  return BANDS.filter((b) => bands.includes(b))
}

// ── Security ────────────────────────────────────────────────────────────────

export const SECURITY_META: Record<
  WifiSecurity,
  { label: string; tone: Tone; hint: string; needs: HostapdFeature | null; passphrase: boolean }
> = {
  wpa2: {
    label: 'WPA2',
    tone: 'neutral',
    hint: 'Works with every device. The safe default.',
    needs: null,
    passphrase: true,
  },
  wpa2_wpa3: {
    label: 'WPA2/WPA3',
    tone: 'neutral',
    hint: 'WPA3 for devices that have it, WPA2 for the rest.',
    needs: 'sae',
    passphrase: true,
  },
  wpa3: {
    label: 'WPA3',
    tone: 'good',
    hint: 'Strongest; older devices cannot join.',
    needs: 'sae',
    passphrase: true,
  },
  owe: {
    label: 'OWE',
    tone: 'neutral',
    hint: 'Enhanced Open: no passphrase, but encrypted. Older devices cannot join.',
    needs: 'owe',
    passphrase: false,
  },
  open: {
    label: 'Open',
    tone: 'warning',
    hint: 'No passphrase and no encryption. Anyone nearby can join and read the traffic.',
    needs: null,
    passphrase: false,
  },
  wpa_wpa2: {
    label: 'WPA/WPA2',
    tone: 'warning',
    hint: 'Legacy mixed mode, kept as imported. Pick WPA2 or better to modernise it.',
    needs: null,
    passphrase: true,
  },
}

/** The modes a new or edited network may pick, strongest-compatible first. */
export const SELECTABLE_SECURITY: readonly Exclude<WifiSecurity, 'wpa_wpa2'>[] = [
  'wpa2',
  'wpa2_wpa3',
  'wpa3',
  'owe',
  'open',
]

export const FEATURE_LABEL: Record<HostapdFeature, string> = {
  '11r': '802.11r',
  sae: 'WPA3 (SAE)',
  owe: 'OWE',
  eap: 'Enterprise (EAP)',
  wps: 'WPS',
  mesh: 'Mesh',
  '11ac': 'Wi-Fi 5',
  '11ax': 'Wi-Fi 6',
  '11be': 'Wi-Fi 7',
  acs: 'Auto channel',
  ocv: 'OCV',
}

export function securityNeedsPassphrase(security: WifiSecurity): boolean {
  return SECURITY_META[security].passphrase
}

/** A security mode weaker than another (a downgrade the editor asks about twice). */
export function isSecurityDowngrade(from: WifiSecurity, to: WifiSecurity): boolean {
  const rank: Record<WifiSecurity, number> = { open: 0, owe: 1, wpa_wpa2: 2, wpa2: 3, wpa2_wpa3: 4, wpa3: 5 }
  return rank[to] < rank[from]
}

/** Which carrying APs cannot run a mode: `[{ apId, name }]` for those whose hostapd lacks the feature. */
export function apsLackingFeature(
  feature: HostapdFeature | null,
  aps: Array<{ apId: number; name: string; features: Partial<Record<HostapdFeature, boolean>> | null }>,
): Array<{ apId: number; name: string }> {
  if (!feature) return []
  return aps.filter((ap) => ap.features !== null && ap.features[feature] === false).map(({ apId, name }) => ({ apId, name }))
}

export function hostapdFeatures(capabilities: WifiCapabilities | null | undefined) {
  return capabilities?.hostapd?.features ?? null
}

// ── Passphrases ─────────────────────────────────────────────────────────────

/** 8–63 printable ASCII characters, or 64 hex digits (controller.md 3.2). */
export function passphraseProblem(value: string): string | null {
  if (value.length === 0) return 'Enter a passphrase.'
  if (/^[0-9a-fA-F]{64}$/.test(value)) return null
  if (!/^[\x20-\x7e]*$/.test(value)) return 'Use plain letters, digits and symbols (printable ASCII) only.'
  if (value.length < 8) return `At least 8 characters (${value.length} so far).`
  if (value.length > 63) return 'At most 63 characters (or exactly 64 hex digits).'
  return null
}

/** No 0/O, 1/l/I: easy to read off a card and type on a phone. */
const UNAMBIGUOUS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 20 characters from an unambiguous set, from the browser's CSPRNG (no modulo bias). */
export function generatePassphrase(length = 20): string {
  const out: string[] = []
  const limit = 256 - (256 % UNAMBIGUOUS.length)
  const buffer = new Uint8Array(length * 2)
  while (out.length < length) {
    crypto.getRandomValues(buffer)
    for (const byte of buffer) {
      if (byte < limit) out.push(UNAMBIGUOUS[byte % UNAMBIGUOUS.length])
      if (out.length === length) break
    }
  }
  return out.join('')
}

/** An SSID is 1–32 bytes of UTF-8, not characters. */
export function ssidBytes(value: string): number {
  return new TextEncoder().encode(value).length
}

export function ssidProblem(value: string): string | null {
  const bytes = ssidBytes(value)
  if (bytes === 0) return 'Enter a network name.'
  if (bytes > 32) return `Too long: ${bytes} of 32 bytes.`
  return null
}

/** How long a revealed passphrase stays on screen (dashboard.md section 4). */
export const REVEAL_SECONDS = 30

// ── Bindings ────────────────────────────────────────────────────────────────

export function bindingText(binding: WifiNetwork['binding'] | WifiBinding): string {
  if (binding.kind === 'lan') return 'LAN'
  if (binding.kind === 'ap_network') return 'AP network'
  const withMeta = binding as WifiNetwork['binding']
  const label = withMeta.label ?? null
  return label ? `VLAN ${binding.vlanId} · ${label}` : `VLAN ${binding.vlanId}`
}

/** Guest-purpose or portal networks pre-tick client isolation (dashboard.md 1.2). */
export function bindingWantsIsolation(purpose: string | null | undefined, portal: boolean): boolean {
  return portal || purpose === 'guest'
}

/** An open network bridged into the main LAN (decision D15). */
export function isOpenOnLan(network: Pick<WifiNetwork, 'security' | 'binding'>): boolean {
  return network.security === 'open' && network.binding.kind === 'lan'
}

// ── Network status ──────────────────────────────────────────────────────────

export const NETWORK_STATUS_META: Record<WifiNetworkStatus, { label: string; tone: Tone }> = {
  in_sync: { label: 'In sync', tone: 'good' },
  applying: { label: 'Applying', tone: 'warning' },
  ahead: { label: 'Not applied', tone: 'info' },
  diverged: { label: 'Changed on an AP', tone: 'serious' },
  conflict: { label: 'Conflict', tone: 'critical' },
  drift: { label: 'Drift', tone: 'serious' },
  partial: { label: 'Partly applied', tone: 'warning' },
  unmanaged: { label: 'Observed', tone: 'neutral' },
}

export const SLOT_STATE_META: Record<WifiSlotState, { label: string; tone: Tone }> = {
  in_sync: { label: 'In sync', tone: 'good' },
  ahead: { label: 'Not applied', tone: 'info' },
  pending: { label: 'Applying', tone: 'warning' },
  conflict: { label: 'Conflict', tone: 'critical' },
  drift: { label: 'Drift', tone: 'serious' },
  diverged: { label: 'Changed on the AP', tone: 'serious' },
  missing: { label: 'Missing', tone: 'critical' },
  unsupported: { label: 'Not supported', tone: 'neutral' },
  offline: { label: 'AP offline', tone: 'neutral' },
}

/**
 * The status pill's words (dashboard.md 1.1): "Applying 1/3" while a rollout
 * carries the network, "Changed on Porch AP", "Waiting for Porch AP
 * (offline)", else the status label.
 */
export function networkStatusText(
  network: WifiNetwork,
  rollout: WifiRollout | null | undefined,
): { label: string; tone: Tone } {
  if (rollout && rollout.state === 'running' && rollout.networkIds.includes(network.id)) {
    const done = rollout.steps.filter((s) => STEP_DONE.has(s.state)).length
    return { label: `Applying ${Math.min(done + 1, rollout.steps.length)}/${rollout.steps.length}`, tone: 'warning' }
  }
  const carrying = network.aps.filter((ap) => ap.carried)
  if (network.status === 'diverged') {
    const ap = carrying.find((a) => a.slots.some((s) => s.state === 'diverged'))
    return { label: ap ? `Changed on ${ap.apName}` : 'Changed on an AP', tone: 'serious' }
  }
  if (network.status === 'ahead' || network.status === 'partial') {
    const offline = carrying.find((a) => !a.online && a.slots.some((s) => s.state === 'ahead' || s.state === 'offline'))
    if (offline) return { label: `Waiting for ${offline.apName} (offline)`, tone: 'neutral' }
  }
  return NETWORK_STATUS_META[network.status]
}

// ── APs ─────────────────────────────────────────────────────────────────────

export const AP_MODE_META: Record<ApMode, { label: string; tone: Tone; hint: string }> = {
  off: { label: 'Off', tone: 'neutral', hint: 'Perch does not read this access point’s Wi-Fi configuration.' },
  observe: {
    label: 'Observe',
    tone: 'info',
    hint: 'Read-only: Perch mirrors the Wi-Fi configuration and logs changes. Nothing is written.',
  },
  managed: {
    label: 'Managed',
    tone: 'good',
    hint: 'Two-way: Perch applies its networks and radios here, and edits made in LuCI flow back.',
  },
}

export const FLEET_STATE_META: Record<ApFleetState, { label: string; tone: Tone }> = {
  unknown: { label: 'Not compared yet', tone: 'neutral' },
  in_line: { label: 'Matches the fleet', tone: 'good' },
  diverged: { label: 'Differs from the fleet', tone: 'serious' },
  behind: { label: 'Behind', tone: 'warning' },
  unassigned: { label: 'Unassigned interfaces', tone: 'warning' },
}

/** The local command that grants write access on an AP (protocol.md 1). */
export const ENABLE_WRITE_COMMAND = 'perch-apd wifi access write'
export const ENABLE_READ_COMMAND = 'perch-apd wifi access read'

export const AP_WRITE_BLOCK_TEXT: Record<ApWriteBlockedReason, string> = {
  offline: 'The access point’s agent is not connected.',
  no_capability: 'This perch-apd has no Wi-Fi plane: update perch-apd on the access point.',
  router_access: 'The access point does not allow Perch to write its Wi-Fi configuration.',
  guard_missing: 'The boot guard is missing on the access point: reinstall or update perch-apd.',
  insecure_transport: 'The connection is plain HTTP: Wi-Fi changes need HTTPS, or pairing with both opt-ins.',
  not_paired: 'Plain HTTP with both opt-ins: pair the controller with the access point to sign writes.',
}

/** One short badge for the AP's write state (dashboard.md 1.4). */
export function writeStateBadge(ap: ApConfig): { label: string; tone: Tone; command?: string } {
  if (!ap.capable) return { label: 'Update perch-apd', tone: 'warning' }
  if (ap.access === 'none' || ap.access === null) {
    return { label: 'Wi-Fi access off on the AP', tone: 'neutral', command: ENABLE_READ_COMMAND }
  }
  if (ap.writable) return { label: ap.secure ? 'Writable (TLS)' : 'Writable (paired)', tone: 'good' }
  switch (ap.writeBlockedReason) {
    case 'router_access':
      return { label: 'Read-only on the AP', tone: 'neutral', command: ENABLE_WRITE_COMMAND }
    case 'guard_missing':
      return { label: 'Boot guard missing', tone: 'serious' }
    case 'insecure_transport':
      return { label: 'Read-only: needs HTTPS', tone: 'warning' }
    case 'not_paired':
      return { label: 'Pair to write over plain HTTP', tone: 'warning' }
    case 'offline':
      return { label: 'Offline', tone: 'neutral' }
    case 'no_capability':
      return { label: 'Update perch-apd', tone: 'warning' }
    default:
      return { label: 'Read-only', tone: 'neutral' }
  }
}

/** A country code's English name ("PH" → "Philippines"), or the code. */
export function countryName(code: string | null | undefined): string {
  if (!code) return 'Not set'
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' })
    return names.of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

/** ISO 3166-1 alpha-2 codes (the country pickers). */
const COUNTRY_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT ' +
  'BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ' +
  'ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT ' +
  'HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS ' +
  'LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI ' +
  'NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG ' +
  'SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG ' +
  'UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ')

let countryOptionsCache: Array<{ code: string; name: string }> | null = null

/** Every country as `{ code, name }`, sorted by name. */
export function countryOptions(): Array<{ code: string; name: string }> {
  if (countryOptionsCache) return countryOptionsCache
  const list = COUNTRY_CODES.map((code) => ({ code, name: countryName(code) }))
  countryOptionsCache = list.sort((a, b) => a.name.localeCompare(b.name))
  return countryOptionsCache
}

// ── Radios ──────────────────────────────────────────────────────────────────

export function widthLabel(width: number | null | undefined): string {
  return width ? `${width} MHz` : '—'
}

/** tx power presets of a radio's maximum: High = max, Medium = max − 6, Low = max − 12 dB. */
export type TxPreset = 'auto' | 'high' | 'medium' | 'low' | 'custom'

export function txPresetDbm(preset: Exclude<TxPreset, 'auto' | 'custom'>, maxDbm: number): number {
  return preset === 'high' ? maxDbm : preset === 'medium' ? Math.max(1, maxDbm - 6) : Math.max(1, maxDbm - 12)
}

export function txPresetOf(txpower: WifiRadio['txpower'], maxDbm: number | null): TxPreset {
  if (txpower.mode === 'auto' || txpower.dbm === null) return 'auto'
  if (maxDbm === null) return 'custom'
  for (const preset of ['high', 'medium', 'low'] as const) {
    if (txPresetDbm(preset, maxDbm) === txpower.dbm) return preset
  }
  return 'custom'
}

export function txpowerText(radio: WifiRadio): string {
  const max = radio.options.txpowerMaxDbm
  const preset = txPresetOf(radio.txpower, max)
  if (preset === 'auto') return 'Auto'
  const label = preset === 'custom' ? 'Custom' : preset[0].toUpperCase() + preset.slice(1)
  return `${label} · ${radio.txpower.dbm} dBm`
}

/** The 5 GHz sub-bands the channel grid wraps by (UNII-1, -2A, -2C, -3), else one group per band. */
export function channelGroups(
  band: Band | null,
  channels: WifiRadio['options']['channels'],
): Array<{ label: string; channels: WifiRadio['options']['channels'] }> {
  if (band !== '5g') return [{ label: band ? BAND_LABEL[band] : 'Channels', channels }]
  const groups: Array<{ label: string; test: (c: number) => boolean }> = [
    { label: 'UNII-1 · 36–48', test: (c) => c <= 48 },
    { label: 'UNII-2A · 52–64 · radar check', test: (c) => c >= 52 && c <= 64 },
    { label: 'UNII-2C · 100–144 · radar check', test: (c) => c >= 100 && c <= 144 },
    { label: 'UNII-3 · 149–177', test: (c) => c >= 149 },
  ]
  return groups
    .map((g) => ({ label: g.label, channels: channels.filter((c) => g.test(c.channel)) }))
    .filter((g) => g.channels.length > 0)
}

/** "Auto (100)" / "36" / "Auto" for a radio's channel. */
export function channelText(radio: WifiRadio): string {
  if (radio.channelMode === 'auto') {
    return radio.current.channel ? `Auto (${radio.current.channel})` : 'Auto'
  }
  return radio.channel ? String(radio.channel) : '—'
}

export function isDfsChannel(radio: WifiRadio, channel: number | null | undefined): boolean {
  if (!channel) return false
  return radio.options.channels.some((c) => c.channel === channel && c.dfs)
}

export function cacSecondsFor(radio: WifiRadio, channel: number | null | undefined): number | null {
  if (!channel) return null
  const hit = radio.options.channels.find((c) => c.channel === channel)
  return hit?.dfs ? (hit.cacSeconds ?? 60) : null
}

/** Radio name for people: "5 GHz · radio1". */
export function radioLabel(radio: { band: Band | null; section: string }): string {
  return radio.band ? `${BAND_LABEL[radio.band]} · ${radio.section}` : radio.section
}

// ── Divergences ─────────────────────────────────────────────────────────────

/** The UCI options Perch owns on a Wi-Fi interface or radio, in words. */
export const OPTION_LABEL: Record<string, string> = {
  ssid: 'Network name',
  encryption: 'Security',
  key: 'Passphrase',
  hidden: 'Hidden',
  isolate: 'Client isolation',
  network: 'Network',
  disabled: 'Broadcasting',
  ieee80211r: 'Fast roaming (802.11r)',
  mobility_domain: 'Mobility domain',
  ft_over_ds: 'FT over DS',
  ft_psk_generate_local: 'FT key holder',
  ieee80211k: 'Neighbour reports (802.11k)',
  bss_transition: 'BSS transition (802.11v)',
  ieee80211w: 'Protected management frames',
  multicast_to_unicast_all: 'Multicast to unicast',
  maxassoc: 'Max clients',
  dtim_period: 'DTIM period',
  country: 'Country',
  channel: 'Channel',
  channels: 'Allowed channels',
  htmode: 'Width',
  txpower: 'Transmit power',
  device: 'Radio',
  mode: 'Mode',
}

export function optionLabel(option: string | null | undefined): string {
  if (!option) return 'Setting'
  return OPTION_LABEL[option] ?? option
}

/** A divergence side as words: booleans for the flags, fingerprints for secrets. */
export function divergenceValueText(option: string | null, value: unknown): string {
  if (value === null || value === undefined) return 'not set'
  if (typeof value === 'object' && value !== null && 'fingerprint' in value) {
    return 'a different passphrase'
  }
  const text = Array.isArray(value) ? value.join(', ') : String(value)
  if (option === 'disabled') return text === '1' || text === 'true' ? 'off' : 'on'
  if (['hidden', 'isolate', 'ieee80211r', 'ieee80211k', 'bss_transition', 'multicast_to_unicast_all'].includes(option ?? '')) {
    return text === '1' || text === 'true' ? 'on' : 'off'
  }
  if (option === 'encryption') return encryptionText(text)
  return text
}

function encryptionText(value: string): string {
  const base = value.split('+')[0]
  const map: Record<string, string> = {
    none: 'Open',
    owe: 'OWE',
    psk2: 'WPA2',
    'sae-mixed': 'WPA2/WPA3',
    sae: 'WPA3',
    'psk-mixed': 'WPA/WPA2',
  }
  return map[base] ?? value
}

export const RESOLUTION_META: Record<DivergenceResolution, { label: string; hint: string }> = {
  fleet: { label: 'Apply to all APs', hint: 'Take this AP’s value for the network everywhere.' },
  override: { label: 'Keep for this AP', hint: 'Keep it as this AP’s own setting; the others stay as they are.' },
  revert: { label: 'Revert this AP', hint: 'Put the network’s value back on this AP.' },
  split: { label: 'Make a new network', hint: 'Turn this AP’s interfaces into a network of their own.' },
}

/** One line of what happened, for the divergence list. */
export function divergenceSummary(d: WifiDivergence): string {
  const where = d.networkName ?? 'An interface'
  switch (d.kind) {
    case 'removed':
      return `${where} was removed from ${d.apName}${d.radio ? ` (${d.radio})` : ''}`
    case 'added':
      return `${where} was added on ${d.apName}${d.radio ? ` (${d.radio})` : ''}`
    case 'unassigned':
      return `An interface on ${d.apName} matches several networks`
    case 'country':
      return `Country on ${d.apName}: ${divergenceValueText('country', d.apValue)} (policy: ${divergenceValueText('country', d.fleetValue)})`
    default:
      if (d.option === 'key') return 'Passphrase: different here from the network’s'
      return `${optionLabel(d.option)}: ${divergenceValueText(d.option, d.apValue)} here, ${divergenceValueText(d.option, d.fleetValue)} in the network`
  }
}

// ── Rollouts ────────────────────────────────────────────────────────────────

export const ROLLOUT_STATE_META: Record<RolloutState, { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'warning' },
  paused: { label: 'Paused', tone: 'info' },
  stopped: { label: 'Stopped', tone: 'critical' },
  completed: { label: 'Completed', tone: 'good' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

export const ROLLOUT_KIND_LABEL: Record<RolloutKind, string> = {
  change: 'Network change',
  radios: 'Radio change',
  catch_up: 'Catch-up',
  revert: 'Roll back',
  adopt: 'Adoption',
  rejoin: 'Rejoin',
}

/** Steps that are over (the rollout moves past them). */
export const STEP_DONE: ReadonlySet<WifiRolloutStep['state']> = new Set([
  'confirmed',
  'noop',
  'skipped',
  'failed',
  'rolled_back',
  'cancelled',
])

export function isOpenRollout(rollout: Pick<WifiRollout, 'state'> | null | undefined): boolean {
  return rollout?.state === 'running' || rollout?.state === 'paused' || rollout?.state === 'stopped'
}

export type StepIcon = 'queued' | 'busy' | 'wait' | 'radar' | 'you' | 'done' | 'failed' | 'skipped' | 'offline'

export type StepPhase = {
  label: string
  tone: Tone
  icon: StepIcon
  /** Seconds left on the step's clock (confirm deadline or radar check), when one runs. */
  secondsLeft: number | null
  /** An admin's "Keep changes" is what the step waits for. */
  needsAdmin: boolean
}

/**
 * Where a rollout step stands, in the words the banner and the sheet share
 * (dashboard.md 1.6): queued, sending, reconnecting, health check or radar
 * check with seconds left, waiting for you, kept, rolled back, skipped, offline.
 */
export function stepPhase(step: WifiRolloutStep, now: number): StepPhase {
  const base = { secondsLeft: null, needsAdmin: false }
  switch (step.state) {
    case 'pending':
      return { ...base, label: 'Queued', tone: 'neutral', icon: 'queued' }
    case 'waiting_offline':
      return { ...base, label: 'Offline: waiting for it', tone: 'neutral', icon: 'offline' }
    case 'confirmed':
      return { ...base, label: 'Kept', tone: 'good', icon: 'done' }
    case 'noop':
      return { ...base, label: 'Nothing to change', tone: 'good', icon: 'done' }
    case 'skipped':
      return { ...base, label: 'Skipped: catches up later', tone: 'neutral', icon: 'skipped' }
    case 'cancelled':
      return { ...base, label: 'Cancelled', tone: 'neutral', icon: 'skipped' }
    case 'rolled_back':
      return {
        ...base,
        label: `Rolled back${step.outcome?.reason ? `: ${outcomeReasonText(step.outcome.reason).toLowerCase()}` : ''}`,
        tone: 'critical',
        icon: 'failed',
      }
    case 'failed':
      return {
        ...base,
        label: `Failed${step.outcome?.message ? `: ${step.outcome.message}` : step.outcome?.error ? `: ${step.outcome.error}` : ''}`,
        tone: 'critical',
        icon: 'failed',
      }
    case 'applying':
      break
  }
  const apply = step.apply
  if (!apply || apply.state === 'queued' || apply.state === 'sending') {
    return { ...base, label: 'Sending', tone: 'warning', icon: 'busy' }
  }
  const deadline = apply.deadlineAt ? Math.round((Date.parse(apply.deadlineAt) - now) / 1000) : null
  if (apply.state !== 'pending_confirm') {
    return { ...base, label: 'Finishing', tone: 'warning', icon: 'busy' }
  }
  if (!apply.agentReconnectedAt) {
    return { ...base, label: 'Reconnecting', tone: 'warning', icon: 'busy', secondsLeft: deadline }
  }
  const cac = apply.health?.radios.find((r) => r.dfs?.cacActive)
  if (apply.health?.pending && cac?.dfs) {
    return {
      ...base,
      label: `Radar check · ${cac.dfs.cacSecondsLeft} s left`,
      tone: 'warning',
      icon: 'radar',
      secondsLeft: cac.dfs.cacSecondsLeft,
    }
  }
  if (apply.health?.pending || (apply.confirmations.agent === null && apply.agentReconnectedAt)) {
    return { ...base, label: 'Health check', tone: 'warning', icon: 'busy', secondsLeft: deadline }
  }
  if (apply.confirmMode === 'admin_and_agent' && apply.confirmations.admin === null) {
    return { label: 'Keep the changes?', tone: 'warning', icon: 'you', secondsLeft: deadline, needsAdmin: true }
  }
  return { ...base, label: 'Waiting for confirm', tone: 'warning', icon: 'wait', secondsLeft: deadline }
}

/** The step that is running, or the one a stop points at. */
export function currentStep(rollout: WifiRollout): WifiRolloutStep | null {
  if (rollout.stop) return rollout.steps.find((s) => s.apId === rollout.stop!.apId) ?? null
  return (
    rollout.steps.find((s) => s.state === 'applying') ??
    rollout.steps.find((s) => s.state === 'waiting_offline') ??
    rollout.steps.find((s) => s.state === 'pending') ??
    null
  )
}

export function rolloutProgress(rollout: WifiRollout): { done: number; total: number } {
  return { done: rollout.steps.filter((s) => STEP_DONE.has(s.state)).length, total: rollout.steps.length }
}

export const OUTCOME_REASON_TEXT: Record<string, string> = {
  confirm_timeout: 'No confirmation arrived before the deadline',
  admin: 'An admin reverted it',
  reboot: 'The access point rebooted during the confirm window',
  commit_failed: 'The access point could not commit the change',
  reload_failed: 'Wi-Fi failed to reload with the change',
  health_failed: 'The health check failed',
  no_answer: 'The agent never answered',
  offline: 'The access point was offline',
  refused: 'The access point refused the change',
  expired: 'The job expired',
}

export function outcomeReasonText(reason: string): string {
  return OUTCOME_REASON_TEXT[reason] ?? reason.replace(/_/g, ' ')
}

export const HEALTH_PROBLEM_TEXT: Record<string, string> = {
  radio_down: 'Radio down',
  radio_setup_failed: 'Radio failed to set up',
  bss_missing: 'Network not broadcasting',
  bss_disabled: 'Network disabled',
  ssid_mismatch: 'Broadcasts a different name',
  cac_running: 'Radar check running',
  acs_running: 'Choosing a channel',
  psk_wildcard: 'Device-group key guard',
  hostapd_unreachable: 'hostapd does not answer',
}

// ── Activity ────────────────────────────────────────────────────────────────

/** Wi-Fi-only event names; the gateway's `EVENT_LABEL` covers the shared ones. */
export const WIFI_EVENT_LABEL: Record<string, string> = {
  health_failed: 'Health check failed',
  health_changed: 'Health changed',
  capabilities_changed: 'Capabilities changed',
  divergence_opened: 'Changed on the AP',
  divergence_resolved: 'Change on the AP resolved',
  passphrase_set: 'Passphrase entered',
  passphrase_revealed: 'Passphrase revealed',
  passphrase_changed: 'Passphrase changed',
  country_changed: 'Country changed',
  rollout_started: 'Rollout started',
  rollout_stopped: 'Rollout stopped',
  rollout_completed: 'Rollout completed',
  caught_up: 'Caught up',
  adopted: 'Adopted',
}

// ── Refusals (controller.md 7.2) ────────────────────────────────────────────

const REFUSALS: Record<string, string> = {
  admin_required: 'Only admins can do this.',
  invalid_password: 'That password is not right.',
  ap_not_found: 'No such access point.',
  agent_offline: 'The access point’s agent is not connected.',
  agent_timeout: 'The access point’s agent did not answer in time.',
  ap_busy: 'Too much work is queued for this access point; try again in a moment.',
  router_access_insufficient: 'The access point does not allow this: raise its Wi-Fi access with perch-apd.',
  guard_missing: 'The boot guard is missing on the access point.',
  insecure_transport: 'Writes over plain HTTP need both opt-ins and a pairing.',
  not_paired: 'Pair the controller with the access point first.',
  no_capability: 'This perch-apd has no Wi-Fi plane: update it.',
  apply_in_flight: 'A change is still being applied on this access point.',
  rollout_running: 'Another rollout is still going: wait for it or stop it first.',
  not_managed: 'The access point is not managed by Perch.',
  not_in_sync: 'The access point and Perch are not in sync yet.',
  sync_changed: 'The access point changed while you were looking: review the list again.',
  groups_active: 'Device groups are applying a change on this access point; try again in a minute.',
  expect_revision_required: 'Reload the sync status and try again.',
  country_invalid: 'That is not a country code.',
  trunk_invalid: 'That is not a port of this access point.',
  mode_off: 'Wi-Fi management is off for this access point.',
  no_rejoin_offer: 'There is nothing to restore any more.',
  radio_not_found: 'No such radio.',
  radio_absent: 'That radio is not present on the access point any more.',
  conflict_open: 'Resolve the open conflict on this radio first.',
  invalid_channel: 'That channel is not available on this radio.',
  invalid_width: 'This radio does not support that width.',
  width_channel: 'That width does not fit that channel.',
  invalid_config: 'The change does not validate.',
  network_not_found: 'No such network.',
  ssid_invalid: 'The network name must be 1–32 bytes.',
  passphrase_invalid: 'The passphrase must be 8–63 printable characters, or 64 hex digits.',
  passphrase_required: 'This security mode needs a passphrase.',
  security_unsupported: 'Some access points cannot run that security mode.',
  binding_invalid: 'That network binding is not valid.',
  vlan_unknown: 'The gateway has no network with that VLAN.',
  passphrase_unknown: 'Perch does not know this network’s passphrase yet: enter it first.',
  network_carries_groups: 'Device group keys still use this network.',
  passphrase_mismatch: 'That passphrase does not match what the access points use.',
  radio_unknown: 'That radio does not exist on this access point.',
  band_unsupported: 'This access point has no radio on that band.',
  ap_network_unknown: 'The access point has no network by that name.',
  divergence_closed: 'Someone resolved that already.',
  resolution_not_allowed: 'That choice does not apply to this change.',
  adoption_changed: 'The access points changed since this list was read: review it again.',
  merge_incompatible: 'Those networks cannot be merged: security or passphrases differ.',
  nothing_to_apply: 'There is nothing to apply.',
  conflicts_open: 'Resolve the open conflicts first.',
  rollout_not_found: 'No such rollout.',
  rollout_not_running: 'The rollout is not running.',
  rollout_not_stopped: 'The rollout is not stopped.',
  step_not_skippable: 'That step cannot be skipped.',
  not_pending: 'That change is no longer waiting for a confirmation.',
  deadline_passed: 'Too late: the confirm window closed and the access point rolls back.',
  not_revertible: 'That change can no longer be reverted.',
  no_drift: 'There is no drift to act on.',
  enforcement_suspended: 'Enforcement is suspended: resume it first.',
}

/** A refusal as one sentence: the known code's text, else the server's message. */
export function wifiRefusalMessage(error: unknown): string {
  const code = apiErrorCode(error)
  if (code && REFUSALS[code]) {
    const extra = refusalExtra(error)
    return extra ? `${REFUSALS[code]} ${extra}` : REFUSALS[code]
  }
  if (error instanceof ApiError) {
    if (error.status === 422) {
      const body = error.body as { errors?: Array<{ message: string }> } | null
      if (body?.errors?.length) return body.errors.map((e) => e.message).join(' ')
    }
    return error.message
  }
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

function refusalExtra(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  const body = error.body as Record<string, unknown> | null
  if (!body) return null
  if (Array.isArray(body.apIds) && body.apIds.length > 0) {
    return `(${body.apIds.length} access point${body.apIds.length === 1 ? '' : 's'})`
  }
  return null
}

// ── Small formatters ────────────────────────────────────────────────────────

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "45 s", "2 min", "1 min 30 s". */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest === 0 ? `${m} min` : `${m} min ${rest} s`
}
