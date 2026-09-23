import { randomBytes } from 'node:crypto'

/**
 * Voucher codes (docs/gateway/portal.md §4.1).
 *
 * Crockford base32, upper case: `0-9 A-Z` without I, L, O, U (32 symbols,
 * 5 bits each). Input is forgiving: case is ignored, I and L read as 1, O as
 * 0, and dashes, spaces, dots and underscores are dropped, so a code copied
 * from a print sheet (`K7Q2M-9XH4D`) or typed as `k7q2m 9xh4d` normalizes to
 * the same `K7Q2M9XH4D`. U never appears in a code and is rejected.
 *
 * Default length 10 (50 bits), minimum 8 (40 bits), maximum 16 (80 bits).
 */

export const VOUCHER_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const VOUCHER_CODE_MIN_LENGTH = 8
export const VOUCHER_CODE_MAX_LENGTH = 16
export const VOUCHER_CODE_DEFAULT_LENGTH = 10
/** Characters of the code an admin list shows (`…9XH4D` style hint). */
export const VOUCHER_HINT_LENGTH = 4
/**
 * Longest raw input worth normalizing: a 16-character code with a separator
 * between every character, plus slack. Anything longer is not a code.
 */
const MAX_RAW_INPUT = 64

const ALPHABET_SET = new Set(VOUCHER_ALPHABET)
const ALIASES: Record<string, string> = { I: '1', L: '1', O: '0' }
const SEPARATORS = /[\s\-._]/g

export function isValidCodeLength(length: number): boolean {
  return (
    Number.isInteger(length) &&
    length >= VOUCHER_CODE_MIN_LENGTH &&
    length <= VOUCHER_CODE_MAX_LENGTH
  )
}

/**
 * A fresh code of `length` symbols. Each symbol takes the low five bits of one
 * random byte: 256 is a multiple of 32, so there is no modulo bias.
 * `random` is injectable for tests.
 */
export function generateVoucherCode(
  length: number = VOUCHER_CODE_DEFAULT_LENGTH,
  random: (size: number) => Uint8Array = randomBytes
): string {
  if (!isValidCodeLength(length)) {
    throw new RangeError(
      `voucher code length must be ${VOUCHER_CODE_MIN_LENGTH}–${VOUCHER_CODE_MAX_LENGTH}, got ${length}`
    )
  }
  const bytes = random(length)
  if (bytes.length < length) throw new Error('random source returned too few bytes')
  let code = ''
  for (let i = 0; i < length; i++) code += VOUCHER_ALPHABET[bytes[i] & 31]
  return code
}

/**
 * `count` distinct codes. Collisions inside one batch are astronomically rare
 * at 40+ bits but cheap to rule out; collisions with existing vouchers are
 * caught by the unique `code_hash` index and retried by the caller.
 */
export function generateVoucherCodes(
  count: number,
  length: number = VOUCHER_CODE_DEFAULT_LENGTH,
  random: (size: number) => Uint8Array = randomBytes
): string[] {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`invalid count ${count}`)
  const codes = new Set<string>()
  let attempts = 0
  while (codes.size < count) {
    if (++attempts > count * 4 + 16) throw new Error('random source keeps repeating codes')
    codes.add(generateVoucherCode(length, random))
  }
  return [...codes]
}

/**
 * Typed input → canonical code, or null when it cannot be a code (wrong
 * length after normalizing, a character outside the alphabet). The result is
 * what gets hashed, so every accepted spelling of a code hashes the same.
 */
export function normalizeVoucherCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > MAX_RAW_INPUT) return null
  const stripped = input.replace(SEPARATORS, '').toUpperCase()
  if (!isValidCodeLength(stripped.length)) return null
  let code = ''
  for (const ch of stripped) {
    const mapped = ALIASES[ch] ?? ch
    if (!ALPHABET_SET.has(mapped)) return null
    code += mapped
  }
  return code
}

/**
 * Display form: groups of 5 when the length is a multiple of 5 (10 →
 * `XXXXX-XXXXX`), else groups of 4 (8, 12, 16), else groups of 4 with a
 * shorter tail. Accepts a code in any accepted spelling.
 */
export function formatVoucherCode(code: string): string {
  const normalized = normalizeVoucherCode(code)
  if (!normalized) throw new Error('not a voucher code')
  const size = normalized.length % 5 === 0 ? 5 : 4
  const groups: string[] = []
  for (let i = 0; i < normalized.length; i += size) groups.push(normalized.slice(i, i + size))
  return groups.join('-')
}

/** The last four characters, what lists show next to an otherwise hidden code. */
export function voucherHint(code: string): string {
  const normalized = normalizeVoucherCode(code)
  if (!normalized) throw new Error('not a voucher code')
  return normalized.slice(-VOUCHER_HINT_LENGTH)
}

/** Guessing space of a code of this length, in bits. */
export function voucherCodeBits(length: number): number {
  return length * 5
}
