import { itemsOf } from '#services/gateway_config/canonical'
import type { UciOptions, UciValue } from '#services/gateway_config/types'

/**
 * Equality normalisers and spelling helpers shared by the Wi-Fi domains
 * (docs/design/wifi controller.md section 3). Normalisers only decide
 * equality; stored content is never normalised, and the `keep*` helpers let
 * a write keep the router's spelling whenever the meaning is unchanged (a
 * render that respells `psk2+ccmp` as `psk2` would churn every AP).
 */

const TRUE_WORDS = ['1', 'true', 'yes', 'on', 'enabled']
const FALSE_WORDS = ['0', 'false', 'no', 'off', 'disabled']

/** UCI booleans: every spelling of true → '1', of false → '0'; anything else as written. */
export function flagText(value: string): string {
  const text = value.trim().toLowerCase()
  if (TRUE_WORDS.includes(text)) return '1'
  if (FALSE_WORDS.includes(text)) return '0'
  return text
}

/** A boolean option: absent (or unreadable) → `fallback`. */
export function flagOf(options: UciOptions, key: string, fallback: boolean): boolean {
  const value = options[key]
  if (typeof value !== 'string') return fallback
  const flag = flagText(value)
  return flag === '1' ? true : flag === '0' ? false : fallback
}

/** A plain string option, or null when absent or a list. */
export function scalarOf(options: UciOptions, key: string): string | null {
  const value = options[key]
  return typeof value === 'string' ? value : null
}

/** Whether every named option is absent or a plain string. */
export function scalarsOnly(options: UciOptions, keys: readonly string[]): boolean {
  return keys.every((k) => options[k] === undefined || typeof options[k] === 'string')
}

/** Items of an option, a scalar with spaces split into words (UCI's `config_get` does). */
export function wordsOf(value: UciValue | undefined): string[] {
  return itemsOf(value)
    .flatMap((v) => v.split(/\s+/))
    .filter((v) => v.length > 0)
}

/** A whole number in a string (`'23'`), else null. */
export function intOf(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !/^\s*-?\d+\s*$/.test(value)) return null
  return Number.parseInt(value, 10)
}

/**
 * Channel numbers of a `channels` value: a list or a space-separated
 * string, ranges (`36-48`) expanded over the band's channel spacing (5 GHz
 * and 6 GHz channels step by 4, 2.4 GHz by 1; without a band, numbers above
 * 14 count as 5 GHz). Sorted, unique; null when any item is not a channel
 * or a range.
 */
export function channelSet(
  value: UciValue | undefined,
  band: string | null = null
): number[] | null {
  const out = new Set<number>()
  for (const word of wordsOf(value)) {
    const range = /^(\d{1,3})-(\d{1,3})$/.exec(word)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (to < from) return null
      const step = band === '6g' ? 4 : band === '2g' ? 1 : from > 14 ? 4 : 1
      for (let c = from; c <= to; c += step) out.add(c)
      continue
    }
    if (!/^\d{1,3}$/.test(word)) return null
    out.add(Number(word))
  }
  return [...out].sort((a, b) => a - b)
}

/** An htmode split into its family and width (`HE80` → HE, 80); null when not one. */
export function parseHtmode(value: string | null): { family: string; width: number } | null {
  if (value === null) return null
  const text = value.trim().toUpperCase()
  if (text === 'NOHT') return { family: 'NOHT', width: 20 }
  const m = /^(HT|VHT|HE|EHT)(20|40|80|160|320)([+-])?$/.exec(text)
  return m ? { family: m[1], width: Number(m[2]) } : null
}

/**
 * The encryption modes the Wi-Fi plane models (controller.md 3.2, 5.1),
 * without their cipher suffix: `none owe psk2 sae sae-mixed psk-mixed`.
 * Returns null for anything else (Enterprise `wpa*`, WPA1 `psk`, WEP, …).
 */
export function encryptionBase(value: string | null): string | null {
  if (value === null) return 'none'
  const [base, ...ciphers] = value.trim().toLowerCase().split('+')
  if (!['none', 'owe', 'psk2', 'sae', 'sae-mixed', 'psk-mixed'].includes(base)) return null
  if (ciphers.some((c) => !['ccmp', 'aes', 'tkip', 'gcmp', 'ccmp256', 'gcmp256'].includes(c))) {
    return null
  }
  if ((base === 'none' || base === 'owe') && ciphers.length > 0) return null
  return base
}

/**
 * Equality form of `encryption`: the base mode, plus the cipher suffix only
 * when it is not the default (`psk2+ccmp` = `psk2+aes` = `psk2`, while
 * `psk2+tkip+ccmp` stays itself).
 */
export function encryptionKey(value: string): string {
  const [base, ...ciphers] = value.trim().toLowerCase().split('+')
  const suffix = ciphers.map((c) => (c === 'aes' ? 'ccmp' : c)).sort()
  if (suffix.length === 0 || (suffix.length === 1 && suffix[0] === 'ccmp')) return base
  return [base, ...suffix].join('+')
}

/**
 * The value to write for a boolean the plane owns (controller.md 5.1:
 * "off = option absent, or kept `'0'` when the router spelled it"): the
 * current spelling when it already means `want`, else `'1'` or absent
 * (`null`). With `offAs: '0'` an explicit off is written as `'0'` (options
 * whose default is on).
 */
export function keepFlag(
  current: UciValue | undefined,
  want: boolean,
  options: { offAs?: 'absent' | '0' } = {}
): string | null {
  if (typeof current === 'string') {
    const flag = flagText(current)
    if (flag === (want ? '1' : '0')) return current
  }
  if (want) return '1'
  return options.offAs === '0' ? '0' : null
}

/** Sets or removes options on a copy (`null` removes, `undefined` leaves alone). */
export function withOptions(
  base: UciOptions,
  set: Record<string, UciValue | null | undefined>
): UciOptions {
  const out: UciOptions = {}
  for (const [k, v] of Object.entries(base)) out[k] = Array.isArray(v) ? [...v] : v
  for (const [key, value] of Object.entries(set)) {
    if (value === undefined) continue
    if (value === null || (Array.isArray(value) && value.length === 0)) delete out[key]
    else out[key] = Array.isArray(value) ? [...value] : value
  }
  return out
}

/** Clones options (lists copied). */
export function cloneOptions(options: UciOptions): UciOptions {
  return withOptions(options, {})
}

/** UTF-8 byte length (SSIDs are limited to 32 bytes, not characters). */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Section names the device-groups engine creates (protocol.md 6, A3). */
export const GROUPS_SECTION_NAME = /^perch_(ws\d+|wv\d+_\w+|v\d+|bv\d+|bvu|dv\d+|bd\d+)$/

/** Whether a read section belongs to the device-groups engine (`owner: "groups"` or its names). */
export function groupsOwned(section: { name: string; owner?: unknown }): boolean {
  return section.owner === 'groups' || GROUPS_SECTION_NAME.test(section.name)
}
