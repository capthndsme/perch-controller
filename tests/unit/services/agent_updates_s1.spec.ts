import {
  artefactPath,
  checkArtefactToken,
  deriveDownloadKey,
  signArtefactUrl,
} from '#services/agent_updates/download_tokens'
import { trustedKeys } from '#services/agent_updates/keys'
import { ManifestError, parseManifest } from '#services/agent_updates/manifest'
import {
  AGENT_UPDATE_DEFAULTS,
  normalizeAgentUpdateSettings,
} from '#services/agent_updates/settings'
import { parsePublicKey, parseSignature, verifySignature } from '#services/agent_updates/signify'
import {
  compareVersions,
  normalisePackageVersion,
  versionSortKey,
} from '#services/agent_updates/versions'
import app from '@adonisjs/core/services/app'
import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = () => app.makePath('tests/fixtures/agent_updates')
const read = (name: string) => readFileSync(join(dir(), name))

type Vector = { a: string; b: string; cmp: number } | { pkg: string; release: string }

test.group('agent updates: versions (shared vectors)', () => {
  test('every comparison vector holds both ways', ({ assert }) => {
    const vectors = JSON.parse(read('versions.json').toString('utf8')) as Vector[]
    let checked = 0
    for (const vector of vectors) {
      if ('cmp' in vector) {
        assert.equal(compareVersions(vector.a, vector.b), vector.cmp, `${vector.a} vs ${vector.b}`)
        assert.equal(compareVersions(vector.b, vector.a), -vector.cmp, `${vector.b} vs ${vector.a}`)
        checked++
      } else {
        assert.equal(normalisePackageVersion(vector.pkg), vector.release, vector.pkg)
        checked++
      }
    }
    assert.isAbove(checked, 20)
  })

  test('the sort key orders like compareVersions', ({ assert }) => {
    const versions = [
      '1.0.0',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha-x',
      '1.0.0-alpha.beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.1.0-pre.2',
      '1.1.0-pre.10',
      '1.10.0',
      '2.0.0',
      '0.9.9',
    ]
    const byKey = [...versions].sort((a, b) =>
      versionSortKey(a) < versionSortKey(b) ? -1 : versionSortKey(a) > versionSortKey(b) ? 1 : 0
    )
    const byCompare = [...versions].sort(compareVersions)
    assert.deepEqual(byKey, byCompare)
    assert.equal(versionSortKey('dev'), '')
  })
})

test.group('agent updates: signify', () => {
  test('the fixture signature verifies with the test key', ({ assert }) => {
    const key = parsePublicKey(read('signify/test.pub').toString('utf8'))
    assert.lengthOf(key.keyId, 16)
    const outcome = verifySignature(
      read('signify/manifest.json'),
      read('signify/manifest.json.sig').toString('utf8'),
      [key]
    )
    assert.deepEqual(outcome, { ok: true, keyId: key.keyId })
    // The key line alone parses to the same key id (UCI update_key form).
    const line = read('signify/test.pub').toString('utf8').trim().split('\n')[1]
    assert.equal(parsePublicKey(line).keyId, key.keyId)
  })

  test('a tampered manifest or signature is bad_signature', ({ assert }) => {
    const key = parsePublicKey(read('signify/test.pub').toString('utf8'))
    const sig = read('signify/manifest.json.sig').toString('utf8')
    const outcome = verifySignature(read('signify/manifest.tampered.json'), sig, [key])
    assert.deepEqual(outcome, { ok: false, error: 'bad_signature', keyId: key.keyId })
    const tamperedSig = read('signify/manifest.json.sig.tampered').toString('utf8')
    const second = verifySignature(read('signify/manifest.json'), tamperedSig, [key])
    assert.equal(second.ok, false)
  })

  test('an untrusted key is unknown_key; garbage is bad_signature', ({ assert }) => {
    const sig = read('signify/manifest.json.sig').toString('utf8')
    const outcome = verifySignature(read('signify/manifest.json'), sig, [])
    assert.equal(outcome.ok, false)
    assert.equal(!outcome.ok && outcome.error, 'unknown_key')
    assert.equal(!outcome.ok && outcome.keyId, parseSignature(sig).keyId)
    const garbage = verifySignature(read('signify/manifest.json'), 'nonsense', [])
    assert.deepEqual(garbage, { ok: false, error: 'bad_signature', keyId: null })
    assert.throws(() => parseSignature('untrusted comment: x\nRWQ=\n'))
    assert.throws(() => parsePublicKey('RWQ2'))
  })

  test('trusted keys come from extraTrustedKeys, invalid entries skipped', ({ assert }) => {
    const pub = read('signify/test.pub').toString('utf8')
    const keys = trustedKeys({ extraTrustedKeys: [pub, 'not a key', pub] })
    assert.lengthOf(keys, 1)
    assert.match(keys[0].label, /Perch test key/)
    assert.isFalse(keys[0].builtIn)
  })
})

test.group('agent updates: manifest', () => {
  test('the fixture manifest parses', ({ assert }) => {
    const manifest = parseManifest(read('signify/manifest.json'))
    assert.equal(manifest.product, 'perch-apd')
    assert.equal(manifest.version, '1.2.0')
    assert.equal(manifest.minVersion, '1.1.0')
    assert.lengthOf(manifest.artefacts, 1)
    assert.equal(manifest.artefacts[0].kind, 'binary')
  })

  test('refuses what protocol.md 1.1 refuses', ({ assert }) => {
    const base = JSON.parse(read('signify/manifest.json').toString('utf8'))
    const bad = (patch: Record<string, unknown>) => {
      try {
        parseManifest(Buffer.from(JSON.stringify({ ...base, ...patch })))
        return null
      } catch (error) {
        assert.instanceOf(error, ManifestError)
        return (error as ManifestError).detail
      }
    }
    assert.match(bad({ schema: 'perch-release/2' })!, /schema/)
    assert.match(bad({ product: 'perch-controller' })!, /product/)
    assert.match(bad({ version: 'v1.2.0' })!, /version/)
    assert.match(bad({ channel: 'stable', version: '1.2.0-rc.1' })!, /stable/)
    assert.match(bad({ notesUrl: 'http://example.com/x' })!, /notesUrl/)
    assert.match(bad({ artefacts: [] })!, /artefacts/)
    const artefact = base.artefacts[0]
    assert.match(bad({ artefacts: [artefact, artefact] })!, /duplicate/)
    assert.match(bad({ artefacts: [{ ...artefact, file: '../x' }] })!, /file/)
    assert.match(bad({ artefacts: [{ ...artefact, sha256: 'ABC' }] })!, /sha256/)
    assert.match(bad({ artefacts: [{ ...artefact, size: 64 * 1024 * 1024 + 1 }] })!, /64 MiB/)
    assert.match(bad({ artefacts: [{ ...artefact, arch: 'x86_64' }] })!, /arch/)
    assert.match(
      bad({
        artefacts: [
          {
            file: 'f.tar.gz',
            kind: 'files',
            size: 10,
            sha256: artefact.sha256,
            members: [
              {
                name: 'passwd',
                path: '/etc/passwd',
                mode: '0644',
                sha256: artefact.sha256,
                installKinds: ['swapped'],
                when: 'always',
              },
            ],
          },
        ],
      })!,
      /allowlist/
    )
    assert.match(
      bad({
        artefacts: [
          {
            file: 'perch-apd_1.2.0-r1_mipsel_24kc.ipk',
            kind: 'package',
            manager: 'opkg',
            openwrt: '24.10',
            pkgArch: 'mipsel_24kc',
            package: 'perch-qos',
            packageVersion: '1.2.0-r1',
            size: 10,
            sha256: artefact.sha256,
          },
        ],
      })!,
      /package/
    )
  })
})

test.group('agent updates: download tokens', () => {
  const key = deriveDownloadKey('0123456789abcdef0123456789abcdef')

  test('vector: the HMAC is over the documented string', ({ assert }) => {
    const sig = signArtefactUrl(key, {
      artefactId: 31,
      file: 'perch-apd-linux-mipsle',
      deviceKey: 'ap-4',
      exp: 1790003600,
    })
    assert.match(sig, /^[0-9a-f]{64}$/)
    const path = artefactPath(key, {
      artefactId: 31,
      file: 'perch-apd-linux-mipsle',
      deviceKey: 'ap-4',
      exp: 1790003600,
    })
    assert.equal(
      path,
      `/api/v1/agent-updates/files/31/perch-apd-linux-mipsle?d=ap-4&exp=1790003600&sig=${sig}`
    )
  })

  test('checks signature, device key and expiry', ({ assert }) => {
    const parts = { artefactId: 7, file: 'x.ipk', deviceKey: 'collector-1', exp: 2000 }
    const sig = signArtefactUrl(key, parts)
    const input = { artefactId: 7, file: 'x.ipk', d: 'collector-1', exp: '2000', sig }
    assert.deepEqual(checkArtefactToken(key, input, 1999), { ok: true })
    assert.deepEqual(checkArtefactToken(key, input, 2001), { ok: false, error: 'expired' })
    assert.deepEqual(checkArtefactToken(key, { ...input, d: 'collector-2' }, 1999), {
      ok: false,
      error: 'bad_signature',
    })
    assert.deepEqual(checkArtefactToken(key, { ...input, artefactId: 8 }, 1999), {
      ok: false,
      error: 'bad_signature',
    })
    assert.deepEqual(checkArtefactToken(key, { ...input, sig: 'zz' }, 1999), {
      ok: false,
      error: 'bad_signature',
    })
  })
})

test.group('agent updates: settings', () => {
  test('clamps numbers, drops wrong types, keeps defaults', ({ assert }) => {
    const settings = normalizeAgentUpdateSettings({
      probationSeconds: 5,
      minPushes: 999,
      githubCheck: 'yes',
      defaultChannel: 'local',
      windowDays: [6, 1, 1, 9, -1],
      windowStart: '25:00',
      extraTrustedKeys: ['a', '', 3],
    })
    assert.equal(settings.probationSeconds, 60)
    assert.equal(settings.minPushes, 20)
    assert.equal(settings.githubCheck, AGENT_UPDATE_DEFAULTS.githubCheck)
    assert.equal(settings.defaultChannel, 'local')
    assert.deepEqual(settings.windowDays, [1, 6])
    assert.equal(settings.windowStart, '02:00')
    assert.deepEqual(settings.extraTrustedKeys, ['a'])
  })
})
