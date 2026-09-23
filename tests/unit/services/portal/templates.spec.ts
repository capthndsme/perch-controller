import { BUILTIN_TEMPLATE_FILES } from '#services/portal/builtin_template'
import {
  EMPTY_SET_SHA256,
  TEMPLATE_LIMITS,
  checkTemplateFile,
  checkTemplateSet,
  renderPreview,
  renderTemplateHtml,
  sha256Hex,
  templateSetSha256,
  unknownVariables,
  usedVariables,
} from '#services/portal/templates'
import { test } from '@japa/runner'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const METHODS = { voucher: true, password: false }

function file(name: string, content: string | Buffer) {
  return { name, data: Buffer.isBuffer(content) ? content : Buffer.from(content) }
}

test.group('portal templates | file checks', () => {
  test('accepts the allowed types by extension and content', ({ assert }) => {
    for (const [name, content] of [
      ['login.html', '<p>{{portal_name}}</p>'],
      ['style.css', 'body{}'],
      ['app.js', 'console.log(1)'],
      ['logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
      ['logo.png', PNG],
      ['photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
      ['anim.gif', Buffer.from('GIF89a....')],
      ['hero.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])],
      ['favicon.ico', Buffer.from([0, 0, 1, 0, 1])],
      ['font.woff2', Buffer.from('wOF2....')],
      ['notes.txt', 'hello'],
    ] as const) {
      const result = checkTemplateFile(file(name, content))
      assert.isTrue(result.ok, name)
    }
  })

  test('refuses bad names, unknown types and lying extensions', ({ assert }) => {
    const refusal = (name: string, content: string | Buffer) => {
      const result = checkTemplateFile(file(name, content))
      return result.ok ? null : result.refusal.error
    }
    assert.equal(refusal('../login.html', 'x'), 'bad_file_name')
    assert.equal(refusal('sub/login.html', 'x'), 'bad_file_name')
    assert.equal(refusal('Login.html', 'x'), 'bad_file_name')
    assert.equal(refusal('.htaccess', 'x'), 'bad_file_name')
    assert.equal(refusal('a'.repeat(65) + '.css', 'x'), 'bad_file_name')
    assert.equal(refusal('page.php', '<?php'), 'unsupported_type')
    assert.equal(refusal('archive.zip', 'PK'), 'unsupported_type')
    assert.equal(refusal('logo.png', '<script>alert(1)</script>'), 'unsupported_type')
    assert.equal(refusal('logo.svg', 'not an svg'), 'unsupported_type')
    assert.equal(refusal('style.css', Buffer.from([0x66, 0x00, 0x67])), 'unsupported_type')
    assert.equal(refusal('style.css', Buffer.from([0xc3, 0x28])), 'unsupported_type')
  })

  test('sizes: 256 KiB per HTML page, 512 KiB per other file', ({ assert }) => {
    const html = checkTemplateFile(file('login.html', 'a'.repeat(TEMPLATE_LIMITS.maxHtmlBytes + 1)))
    assert.isFalse(html.ok)
    if (!html.ok) {
      assert.equal(html.refusal.status, 413)
      assert.equal(html.refusal.error, 'template_too_large')
    }
    assert.isTrue(
      checkTemplateFile(file('big.css', 'a'.repeat(TEMPLATE_LIMITS.maxHtmlBytes + 1))).ok
    )
    assert.isFalse(
      checkTemplateFile(file('big.css', 'a'.repeat(TEMPLATE_LIMITS.maxFileBytes + 1))).ok
    )
  })

  test('unknown variables are refused with file, line and name', ({ assert }) => {
    const result = checkTemplateFile(
      file('login.html', '<h1>{{portal_name}}</h1>\n<p>\n{{ secret_admin_token }}</p>')
    )
    assert.isFalse(result.ok)
    if (!result.ok) {
      assert.equal(result.refusal.error, 'unknown_variable')
      assert.deepInclude(result.refusal.detail!, {
        file: 'login.html',
        line: 3,
        name: 'secret_admin_token',
      })
    }
    // Only HTML is scanned: a script may use braces freely.
    assert.isTrue(checkTemplateFile(file('app.js', 'const t = `{{nope}}`')).ok)
    assert.deepEqual(unknownVariables('{{ client_mac }} {{voucher_form}}'), [])
  })

  test('set rules: login.html required, file count, total size, duplicates', ({ assert }) => {
    assert.equal(checkTemplateSet([{ name: 'style.css', bytes: 1 }])?.error, 'missing_login_page')
    assert.isNull(checkTemplateSet([{ name: 'login.html', bytes: 1 }]))
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `f${i}.css`, bytes: 1 }))
    assert.equal(
      checkTemplateSet([{ name: 'login.html', bytes: 1 }, ...many])?.error,
      'too_many_files'
    )
    const big = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.png`, bytes: 500 * 1024 }))
    const total = checkTemplateSet([{ name: 'login.html', bytes: 1 }, ...big])
    assert.equal(total?.error, 'template_too_large')
    assert.equal(total?.status, 413)
    assert.equal(
      checkTemplateSet([
        { name: 'login.html', bytes: 1 },
        { name: 'login.html', bytes: 2 },
      ])?.error,
      'duplicate_file'
    )
  })
})

test.group('portal templates | digest and rendering', () => {
  test('the set digest is order independent; the empty set is the builtin marker', ({ assert }) => {
    const a = { name: 'login.html', sha256: sha256Hex('a') }
    const b = { name: 'style.css', sha256: sha256Hex('b') }
    assert.equal(templateSetSha256([a, b]), templateSetSha256([b, a]))
    assert.equal(templateSetSha256([]), EMPTY_SET_SHA256)
    assert.equal(
      EMPTY_SET_SHA256,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
    assert.equal(templateSetSha256([a]), sha256Hex(`login.html\n${sha256Hex('a')}\n`))
  })

  test('variables are HTML-escaped; snippets raw; status_json script-safe', ({ assert }) => {
    const html = renderTemplateHtml(
      '<h1>{{portal_name}}</h1>{{voucher_form}}{{login_form}}<script type="application/json">{{status_json}}</script>',
      {
        portal_name: '<img src=x onerror=alert(1)>',
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
        status_json: { note: '</script><script>alert(1)</script>' },
      },
      METHODS
    )
    assert.include(html, '&lt;img src=x onerror=alert(1)&gt;')
    assert.include(html, 'action="/portal/voucher"')
    assert.notInclude(html, 'action="/portal/login"')
    assert.notInclude(html, '</script><script>')
    assert.include(html, '\\u003c/script\\u003e')
  })

  test('the preview is self-contained: assets become data URIs', ({ assert }) => {
    const files = [
      {
        name: 'login.html',
        contentType: 'text/html; charset=utf-8',
        data: Buffer.from(
          '<link rel="stylesheet" href="{{assets}}/style.css"><img src="{{assets}}/logo.png"><img src="{{assets}}/missing.png">{{message}}'
        ),
      },
      { name: 'style.css', contentType: 'text/css; charset=utf-8', data: Buffer.from('body{}') },
      { name: 'logo.png', contentType: 'image/png', data: PNG },
    ]
    const sample = {
      portal_name: 'Guest',
      gateway_name: 'Perch',
      client_mac: '02:00:00:00:00:01',
      client_ip: '192.168.20.23',
      origin_url: 'http://example.com/',
      message_code: 'invalid_code',
      remaining_time: '',
      remaining_data: '',
      expires_at: '',
      privacy_notice: '',
      methods: 'voucher',
      status_json: {},
    }
    const html = renderPreview(files, 'login', sample, METHODS)
    assert.include(html, `href="data:text/css;base64,${Buffer.from('body{}').toString('base64')}"`)
    assert.include(html, 'src="data:image/png;base64,')
    assert.include(html, 'src="data:,"')
    assert.include(html, 'That code is not valid')
    assert.notInclude(html, 'perch-assets-')

    // No status.html in the set: the builtin status page renders.
    const status = renderPreview(files, 'status', sample, METHODS)
    assert.include(status, 'You are online')
    assert.include(status, 'data:text/css;base64,')
  })

  test('the builtin files pass the upload rules and use only known variables', ({ assert }) => {
    for (const f of BUILTIN_TEMPLATE_FILES) {
      assert.isTrue(checkTemplateFile({ name: f.name, data: f.data }).ok, f.name)
    }
    assert.includeMembers(usedVariables(BUILTIN_TEMPLATE_FILES), [
      'assets',
      'voucher_form',
      'login_form',
      'logout_form',
      'message',
    ])
    // Builtin pages run without inline script (checkout.js is a file).
    for (const f of BUILTIN_TEMPLATE_FILES) {
      assert.notMatch(f.data.toString(), /<script(?![^>]*\ssrc=)/)
    }
  })
})
