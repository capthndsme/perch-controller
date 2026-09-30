/*
|--------------------------------------------------------------------------
| Agent updates routes (docs/design/agent-updates/controller.md section 9)
|--------------------------------------------------------------------------
|
| Imported once from start/routes.ts. ES module imports run before the
| importing module's body, so these register before every route there, the
| SPA catch-all included; no path overlaps, so the order among API routes
| does not matter.
|
| Auth: reads `auth + requirePasswordChange`, writes also `requireAdmin`; the
| file route takes only its signed URL. Everything sits behind
| `requireSetupComplete`.
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const AgentReleasesController = () => import('#controllers/agent_releases_controller')
const AgentArtefactsController = () => import('#controllers/agent_artefacts_controller')

router
  .group(() => {
    // Agents: signed URL only (protocol.md section 2).
    router
      .get('agent-updates/files/:artefactId/:file', [AgentArtefactsController, 'download'])
      .where('artefactId', router.matchers.number())
      .as('agentUpdates.download')

    router
      .group(() => {
        router.get('releases', [AgentReleasesController, 'index']).as('releases')
        router.get('releases/:id', [AgentReleasesController, 'show']).as('release')
        router
          .group(() => {
            router.post('releases/check', [AgentReleasesController, 'check']).as('checkReleases')
            router.post('releases', [AgentReleasesController, 'store']).as('storeRelease')
            router
              .put('releases/:id/files/:file', [AgentReleasesController, 'upload'])
              .as('uploadReleaseFile')
            router.patch('releases/:id', [AgentReleasesController, 'update']).as('updateRelease')
            router.delete('releases/:id', [AgentReleasesController, 'destroy']).as('destroyRelease')
          })
          .use(middleware.requireAdmin())
      })
      .prefix('agent-updates')
      .as('agentUpdates')
      .where('id', router.matchers.number())
      .where('kind', /^(ap|collector)$/)
      .use([middleware.auth(), middleware.requirePasswordChange()])
  })
  .prefix('/api/v1')
  .use(middleware.requireSetupComplete())
