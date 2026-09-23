import PortalTemplate from '#models/portal_template'
import { EMPTY_SET_SHA256, sha256Hex, templateSetSha256 } from '#services/portal/templates'
import {
  bodyOf,
  outboxKeys,
  call,
  resetPortalTests,
  seedPortal,
  seedPortalWorld,
} from '#tests/helpers/portal'
import { test } from '@japa/runner'

const LOGIN = Buffer.from(
  '<!doctype html><title>{{portal_name}}</title><link rel="stylesheet" href="{{assets}}/site.css">\n<p>{{client_mac}}</p>\n{{voucher_form}}\n<script>fetch("http://192.168.20.5:8080/coin?mac=" + document.body.dataset.mac)</script>'
)
const CSS = Buffer.from('body { color: red }')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

test.group('portal | templates', (group) => {
  group.each.setup(resetPortalTests)

  test('the builtin template lists its compiled-in files and is read-only', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const list = await call(client, 'get', '/api/v1/portal/templates', world.adminToken)
    list.assertStatus(200)
    const [builtin] = bodyOf(list).data
    assert.deepInclude(builtin, {
      id: world.builtinTemplateId,
      builtin: true,
      sha256: EMPTY_SET_SHA256,
      inUse: [],
    })
    assert.deepEqual(
      builtin.files.map((f: any) => f.name),
      ['login.html', 'status.html', 'style.css']
    )
    assert.includeMembers(builtin.variables, ['voucher_form', 'login_form', 'logout_form'])

    const id = world.builtinTemplateId
    for (const [method, path, body] of [
      ['patch', `/api/v1/portal/templates/${id}`, { name: 'x' }],
      ['delete', `/api/v1/portal/templates/${id}`, {}],
      ['delete', `/api/v1/portal/templates/${id}/files/style.css`, {}],
    ] as const) {
      const r = await call(client, method, path, world.adminToken).json(body)
      r.assertStatus(403)
      assert.equal(bodyOf(r).error, 'builtin_template')
    }
    const put = await call(
      client,
      'put',
      `/api/v1/portal/templates/${id}/files/style.css`,
      world.adminToken
    ).file('file', CSS, { filename: 'style.css' })
    put.assertStatus(403)
  })

  test('upload a template (multipart), then replace and delete files', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const r = await call(client, 'post', '/api/v1/portal/templates', world.adminToken)
      .field('name', 'Coin page')
      .file('files', LOGIN, { filename: 'login.html' })
      .file('files', CSS, { filename: 'site.css' })
      .file('files', PNG, { filename: 'logo.png' })
    r.assertStatus(201)
    const template = bodyOf(r).data
    assert.deepInclude(template, {
      name: 'Coin page',
      builtin: false,
      totalBytes: LOGIN.length + CSS.length + PNG.length,
      inUse: [],
    })
    assert.deepEqual(
      template.files.map((f: any) => [f.name, f.contentType, f.bytes]),
      [
        ['login.html', 'text/html; charset=utf-8', LOGIN.length],
        ['logo.png', 'image/png', PNG.length],
        ['site.css', 'text/css; charset=utf-8', CSS.length],
      ]
    )
    assert.equal(
      template.sha256,
      templateSetSha256([
        { name: 'login.html', sha256: sha256Hex(LOGIN) },
        { name: 'site.css', sha256: sha256Hex(CSS) },
        { name: 'logo.png', sha256: sha256Hex(PNG) },
      ])
    )
    assert.sameMembers(template.variables, ['portal_name', 'assets', 'client_mac', 'voucher_form'])

    // In use by a portal: a file change is pushed to its router.
    const portal = await seedPortal(world.gatewayId, undefined, { templateId: template.id })
    const css2 = Buffer.from('body { color: blue }')
    const put = await call(
      client,
      'put',
      `/api/v1/portal/templates/${template.id}/files/site.css`,
      world.adminToken
    ).file('file', css2, { filename: 'whatever.css' })
    put.assertStatus(200)
    assert.notEqual(bodyOf(put).data.sha256, template.sha256)
    assert.deepEqual(bodyOf(put).data.inUse, [portal.id])
    assert.deepEqual(await outboxKeys(world.gatewayId), [`template:${portal.id}`])

    const add = await call(
      client,
      'put',
      `/api/v1/portal/templates/${template.id}/files/status.html`,
      world.adminToken
    ).file('file', Buffer.from('<p>{{remaining_time}}</p>'), { filename: 'status.html' })
    add.assertStatus(200)
    assert.lengthOf(bodyOf(add).data.files, 4)

    let del = await call(
      client,
      'delete',
      `/api/v1/portal/templates/${template.id}/files/logo.png`,
      world.adminToken
    )
    del.assertStatus(200)
    assert.lengthOf(bodyOf(del).data.files, 3)
    del = await call(
      client,
      'delete',
      `/api/v1/portal/templates/${template.id}/files/logo.png`,
      world.adminToken
    )
    del.assertStatus(404)
    assert.equal(bodyOf(del).error, 'template_file_not_found')
    del = await call(
      client,
      'delete',
      `/api/v1/portal/templates/${template.id}/files/login.html`,
      world.adminToken
    )
    del.assertStatus(422)
    assert.equal(bodyOf(del).error, 'login_page_required')

    // In use: cannot be deleted; renaming is fine.
    const rename = await call(
      client,
      'patch',
      `/api/v1/portal/templates/${template.id}`,
      world.adminToken
    ).json({ name: 'Coin page v2' })
    rename.assertStatus(200)
    assert.equal(bodyOf(rename).data.name, 'Coin page v2')
    const inUse = await call(
      client,
      'delete',
      `/api/v1/portal/templates/${template.id}`,
      world.adminToken
    )
    inUse.assertStatus(409)
    assert.deepInclude(bodyOf(inUse), { error: 'template_in_use', portalIds: [portal.id] })
    portal.templateId = world.builtinTemplateId
    await portal.save()
    const gone = await call(
      client,
      'delete',
      `/api/v1/portal/templates/${template.id}`,
      world.adminToken
    )
    gone.assertStatus(204)
    assert.isNull(await PortalTemplate.find(template.id))
  })

  test('upload refusals', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    const upload = (files: Array<[string, Buffer]>, name = 'T') => {
      let request = call(client, 'post', '/api/v1/portal/templates', world.adminToken).field(
        'name',
        name
      )
      for (const [filename, data] of files) request = request.file('files', data, { filename })
      return request
    }
    const expectError = async (files: Array<[string, Buffer]>, status: number, error: string) => {
      const r = await upload(files)
      assert.equal(r.status(), status, error)
      assert.equal(bodyOf(r).error, error)
      return bodyOf(r)
    }
    await expectError([['style.css', CSS]], 422, 'missing_login_page')
    await expectError([], 422, 'missing_login_page')
    const unknown = await expectError(
      [['login.html', Buffer.from('<p>\n{{admin_token}}</p>')]],
      422,
      'unknown_variable'
    )
    assert.deepInclude(unknown, { file: 'login.html', line: 2, name: 'admin_token' })
    await expectError(
      [
        ['login.html', LOGIN],
        ['Bad Name.css', CSS],
      ],
      422,
      'bad_file_name'
    )
    await expectError(
      [
        ['login.html', LOGIN],
        ['shell.php', CSS],
      ],
      422,
      'unsupported_type'
    )
    await expectError(
      [
        ['login.html', LOGIN],
        ['logo.png', Buffer.from('<svg onload=alert(1)>')],
      ],
      422,
      'unsupported_type'
    )
    await expectError([['login.html', Buffer.alloc(300 * 1024, 0x61)]], 413, 'template_too_large')
    await expectError(
      [
        ['login.html', LOGIN],
        ...Array.from({ length: 24 }, (_, i): [string, Buffer] => [`f${i}.css`, CSS]),
      ],
      422,
      'too_many_files'
    )
    await expectError(
      [
        ['login.html', LOGIN],
        ...Array.from({ length: 5 }, (_, i): [string, Buffer] => [
          `f${i}.png`,
          Buffer.concat([PNG, Buffer.alloc(450 * 1024)]),
        ]),
      ],
      413,
      'template_too_large'
    )
    const noName = await upload([['login.html', LOGIN]], '')
    noName.assertStatus(422)
    assert.lengthOf(await PortalTemplate.query().where('builtin', false), 0)
  })

  test('duplicate the builtin template; preview is self-contained JSON', async ({
    client,
    assert,
  }) => {
    const world = await seedPortalWorld()
    const dup = await call(
      client,
      'post',
      `/api/v1/portal/templates/${world.builtinTemplateId}/duplicate`,
      world.adminToken
    ).json({ name: 'My pages' })
    dup.assertStatus(201)
    const copy = bodyOf(dup).data
    assert.deepInclude(copy, { name: 'My pages', builtin: false })
    assert.notEqual(copy.sha256, EMPTY_SET_SHA256)
    assert.lengthOf(copy.files, 3)

    const portal = await seedPortal(world.gatewayId, undefined, {
      name: 'Café <Guests>',
      methods: { voucher: false, password: true },
      privacyNotice: 'Kept 30 days.',
    })
    const r = await call(
      client,
      'get',
      `/api/v1/portal/templates/${copy.id}/preview?page=login&message=invalid_credentials&portalId=${portal.id}`,
      world.adminToken
    )
    r.assertStatus(200)
    assert.match(r.header('content-type')!, /^application\/json/)
    assert.equal(r.header('cache-control'), 'no-store')
    const { html, page, messageCode } = bodyOf(r).data
    assert.equal(page, 'login')
    assert.equal(messageCode, 'invalid_credentials')
    assert.include(html, 'Café &lt;Guests&gt;')
    assert.include(html, 'Wrong username or password.')
    assert.include(html, 'action="/portal/login"')
    assert.notInclude(html, 'action="/portal/voucher"')
    assert.include(html, 'Kept 30 days.')
    assert.include(html, 'href="data:text/css;base64,')
    assert.notInclude(html, '{{')

    const status = await call(
      client,
      'get',
      `/api/v1/portal/templates/${world.builtinTemplateId}/preview?page=status&message=bogus`,
      world.adminToken
    )
    status.assertStatus(200)
    assert.include(bodyOf(status).data.html, 'You are online')
    assert.isNull(bodyOf(status).data.messageCode)

    const bad = await call(
      client,
      'get',
      `/api/v1/portal/templates/${copy.id}/preview?page=admin`,
      world.adminToken
    )
    bad.assertStatus(422)
    const missing = await call(
      client,
      'get',
      '/api/v1/portal/templates/999/preview',
      world.adminToken
    )
    missing.assertStatus(404)
    assert.equal(bodyOf(missing).error, 'template_not_found')
  })

  test('no endpoint serves template content as a document', async ({ client, assert }) => {
    const world = await seedPortalWorld()
    for (const path of [
      `/api/v1/portal/templates/${world.builtinTemplateId}`,
      `/api/v1/portal/templates/${world.builtinTemplateId}/preview`,
      `/api/v1/portal/templates/${world.builtinTemplateId}/files/login.html`,
    ]) {
      const r = await call(client, 'get', path, world.adminToken)
      assert.notMatch(r.header('content-type') ?? '', /text\/html/, path)
    }
  })
})
