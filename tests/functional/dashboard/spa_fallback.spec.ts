import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { access } from 'node:fs/promises'

/**
 * The API serves the built dashboard; anything that is not an API path falls
 * back to index.html. The dashboard is only present when it has been built,
 * so the fallback assertion adapts to the checkout state.
 */
test.group('Dashboard SPA fallback', () => {
  test('unknown API paths stay JSON 404s', async ({ client, assert }) => {
    const r = await client.get('/api/v1/definitely-not-a-route')
    r.assertStatus(404)
    assert.match(String(r.header('content-type')), /application\/json/)
  })

  test('client-side routes resolve to index.html when the dashboard is built', async ({
    client,
    assert,
  }) => {
    const index = app.publicPath('index.html')
    const built = await access(index).then(
      () => true,
      () => false
    )
    for (const path of ['/', '/devices/aa-bb-cc-dd-ee-ff', '/wifi']) {
      const r = await client.get(path)
      if (built) {
        r.assertStatus(200)
        assert.match(String(r.header('content-type')), /text\/html/)
        r.assertHeader('cache-control', 'no-cache')
      } else {
        r.assertStatus(404)
        assert.match(String((r.body() as { error?: string }).error), /Dashboard not built/)
      }
    }
  })

  test('a missing built asset is a 404, never index.html', async ({ client, assert }) => {
    // What a tab open across a redeploy asks for: a chunk of the previous build.
    for (const path of ['/assets/page-deadbeef.js', '/assets/index-deadbeef.css']) {
      const r = await client.get(path)
      r.assertStatus(404)
      assert.notMatch(String(r.header('content-type')), /text\/html/)
      r.assertHeader('cache-control', 'no-cache')
    }
  })
})
