import { durationText } from '#services/portal/hotspot'

/**
 * The builtin portal template ("Perch default", docs/gateway/portal.md
 * section 12.4). The seeded `portal_templates` row has no files: its digest
 * is that of the empty set, which tells the collector to serve the pages it
 * has compiled in. These are those pages. The collector (WP4) embeds the same
 * files byte for byte (`internal/portal/builtin/`: login.html, status.html,
 * style.css, checkout.js) and the same snippets and messages; the controller
 * uses them for previews and for "duplicate the builtin template".
 *
 * No inline script: the builtin pages run under a CSP without
 * `'unsafe-inline'` for scripts; the live checkout total is `checkout.js`.
 */

export const BUILTIN_LOGIN_HTML = `<!doctype html>
<html lang="en" data-perch-portal>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{portal_name}}</title>
<link rel="stylesheet" href="{{assets}}/style.css">
<script src="{{assets}}/checkout.js" defer></script>
</head>
<body>
<main class="card">
  <h1>{{portal_name}}</h1>
  <p class="lead">Welcome to {{gateway_name}}. Sign in to use the internet.</p>
  <p class="message" data-code="{{message_code}}">{{message}}</p>
  {{receipt}}
  {{checkout_form}}
  {{voucher_form}}
  {{login_form}}
  {{clickthrough_form}}
  <p class="notice">{{privacy_notice}}</p>
  <p class="device">Device {{client_mac}}</p>
</main>
</body>
</html>
`

export const BUILTIN_STATUS_HTML = `<!doctype html>
<html lang="en" data-perch-portal>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{portal_name}}</title>
<link rel="stylesheet" href="{{assets}}/style.css">
<script src="{{assets}}/checkout.js" defer></script>
</head>
<body>
<main class="card">
  <h1>You are online</h1>
  <p class="message" data-code="{{message_code}}">{{message}}</p>
  {{receipt}}
  <dl class="status">
    <dt>Time left</dt><dd>{{remaining_time}}</dd>
    <dt>Data left</dt><dd>{{remaining_data}}</dd>
    <dt>Until</dt><dd>{{expires_at}}</dd>
  </dl>
  {{checkout_form}}
  {{logout_form}}
  <p class="notice">{{privacy_notice}}</p>
  <p class="device">Device {{client_mac}}</p>
</main>
</body>
</html>
`

export const BUILTIN_STYLE_CSS = `:root { color-scheme: light dark; --fg: #1d2330; --bg: #f4f6fa; --card: #fff; --accent: #2f6fde; --muted: #667085; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e9ef; --bg: #11151c; --card: #1a202a; --accent: #6c9cff; --muted: #98a2b3; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
.card { width: 100%; max-width: 420px; background: var(--card); border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgb(0 0 0 / 0.12); }
h1 { margin: 0 0 8px; font-size: 1.4rem; }
.lead, .notice, .device { color: var(--muted); }
.notice:empty, .message:empty { display: none; }
.message { padding: 8px 12px; border-radius: 8px; background: rgb(220 38 38 / 0.12); }
.device { font-size: 0.8rem; }
.perch-form { display: grid; gap: 8px; margin: 16px 0; }
.perch-form input { font: inherit; padding: 10px 12px; border: 1px solid var(--muted); border-radius: 8px; background: transparent; color: inherit; }
.perch-form button { font: inherit; padding: 10px 12px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; }
.status { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; }
.status dt { color: var(--muted); }
.status dd { margin: 0; }
.perch-form select { font: inherit; padding: 10px 12px; border: 1px solid var(--muted); border-radius: 8px; background: transparent; color: inherit; }
.perch-form button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--muted); }
.perch-accept { display: flex; gap: 8px; align-items: flex-start; }
.perch-terms { max-height: 12em; overflow: auto; white-space: pre-line; font-size: 0.9rem; color: var(--muted); margin: 0; }
.perch-rates { margin: 0 0 16px; padding-left: 20px; color: var(--muted); font-size: 0.9rem; }
.perch-checkout, .perch-receipt { margin: 16px 0; padding: 16px; border-radius: 8px; border: 1px solid var(--muted); }
.perch-checkout h2, .perch-receipt h2 { margin: 0 0 8px; font-size: 1.1rem; }
.perch-total { margin: 0; font-size: 2rem; font-weight: 600; }
.perch-preview, .perch-idle, .perch-receipt-detail { color: var(--muted); margin: 4px 0; }
.perch-terminal-state:empty { display: none; }
.perch-code { margin: 8px 0; font: 600 1.6rem/1.2 ui-monospace, monospace; letter-spacing: 0.08em; user-select: all; }
`

/** Live total of an open checkout (Paid Hotspot, section 14.8); the pages work without it. */
export const BUILTIN_CHECKOUT_JS = `// Live total of an open checkout (Paid Hotspot). The page works without
// it: the panel has a Refresh link and the forms post without script.
(function () {
  'use strict';
  var box = document.querySelector('[data-perch-checkout="open"]');
  if (!box || !window.fetch) return;
  var ref = box.getAttribute('data-ref');
  function set(name, text) {
    var el = box.querySelector('[data-perch-' + name + ']');
    if (el && el.textContent !== text) el.textContent = text;
  }
  function tick() {
    fetch('/portal/checkout', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        var c = s && s.checkout;
        if (!c || c.checkoutRef !== ref || c.state !== 'open') {
          location.replace('/?m=' + (c && c.checkoutRef === ref && c.state === 'finalized' ? 'paid' : 'checkout_closed'));
          return;
        }
        set('amount', c.amountText);
        set('preview', c.previewText);
        set('idle', String(c.idleSecondsLeft));
        set('terminal-state', c.terminalOnline ? '' : 'The terminal is not responding.');
        setTimeout(tick, 1000);
      })
      .catch(function () { setTimeout(tick, 3000); });
  }
  setTimeout(tick, 1000);
})();
`

export const BUILTIN_TEMPLATE_FILES: ReadonlyArray<{
  name: string
  contentType: string
  data: Buffer
}> = [
  {
    name: 'login.html',
    contentType: 'text/html; charset=utf-8',
    data: Buffer.from(BUILTIN_LOGIN_HTML),
  },
  {
    name: 'status.html',
    contentType: 'text/html; charset=utf-8',
    data: Buffer.from(BUILTIN_STATUS_HTML),
  },
  {
    name: 'style.css',
    contentType: 'text/css; charset=utf-8',
    data: Buffer.from(BUILTIN_STYLE_CSS),
  },
  {
    name: 'checkout.js',
    contentType: 'text/javascript; charset=utf-8',
    data: Buffer.from(BUILTIN_CHECKOUT_JS),
  },
]

/** What the payment and click-through snippets show (the router fills it per guest). */
export type HotspotSnippetView = {
  /** The portal's terminals, sorted by name then id. */
  terminals: Array<{ terminalId: number; name: string; state: 'free' | 'busy' | 'offline' }>
  /** Rate lines of the portal's price table (`rateText`). */
  rates: string[]
  /** The guest's open checkout, when there is one. */
  checkout: {
    ref: string
    terminalName: string
    amountText: string
    previewText: string
    idleSecondsLeft: number
    terminalOnline: boolean
  } | null
  /** The guest's latest paid checkout within 24 h. */
  receipt: { code: string; detail: string } | null
  /** null = the method is off. */
  clickThrough: {
    available: boolean
    minutes: number
    terms: string
    retrySeconds: number
  } | null
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The Perch-rendered snippets, inserted raw. A method the portal does not
 * offer renders as the empty string. The forms post to the router's guest
 * routes (`POST /portal/voucher`, `/portal/login`, `/portal/logout`,
 * `/portal/checkout[/done|/cancel]`, `/portal/clickthrough`), which answer
 * 303 to `/?m=<message_code>` so they work without JavaScript. The voucher
 * form is also there for the payment and desk methods: a reference code and a
 * desk-sold code are voucher codes (sections 14.6, 15). `reference_code` is not a snippet but a plain value
 * (escaped by the renderer).
 */
export function portalSnippets(
  methods: {
    voucher: boolean
    password: boolean
    payment?: boolean
    clickThrough?: boolean
    desk?: boolean
  },
  hotspot: HotspotSnippetView | null = null
) {
  const payment = Boolean(methods.payment)
  return {
    voucher_form:
      methods.voucher || payment || Boolean(methods.desk)
        ? '<form class="perch-form perch-voucher" method="post" action="/portal/voucher">' +
          '<label for="perch-code">Voucher code</label>' +
          '<input id="perch-code" name="code" required maxlength="64" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false">' +
          '<button type="submit">Connect</button></form>'
        : '',
    login_form: methods.password
      ? '<form class="perch-form perch-login" method="post" action="/portal/login">' +
        '<label for="perch-user">Username</label>' +
        '<input id="perch-user" name="username" required maxlength="32" autocomplete="username" autocapitalize="none" spellcheck="false">' +
        '<label for="perch-pass">Password</label>' +
        '<input id="perch-pass" name="password" type="password" required maxlength="64" autocomplete="current-password">' +
        '<button type="submit">Sign in</button></form>'
      : '',
    logout_form:
      '<form class="perch-form perch-logout" method="post" action="/portal/logout">' +
      '<button type="submit">Disconnect</button></form>',
    checkout_form: payment && hotspot ? checkoutSnippet(hotspot) : '',
    receipt: payment && hotspot?.receipt ? receiptSnippet(hotspot.receipt) : '',
    clickthrough_form:
      methods.clickThrough && hotspot?.clickThrough
        ? clickThroughSnippet(hotspot.clickThrough)
        : '',
  }
}

function checkoutSnippet(v: HotspotSnippetView): string {
  const E = escapeText
  const c = v.checkout
  if (c) {
    return (
      `<section class="perch-checkout" data-perch-checkout="open" data-ref="${E(c.ref)}">` +
      `<h2>Insert coins at ${E(c.terminalName)}</h2>` +
      `<p class="perch-total" data-perch-amount>${E(c.amountText)}</p>` +
      `<p class="perch-preview" data-perch-preview>${E(c.previewText)}</p>` +
      `<p class="perch-idle">Closes after <span data-perch-idle>${Math.max(0, Math.trunc(c.idleSecondsLeft))}</span> s without a coin.</p>` +
      `<p class="perch-terminal-state" data-perch-terminal-state>${c.terminalOnline ? '' : 'The terminal is not responding.'}</p>` +
      '<form class="perch-form" method="post" action="/portal/checkout/done"><button type="submit">Done</button></form>' +
      '<form class="perch-form" method="post" action="/portal/checkout/cancel"><button type="submit" class="secondary">Cancel</button></form>' +
      '<p><a href="/">Refresh</a></p></section>'
    )
  }
  if (!v.terminals.length) return ''
  const options = v.terminals
    .map((t) =>
      t.state === 'free'
        ? `<option value="${t.terminalId}">${E(t.name)}</option>`
        : `<option value="${t.terminalId}" disabled>${E(t.name)} (${t.state})</option>`
    )
    .join('')
  const rates = v.rates.length
    ? `<ul class="perch-rates">${v.rates.map((r) => `<li>${E(r)}</li>`).join('')}</ul>`
    : ''
  return (
    '<form class="perch-form perch-checkout-start" method="post" action="/portal/checkout" data-perch-checkout="picker">' +
    '<label for="perch-terminal">Pay at a coin terminal</label>' +
    `<select id="perch-terminal" name="terminalId">${options}</select>` +
    '<button type="submit">Start</button></form>' +
    rates
  )
}

function receiptSnippet(r: NonNullable<HotspotSnippetView['receipt']>): string {
  return (
    '<section class="perch-receipt"><h2>Your reference code</h2>' +
    `<p class="perch-code">${escapeText(r.code)}</p>` +
    "<p>Screenshot or save this code. If this device's address changes, enter it as a voucher code to move your remaining time.</p>" +
    `<p class="perch-receipt-detail">${escapeText(r.detail)}</p></section>`
  )
}

function clickThroughSnippet(c: NonNullable<HotspotSnippetView['clickThrough']>): string {
  if (!c.available) {
    return `<p class="perch-clickthrough-used">Free access used. It is available again in ${escapeText(durationText(c.retrySeconds))}.</p>`
  }
  return (
    '<form class="perch-form perch-clickthrough" method="post" action="/portal/clickthrough">' +
    (c.terms ? `<p class="perch-terms">${escapeText(c.terms)}</p>` : '') +
    '<label class="perch-accept"><input type="checkbox" name="accept" value="1" required> I accept the terms of use</label>' +
    `<button type="submit">Free access: ${escapeText(durationText(c.minutes * 60))}</button></form>`
  )
}

/** `message_code` → `message` text, as the guest pages show them. */
export const PORTAL_MESSAGES: Readonly<Record<string, string>> = {
  invalid_code: 'That code is not valid. Check it and try again.',
  invalid_credentials: 'Wrong username or password.',
  expired: 'This voucher has expired.',
  exhausted: 'The data of this voucher is used up.',
  revoked: 'This voucher is no longer valid.',
  disabled: 'This account is disabled.',
  device_limit: 'Too many devices are using this login. Disconnect one first.',
  already_authorized: 'This device is already online.',
  wrong_portal: 'This voucher is for another network.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  controller_unreachable: 'Sign-in is not available right now. Try again in a moment.',
  origin_mismatch: 'The request came from another page. Reload and try again.',
  bad_request: 'Something was missing. Try again.',
  logged_out: 'You are disconnected.',
  connected: 'You are online.',
  time_up: 'Your time is up.',
  data_used_up: 'Your data is used up.',
  // Paid Hotspot and click-through (section 14)
  checkout_started: 'Insert your coins at the terminal now.',
  checkout_closed: 'The payment window closed.',
  checkout_cancelled: 'Payment cancelled.',
  paid: 'Payment received. You are online.',
  terminal_busy: 'That terminal is in use. Wait a moment or pick another one.',
  terminal_offline: 'That terminal is not responding. Pick another one.',
  terminal_unknown: 'That terminal is not available here.',
  checkout_open: 'You already have a payment in progress at another terminal.',
  checkout_paid: 'Coins are already in: press Done to use them.',
  below_minimum: 'That is not enough for a rate yet. Add more coins.',
  no_checkout: 'There is no payment in progress.',
  clickthrough_used: 'Free access is used up for now. Try again later.',
  terms_required: 'Accept the terms to continue.',
  not_ready: 'Payments are not available right now.',
}
