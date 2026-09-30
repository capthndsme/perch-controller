import type {
  ConfigDomain,
  SecretEdit,
  SectionEdit,
  SyncedSection,
  ValidationCtx,
} from '#services/gateway_config/domain'
import type { Issue, UciOptions, UciValue } from '#services/gateway_config/types'
import {
  channelSet,
  flagOf,
  flagText,
  intOf,
  keepFlag,
  parseHtmode,
  scalarOf,
  scalarsOnly,
  withOptions,
} from '#services/wifi_config/domains/normalize'
import type {
  ApCapabilities,
  ApManagementPath,
  ApRadioCaps,
  Band,
} from '#services/wifi_config/types'

/**
 * `wifi_radios`: the AP's `wifi-device` sections (docs/design/wifi
 * controller.md section 3.1). Perch owns only `channel channels htmode
 * txpower country disabled`; `path`, `band`, `type`, `cell_density` and
 * everything else stay the router's. `country` is not owned on an AP that
 * cannot set it (`regulatory.settable === false`: an unprivileged
 * container). Stale radios (no hardware behind the section) are claimed
 * too, so a later LuCI deletion is seen, but never rendered onto.
 *
 * Perch never creates, renames or deletes a `wifi-device` section.
 *
 * `channels` compares as a set of channel numbers (ranges expanded) under
 * atomic list semantics: a both-sides edit of the list is a conflict
 * rather than an item merge of mixed spellings (`36-48` vs `36 40 44 48`).
 */

export const WIFI_RADIOS_DOMAIN = 'wifi_radios'

export const RADIO_OWNED_OPTIONS = [
  'channel',
  'channels',
  'htmode',
  'txpower',
  'country',
  'disabled',
] as const

/** The widths each htmode family can express. */
const FAMILY_WIDTHS: Record<string, number[]> = {
  HT: [20, 40],
  VHT: [20, 40, 80, 160],
  HE: [20, 40, 80, 160],
  EHT: [20, 40, 80, 160, 320],
}
const FAMILY_RANK = ['EHT', 'HE', 'VHT', 'HT']

/** A radio as the Wi-Fi plane models it (controller.md 3.1). */
export interface RadioObject {
  perchId: string | null
  section: string
  band: Band | null
  /** Hardware behind the section (capabilities); true when unknown. */
  present: boolean
  /** `auto`, a fixed channel, or null when UCI has no `channel` (not the same as auto). */
  channelMode: 'auto' | 'fixed' | null
  channel: number | null
  /** `channels`: the channels auto may pick from; null = all. */
  allowed: number[] | null
  width: number | null
  /** htmode family the router uses (`HT`, `VHT`, `HE`, `EHT`, `NOHT`). */
  htmodeFamily: string | null
  txpower: { mode: 'auto' | 'fixed'; dbm: number | null }
  enabled: boolean
  country: string | null
  /** The section's options as read: router-owned ones ride along, spellings are kept. */
  options: UciOptions
  secretNames: string[]
}

type RadioFields = Pick<
  RadioObject,
  | 'channelMode'
  | 'channel'
  | 'allowed'
  | 'width'
  | 'htmodeFamily'
  | 'txpower'
  | 'enabled'
  | 'country'
>

/** The modeled fields of a `wifi-device`'s options. */
export function radioFields(options: UciOptions, band: string | null = null): RadioFields {
  const channelText = scalarOf(options, 'channel')
  const channelNumber = intOf(channelText)
  const channelMode =
    channelText === null
      ? null
      : channelText.trim().toLowerCase() === 'auto'
        ? 'auto'
        : channelNumber !== null
          ? 'fixed'
          : null
  const htmode = parseHtmode(scalarOf(options, 'htmode'))
  const txpower = intOf(scalarOf(options, 'txpower'))
  const country = scalarOf(options, 'country')
  return {
    channelMode,
    channel: channelMode === 'fixed' ? channelNumber : null,
    allowed: options.channels === undefined ? null : channelSet(options.channels, band),
    width: htmode?.width ?? null,
    htmodeFamily: htmode?.family ?? null,
    txpower: txpower === null ? { mode: 'auto', dbm: null } : { mode: 'fixed', dbm: txpower },
    enabled: !flagOf(options, 'disabled', false),
    country: country === null ? null : country.trim().toUpperCase(),
  }
}

function radioCapsOf(caps: ApCapabilities | null, section: string): ApRadioCaps | null {
  return caps?.radios?.find((r) => r.section === section) ?? null
}

function bandOf(options: UciOptions, radio: ApRadioCaps | null): Band | null {
  const band = scalarOf(options, 'band')
  if (band === '2g' || band === '5g' || band === '6g' || band === '60g') return band
  return radio?.band ?? null
}

/**
 * The htmode for a width (controller.md 3.1): the router's family when it
 * can express the width (`VHT80` stays VHT), else the best family the radio
 * supports that can (EHT > HE > VHT > HT; VHT never on 2.4 GHz).
 */
export function htmodeFor(
  family: string | null,
  width: number,
  radio: { band: Band | null; modes: string[] } | null
): string {
  const band = radio?.band ?? null
  const fits = (f: string) =>
    (FAMILY_WIDTHS[f] ?? []).includes(width) && !(band === '2g' && f === 'VHT')
  if (family && fits(family)) return `${family}${width}`
  const modes = radio?.modes ?? []
  const best = FAMILY_RANK.find((f) => modes.includes(f) && fits(f))
  return `${best ?? family ?? 'HT'}${width}`
}

function sameNumbers(a: number[] | null, b: number[] | null): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** Every channel of the 5 GHz block a primary channel sits in at a width (null: no such block). */
export function channelBlock(channel: number, width: number): number[] | null {
  if (width <= 20) return [channel]
  const centers: Record<number, number[]> = {
    40: [38, 46, 54, 62, 102, 110, 118, 126, 134, 142, 151, 159, 167, 175],
    80: [42, 58, 106, 122, 138, 155, 171],
    160: [50, 114, 163],
  }
  const span = width / 10 - 2
  for (const center of centers[width] ?? []) {
    const members: number[] = []
    for (let c = center - span; c <= center + span; c += 4) members.push(c)
    if (members.includes(channel)) return members
  }
  return null
}

function issueFor(
  s: SyncedSection,
  severity: Issue['severity'],
  code: string,
  message: string,
  option?: string
): Issue {
  return {
    severity,
    code,
    message,
    perchId: s.perchId,
    config: s.config,
    section: s.name,
    ...(option ? { option } : {}),
  }
}

function validateRadios(
  desired: SyncedSection[],
  ctx: ValidationCtx,
  fallback: ApCapabilities | null
): Issue[] {
  const caps = (ctx.capabilities as ApCapabilities | null) ?? fallback
  const issues: Issue[] = []
  for (const s of desired) {
    if (s.config !== 'wireless' || s.type !== 'wifi-device') continue
    const radio = radioCapsOf(caps, s.name)
    const band = bandOf(s.options, radio)
    const f = radioFields(s.options, band)
    if (caps?.regulatory?.settable === false && f.country !== null) {
      issues.push(
        issueFor(
          s,
          'warning',
          'country_not_settable',
          `This access point cannot set its country (${caps.regulatory.reason ?? 'not settable'})`,
          'country'
        )
      )
    }
    if (!radio) continue
    if (!radio.present) {
      issues.push(
        issueFor(
          s,
          'error',
          'radio_absent',
          `${s.name} has no hardware behind it (a stale section)`
        )
      )
      continue
    }
    const usable = (c: number) =>
      radio.channels.some((ch) => ch.channel === c && !ch.disabled && !ch.noIr)
    if (radio.channels.length > 0) {
      if (f.channelMode === 'fixed' && f.channel !== null && !usable(f.channel)) {
        issues.push(
          issueFor(
            s,
            'error',
            'invalid_channel',
            `Channel ${f.channel} is not available on ${s.name}`,
            'channel'
          )
        )
      }
      for (const c of f.allowed ?? []) {
        if (!usable(c)) {
          issues.push(
            issueFor(
              s,
              'error',
              'invalid_channel',
              `Channel ${c} is not available on ${s.name}`,
              'channels'
            )
          )
        }
      }
    }
    if (f.width !== null && radio.widths.length > 0 && !radio.widths.includes(f.width)) {
      issues.push(
        issueFor(s, 'error', 'invalid_width', `${s.name} cannot use ${f.width} MHz`, 'htmode')
      )
    } else if (f.width !== null && f.width > 40 && band === '2g') {
      issues.push(
        issueFor(s, 'error', 'width_channel', `${f.width} MHz is not possible on 2.4 GHz`, 'htmode')
      )
    } else if (
      f.width !== null &&
      f.width > 20 &&
      band === '5g' &&
      f.channelMode === 'fixed' &&
      f.channel !== null &&
      radio.channels.length > 0
    ) {
      const block = channelBlock(f.channel, f.width)
      if (
        !block ||
        !block.every((c) => radio.channels.some((ch) => ch.channel === c && !ch.disabled))
      ) {
        issues.push(
          issueFor(
            s,
            'error',
            'width_channel',
            `Channel ${f.channel} has no ${f.width} MHz block on ${s.name}`,
            'htmode'
          )
        )
      }
    }
    if (
      f.txpower.mode === 'fixed' &&
      f.txpower.dbm !== null &&
      radio.txpowerMaxDbm !== null &&
      f.txpower.dbm > radio.txpowerMaxDbm
    ) {
      issues.push(
        issueFor(
          s,
          'warning',
          'txpower_over_max',
          `${f.txpower.dbm} dBm is above what ${s.name} allows (${radio.txpowerMaxDbm} dBm); the radio caps it`,
          'txpower'
        )
      )
    }
  }
  return issues
}

/**
 * The domain for one AP, parameterised by its capabilities (the ownership
 * of `country`, the htmode families, validation).
 */
export function wifiRadiosDomain(caps: ApCapabilities | null): ConfigDomain<RadioObject> {
  const settable = caps?.regulatory?.settable !== false
  const owned = RADIO_OWNED_OPTIONS.filter((o) => settable || o !== 'country')
  return {
    key: WIFI_RADIOS_DOMAIN,
    configs: ['wireless'],
    types: ['wifi-device'],

    claims(section) {
      return (
        section.config === 'wireless' &&
        section.type === 'wifi-device' &&
        scalarOf(section.options, 'type') === 'mac80211' &&
        scalarsOnly(section.options, ['channel', 'htmode', 'txpower', 'country', 'disabled'])
      )
    },

    ownership() {
      return { kind: 'options', options: [...owned] }
    },

    normalize(type, option, value): UciValue {
      if (type !== 'wifi-device') return value
      if (option === 'channels') {
        const set = channelSet(value)
        return set === null ? value : set.map(String)
      }
      if (typeof value !== 'string') return value
      switch (option) {
        case 'channel':
          return value.trim().toLowerCase()
        case 'htmode':
        case 'country':
          return value.trim().toUpperCase()
        case 'txpower': {
          const n = intOf(value)
          return n === null ? value : String(n)
        }
        case 'disabled':
          return flagText(value)
        default:
          return value
      }
    },

    identityKeys(section) {
      if (section.type !== 'wifi-device') return []
      const path = scalarOf(section.options, 'path')
      if (!path) return []
      const band = scalarOf(section.options, 'band')
      return [`radio:path:${path}${band ? `|${band}` : ''}`]
    },

    touchesManagement(section, path) {
      const radios = (path as Partial<ApManagementPath>).radios ?? []
      return section.type === 'wifi-device' && radios.includes(section.name)
    },

    parse(sections) {
      return sections
        .filter((s) => s.config === 'wireless' && s.type === 'wifi-device')
        .map((s) => {
          const radio = radioCapsOf(caps, s.name)
          const band = bandOf(s.options, radio)
          return {
            perchId: s.perchId,
            section: s.name,
            band,
            present: radio?.present ?? true,
            ...radioFields(s.options, band),
            options: withOptions(s.options, {}),
            secretNames: Object.keys(s.secrets ?? {}),
          }
        })
    },

    render(obj, current): SectionEdit[] {
      const existing = obj.perchId ? current.find((s) => s.perchId === obj.perchId) : undefined
      const was = radioFields(obj.options, obj.band)
      const set: Record<string, UciValue | null> = {}
      if (obj.channelMode !== was.channelMode || obj.channel !== was.channel) {
        set.channel =
          obj.channelMode === null
            ? null
            : obj.channelMode === 'auto'
              ? 'auto'
              : obj.channel === null
                ? null
                : String(obj.channel)
      }
      if (!sameNumbers(obj.allowed, was.allowed)) {
        set.channels = obj.allowed === null ? null : obj.allowed.map(String)
      }
      if (obj.width !== was.width || obj.htmodeFamily !== was.htmodeFamily) {
        set.htmode =
          obj.width === null
            ? null
            : htmodeFor(obj.htmodeFamily, obj.width, radioCapsOf(caps, obj.section))
      }
      if (obj.txpower.mode !== was.txpower.mode || obj.txpower.dbm !== was.txpower.dbm) {
        set.txpower =
          obj.txpower.mode === 'auto' || obj.txpower.dbm === null ? null : String(obj.txpower.dbm)
      }
      if (obj.enabled !== was.enabled) set.disabled = keepFlag(obj.options.disabled, !obj.enabled)
      if (obj.country !== was.country) set.country = obj.country
      const secrets: Record<string, SecretEdit> = {}
      for (const name of obj.secretNames) {
        if (existing?.secrets?.[name]) secrets[name] = { keep: true }
      }
      return [
        {
          op: 'put',
          perchId: obj.perchId,
          config: 'wireless',
          type: 'wifi-device',
          options: withOptions(obj.options, set),
          ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
        },
      ]
    },

    validate(desired, ctx) {
      return validateRadios(desired, ctx, caps)
    },
  }
}
