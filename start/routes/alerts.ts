/*
|--------------------------------------------------------------------------
| Alerts routes (docs/design/alerts/api.md §4)
|--------------------------------------------------------------------------
|
| Imported by start/routes.ts before anything else registers, so every path
| here comes before the SPA catch-all. Inbox, mutes and watches: WP-A1;
| settings and the delivery log: WP-A2; push: WP-A3; webhooks: WP-A4 (the
| controllers of later packages start as 501 stubs).
|
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const AlertsController = () => import('#controllers/alerts_controller')
const AlertMutesController = () => import('#controllers/alert_mutes_controller')
const AlertDeliveriesController = () => import('#controllers/alert_deliveries_controller')
const AlertPushController = () => import('#controllers/alert_push_controller')
const AlertSettingsController = () => import('#controllers/alert_settings_controller')
const AlertWebhooksController = () => import('#controllers/alert_webhooks_controller')

router
  .group(() => {
    // The service worker has no bearer token: the renew token in the body is the credential.
    router.post('alerts/push/renew', [AlertPushController, 'renew']).as('alerts.push.renew')

    router
      .group(() => {
        // Static segments before `:id`.
        router.get('summary', [AlertsController, 'summary']).as('summary')
        router.get('catalogue', [AlertsController, 'catalogue']).as('catalogue')
        router.post('read', [AlertsController, 'read']).as('read')
        router.get('mutes', [AlertMutesController, 'index']).as('mutes.index')
        router.get('watches', [AlertMutesController, 'watches']).as('watches.index')
        router.get('push/config', [AlertPushController, 'config']).as('push.config')
        router.get('push/subscriptions', [AlertPushController, 'index']).as('push.index')
        router.post('push/subscriptions', [AlertPushController, 'store']).as('push.store')
        router
          .post('push/subscriptions/unsubscribe', [AlertPushController, 'unsubscribe'])
          .as('push.unsubscribe')
        router
          .patch('push/subscriptions/:id', [AlertPushController, 'update'])
          .as('push.update')
          .where('id', router.matchers.number())
        router
          .delete('push/subscriptions/:id', [AlertPushController, 'destroy'])
          .as('push.destroy')
          .where('id', router.matchers.number())
        router
          .post('push/subscriptions/:id/test', [AlertPushController, 'test'])
          .as('push.test')
          .where('id', router.matchers.number())
        router.get('', [AlertsController, 'index']).as('index')
        router
          .get(':id', [AlertsController, 'show'])
          .as('show')
          .where('id', router.matchers.number())

        router
          .group(() => {
            router.post('mutes', [AlertMutesController, 'store']).as('mutes.store')
            router
              .delete('mutes/:id', [AlertMutesController, 'destroy'])
              .as('mutes.destroy')
              .where('id', router.matchers.number())
            router
              .put('watches/devices/:mac', [AlertMutesController, 'updateWatch'])
              .as('watches.update')
            router.get('deliveries', [AlertDeliveriesController, 'index']).as('deliveries.index')
            router
              .get('deliveries/:id', [AlertDeliveriesController, 'show'])
              .as('deliveries.show')
              .where('id', router.matchers.number())
            router
              .post(':id/acknowledge', [AlertsController, 'acknowledge'])
              .as('acknowledge')
              .where('id', router.matchers.number())
            router
              .post(':id/resolve', [AlertsController, 'resolve'])
              .as('resolve')
              .where('id', router.matchers.number())
          })
          .use(middleware.requireAdmin())
      })
      .prefix('alerts')
      .as('alerts')
      .use([middleware.auth(), middleware.requirePasswordChange()])

    router
      .group(() => {
        router.get('', [AlertSettingsController, 'show']).as('show')
        router.patch('', [AlertSettingsController, 'update']).as('update')
        router.post('test', [AlertSettingsController, 'test']).as('test')
        router.post('vapid/rotate', [AlertPushController, 'rotate']).as('vapid.rotate')
        router.get('webhooks', [AlertWebhooksController, 'index']).as('webhooks.index')
        router.post('webhooks', [AlertWebhooksController, 'store']).as('webhooks.store')
        router.get('webhooks/:id', [AlertWebhooksController, 'show']).as('webhooks.show')
        router.patch('webhooks/:id', [AlertWebhooksController, 'update']).as('webhooks.update')
        router.delete('webhooks/:id', [AlertWebhooksController, 'destroy']).as('webhooks.destroy')
        router.post('webhooks/:id/test', [AlertWebhooksController, 'test']).as('webhooks.test')
        router
          .post('webhooks/:id/rotate-secret', [AlertWebhooksController, 'rotateSecret'])
          .as('webhooks.rotateSecret')
      })
      .prefix('settings/alerts')
      .as('settings.alerts')
      .where('id', router.matchers.number())
      .use([middleware.auth(), middleware.requirePasswordChange(), middleware.requireAdmin()])
  })
  .prefix('/api/v1')
  .use(middleware.requireSetupComplete())
