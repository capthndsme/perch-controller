import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'

/**
 * Wi-Fi management REST (docs/design/wifi controller.md section 7.2).
 * Registered from `start/routes.ts` right before the SPA catch-all.
 *
 * The per-AP plane lives under `/wifi/config/aps/:apId/…` (the design's
 * `/wifi/aps/…`): `/wifi/aps` and `/wifi/aps/:id/health` are the
 * monitoring pages' routes. Every signed-in user reads; writes are
 * admin-only (step-up passwords where the gateway has them).
 */

const Aps = () => import('#controllers/wifi_config_aps_controller')
const Networks = () => import('#controllers/wifi_config_networks_controller')
const Radios = () => import('#controllers/wifi_config_radios_controller')
const Divergences = () => import('#controllers/wifi_config_divergences_controller')
const Adoption = () => import('#controllers/wifi_config_adoption_controller')
const Rollouts = () => import('#controllers/wifi_config_rollouts_controller')
const Settings = () => import('#controllers/wifi_config_settings_controller')

const signedIn = () => [middleware.auth(), middleware.requirePasswordChange()]

export function registerWifiRoutes() {
  router
    .group(() => {
      // ── overview, access points and their config plane ──
      router
        .group(() => {
          router.get('config', [Aps, 'overview']).as('overview')
          router
            .group(() => {
              router.get('', [Aps, 'index']).as('index')
              router.get(':apId', [Aps, 'show']).as('show')
              router.get(':apId/health', [Aps, 'health']).as('health')
              router.get(':apId/sync-status', [Aps, 'syncStatus']).as('syncStatus')
              router.get(':apId/sections', [Aps, 'sections']).as('sections')
              router.get(':apId/sections/:perchId', [Aps, 'section']).as('section')
              router.get(':apId/draft', [Aps, 'draft']).as('draft')
              router.get(':apId/applies', [Aps, 'applies']).as('applies')
              router.get(':apId/applies/:applyId', [Aps, 'apply']).as('apply')
              router.get(':apId/revisions', [Aps, 'revisions']).as('revisions')
              router
                .get(':apId/revisions/:number', [Aps, 'revision'])
                .as('revision')
                .where('number', router.matchers.number())
              router.get(':apId/events', [Aps, 'events']).as('events')
              router.get(':apId/pairing', [Aps, 'pairing']).as('pairing')
              router
                .group(() => {
                  router.patch(':apId', [Aps, 'update']).as('update')
                  router.post(':apId/refresh', [Aps, 'refresh']).as('refresh')
                  router.post(':apId/rejoin', [Aps, 'rejoin']).as('rejoin')
                  router.post(':apId/rejoin/dismiss', [Aps, 'dismissRejoin']).as('dismissRejoin')
                  router
                    .patch(':apId/sections/:perchId', [Aps, 'updateSection'])
                    .as('updateSection')
                  router.post(':apId/sections/resolve', [Aps, 'resolve']).as('resolve')
                  router.delete(':apId/draft', [Aps, 'discardDraft']).as('discardDraft')
                  router
                    .post(':apId/applies/:applyId/confirm', [Aps, 'confirmApply'])
                    .as('confirmApply')
                  router
                    .post(':apId/applies/:applyId/revert', [Aps, 'revertApply'])
                    .as('revertApply')
                  router
                    .post(':apId/revisions/:number/restore', [Aps, 'restoreRevision'])
                    .as('restoreRevision')
                    .where('number', router.matchers.number())
                  router.post(':apId/drift/accept', [Aps, 'acceptDrift']).as('acceptDrift')
                  router.post(':apId/drift/revert-now', [Aps, 'revertDrift']).as('revertDrift')
                  router
                    .post(':apId/enforcement/resume', [Aps, 'resumeEnforcement'])
                    .as('resumeEnforcement')
                  router.post(':apId/pairing', [Aps, 'pairingUnavailable']).as('startPairing')
                  router
                    .post(':apId/pairing/confirm', [Aps, 'pairingUnavailable'])
                    .as('confirmPairing')
                  router.delete(':apId/pairing', [Aps, 'pairingUnavailable']).as('unpair')
                  router.patch(':apId/radios/:section', [Radios, 'update']).as('updateRadio')
                })
                .use(middleware.requireAdmin())
            })
            .prefix('config/aps')
            .as('aps')
            .where('apId', router.matchers.number())

          // ── radios ──
          router.get('radios', [Radios, 'index']).as('radios.index')

          // ── networks ──
          router
            .group(() => {
              router.get('', [Networks, 'index']).as('index')
              router.get(':id', [Networks, 'show']).as('show')
              router
                .group(() => {
                  router.post('', [Networks, 'store']).as('store')
                  router.patch(':id', [Networks, 'update']).as('update')
                  router.delete(':id', [Networks, 'destroy']).as('destroy')
                  router.post(':id/passphrase', [Networks, 'setPassphrase']).as('setPassphrase')
                  router
                    .get(':id/passphrase', [Networks, 'revealPassphrase'])
                    .as('revealPassphrase')
                  router
                    .put(':id/aps/:apId', [Networks, 'putAp'])
                    .as('putAp')
                    .where('apId', router.matchers.number())
                  router
                    .delete(':id/aps/:apId/overrides', [Networks, 'resetAp'])
                    .as('resetAp')
                    .where('apId', router.matchers.number())
                })
                .use(middleware.requireAdmin())
            })
            .prefix('networks')
            .as('networks')
            .where('id', router.matchers.number())

          // ── divergences and adoption ──
          router.get('divergences', [Divergences, 'index']).as('divergences.index')
          router.get('adoption', [Adoption, 'show']).as('adoption.show')
          router
            .group(() => {
              router.post('divergences/resolve', [Divergences, 'resolve']).as('divergences.resolve')
              router.post('adoption', [Adoption, 'accept']).as('adoption.accept')
            })
            .use(middleware.requireAdmin())

          // ── rollouts ──
          router
            .group(() => {
              router.get('', [Rollouts, 'index']).as('index')
              router.get('current', [Rollouts, 'current']).as('current')
              router
                .get(':rolloutId', [Rollouts, 'show'])
                .as('show')
                .where('rolloutId', router.matchers.number())
              router
                .group(() => {
                  router.post('preview', [Rollouts, 'preview']).as('preview')
                  router.post('', [Rollouts, 'store']).as('store')
                  router
                    .post(':rolloutId/:action', [Rollouts, 'action'])
                    .as('action')
                    .where('rolloutId', router.matchers.number())
                    .where('action', /^(pause|resume|cancel|retry|skip|rollback)$/)
                })
                .use(middleware.requireAdmin())
            })
            .prefix('rollouts')
            .as('rollouts')
        })
        .prefix('wifi')
        .as('wifiConfig')
        .use(signedIn())

      // ── Settings → Wi-Fi management ──
      router
        .group(() => {
          router.get('wifi-config', [Settings, 'show']).as('show')
          router.patch('wifi-config', [Settings, 'update']).as('update')
        })
        .prefix('settings')
        .as('wifiConfigSettings')
        .use([...signedIn(), middleware.requireAdmin()])
    })
    .prefix('/api/v1')
    .use(middleware.requireSetupComplete())
}
