import { rebindDomainFor } from '#controllers/ap_agents_controller'
import { githubReleaseDownloadUrl, perchVersions } from '#services/perch_version'
import { test } from '@japa/runner'

test.group('perch_version', () => {
  test('reads the version from package.json and pairs the daemons', ({ assert }) => {
    const v = perchVersions()
    assert.match(v.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/)
    assert.match(v.apdVersion, /^(latest|\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?)$/)
    assert.match(v.collectorVersion, /^(latest|\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?)$/)
  })

  test('release download URLs: a tag, or latest', ({ assert }) => {
    assert.equal(
      githubReleaseDownloadUrl('perch-apd', '1.0.0-rc.2'),
      'https://github.com/capthndsme/perch-apd/releases/download/v1.0.0-rc.2'
    )
    assert.equal(
      githubReleaseDownloadUrl('perch-collector', 'latest'),
      'https://github.com/capthndsme/perch-collector/releases/latest/download'
    )
  })

  test('rebind domain: names only', ({ assert }) => {
    assert.equal(rebindDomainFor('http://perch.example.com:8080'), 'perch.example.com')
    assert.equal(rebindDomainFor('https://Perch.Example.com./'), 'perch.example.com')
    assert.equal(rebindDomainFor('http://controller:8080'), 'controller')
    assert.isNull(rebindDomainFor('http://192.168.1.10:8080'))
    assert.isNull(rebindDomainFor('http://[fd00::1]:8080'))
    assert.isNull(rebindDomainFor('http://localhost:3333'))
    assert.isNull(rebindDomainFor('not a url'))
  })
})
