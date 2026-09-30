import type {
  ConfigDomain,
  SecretEdit,
  SectionEdit,
  SyncedSection,
  ValidationCtx,
} from '#services/gateway_config/domain'
import type { Issue, UciOptions, UciValue } from '#services/gateway_config/types'
import {
  byteLength,
  encryptionBase,
  encryptionKey,
  flagOf,
  flagText,
  groupsOwned,
  intOf,
  keepFlag,
  scalarOf,
  scalarsOnly,
  withOptions,
  wordsOf,
} from '#services/wifi_config/domains/normalize'
import type {
  ApCapabilities,
  HostapdFeatures,
  PmfMode,
  WifiSecurity,
} from '#services/wifi_config/types'

/**
 * `wifi_ifaces`: the AP's access-point `wifi-iface` sections (docs/design/wifi
 * controller.md section 3.2). Claimed when all hold: mode absent or `ap`;
 * `encryption` absent or one of `none owe psk2* sae sae-mixed* psk-mixed*`;
 * no `mesh_id`, no WDS, no OWE transition; `device` names a `wifi-device`
 * section of the read; a non-empty SSID; not a device-groups section.
 * Unclaimed (unmodeled): stations, mesh, ad-hoc, monitor, WDS, Enterprise,
 * WEP, WPA1, interfaces on a radio that does not exist ("orphans").
 *
 * Perch owns the options below; `ifname`, `macaddr`, `dynamic_vlan` (until
 * the device-groups fold), `wpa_disable_eapol_key_retries` and anything else
 * stay the router's: never a conflict, never drift, kept by every write.
 * Equality is normalised (`psk2+ccmp` = `psk2`, flag spellings, `network`
 * as a set); stored content never is.
 */

export const WIFI_IFACES_DOMAIN = 'wifi_ifaces'

export const IFACE_OWNED_OPTIONS = [
  'device',
  'mode',
  'ssid',
  'encryption',
  'key',
  'hidden',
  'isolate',
  'network',
  'disabled',
  'ieee80211r',
  'mobility_domain',
  'ft_over_ds',
  'ft_psk_generate_local',
  'ieee80211k',
  'bss_transition',
  'ieee80211w',
  'multicast_to_unicast_all',
  'maxassoc',
  'dtim_period',
] as const

/** The owned options that must be plain strings for a section to be modeled. */
const SCALAR_OWNED = IFACE_OWNED_OPTIONS.filter((o) => o !== 'key' && o !== 'network')

const FLAG_OPTIONS = [
  'hidden',
  'isolate',
  'disabled',
  'ieee80211r',
  'ft_over_ds',
  'ft_psk_generate_local',
  'ieee80211k',
  'bss_transition',
  'multicast_to_unicast_all',
]

/** `encryption` base → security (controller.md 5.1). */
const SECURITY_OF_BASE: Record<string, WifiSecurity> = {
  'none': 'open',
  'owe': 'owe',
  'psk2': 'wpa2',
  'sae-mixed': 'wpa2_wpa3',
  'sae': 'wpa3',
  'psk-mixed': 'wpa_wpa2',
}

/** Security → the `encryption` Perch writes (`wpa_wpa2` is never offered: import only). */
export const ENCRYPTION_OF_SECURITY: Record<WifiSecurity, string> = {
  open: 'none',
  owe: 'owe',
  wpa2: 'psk2',
  wpa2_wpa3: 'sae-mixed',
  wpa3: 'sae',
  wpa_wpa2: 'psk-mixed',
}

/** The security an `encryption` value (null = absent = open) means, or null when not modeled. */
export function securityOfEncryption(encryption: string | null): WifiSecurity | null {
  const base = encryptionBase(encryption)
  return base === null ? null : (SECURITY_OF_BASE[base] ?? null)
}

/**
 * The `encryption` to write for a security: the current spelling when it
 * already means that security (`psk2+ccmp` stays), else Perch's.
 */
export function encryptionFor(security: WifiSecurity, current: string | null): string | null {
  if (securityOfEncryption(current) === security && current !== null) return current
  return ENCRYPTION_OF_SECURITY[security]
}

/** The hostapd feature a security needs (controller.md 5.1 "Needs"), or null. */
export function securityFeature(security: WifiSecurity): keyof HostapdFeatures | null {
  if (security === 'owe') return 'owe'
  if (security === 'wpa3' || security === 'wpa2_wpa3') return 'sae'
  return null
}

/** Whether a security carries a passphrase (`key`). */
export function securityNeedsKey(security: WifiSecurity): boolean {
  return security !== 'open' && security !== 'owe'
}

const PMF_OF: Record<string, PmfMode> = { '0': 'disabled', '1': 'optional', '2': 'required' }
const PMF_VALUE: Record<PmfMode, string | null> = {
  default: null,
  disabled: '0',
  optional: '1',
  required: '2',
}

/** An access-point interface as the Wi-Fi plane models it. */
export interface IfaceObject {
  perchId: string | null
  section: string
  radio: string
  ssid: string
  security: WifiSecurity
  hidden: boolean
  isolate: boolean
  /** `network` items (the interfaces the BSS is bridged into). */
  networks: string[]
  enabled: boolean
  /** 802.11r. */
  ft: boolean
  mobilityDomain: string | null
  /** null = option absent. */
  ftOverDs: boolean | null
  ftPskGenerateLocal: boolean | null
  /** 802.11k. */
  rrm: boolean
  /** 802.11v BSS transition. */
  btm: boolean
  pmf: PmfMode
  /** null = option absent. */
  multicastToUnicast: boolean | null
  maxClients: number | null
  dtimPeriod: number | null
  /**
   * The passphrase: `{keep}` the AP's (as read), `{ref, fingerprint}` a
   * controller value, null none (open, OWE).
   */
  key: SecretEdit | null
  /** The section's options as read: router-owned ones ride along, spellings are kept. */
  options: UciOptions
  /** Secret slots other than `key` the section carries (kept as the router's). */
  secretNames: string[]
}

export type IfaceFields = Omit<
  IfaceObject,
  'perchId' | 'section' | 'key' | 'options' | 'secretNames'
>

function optionalFlag(options: UciOptions, key: string): boolean | null {
  const value = scalarOf(options, key)
  if (value === null) return null
  const flag = flagText(value)
  return flag === '1' ? true : flag === '0' ? false : null
}

/** The modeled fields of a `wifi-iface`'s options. */
export function ifaceFields(options: UciOptions): IfaceFields {
  const pmfText = scalarOf(options, 'ieee80211w')
  return {
    radio: scalarOf(options, 'device') ?? '',
    ssid: scalarOf(options, 'ssid') ?? '',
    security: securityOfEncryption(scalarOf(options, 'encryption')) ?? 'open',
    hidden: flagOf(options, 'hidden', false),
    isolate: flagOf(options, 'isolate', false),
    networks: wordsOf(options.network),
    enabled: !flagOf(options, 'disabled', false),
    ft: flagOf(options, 'ieee80211r', false),
    mobilityDomain: scalarOf(options, 'mobility_domain')?.trim().toLowerCase() ?? null,
    ftOverDs: optionalFlag(options, 'ft_over_ds'),
    ftPskGenerateLocal: optionalFlag(options, 'ft_psk_generate_local'),
    rrm: flagOf(options, 'ieee80211k', false),
    btm: flagOf(options, 'bss_transition', false),
    pmf: pmfText === null ? 'default' : (PMF_OF[pmfText.trim()] ?? 'default'),
    multicastToUnicast: optionalFlag(options, 'multicast_to_unicast_all'),
    maxClients: intOf(scalarOf(options, 'maxassoc')),
    dtimPeriod: intOf(scalarOf(options, 'dtim_period')),
  }
}

function sameSet(a: string[], b: string[]): boolean {
  const x = [...new Set(a)].sort()
  const y = [...new Set(b)].sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/**
 * The options a changed interface object writes over its current ones:
 * only fields that differ from what the options already mean are
 * respelled, so an unchanged field keeps the router's spelling
 * (controller.md 5.2 step 3) and `render(parse(x))` is exact.
 */
export function ifaceOptions(obj: IfaceObject): UciOptions {
  const fresh = scalarOf(obj.options, 'device') === null
  const was = ifaceFields(obj.options)
  const o = obj.options
  const set: Record<string, UciValue | null> = {}
  if (fresh || obj.radio !== was.radio) set.device = obj.radio
  if (fresh) set.mode = 'ap'
  if (fresh || obj.ssid !== was.ssid) set.ssid = obj.ssid
  if (fresh || obj.security !== was.security) {
    set.encryption = encryptionFor(obj.security, scalarOf(o, 'encryption'))
  }
  if (obj.hidden !== was.hidden) set.hidden = keepFlag(o.hidden, obj.hidden)
  if (obj.isolate !== was.isolate) set.isolate = keepFlag(o.isolate, obj.isolate)
  if (!sameSet(obj.networks, was.networks) || (fresh && obj.networks.length > 0)) {
    set.network = obj.networks.length === 1 ? obj.networks[0] : [...obj.networks]
  }
  if (obj.enabled !== was.enabled) set.disabled = keepFlag(o.disabled, !obj.enabled)
  if (obj.ft !== was.ft) set.ieee80211r = keepFlag(o.ieee80211r, obj.ft)
  if (obj.mobilityDomain !== was.mobilityDomain) set.mobility_domain = obj.mobilityDomain
  if (obj.ftOverDs !== was.ftOverDs) {
    set.ft_over_ds =
      obj.ftOverDs === null ? null : keepFlag(o.ft_over_ds, obj.ftOverDs, { offAs: '0' })
  }
  if (obj.ftPskGenerateLocal !== was.ftPskGenerateLocal) {
    set.ft_psk_generate_local =
      obj.ftPskGenerateLocal === null
        ? null
        : keepFlag(o.ft_psk_generate_local, obj.ftPskGenerateLocal, { offAs: '0' })
  }
  if (obj.rrm !== was.rrm) set.ieee80211k = keepFlag(o.ieee80211k, obj.rrm)
  if (obj.btm !== was.btm) set.bss_transition = keepFlag(o.bss_transition, obj.btm)
  if (obj.pmf !== was.pmf) set.ieee80211w = PMF_VALUE[obj.pmf]
  if (obj.multicastToUnicast !== was.multicastToUnicast) {
    set.multicast_to_unicast_all =
      obj.multicastToUnicast === null
        ? null
        : keepFlag(o.multicast_to_unicast_all, obj.multicastToUnicast, { offAs: '0' })
  }
  if (obj.maxClients !== was.maxClients) {
    set.maxassoc = obj.maxClients === null ? null : String(obj.maxClients)
  }
  if (obj.dtimPeriod !== was.dtimPeriod) {
    set.dtim_period = obj.dtimPeriod === null ? null : String(obj.dtimPeriod)
  }
  return withOptions(obj.options, set)
}

/** Every `interface` name the AP's `network` config (or its report) knows, or null when unknown. */
function knownNetworks(ctx: ValidationCtx, caps: ApCapabilities | null): Set<string> | null {
  const names = new Set<string>()
  for (const s of [...ctx.all, ...(ctx.unmanaged ?? [])]) {
    if (s.config === 'network' && s.type === 'interface') names.add(s.name)
  }
  for (const n of ctx.networks ?? []) names.add(n.name)
  for (const n of caps?.networks ?? []) names.add(n.name)
  return names.size > 0 ? names : null
}

function validateIfaces(
  desired: SyncedSection[],
  ctx: ValidationCtx,
  fallback: ApCapabilities | null
): Issue[] {
  const caps = (ctx.capabilities as ApCapabilities | null) ?? fallback
  const features = caps?.hostapd?.features ?? null
  const networks = knownNetworks(ctx, caps)
  const management = ctx.managementPath?.network ?? caps?.management?.network ?? null
  const issues: Issue[] = []
  const issue = (
    s: SyncedSection,
    severity: Issue['severity'],
    code: string,
    message: string,
    option?: string
  ) =>
    issues.push({
      severity,
      code,
      message,
      perchId: s.perchId,
      config: s.config,
      section: s.name,
      ...(option ? { option } : {}),
    })
  const ifaces = desired.filter((s) => s.config === 'wireless' && s.type === 'wifi-iface')
  const enabledByRadio = new Map<string, SyncedSection[]>()
  for (const s of ifaces) {
    const f = ifaceFields(s.options)
    const bytes = byteLength(f.ssid)
    if (bytes < 1 || bytes > 32) {
      issue(s, 'error', 'ssid_invalid', 'An SSID is 1 to 32 bytes', 'ssid')
    }
    const feature = securityFeature(f.security)
    if (features && feature && features[feature] !== true) {
      issue(
        s,
        'error',
        'security_unsupported',
        `This access point's hostapd cannot do ${f.security} (no ${feature})`,
        'encryption'
      )
    }
    if (features && f.ft && features['11r'] !== true) {
      issue(
        s,
        'error',
        'ft_unsupported',
        "This access point's hostapd has no 802.11r",
        'ieee80211r'
      )
    }
    if (f.security === 'wpa3' && f.pmf === 'disabled') {
      issue(s, 'error', 'pmf_required', 'WPA3 needs protected management frames', 'ieee80211w')
    }
    const radio = caps?.radios?.find((r) => r.section === f.radio)
    if (caps?.radios && !radio) {
      issue(s, 'error', 'radio_unknown', `${f.radio} is not a radio of this access point`, 'device')
    } else if (radio && !radio.present && f.enabled) {
      issue(s, 'warning', 'radio_absent', `${f.radio} has no hardware behind it`, 'device')
    }
    if (networks) {
      for (const n of f.networks) {
        if (!networks.has(n)) {
          issue(
            s,
            'error',
            'network_unknown',
            `No interface "${n}" on this access point`,
            'network'
          )
        }
      }
    }
    if (
      f.enabled &&
      f.security === 'open' &&
      management !== null &&
      f.networks.includes(management)
    ) {
      issue(
        s,
        'warning',
        'open_on_lan',
        `An open network bridged into the management network (${management})`,
        'encryption'
      )
    }
    if (f.enabled) {
      const list = enabledByRadio.get(f.radio) ?? []
      list.push(s)
      enabledByRadio.set(f.radio, list)
    }
  }
  for (const [radio, list] of enabledByRadio) {
    const max = caps?.radios?.find((r) => r.section === radio)?.maxBss ?? null
    if (max !== null && list.length > max) {
      for (const s of list) {
        issue(s, 'error', 'too_many_bss', `${radio} runs at most ${max} networks at once`, 'device')
      }
    }
    const bySsid = new Map<string, SyncedSection[]>()
    for (const s of list) {
      const ssid = scalarOf(s.options, 'ssid') ?? ''
      bySsid.set(ssid, [...(bySsid.get(ssid) ?? []), s])
    }
    for (const [ssid, same] of bySsid) {
      if (same.length < 2) continue
      for (const s of same) {
        issue(s, 'error', 'duplicate_ssid_on_radio', `"${ssid}" twice on ${radio}`, 'ssid')
      }
    }
  }
  return issues
}

/** The domain for one AP (validation reads its capabilities). */
export function wifiIfacesDomain(caps: ApCapabilities | null): ConfigDomain<IfaceObject> {
  return {
    key: WIFI_IFACES_DOMAIN,
    configs: ['wireless'],
    types: ['wifi-iface'],

    claims(section, all) {
      if (section.config !== 'wireless' || section.type !== 'wifi-iface') return false
      if (groupsOwned(section as { name: string; owner?: unknown })) return false
      const o = section.options
      if (!scalarsOnly(o, SCALAR_OWNED)) return false
      const mode = scalarOf(o, 'mode')
      if (mode !== null && mode !== 'ap') return false
      if (o.mesh_id !== undefined || flagOf(o, 'wds', false)) return false
      if (o.owe_transition_ifname !== undefined || o.owe_transition_ssid !== undefined) return false
      if (securityOfEncryption(scalarOf(o, 'encryption')) === null) return false
      const ssid = scalarOf(o, 'ssid')
      if (ssid === null || ssid.length === 0) return false
      const device = scalarOf(o, 'device')
      if (device === null) return false
      return (all.wireless?.sections ?? []).some(
        (s) => s.type === 'wifi-device' && s.name === device
      )
    },

    ownership() {
      return { kind: 'options', options: [...IFACE_OWNED_OPTIONS] }
    },

    listSemantics: { 'wifi-iface.network': 'set' },
    secretOptions: ['key', 'sae_password'],

    normalize(type, option, value): UciValue {
      if (type !== 'wifi-iface') return value
      if (option === 'network') return [...new Set(wordsOf(value))].sort()
      if (typeof value !== 'string') return value
      if (option === 'encryption') return encryptionKey(value)
      if (option === 'mobility_domain') return value.trim().toLowerCase()
      if (option === 'maxassoc' || option === 'dtim_period' || option === 'ieee80211w') {
        const n = intOf(value)
        return n === null ? value : String(n)
      }
      if (FLAG_OPTIONS.includes(option)) return flagText(value)
      return value
    },

    identityKeys(section) {
      if (section.type !== 'wifi-iface') return []
      const device = scalarOf(section.options, 'device')
      const ssid = scalarOf(section.options, 'ssid')
      return device !== null && ssid !== null ? [`iface:${device}:${ssid}`] : []
    },

    parse(sections) {
      return sections
        .filter((s) => s.config === 'wireless' && s.type === 'wifi-iface')
        .map((s) => ({
          perchId: s.perchId,
          section: s.name,
          ...ifaceFields(s.options),
          key: s.secrets?.key ? { keep: true as const } : null,
          options: withOptions(s.options, {}),
          secretNames: Object.keys(s.secrets ?? {}).filter((n) => n !== 'key'),
        }))
    },

    render(obj, current): SectionEdit[] {
      const existing = obj.perchId ? current.find((s) => s.perchId === obj.perchId) : undefined
      const secrets: Record<string, SecretEdit> = {}
      if (obj.key && ('ref' in obj.key || existing?.secrets?.key)) secrets.key = obj.key
      for (const name of obj.secretNames) {
        if (existing?.secrets?.[name]) secrets[name] = { keep: true }
      }
      return [
        {
          op: 'put',
          perchId: obj.perchId,
          config: 'wireless',
          type: 'wifi-iface',
          ...(obj.perchId === null ? { name: obj.section } : {}),
          options: ifaceOptions(obj),
          ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
        },
      ]
    },

    validate(desired, ctx) {
      return validateIfaces(desired, ctx, caps)
    },
  }
}
