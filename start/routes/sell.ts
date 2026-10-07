/*
|--------------------------------------------------------------------------
| Sell Mode routes (docs/gateway/portal.md section 15.3)
|--------------------------------------------------------------------------
|
| Desk sales of portal codes. Admins and Wi-Fi vendors; a vendor sees and
| changes only their own sales. Imported by start/routes.ts before the SPA
| catch-all.
|
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'
import { SELL_ROLES } from '#models/user'

const SellController = () => import('#controllers/sell_controller')

router
  .group(() => {
    router.get('', [SellController, 'menu']).as('menu')
    router.get('sales', [SellController, 'index']).as('sales.index')
    router.post('sales', [SellController, 'store']).as('sales.store')
    router.get('sales/:id/code', [SellController, 'code']).as('sales.code')
    router.post('sales/:id/void', [SellController, 'void']).as('sales.void')
  })
  .prefix('/api/v1/sell')
  .as('sell')
  .use([
    middleware.requireSetupComplete(),
    middleware.auth({ roles: SELL_ROLES }),
    middleware.requirePasswordChange(),
  ])
