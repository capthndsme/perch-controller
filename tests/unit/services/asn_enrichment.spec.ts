import { test } from '@japa/runner'
import { parseCymruAsInfo, parseCymruOrigin } from '#services/asn_enrichment'

test.group('asn_enrichment | parseCymruOrigin', () => {
  test('returns ASN and prefix from a single-origin response', ({ assert }) => {
    const out = parseCymruOrigin('15169 | 8.8.8.0/24 | US | arin | 2014-03-14')
    assert.equal(out.asn, 15169)
    assert.equal(out.prefix, '8.8.8.0/24')
  })

  test('keeps the first ASN when the origin is multi-homed', ({ assert }) => {
    const out = parseCymruOrigin('12345 67890 | 203.0.113.0/24 | AU | apnic | 2010-01-01')
    assert.equal(out.asn, 12345)
  })

  test('returns null asn when the field is unparseable', ({ assert }) => {
    const out = parseCymruOrigin(' | | | | ')
    assert.isNull(out.asn)
    assert.isNull(out.prefix)
  })
})

test.group('asn_enrichment | parseCymruAsInfo', () => {
  test('extracts the AS name from the 5th field', ({ assert }) => {
    // Real-world example from `dig +short AS15169.asn.cymru.com TXT`.
    assert.equal(
      parseCymruAsInfo('15169 | US | arin | 2000-03-30 | GOOGLE - Google LLC, US'),
      'GOOGLE - Google LLC, US'
    )
  })

  test('returns null when the AS name slot is empty', ({ assert }) => {
    assert.isNull(parseCymruAsInfo('15169 | US | arin | 2000-03-30 |'))
  })

  test('regression: rejects a date string masquerading as an org', ({ assert }) => {
    // Guard against the previous bug where the *origin* lookup's
    // allocation date (`parts[4]`) was being mistaken for the AS name.
    // If an origin response is fed in by accident, we return null so
    // the caller falls back to `AS<n>` instead of "1998-06-15".
    assert.isNull(parseCymruAsInfo('15169 | 8.8.8.0/24 | US | arin | 2014-03-14'))
  })
})
