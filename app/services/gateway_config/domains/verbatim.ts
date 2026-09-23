import { itemsOf } from '#services/gateway_config/canonical'
import type { SectionEdit, SecretEdit, SyncedSection } from '#services/gateway_config/domain'
import type { UciOptions, UciValue } from '#services/gateway_config/types'
import { isIP } from 'node:net'

/**
 * Shared pieces of the plan 2 phase 4 domains (`system`, `dns_settings`,
 * `routes`, `dhcp_tags`; docs/gateway/native-sync.md): their objects are
 * the sections themselves, like the firewall's. `render(parse(x))` writes
 * every option back verbatim, so the round trip is exact whatever spelling
 * LuCI or `uci` used; the REST layer edits the options it models and
 * leaves the rest alone.
 */

/** A section as a verbatim domain object. */
export interface VerbatimSection {
  perchId: string | null
  /** UCI section name (the name a new section gets, when `perchId` is null). */
  section: string
  type: string
  options: UciOptions
  secretNames: string[]
}

export function cloneOptions(options: UciOptions): UciOptions {
  const out: UciOptions = {}
  for (const [k, v] of Object.entries(options)) out[k] = Array.isArray(v) ? [...v] : v
  return out
}

/** `parse` of a verbatim domain: every section of `config` whose type is listed. */
export function parseVerbatim(
  sections: SyncedSection[],
  config: string,
  types: readonly string[]
): VerbatimSection[] {
  return sections
    .filter((s) => s.config === config && types.includes(s.type))
    .map((s) => ({
      perchId: s.perchId,
      section: s.name,
      type: s.type,
      options: cloneOptions(s.options),
      secretNames: Object.keys(s.secrets ?? {}),
    }))
}

/** `render` of a verbatim domain: one `put` with the object's options. */
export function renderVerbatim(
  obj: VerbatimSection,
  current: SyncedSection[],
  config: string
): SectionEdit[] {
  const existing = obj.perchId ? current.find((s) => s.perchId === obj.perchId) : undefined
  const secrets: Record<string, SecretEdit> = {}
  for (const name of obj.secretNames) {
    if (existing?.secrets?.[name]) secrets[name] = { keep: true }
  }
  return [
    {
      op: 'put',
      perchId: obj.perchId,
      config,
      type: obj.type,
      options: cloneOptions(obj.options),
      ...(obj.perchId === null && obj.section ? { name: obj.section } : {}),
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    },
  ]
}

/** A plain-string option (a one-item list counts); null when absent or a longer list. */
export function scalarOption(options: UciOptions, key: string): string | null {
  const value = options[key]
  if (value === undefined) return null
  return Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value
}

/** Whether every named option is absent or a plain string (lists would not round-trip as scalars). */
export function scalarsOnly(options: UciOptions, keys: readonly string[]): boolean {
  return keys.every((k) => options[k] === undefined || typeof options[k] === 'string')
}

/** UCI booleans: `1 true yes on enabled` → `'1'`, `0 false no off disabled` → `'0'`; else the text. */
export function flagValue(value: string): string {
  const text = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return '1'
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return '0'
  return text
}

/** A boolean option, `fallback` when absent or not a boolean. */
export function flagOf(options: UciOptions, key: string, fallback: boolean): boolean {
  const value = scalarOption(options, key)
  if (value === null) return fallback
  const flag = flagValue(value)
  return flag === '1' ? true : flag === '0' ? false : fallback
}

/** Items of an option, a scalar with spaces split into words (UCI's `config_get` does). */
export function wordsOf(value: UciValue | undefined): string[] {
  return itemsOf(value)
    .flatMap((v) => v.split(/\s+/))
    .filter((v) => v.length > 0)
}

/**
 * Sets or removes options on a copy: `undefined` leaves an option alone,
 * `null` (or an empty list) removes it, anything else replaces it.
 */
export function withOptions(
  base: UciOptions,
  set: Record<string, UciValue | null | undefined>
): UciOptions {
  const out = cloneOptions(base)
  for (const [key, value] of Object.entries(set)) {
    if (value === undefined) continue
    if (value === null || (Array.isArray(value) && value.length === 0)) delete out[key]
    else out[key] = Array.isArray(value) ? [...value] : value
  }
  return out
}

export function isIpv4Address(value: string): boolean {
  return isIP(value) === 4
}

export function isIpv6Address(value: string): boolean {
  return isIP(value) === 6
}

export function isIpAddress(value: string): boolean {
  return isIP(value) !== 0
}

/** DNS host names: labels of `[a-z0-9-]`, 1–63 each, 253 in all. */
export const DNS_NAME =
  /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/i

export function isDnsName(value: string): boolean {
  return DNS_NAME.test(value)
}

/** An IPv4 or IPv6 prefix `addr/len` (or a bare address: a host route). */
export function parsePrefix(
  value: string
): { family: 4 | 6; address: string; prefix: number } | null {
  const [address, lengthText, rest] = value.trim().split('/')
  if (rest !== undefined) return null
  const family = isIP(address)
  if (family === 0) return null
  const max = family === 4 ? 32 : 128
  if (lengthText === undefined) return { family: family as 4 | 6, address, prefix: max }
  if (!/^\d{1,3}$/.test(lengthText)) return null
  const prefix = Number(lengthText)
  if (prefix > max) return null
  return { family: family as 4 | 6, address, prefix }
}

function ipv6Words(address: string): number[] | null {
  let text = address.toLowerCase()
  // An embedded IPv4 tail (::ffff:192.168.1.1) becomes two words.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (v4) {
    const parts = v4[1].split('.').map(Number)
    text =
      text.slice(0, -v4[1].length) +
      ((parts[0] << 8) | parts[1]).toString(16) +
      ':' +
      ((parts[2] << 8) | parts[3]).toString(16)
  }
  const [head, tail] = text.split('::')
  const h = head ? head.split(':') : []
  const t = tail !== undefined && tail ? tail.split(':') : []
  const fill = text.includes('::') ? 8 - h.length - t.length : 0
  const words = [...h, ...Array(fill).fill('0'), ...t].map((w) => Number.parseInt(w, 16))
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff)
    ? words
    : null
}

/** The address as 32-bit words (IPv4: one word; IPv6: four). */
function addressBits(address: string): { family: 4 | 6; bits: bigint } | null {
  const family = isIP(address)
  if (family === 4) {
    const n = address.split('.').reduce((acc, p) => acc * 256n + BigInt(Number(p)), 0n)
    return { family: 4, bits: n }
  }
  if (family === 6) {
    const words = ipv6Words(address)
    if (!words) return null
    return { family: 6, bits: words.reduce((acc, w) => (acc << 16n) + BigInt(w), 0n) }
  }
  return null
}

/** Whether `address` is inside `addr/prefix` (same family). */
export function prefixContains(
  prefix: { family: 4 | 6; address: string; prefix: number },
  address: string
): boolean {
  const a = addressBits(prefix.address)
  const b = addressBits(address)
  if (!a || !b || a.family !== b.family || a.family !== prefix.family) return false
  const width = a.family === 4 ? 32n : 128n
  const shift = width - BigInt(prefix.prefix)
  return a.bits >> shift === b.bits >> shift
}

/**
 * Private, loopback, link-local and ULA addresses (rebind protection
 * treats answers in them as a rebind: dnsmasq `--stop-dns-rebind`).
 */
export function isPrivateAddress(address: string): boolean {
  const ranges = [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '100.64.0.0/10',
    '0.0.0.0/8',
    'fc00::/7',
    'fe80::/10',
    '::1/128',
  ]
  return ranges.some((r) => prefixContains(parsePrefix(r)!, address))
}

/** `255.255.255.0` → 24; null when not a contiguous IPv4 mask. */
export function netmaskBits(mask: string): number | null {
  if (!isIpv4Address(mask)) return null
  const n = mask.split('.').reduce((acc, p) => acc * 256 + Number(p), 0) >>> 0
  let bits = 0
  while (bits < 32 && (n & (0x80000000 >>> bits)) !== 0) bits++
  const rebuilt = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return rebuilt === n ? bits : null
}
