import { assert } from '@japa/assert'
import { apiClient } from '@japa/api-client'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import type { Config } from '@japa/runner/types'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import { dbAssertions } from '@adonisjs/lucid/plugins/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { authApiClient } from '@adonisjs/auth/plugins/api_client'
import { sessionApiClient } from '@adonisjs/session/plugins/api_client'
import type { Registry } from '../.adonisjs/client/registry/schema.d.ts'

/**
 * Hard safety net: every test calls `testUtils.db().truncate()` on its
 * own setup hook. If `.env.test` ever forgets to override `DB_DATABASE`,
 * those truncates wipe the dev/prod database. Refuse to run unless the
 * configured database name ends in `_test`.
 */
const dbName = env.get('DB_DATABASE')
if (!/_test$/.test(dbName)) {
  throw new Error(
    `Refusing to run tests against database "${dbName}". ` +
      `Tests truncate tables and would destroy real data. ` +
      `Set DB_DATABASE to a name ending in "_test" in .env.test (e.g. "hypermetrics_test").`
  )
}

/**
 * This file is imported by the "bin/test.ts" entrypoint file
 */
declare module '@japa/api-client/types' {
  interface RoutesRegistry extends Registry {}
}

/**
 * This file is imported by the "bin/test.ts" entrypoint file
 */

/**
 * Configure Japa plugins in the plugins array.
 * Learn more - https://japa.dev/docs/runner-config#plugins-optional
 */
export const plugins: Config['plugins'] = [
  assert(),
  pluginAdonisJS(app),
  dbAssertions(app),
  apiClient(),
  sessionApiClient(app),
  authApiClient(app),
]

/**
 * Configure lifecycle function to run before and after all the
 * tests.
 *
 * The setup functions are executed before all the tests
 * The teardown functions are executed after all the tests
 */
export const runnerHooks: Required<Pick<Config, 'setup' | 'teardown'>> = {
  /**
   * Migrate the test database before the suite runs and roll back at
   * teardown. `testUtils.db().migrate()` returns a teardown function
   * that Japa adds automatically. With this hook the `_test` database
   * is always brought to the latest schema before tests execute and
   * left clean afterwards.
   */
  setup: [() => testUtils.db().migrate()],
  teardown: [],
}

/**
 * Configure suites by tapping into the test suite instance.
 * Learn more - https://japa.dev/docs/test-suites#lifecycle-hooks
 */
export const configureSuite: Config['configureSuite'] = (suite) => {
  if (['browser', 'functional', 'e2e'].includes(suite.name)) {
    /**
     * The device-agent WebSocket endpoints live on the Node server's
     * `upgrade` event, which the web-only provider hooks in production. Here
     * the server is the one test utils create, so the gateway is attached to
     * it directly — `ws` clients in tests reach `ws://HOST:PORT/api/v1/ap-agent/ws`
     * and `/api/v1/collector-agent/ws`. Sessions are closed before the server,
     * or its close would wait on them.
     */
    return suite.setup(async () => {
      const closeServer = await testUtils.httpServer().start()
      const server = await app.container.make('server')
      const { attachAgentGateway } = await import('#services/agent_gateway')
      const gateway = await attachAgentGateway(server.getNodeServer()!)
      return async () => {
        await gateway.close()
        await closeServer()
      }
    })
  }
}
