import { createHash, createHmac } from 'node:crypto'
import { deriveGatewayKeys } from '#services/portal/crypto'
import {
  type CheckoutRecord,
  type PriceTable,
  canonicalCheckout,
  checkoutReferenceCode,
  normalizeClickThroughSettings,
  normalizePaymentSettings,
  priceEntitlement,
  signCheckout,
  signTerminalRequest,
  terminalSigningString,
  validatePriceEntries,
} from '#services/portal/hotspot'
import { normalizeVoucherCode } from '#services/portal/codes'
import { test } from '@japa/runner'

/**
 * Pinned vectors for the Paid Hotspot records (docs/gateway/portal.md
 * section 14). perch-collector's Go side must produce exactly these; the
 * inputs are the crypto spec's (APP_KEY, gateway 7, epoch 1).
 */
const APP_KEY = 'perch-test-app-key-0123456789abcdef'
const KEYS = deriveGatewayKeys(APP_KEY, 7, 1)

export const VECTOR_TABLE: PriceTable = {
  priceTableId: 2,
  revision: 3,
  name: 'Coins',
  currency: 'PHP',
  decimals: 0,
  durationMode: 'wall_clock',
  entries: [
    { amount: 1, minutes: 10, quotaBytes: null, downKbps: null, upKbps: null },
    { amount: 5, minutes: 60, quotaBytes: null, downKbps: 5000, upKbps: 2000 },
    { amount: 20, minutes: 300, quotaBytes: null, downKbps: 10000, upKbps: 5000 },
  ],
}

export const VECTOR_RECORD: CheckoutRecord = {
  checkoutRef: 'ck-0123456789abcdef',
  portalId: 3,
  terminalId: 4,
  mac: '02:00:00:aa:bb:cc',
  amount: 7,
  currency: 'PHP',
  priceTableId: 2,
  priceRevision: 3,
  durationMode: 'wall_clock',
  durationSeconds: 4800,
  quotaBytes: null,
  downKbps: 5000,
  upKbps: 2000,
  openedAt: 1790000000000,
  finalizedAt: 1790000042000,
  reason: 'done',
  localRef: 'k5-a1b2c3d4',
  unusedAmount: 0,
  coinCount: 3,
}

test.group('Paid Hotspot: price tables', () => {
  test('greedy fill: the largest rate first, the tier of the most expensive one', ({ assert }) => {
    assert.deepEqual(priceEntitlement(VECTOR_TABLE, 7), {
      amount: 7,
      durationMode: 'wall_clock',
      durationSeconds: 4800,
      quotaBytes: null,
      downKbps: 5000,
      upKbps: 2000,
      unusedAmount: 0,
    })
    assert.equal(priceEntitlement(VECTOR_TABLE, 47).durationSeconds, (600 + 60 + 20) * 60)
    assert.equal(priceEntitlement(VECTOR_TABLE, 47).downKbps, 10000)
    assert.equal(priceEntitlement(VECTOR_TABLE, 1).durationSeconds, 600)
    assert.isNull(priceEntitlement(VECTOR_TABLE, 1).downKbps)
  })

  test('nothing bought: zero seconds, the amount unused', ({ assert }) => {
    const t = { ...VECTOR_TABLE, entries: [VECTOR_TABLE.entries[1]] }
    assert.deepEqual(priceEntitlement(t, 3), {
      amount: 3,
      durationMode: 'wall_clock',
      durationSeconds: 0,
      quotaBytes: null,
      downKbps: null,
      upKbps: null,
      unusedAmount: 3,
    })
    assert.equal(priceEntitlement(t, 0).durationSeconds, 0)
    assert.equal(priceEntitlement(t, -5).amount, 0)
    assert.equal(priceEntitlement(t, 12).unusedAmount, 2)
  })

  test('data quotas add up; time is capped at one year', ({ assert }) => {
    const t: PriceTable = {
      ...VECTOR_TABLE,
      entries: [
        { amount: 10, minutes: 60, quotaBytes: 500_000_000, downKbps: null, upKbps: null },
        { amount: 50, minutes: 1440, quotaBytes: 5_000_000_000, downKbps: null, upKbps: null },
      ],
    }
    assert.equal(priceEntitlement(t, 70).quotaBytes, 6_000_000_000)
    assert.equal(priceEntitlement(t, 70).durationSeconds, (1440 + 120) * 60)
    const big = {
      ...t,
      entries: [{ amount: 1, minutes: 525_600, quotaBytes: null, downKbps: null, upKbps: null }],
    }
    assert.equal(priceEntitlement(big, 3).durationSeconds, 525_600 * 60)
  })

  test('validation', ({ assert }) => {
    assert.isNull(validatePriceEntries(VECTOR_TABLE.entries))
    assert.equal(validatePriceEntries([]), 'no_entries')
    const e = VECTOR_TABLE.entries[0]
    assert.equal(validatePriceEntries([e, { ...e, minutes: 20 }]), 'duplicate_amount')
    assert.equal(
      validatePriceEntries([e, { ...e, amount: 2, quotaBytes: 1_000_000 }]),
      'mixed_quota'
    )
    assert.equal(validatePriceEntries([{ ...e, amount: 0 }]), 'invalid_entry')
    assert.equal(validatePriceEntries([{ ...e, downKbps: 10 }]), 'invalid_entry')
    assert.equal(
      validatePriceEntries(Array.from({ length: 33 }, (_, i) => ({ ...e, amount: i + 1 }))),
      'too_many_entries'
    )
  })
})

test.group('Paid Hotspot: checkout records', () => {
  test('canonical form', ({ assert }) => {
    assert.equal(
      canonicalCheckout(KEYS, VECTOR_RECORD),
      [
        'perch-portal-checkout-v1',
        '7',
        '1',
        'ck-0123456789abcdef',
        '3',
        '4',
        '02:00:00:aa:bb:cc',
        '7',
        'PHP',
        '2',
        '3',
        'wall_clock',
        '4800',
        '',
        '5000',
        '2000',
        '1790000000000',
        '1790000042000',
        'done',
        'k5-a1b2c3d4',
        '0',
        '3',
      ].join('\n')
    )
  })

  test('pinned signature and reference code', ({ assert }) => {
    const sig = signCheckout(KEYS, VECTOR_RECORD)
    const code = checkoutReferenceCode(KEYS, VECTOR_RECORD)
    assert.equal(sig, 'addRWmtev4ux-XcOWgh524P90PI5NMkRip7TT-If_Ow')
    assert.equal(code, 'GE6RH9AQ1S')
    // Independent recomputation of both.
    const text = canonicalCheckout(KEYS, VECTOR_RECORD)
    assert.equal(sig, createHmac('sha256', KEYS.signKey).update(text).digest('base64url'))
    const ck = createHmac('sha256', KEYS.gatewayKey).update('perch-portal-checkout-v1').digest()
    const b = createHmac('sha256', ck).update(text).digest()
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    assert.equal(code, [...b.subarray(0, 10)].map((x) => alphabet[x & 31]).join(''))
    assert.equal(normalizeVoucherCode(code), code)
  })

  test('every field is bound', ({ assert }) => {
    const base = signCheckout(KEYS, VECTOR_RECORD)
    assert.notEqual(signCheckout(KEYS, { ...VECTOR_RECORD, amount: 8 }), base)
    assert.notEqual(signCheckout(KEYS, { ...VECTOR_RECORD, mac: '02:00:00:aa:bb:cd' }), base)
    assert.notEqual(
      checkoutReferenceCode(KEYS, { ...VECTOR_RECORD, checkoutRef: 'ck-x' }),
      checkoutReferenceCode(KEYS, VECTOR_RECORD)
    )
    assert.notEqual(signCheckout(deriveGatewayKeys(APP_KEY, 7, 2), VECTOR_RECORD), base)
  })

  test('refuses records outside the charsets', ({ assert }) => {
    assert.throws(() => canonicalCheckout(KEYS, { ...VECTOR_RECORD, currency: 'php' }))
    assert.throws(() => canonicalCheckout(KEYS, { ...VECTOR_RECORD, checkoutRef: 'a\nb' }))
    assert.throws(() => canonicalCheckout(KEYS, { ...VECTOR_RECORD, reason: 'other' as never }))
    assert.throws(() => canonicalCheckout(KEYS, { ...VECTOR_RECORD, amount: -1 }))
  })
})

test.group('Paid Hotspot: terminal requests', () => {
  test('pinned request signature', ({ assert }) => {
    const token = 'perch_pt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const body = '{"checkoutRef":"ck-0123456789abcdef","eventId":"b1-7","amount":5}'
    const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
    const r = {
      method: 'POST',
      path: '/portal/v1/terminal/coins',
      terminalId: 4,
      session: 'Zm9vYmFyYmF6cXV4MTIzNA',
      seq: 12,
      bodySha256Hex: sha(body),
    }
    assert.equal(
      terminalSigningString(r),
      `perch-terminal-v1\nPOST\n/portal/v1/terminal/coins\n4\nZm9vYmFyYmF6cXV4MTIzNA\n12\n${sha(body)}`
    )
    assert.equal(
      r.bodySha256Hex,
      '18f89dad2df98792fd8af9ecc7476adccfeeb6833e0ab4f160abd8553eabd629'
    )
    assert.equal(signTerminalRequest(token, r), 'j-IqTTtDgwOwIyJZOYnyPQKsmZS_cvs-iOIo7RAOcWM')
  })
})

test.group('Paid Hotspot: method settings', () => {
  test('payment and click-through settings read defensively', ({ assert }) => {
    assert.deepEqual(normalizePaymentSettings(null), { priceTableId: null, idleTimeoutSeconds: 60 })
    assert.deepEqual(normalizePaymentSettings({ priceTableId: 3, idleTimeoutSeconds: 5 }), {
      priceTableId: 3,
      idleTimeoutSeconds: 15,
    })
    const c = normalizeClickThroughSettings({ minutes: 5000, perWindow: 'x', terms: 'Be nice' })
    assert.equal(c.minutes, 1440)
    assert.equal(c.perWindow, 1)
    assert.equal(c.windowHours, 24)
    assert.equal(c.terms, 'Be nice')
    assert.isNull(c.downKbps)
  })
})

test.group('Paid Hotspot: display texts', () => {
  test('money, duration, bytes, speed', async ({ assert }) => {
    const h = await import('#services/portal/hotspot')
    assert.equal(h.moneyText(5, 'PHP', 0), 'PHP 5')
    assert.equal(h.moneyText(125, 'USD', 2), 'USD 1.25')
    assert.equal(h.moneyText(5, 'USD', 2), 'USD 0.05')
    assert.equal(h.durationText(0), '0 min')
    assert.equal(h.durationText(61), '2 min')
    assert.equal(h.durationText(3600), '1 h')
    assert.equal(h.durationText(4800), '1 h 20 min')
    assert.equal(h.durationText(86400 * 2 + 3 * 3600 + 59), '2 d 3 h')
    assert.equal(h.bytesText(999), '999 B')
    assert.equal(h.bytesText(500_000_000), '500 MB')
    assert.equal(h.bytesText(1_500_000_000), '1.5 GB')
    assert.equal(h.bytesText(1_250_000), '1.3 MB')
    assert.equal(h.speedText(5000), '5 Mbit/s')
    assert.equal(h.speedText(1500), '1.5 Mbit/s')
    assert.equal(h.speedText(512), '512 kbit/s')
    assert.equal(h.entitlementText(4800, null, 5000), '1 h 20 min · 5 Mbit/s down')
    assert.equal(
      h.previewText(priceEntitlement(VECTOR_TABLE, 7), 'PHP', 0),
      '1 h 20 min · 5 Mbit/s down'
    )
    assert.equal(h.previewText(priceEntitlement(VECTOR_TABLE, 0), 'PHP', 0), 'Insert coins')
    const five = { ...VECTOR_TABLE, entries: [VECTOR_TABLE.entries[1]] }
    assert.equal(h.previewText(priceEntitlement(five, 3), 'PHP', 0), 'Not enough for a rate yet')
    assert.equal(
      h.previewText(priceEntitlement(five, 7), 'PHP', 0),
      '1 h · 5 Mbit/s down (PHP 2 unused)'
    )
    assert.equal(h.rateText(VECTOR_TABLE.entries[0], 'PHP', 0), 'PHP 1: 10 min')
  })
})

test.group('Paid Hotspot: snippets (same HTML as the router)', () => {
  test('picker, open checkout, receipt, click-through', async ({ assert }) => {
    const { portalSnippets } = await import('#services/portal/builtin_template')
    const { rateText } = await import('#services/portal/hotspot')
    const methods = { voucher: false, password: false, payment: true, clickThrough: true }
    const view = {
      terminals: [
        { terminalId: 5, name: 'Cafe', state: 'offline' as const },
        { terminalId: 4, name: 'Lobby', state: 'free' as const },
      ],
      rates: VECTOR_TABLE.entries.map((e) => rateText(e, 'PHP', 0)),
      checkout: null,
      receipt: null,
      clickThrough: { available: true, minutes: 30, terms: 'Be nice.', retrySeconds: 0 },
    }
    const s = portalSnippets(methods, view)
    assert.equal(
      s.checkout_form,
      '<form class="perch-form perch-checkout-start" method="post" action="/portal/checkout" data-perch-checkout="picker">' +
        '<label for="perch-terminal">Pay at a coin terminal</label><select id="perch-terminal" name="terminalId">' +
        '<option value="5" disabled>Cafe (offline)</option><option value="4">Lobby</option></select><button type="submit">Start</button></form>' +
        '<ul class="perch-rates"><li>PHP 1: 10 min</li><li>PHP 5: 1 h · 5 Mbit/s down</li><li>PHP 20: 5 h · 10 Mbit/s down</li></ul>'
    )
    assert.equal(
      s.clickthrough_form,
      '<form class="perch-form perch-clickthrough" method="post" action="/portal/clickthrough"><p class="perch-terms">Be nice.</p>' +
        '<label class="perch-accept"><input type="checkbox" name="accept" value="1" required> I accept the terms of use</label><button type="submit">Free access: 30 min</button></form>'
    )
    // The voucher form is there for reference codes even without the voucher method.
    assert.include(s.voucher_form, 'action="/portal/voucher"')
    const open = portalSnippets(methods, {
      ...view,
      checkout: {
        ref: 'ck-1',
        terminalName: 'Lobby',
        amountText: 'PHP 0',
        previewText: 'Insert coins',
        idleSecondsLeft: 60,
        terminalOnline: true,
      },
      receipt: {
        code: 'GE6RH-9AQ1S',
        detail: 'PHP 5 · 1 h · 5 Mbit/s down · 2026-09-21 14:13 UTC',
      },
      clickThrough: { available: false, minutes: 30, terms: '', retrySeconds: 84540 },
    })
    assert.equal(
      open.checkout_form,
      '<section class="perch-checkout" data-perch-checkout="open" data-ref="ck-1"><h2>Insert coins at Lobby</h2>' +
        '<p class="perch-total" data-perch-amount>PHP 0</p><p class="perch-preview" data-perch-preview>Insert coins</p>' +
        '<p class="perch-idle">Closes after <span data-perch-idle>60</span> s without a coin.</p><p class="perch-terminal-state" data-perch-terminal-state></p>' +
        '<form class="perch-form" method="post" action="/portal/checkout/done"><button type="submit">Done</button></form>' +
        '<form class="perch-form" method="post" action="/portal/checkout/cancel"><button type="submit" class="secondary">Cancel</button></form>' +
        '<p><a href="/">Refresh</a></p></section>'
    )
    assert.equal(
      open.receipt,
      '<section class="perch-receipt"><h2>Your reference code</h2><p class="perch-code">GE6RH-9AQ1S</p>' +
        "<p>Screenshot or save this code. If this device's address changes, enter it as a voucher code to move your remaining time.</p>" +
        '<p class="perch-receipt-detail">PHP 5 · 1 h · 5 Mbit/s down · 2026-09-21 14:13 UTC</p></section>'
    )
    assert.equal(
      open.clickthrough_form,
      '<p class="perch-clickthrough-used">Free access used. It is available again in 23 h 29 min.</p>'
    )
    const off = portalSnippets({ voucher: true, password: false }, view)
    assert.equal(off.checkout_form, '')
    assert.equal(off.clickthrough_form, '')
  })

  test('templates may use the new variables', async ({ assert }) => {
    const { checkTemplateFile, renderTemplateHtml } = await import('#services/portal/templates')
    const html = Buffer.from(
      '<p>{{reference_code}}</p>{{checkout_form}}{{receipt}}{{clickthrough_form}}'
    )
    assert.isTrue(checkTemplateFile({ name: 'login.html', data: html }).ok)
    const out = renderTemplateHtml(
      html.toString(),
      {
        portal_name: '',
        gateway_name: '',
        client_mac: '',
        client_ip: '',
        origin_url: '',
        message: '',
        message_code: '',
        assets: '',
        remaining_time: '',
        remaining_data: '',
        expires_at: '',
        privacy_notice: '',
        methods: '',
        status_json: null,
        reference_code: '<GE6RH-9AQ1S>',
      },
      { voucher: true, password: false, payment: true },
      {
        terminals: [],
        rates: [],
        checkout: null,
        receipt: { code: 'GE6RH-9AQ1S', detail: 'x' },
        clickThrough: null,
      }
    )
    assert.include(out, '<p>&lt;GE6RH-9AQ1S&gt;</p>')
    assert.include(out, '<section class="perch-receipt">')
  })
})
