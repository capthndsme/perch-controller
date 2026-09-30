import AgentArtefact from '#models/agent_artefact'
import AgentRelease from '#models/agent_release'
import { artefactPath, downloadKey } from '#services/agent_updates/download_tokens'
import { setGithubFetchForTesting } from '#services/agent_updates/github'
import { eventually, seedAgentAp, seedSetupComplete } from '#tests/helpers/ap_agent'
import {
  TEST_KEY_ID,
  buildManifest,
  seedRelease,
  signWithTestKey,
  trustTestKey,
  useScratchStore,
} from '#tests/helpers/agent_updates'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import type { AddressInfo } from 'node:net'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

async function baseUrl(): Promise<string> {
  const server = await app.container.make('server')
  const address = server.getNodeServer()!.address() as AddressInfo
  const host = address.address.includes(':') ? `[${address.address}]` : address.address
  return `http://${host}:${address.port}`
}

async function signedPath(artefact: AgentArtefact, deviceKey = 'ap-4', expIn = 600) {
  return artefactPath(await downloadKey(), {
    artefactId: artefact.id,
    file: artefact.fileName,
    deviceKey,
    exp: Math.floor(Date.now() / 1000) + expIn,
  })
}

test.group('agent updates: releases API', (group) => {
  group.each.setup(resetDb)
  group.each.setup(async () => useScratchStore())

  test('upload: manifest + signature, then each file; idempotent; conflicts', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey()
    const built = buildManifest({ version: '1.1.0-pre.5', channel: 'local' })

    const created = await client
      .post('/api/v1/agent-updates/releases')
      .bearerToken(adminToken)
      .json({ manifest: built.bytes.toString('base64'), signature: built.signature })
    created.assertStatus(201)
    const release = created.body().data
    assert.equal(release.product, 'perch-apd')
    assert.equal(release.version, '1.1.0-pre.5')
    assert.equal(release.channel, 'local')
    assert.equal(release.source, 'upload')
    assert.equal(release.keyId, TEST_KEY_ID)
    assert.match(release.keyLabel, /Perch test key/)
    assert.isTrue(release.offerable)
    assert.lengthOf(release.artefacts, 2)
    assert.isFalse(release.artefacts[0].stored)

    const again = await client
      .post('/api/v1/agent-updates/releases')
      .bearerToken(adminToken)
      .json({ manifest: built.bytes.toString('base64'), signature: built.signature })
    again.assertStatus(200)
    assert.equal(again.body().data.id, release.id)

    const other = buildManifest({ version: '1.1.0-pre.5', channel: 'local', minVersion: '1.0.0' })
    const conflict = await client
      .post('/api/v1/agent-updates/releases')
      .bearerToken(adminToken)
      .json({ manifest: other.bytes.toString('base64'), signature: other.signature })
    conflict.assertStatus(409)
    conflict.assertBodyContains({ error: 'release_exists_different' })

    const file = 'perch-apd-linux-mipsle'
    const upload = await client
      .put(`/api/v1/agent-updates/releases/${release.id}/files/${file}`)
      .bearerToken(adminToken)
      .file('file', built.files.get(file)!, { filename: file })
    upload.assertStatus(200)
    assert.equal(upload.body().data.file, file)
    assert.isTrue(upload.body().data.stored)

    const wrong = await client
      .put(`/api/v1/agent-updates/releases/${release.id}/files/perch-apd-linux-arm64`)
      .bearerToken(adminToken)
      .file('file', Buffer.from('x'.repeat(built.files.get('perch-apd-linux-arm64')!.length)), {
        filename: 'perch-apd-linux-arm64',
      })
    wrong.assertStatus(422)
    wrong.assertBodyContains({ error: 'hash_mismatch' })

    const short = await client
      .put(`/api/v1/agent-updates/releases/${release.id}/files/perch-apd-linux-arm64`)
      .bearerToken(adminToken)
      .file('file', Buffer.from('short'), { filename: 'perch-apd-linux-arm64' })
    short.assertStatus(422)
    short.assertBodyContains({ error: 'size_mismatch' })

    const unknown = await client
      .put(`/api/v1/agent-updates/releases/${release.id}/files/other-file`)
      .bearerToken(adminToken)
      .file('file', Buffer.from('x'), { filename: 'other-file' })
    unknown.assertStatus(404)
    unknown.assertBodyContains({ error: 'artefact_not_in_manifest' })

    const shown = await client
      .get(`/api/v1/agent-updates/releases/${release.id}`)
      .bearerToken(adminToken)
    shown.assertStatus(200)
    assert.equal(shown.body().data.manifest.version, '1.1.0-pre.5')
    const stored = shown.body().data.artefacts.filter((a: { stored: boolean }) => a.stored)
    assert.lengthOf(stored, 1)
  })

  test('refuses bad signatures, unknown keys and invalid manifests', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const built = buildManifest()

    const untrusted = await client
      .post('/api/v1/agent-updates/releases')
      .bearerToken(adminToken)
      .json({ manifest: built.bytes.toString('base64'), signature: built.signature })
    untrusted.assertStatus(422)
    untrusted.assertBodyContains({ error: 'unknown_key', keyId: TEST_KEY_ID })

    await trustTestKey()
    const tampered = Buffer.from(built.bytes)
    tampered[tampered.length - 3] ^= 1
    const bad = await client
      .post('/api/v1/agent-updates/releases')
      .bearerToken(adminToken)
      .json({ manifest: tampered.toString('base64'), signature: built.signature })
    bad.assertStatus(422)
    bad.assertBodyContains({ error: 'bad_signature' })

    const invalidBytes = Buffer.from(JSON.stringify({ schema: 'perch-release/1', product: 'x' }))
    const invalid = await client
      .post('/api/v1/agent-updates/releases')
      .bearerToken(adminToken)
      .json({ manifest: invalidBytes.toString('base64'), signature: signWithTestKey(invalidBytes) })
    invalid.assertStatus(422)
    invalid.assertBodyContains({ error: 'manifest_invalid' })
    assert.equal(
      await AgentRelease.query()
        .count('* as n')
        .first()
        .then((r) => Number(r?.$extras.n)),
      0
    )
  })

  test('operators read, only admins write', async ({ client }) => {
    const { operatorToken } = await seedSetupComplete()
    await trustTestKey()
    await seedRelease()
    const read = await client.get('/api/v1/agent-updates/releases').bearerToken(operatorToken)
    read.assertStatus(200)
    const built = buildManifest({ version: '1.3.0' })
    const write = await client
      .post('/api/v1/agent-updates/releases')
      .bearerToken(operatorToken)
      .json({ manifest: built.bytes.toString('base64'), signature: built.signature })
    write.assertStatus(403)
    const anonymous = await client.get('/api/v1/agent-updates/releases')
    anonymous.assertStatus(401)
  })

  test('withdraw hides a release; delete refuses while a device runs it', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey()
    const { release } = await seedRelease({ version: '1.2.0', store: true })
    const { ap } = await seedAgentAp()
    ap.agentVersion = '1.2.0'
    await ap.save()

    const withdrawn = await client
      .patch(`/api/v1/agent-updates/releases/${release.id}`)
      .bearerToken(adminToken)
      .json({ withdrawn: true })
    withdrawn.assertStatus(200)
    assert.isFalse(withdrawn.body().data.offerable)
    assert.equal(withdrawn.body().data.notOfferableReason, 'withdrawn')
    assert.equal(withdrawn.body().data.devicesOn, 1)

    const list = await client.get('/api/v1/agent-updates/releases').bearerToken(adminToken)
    assert.lengthOf(list.body().data.releases, 0)
    const all = await client
      .get('/api/v1/agent-updates/releases?includeWithdrawn=true')
      .bearerToken(adminToken)
    assert.lengthOf(all.body().data.releases, 1)

    const refused = await client
      .delete(`/api/v1/agent-updates/releases/${release.id}`)
      .bearerToken(adminToken)
    refused.assertStatus(409)
    refused.assertBodyContains({ error: 'release_in_use', devices: 1 })

    ap.agentVersion = '1.1.0'
    await ap.save()
    const deleted = await client
      .delete(`/api/v1/agent-updates/releases/${release.id}`)
      .bearerToken(adminToken)
    deleted.assertStatus(204)
    assert.isNull(await AgentRelease.find(release.id))
    assert.lengthOf(await AgentArtefact.query().where('release_id', release.id), 0)
  })

  test('a release asking for a newer controller is not offerable', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey()
    await seedRelease({ version: '9.0.0', minControllerVersion: '9.0.0' })
    const list = await client.get('/api/v1/agent-updates/releases').bearerToken(adminToken)
    const [release] = list.body().data.releases
    assert.isFalse(release.offerable)
    assert.equal(release.notOfferableReason, 'controller_too_old')
  })
})

test.group('agent updates: file route', (group) => {
  group.each.setup(resetDb)
  group.each.setup(async () => useScratchStore())

  test('serves a stored artefact whole and by range, with the documented headers', async ({
    assert,
  }) => {
    await seedSetupComplete()
    await trustTestKey()
    const { artefacts, built } = await seedRelease({ store: true })
    const artefact = artefacts[0]
    const bytes = built.files.get(artefact.fileName)!
    const url = `${await baseUrl()}${await signedPath(artefact)}`

    const whole = await fetch(url)
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get('accept-ranges'), 'bytes')
    assert.equal(whole.headers.get('etag'), `"sha256:${artefact.sha256}"`)
    assert.equal(whole.headers.get('content-type'), 'application/octet-stream')
    assert.equal(whole.headers.get('cache-control'), 'no-store')
    assert.equal(whole.headers.get('content-length'), String(bytes.length))
    assert.isTrue(Buffer.from(await whole.arrayBuffer()).equals(bytes))

    const ranged = await fetch(url, {
      headers: { 'Range': 'bytes=100-', 'If-Range': `"sha256:${artefact.sha256}"` },
    })
    assert.equal(ranged.status, 206)
    assert.equal(
      ranged.headers.get('content-range'),
      `bytes 100-${bytes.length - 1}/${bytes.length}`
    )
    assert.isTrue(Buffer.from(await ranged.arrayBuffer()).equals(bytes.subarray(100)))

    const otherEtag = await fetch(url, { headers: { 'Range': 'bytes=100-', 'If-Range': '"x"' } })
    assert.equal(otherEtag.status, 200)
    await otherEtag.arrayBuffer()

    const past = await fetch(url, { headers: { Range: `bytes=${bytes.length}-` } })
    assert.equal(past.status, 416)
    await past.arrayBuffer()
  })

  test('refuses bad signatures, expired links and unstored files', async ({ assert }) => {
    await seedSetupComplete()
    await trustTestKey()
    const { artefacts } = await seedRelease({ store: false })
    const artefact = artefacts[0]
    const base = await baseUrl()

    const good = await signedPath(artefact)
    const forged = good.replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`)
    const forgedResponse = await fetch(`${base}${forged}`)
    assert.equal(forgedResponse.status, 403)
    const forgedBody = (await forgedResponse.json()) as { error: string }
    assert.equal(forgedBody.error, 'bad_signature')

    const otherDevice = good.replace('d=ap-4', 'd=ap-5')
    const otherResponse = await fetch(`${base}${otherDevice}`)
    assert.equal(otherResponse.status, 403)

    const expired = await fetch(`${base}${await signedPath(artefact, 'ap-4', -10)}`)
    assert.equal(expired.status, 403)
    const expiredBody = (await expired.json()) as { error: string }
    assert.equal(expiredBody.error, 'expired')

    const missing = await fetch(`${base}${good}`)
    assert.equal(missing.status, 404)
    const missingBody = (await missing.json()) as { error: string }
    assert.equal(missingBody.error, 'artefact_not_stored')
  })
})

type FakeRoute = { status?: number; body: unknown; headers?: Record<string, string> }

function fakeGithub(routes: Record<string, FakeRoute | (() => FakeRoute)>) {
  const requests: string[] = []
  const fake = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push(url)
    const entry = routes[url]
    if (!entry) return new Response('not found', { status: 404 })
    const route = typeof entry === 'function' ? entry() : entry
    const body = Buffer.isBuffer(route.body)
      ? new Uint8Array(route.body)
      : typeof route.body === 'string'
        ? route.body
        : JSON.stringify(route.body)
    return new Response(body, { status: route.status ?? 200, headers: route.headers })
  }) as typeof fetch
  setGithubFetchForTesting(fake)
  return requests
}

const API = (repo: string) => `https://api.github.com/repos/capthndsme/${repo}/releases?per_page=30`
const ASSET = (repo: string, tag: string, name: string) =>
  `https://github.com/capthndsme/${repo}/releases/download/${tag}/${name}`

test.group('agent updates: GitHub mirror (recorded responses, no network)', (group) => {
  group.each.setup(resetDb)
  group.each.setup(async () => useScratchStore())
  group.each.setup(() => () => setGithubFetchForTesting(null))

  test('check imports signed releases, lists unsigned ones, rejects bad ones', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    await trustTestKey()
    const good = buildManifest({ version: '1.2.0' })
    const unsigned = buildManifest({ version: '1.3.0-rc.1' })
    const forged = buildManifest({ version: '1.1.9' })
    const collector = buildManifest({ product: 'perch-collector', version: '1.2.0' })
    const asset = (repo: string, tag: string, name: string) => ({
      name,
      browser_download_url: ASSET(repo, tag, name),
    })
    const requests = fakeGithub({
      [API('perch-apd')]: {
        body: [
          {
            id: 11,
            tag_name: 'v1.3.0-rc.1',
            draft: false,
            assets: [asset('perch-apd', 'v1.3.0-rc.1', 'perch-manifest.json')],
          },
          {
            id: 10,
            tag_name: 'v1.2.0',
            draft: false,
            assets: [
              asset('perch-apd', 'v1.2.0', 'perch-manifest.json'),
              asset('perch-apd', 'v1.2.0', 'perch-manifest.json.sig'),
              asset('perch-apd', 'v1.2.0', 'perch-apd-linux-mipsle'),
            ],
          },
          {
            id: 9,
            tag_name: 'v1.1.9',
            draft: false,
            assets: [
              asset('perch-apd', 'v1.1.9', 'perch-manifest.json'),
              asset('perch-apd', 'v1.1.9', 'perch-manifest.json.sig'),
            ],
          },
          { id: 8, tag_name: 'v1.0.0', draft: false, assets: [] },
          { id: 7, tag_name: 'v9.9.9', draft: true, assets: [] },
        ],
      },
      [ASSET('perch-apd', 'v1.2.0', 'perch-manifest.json')]: { body: good.bytes },
      [ASSET('perch-apd', 'v1.2.0', 'perch-manifest.json.sig')]: { body: good.signature },
      [ASSET('perch-apd', 'v1.2.0', 'perch-apd-linux-mipsle')]: {
        body: good.files.get('perch-apd-linux-mipsle')!,
      },
      [ASSET('perch-apd', 'v1.3.0-rc.1', 'perch-manifest.json')]: { body: unsigned.bytes },
      [ASSET('perch-apd', 'v1.1.9', 'perch-manifest.json')]: { body: forged.bytes },
      [ASSET('perch-apd', 'v1.1.9', 'perch-manifest.json.sig')]: { body: good.signature },
      [API('perch-collector')]: {
        body: [
          {
            id: 20,
            tag_name: 'v1.2.0',
            draft: false,
            assets: [
              asset('perch-collector', 'v1.2.0', 'perch-manifest.json'),
              asset('perch-collector', 'v1.2.0', 'perch-manifest.json.sig'),
            ],
          },
        ],
      },
      [ASSET('perch-collector', 'v1.2.0', 'perch-manifest.json')]: { body: collector.bytes },
      [ASSET('perch-collector', 'v1.2.0', 'perch-manifest.json.sig')]: {
        body: collector.signature,
      },
    })

    const check = await client.post('/api/v1/agent-updates/releases/check').bearerToken(adminToken)
    check.assertStatus(200)
    const found = check.body().data.found as Array<Record<string, unknown>>
    const byVersion = (product: string, version: string) =>
      found.find((entry) => entry.product === product && entry.version === version)
    assert.equal(byVersion('perch-apd', '1.2.0')?.status, 'new')
    assert.equal(byVersion('perch-apd', '1.3.0-rc.1')?.status, 'unsigned')
    assert.equal(byVersion('perch-apd', '1.1.9')?.status, 'rejected')
    assert.equal(byVersion('perch-apd', '1.1.9')?.reason, 'bad_signature')
    assert.equal(byVersion('perch-collector', '1.2.0')?.status, 'new')
    assert.isUndefined(byVersion('perch-apd', '9.9.9'))
    assert.isTrue(requests.every((url) => !url.includes('v9.9.9')))

    const release = await AgentRelease.query()
      .where('product', 'perch-apd')
      .where('version', '1.2.0')
      .firstOrFail()
    assert.equal(release.source, 'github')
    assert.equal(release.githubReleaseId, 10)
    const artefact = await AgentArtefact.query()
      .where('release_id', release.id)
      .where('file_name', 'perch-apd-linux-mipsle')
      .firstOrFail()
    assert.equal(artefact.sourceUrl, ASSET('perch-apd', 'v1.2.0', 'perch-apd-linux-mipsle'))
    assert.isNull(artefact.storedPath)

    // A second check knows it without fetching the manifest again.
    const before = requests.length
    const second = await client.post('/api/v1/agent-updates/releases/check').bearerToken(adminToken)
    assert.equal(
      (second.body().data.found as Array<Record<string, unknown>>).find(
        (entry) => entry.product === 'perch-apd' && entry.version === '1.2.0'
      )?.status,
      'known'
    )
    assert.notInclude(requests.slice(before), ASSET('perch-apd', 'v1.2.0', 'perch-manifest.json'))

    // Fetch on demand: the file route starts the download; the agent's retry gets it.
    const url = `${await baseUrl()}${await signedPath(artefact)}`
    const first = await fetch(url)
    assert.equal(first.status, 404)
    await first.json()
    await eventually(
      () => AgentArtefact.findOrFail(artefact.id),
      (row) => row.storedPath !== null
    )
    const retry = await fetch(url)
    assert.equal(retry.status, 200)
    assert.isTrue(
      Buffer.from(await retry.arrayBuffer()).equals(good.files.get('perch-apd-linux-mipsle')!)
    )
  })

  test('an unreachable GitHub answers 502', async ({ client }) => {
    const { adminToken } = await seedSetupComplete()
    fakeGithub({ [API('perch-apd')]: { status: 503, body: 'down' } })
    const check = await client.post('/api/v1/agent-updates/releases/check').bearerToken(adminToken)
    check.assertStatus(502)
    check.assertBodyContains({ error: 'github_unreachable' })
  })
})
