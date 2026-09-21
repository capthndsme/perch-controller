import Collector from '#models/collector'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

/**
 * Smoke test for `node ace inspect:collector`. We register a single
 * collector whose `baseUrl` points to a guaranteed-closed port so the
 * probe fails fast (no need for a live collector in CI). The command
 * still needs to exit cleanly: a failed probe must be reported, not
 * fataled.
 *
 * If we ever want to test the success path, replace `globalThis.fetch`
 * the same way `wizard.spec.ts` does — the command uses the same global.
 */
test.group('inspect:collector command', (group) => {
  group.each.setup(resetDb)

  test('exits 0 even when no collectors are registered', async ({ assert }) => {
    const ace = await app.container.make('ace')
    const command = await ace.exec('inspect:collector', [])
    assert.equal(command.exitCode, 0)
  })

  test('reports a failed probe but does not crash', async ({ assert }) => {
    await Collector.create({
      name: 'unreachable',
      baseUrl: 'http://127.0.0.1:1', // port 1 is reserved/closed
      pollIntervalSeconds: 15,
      enabled: true,
      apiKey: null,
      lastStatus: null,
    })
    const ace = await app.container.make('ace')
    const command = await ace.exec('inspect:collector', [])
    assert.equal(command.exitCode, 0, 'one bad collector should not flip the exit code')
  })

  test('exits 0 when --id matches nothing (operator typo)', async ({ assert }) => {
    const ace = await app.container.make('ace')
    const command = await ace.exec('inspect:collector', ['--id=999'])
    assert.equal(command.exitCode, 0)
  })
})
