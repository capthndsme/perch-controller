import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

const ADMIN_PAYLOAD = {
  fullName: 'Admin Person',
  email: 'admin@example.com',
  password: 'admin-pass-123',
  passwordConfirmation: 'admin-pass-123',
}

const SIGNUP_PAYLOAD = {
  fullName: 'Random User',
  email: 'random@example.com',
  password: 'random-pass-123',
  passwordConfirmation: 'random-pass-123',
}

/**
 * Same pattern as `wizard.spec.ts`: truncate both before AND after each
 * test so cross-file ordering can't leak admin rows into the "during setup"
 * case.
 */
async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

/**
 * The legacy `/api/v1/auth/signup` route stays mounted but is now a dead
 * end: 503 during the wizard (the requireSetupComplete middleware), 403
 * after the wizard (the controller-level guard). This spec pins both
 * states so we can't accidentally re-open public signup.
 */
test.group('legacy /auth/signup lockdown', (group) => {
  group.each.setup(resetDb)

  test('returns 503 while setup is in progress', async ({ client }) => {
    const r = await client.post('/api/v1/auth/signup').json(SIGNUP_PAYLOAD)
    r.assertStatus(503)
    r.assertBodyContains({ error: 'setup_required', step: 'admin' })
  })

  test('returns 403 once setup is complete', async ({ client }) => {
    await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    // Bypass the rest of the wizard at the model layer so the test stays
    // focused on the signup lock (we have dedicated wizard tests elsewhere).
    await SystemSetting.set('site_name', 'Perch @ test')
    await SystemSetting.set('timezone', 'UTC')
    await Collector.create({
      name: 'localhost',
      baseUrl: 'http://127.0.0.1:9800',
      pollIntervalSeconds: 15,
      enabled: true,
      apiKey: null,
      lastStatus: null,
    })

    const r = await client.post('/api/v1/auth/signup').json(SIGNUP_PAYLOAD)
    r.assertStatus(403)
    r.assertBodyContains({ error: 'signup_disabled' })
  })
})
