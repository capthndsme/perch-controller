import { idParam } from '#services/portal_errors'
import {
  createSale,
  listSales,
  saleCode,
  saleNotFound,
  sellMenu,
  voidSale,
} from '#services/portal_desk_sales'
import { createSaleValidator, saleListQueryValidator, voidSaleValidator } from '#validators/sell'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Sell Mode (docs/gateway/portal.md section 15.3): admins and Wi-Fi vendors
 * sell portal codes at the desk. The route group admits both roles; the
 * service limits a vendor to their own sales. Codes are in the sale and
 * code answers only (`no-store`).
 */
export default class SellController {
  /** GET /api/v1/sell */
  async menu({ auth }: HttpContext) {
    return { data: await sellMenu(auth.getUserOrFail()) }
  }

  /** POST /api/v1/sell/sales */
  async store({ auth, request, response }: HttpContext) {
    const payload = await request.validateUsing(createSaleValidator)
    const { created, ...result } = await createSale(auth.getUserOrFail(), payload)
    response.header('Cache-Control', 'no-store')
    response.status(created ? 201 : 200)
    return { data: result }
  }

  /** GET /api/v1/sell/sales */
  async index({ auth, request }: HttpContext) {
    const qs = await saleListQueryValidator.validate(request.qs())
    return { data: await listSales(auth.getUserOrFail(), qs) }
  }

  /** GET /api/v1/sell/sales/:id/code */
  async code({ auth, params, response }: HttpContext) {
    const code = await saleCode(auth.getUserOrFail(), idParam(params.id, saleNotFound))
    response.header('Cache-Control', 'no-store')
    return { data: { code } }
  }

  /** POST /api/v1/sell/sales/:id/void */
  async void({ auth, params, request }: HttpContext) {
    const payload = await request.validateUsing(voidSaleValidator)
    return {
      data: await voidSale(auth.getUserOrFail(), idParam(params.id, saleNotFound), payload),
    }
  }
}
