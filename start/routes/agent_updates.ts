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

const AgentUpdatesController = () => import('#controllers/agent_updates_controller')
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
        router.get('fleet', [AgentUpdatesController, 'fleet']).as('fleet')
        router.get('jobs', [AgentUpdatesController, 'jobs']).as('jobs')
        router.get('jobs/:id', [AgentUpdatesController, 'job']).as('job')
        router.get('events', [AgentUpdatesController, 'events']).as('events')
        router.get('releases', [AgentReleasesController, 'index']).as('releases')
        router.get('releases/:id', [AgentReleasesController, 'show']).as('release')
        router
          .group(() => {
            router
              .patch('devices/:kind/:id', [AgentUpdatesController, 'updateDevice'])
              .as('updateDevice')
            router
              .post('devices/:kind/:id/refresh', [AgentUpdatesController, 'refresh'])
              .as('refreshDevice')
            router
              .post('devices/:kind/:id/preflight', [AgentUpdatesController, 'preflight'])
              .as('preflightDevice')
            router
              .post('devices/:kind/:id/update', [AgentUpdatesController, 'update'])
              .as('updateDeviceVersion')
            router
              .post('devices/:kind/:id/rollback', [AgentUpdatesController, 'rollback'])
              .as('rollbackDevice')
            router.post('jobs/:id/abort', [AgentUpdatesController, 'abort']).as('abortJob')
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

    router
      .group(() => {
        router.get('agent-updates', [AgentUpdatesController, 'settings']).as('agentUpdates')
        router
          .patch('agent-updates', [AgentUpdatesController, 'updateSettings'])
          .as('updateAgentUpdates')
      })
      .prefix('settings')
      .as('settings')
      .use([middleware.auth(), middleware.requirePasswordChange(), middleware.requireAdmin()])
  })
  .prefix('/api/v1')
  .use(middleware.requireSetupComplete())
