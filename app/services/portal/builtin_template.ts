/**
 * The builtin portal template ("Perch default", docs/gateway/portal.md
 * section 12.4). The seeded `portal_templates` row has no files: its digest
 * is that of the empty set, which tells the collector to serve the pages it
 * has compiled in. These are those pages. The collector (WP4) embeds the same
 * three files and the same snippets and messages; the controller uses them
 * for previews and for "duplicate the builtin template".
 *
 * No inline script: the builtin pages run under a CSP without
 * `'unsafe-inline'` for scripts.
 */

export const BUILTIN_LOGIN_HTML = `<!doctype html>
<html lang="en" data-perch-portal>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{portal_name}}</title>
<link rel="stylesheet" href="{{assets}}/style.css">
</head>
<body>
<main class="card">
  <h1>{{portal_name}}</h1>
  <p class="lead">Welcome to {{gateway_name}}. Sign in to use the internet.</p>
  <p class="message" data-code="{{message_code}}">{{message}}</p>
  {{voucher_form}}
  {{login_form}}
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
</head>
<body>
<main class="card">
  <h1>You are online</h1>
  <p class="message" data-code="{{message_code}}">{{message}}</p>
  <dl class="status">
    <dt>Time left</dt><dd>{{remaining_time}}</dd>
    <dt>Data left</dt><dd>{{remaining_data}}</dd>
    <dt>Until</dt><dd>{{expires_at}}</dd>
  </dl>
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
]

/**
 * The three Perch-rendered snippets, inserted raw. A method the portal does
 * not offer renders as the empty string. The forms post to the router's
 * guest routes (`POST /portal/voucher`, `/portal/login`, `/portal/logout`),
 * which answer 303 to `/?m=<message_code>` so they work without JavaScript.
 */
export function portalSnippets(methods: { voucher: boolean; password: boolean }) {
  return {
    voucher_form: methods.voucher
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
  }
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
}
