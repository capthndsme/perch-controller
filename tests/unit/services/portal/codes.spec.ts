import {
  VOUCHER_ALPHABET,
  formatVoucherCode,
  generateVoucherCode,
  generateVoucherCodes,
  isValidCodeLength,
  normalizeVoucherCode,
  voucherCodeBits,
  voucherHint,
} from '#services/portal/codes'
import { test } from '@japa/runner'

/** A random source that returns the given bytes, cycling. */
function fixedRandom(bytes: number[]) {
  let i = 0
  return (size: number) => {
    const out = new Uint8Array(size)
    for (let k = 0; k < size; k++) out[k] = bytes[i++ % bytes.length]
    return out
  }
}

test.group('portal codes: alphabet and generation', () => {
  test('the alphabet is Crockford base32 without I, L, O, U', ({ assert }) => {
    assert.lengthOf(VOUCHER_ALPHABET, 32)
    assert.equal(new Set(VOUCHER_ALPHABET).size, 32)
    for (const ch of 'ILOU') assert.notInclude(VOUCHER_ALPHABET, ch)
  })

  test('codes have the requested length and only alphabet characters', ({ assert }) => {
    for (const length of [8, 10, 12, 16]) {
      const code = generateVoucherCode(length)
      assert.lengthOf(code, length)
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]+$/)
    }
    assert.lengthOf(generateVoucherCode(), 10)
  })

  test('each symbol is the low five bits of one byte (no modulo bias)', ({ assert }) => {
    // 0, 31, 32 (→0), 255 (→31), 37 (→5)
    assert.equal(generateVoucherCode(10, fixedRandom([0, 31, 32, 255, 37])), '0Z0Z50Z0Z5')
    // Every byte value maps to exactly 8 of 256 → uniform.
    const counts = new Map<string, number>()
    const code = generateVoucherCode(16, fixedRandom(Array.from({ length: 256 }, (_, i) => i)))
    assert.lengthOf(code, 16)
    for (let b = 0; b < 256; b++) {
      const ch = VOUCHER_ALPHABET[b & 31]
      counts.set(ch, (counts.get(ch) ?? 0) + 1)
    }
    for (const n of counts.values()) assert.equal(n, 8)
  })

  test('lengths outside 8–16 are refused', ({ assert }) => {
    assert.throws(() => generateVoucherCode(7), /8–16/)
    assert.throws(() => generateVoucherCode(17), /8–16/)
    assert.throws(() => generateVoucherCode(9.5), /8–16/)
    assert.isFalse(isValidCodeLength(0))
    assert.isTrue(isValidCodeLength(8))
    assert.isTrue(isValidCodeLength(16))
  })

  test('a short random source is an error, not a short code', ({ assert }) => {
    assert.throws(() => generateVoucherCode(10, () => new Uint8Array(3)), /too few bytes/)
  })

  test('batches are distinct; a repeating source is detected', ({ assert }) => {
    const codes = generateVoucherCodes(200, 10)
    assert.lengthOf(codes, 200)
    assert.equal(new Set(codes).size, 200)
    assert.deepEqual(generateVoucherCodes(0), [])
    assert.throws(() => generateVoucherCodes(3, 10, fixedRandom([1])), /repeating/)
    assert.throws(() => generateVoucherCodes(-1), /invalid count/)
  })

  test('bits of guessing space', ({ assert }) => {
    assert.equal(voucherCodeBits(10), 50)
    assert.equal(voucherCodeBits(8), 40)
  })
})

test.group('portal codes: normalization', () => {
  test('case, separators and look-alikes normalize to one code', ({ assert }) => {
    const variants = [
      'K7Q2M9XH4D',
      'k7q2m9xh4d',
      'K7Q2M-9XH4D',
      ' k7q2m 9xh4d ',
      'K7Q2M.9XH4D',
      'K7Q2M_9XH4D',
      'K7Q2M\t9XH4D',
    ]
    for (const v of variants) assert.equal(normalizeVoucherCode(v), 'K7Q2M9XH4D', v)
  })

  test('I and L read as 1, O as 0', ({ assert }) => {
    assert.equal(normalizeVoucherCode('ILOIL-OIL0o'), '1101101100')
    assert.equal(normalizeVoucherCode('il0oi-lo1Ll'), '1100110111')
  })

  test('U and other characters outside the alphabet are rejected', ({ assert }) => {
    assert.isNull(normalizeVoucherCode('K7Q2M9XH4U'))
    assert.isNull(normalizeVoucherCode('K7Q2M9XH4!'))
    assert.isNull(normalizeVoucherCode('K7Q2M9XH4Ä'))
    assert.isNull(normalizeVoucherCode('K7Q2M/9XH4D'))
  })

  test('wrong lengths after stripping are rejected', ({ assert }) => {
    assert.isNull(normalizeVoucherCode('K7Q2M9X'))
    assert.isNull(normalizeVoucherCode('----K7Q2M9X----'))
    assert.isNull(normalizeVoucherCode('K7Q2M9XH4DK7Q2M9X'))
    assert.equal(normalizeVoucherCode('K7Q2M9XH'), 'K7Q2M9XH')
    assert.equal(normalizeVoucherCode('K7Q2M9XH4DK7Q2M9'), 'K7Q2M9XH4DK7Q2M9')
  })

  test('non-strings and oversized input are rejected', ({ assert }) => {
    assert.isNull(normalizeVoucherCode(null))
    assert.isNull(normalizeVoucherCode(12345678))
    assert.isNull(normalizeVoucherCode(['K7Q2M9XH4D']))
    assert.isNull(normalizeVoucherCode(`K7Q2M9XH4D${' '.repeat(80)}`))
    assert.isNull(normalizeVoucherCode(''))
  })

  test('every generated code survives normalization unchanged', ({ assert }) => {
    for (const code of generateVoucherCodes(100, 12)) {
      assert.equal(normalizeVoucherCode(code), code)
      assert.equal(normalizeVoucherCode(formatVoucherCode(code).toLowerCase()), code)
    }
  })
})

test.group('portal codes: display', () => {
  test('groups of 5 for multiples of 5, else groups of 4', ({ assert }) => {
    assert.equal(formatVoucherCode('K7Q2M9XH4D'), 'K7Q2M-9XH4D')
    assert.equal(formatVoucherCode('K7Q2M9XH4DABCDE'), 'K7Q2M-9XH4D-ABCDE')
    assert.equal(formatVoucherCode('K7Q2M9XH'), 'K7Q2-M9XH')
    assert.equal(formatVoucherCode('K7Q2M9XH4DAB'), 'K7Q2-M9XH-4DAB')
    assert.equal(formatVoucherCode('K7Q2M9XH4DABCDEF'), 'K7Q2-M9XH-4DAB-CDEF')
    assert.equal(formatVoucherCode('K7Q2M9XH4'), 'K7Q2-M9XH-4')
    assert.equal(formatVoucherCode('k7q2m-9xh4d'), 'K7Q2M-9XH4D')
  })

  test('hint is the last four characters', ({ assert }) => {
    assert.equal(voucherHint('K7Q2M-9XH4D'), 'XH4D')
    assert.equal(voucherHint('k7q2m9xh4o'), 'XH40')
  })

  test('display helpers refuse non-codes', ({ assert }) => {
    assert.throws(() => formatVoucherCode('nope'), /not a voucher code/)
    assert.throws(() => voucherHint('nope'), /not a voucher code/)
  })
})
