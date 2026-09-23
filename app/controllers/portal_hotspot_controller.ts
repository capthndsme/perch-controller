import { idParam } from '#services/portal_errors'
import {
  checkoutNotFound,
  createPriceTable,
  createTerminal,
  creditCheckout,
  deletePriceTable,
  deleteTerminal,
  dismissCheckout,
  listCheckouts,
  listPriceTables,
  listTerminals,
  priceTableNotFound,
  quotePriceTable,
  rotateTerminal,
  showCheckout,
  showPriceTable,
  showTerminal,
  terminalNotFound,
  updatePriceTable,
  updateTerminal,
  voidCheckout,
} from '#services/portal_hotspot'
import {
  checkoutListQueryValidator,
  createPriceTableValidator,
  createTerminalValidator,
  creditCheckoutValidator,
  dismissCheckoutValidator,
  quoteValidator,
  terminalListQueryValidator,
  updatePriceTableValidator,
  updateTerminalValidator,
  voidCheckoutValidator,
} from '#validators/portal'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Paid Hotspot administration (docs/gateway/portal.md section 14.9): price
 * tables, coin terminals, the payment ledger. Reads: any signed-in user.
 * Writes: admins. A terminal token is in the answer of create and rotate
 * only, a credited voucher code in the credit answer only (`no-store`).
 */
export default class PortalHotspotController {
  // --- price tables -----------------------------------------------------------

  /** GET /api/v1/portal/price-tables */
  async priceTables() {
    return { data: await listPriceTables() }
  }

  /** GET /api/v1/portal/price-tables/:id */
  async priceTable({ params }: HttpContext) {
    return { data: await showPriceTable(idParam(params.id, priceTableNotFound)) }
  }

  /** POST /api/v1/portal/price-tables */
  async storePriceTable({ auth, request, response }: HttpContext) {
    const payload = await request.validateUsing(createPriceTableValidator)
    response.status(201)
    return { data: await createPriceTable(payload, auth.user?.id ?? null) }
  }

  /** PATCH /api/v1/portal/price-tables/:id */
  async updatePriceTable({ params, request }: HttpContext) {
    const id = idParam(params.id, priceTableNotFound)
    const payload = await request.validateUsing(updatePriceTableValidator)
    return { data: await updatePriceTable(id, payload) }
  }

  /** DELETE /api/v1/portal/price-tables/:id */
  async destroyPriceTable({ params, response }: HttpContext) {
    await deletePriceTable(idParam(params.id, priceTableNotFound))
    return response.noContent()
  }

  /** POST /api/v1/portal/price-tables/:id/quote {amount} */
  async quote({ params, request }: HttpContext) {
    const id = idParam(params.id, priceTableNotFound)
    const { amount } = await request.validateUsing(quoteValidator)
    return { data: await quotePriceTable(id, amount) }
  }

  // --- terminals --------------------------------------------------------------

  /** GET /api/v1/portal/terminals?portalId= */
  async terminals({ request }: HttpContext) {
    const qs = await terminalListQueryValidator.validate(request.qs())
    return { data: await listTerminals(qs) }
  }

  /** GET /api/v1/portal/terminals/:id */
  async terminal({ params }: HttpContext) {
    return { data: await showTerminal(idParam(params.id, terminalNotFound)) }
  }

  /** POST /api/v1/portal/terminals */
  async storeTerminal({ auth, request, response }: HttpContext) {
    const payload = await request.validateUsing(createTerminalValidator)
    const result = await createTerminal(payload, auth.user?.id ?? null)
    response.header('Cache-Control', 'no-store')
    response.status(201)
    return { data: result }
  }

  /** PATCH /api/v1/portal/terminals/:id */
  async updateTerminal({ params, request }: HttpContext) {
    const id = idParam(params.id, terminalNotFound)
    const payload = await request.validateUsing(updateTerminalValidator)
    return { data: await updateTerminal(id, payload) }
  }

  /** POST /api/v1/portal/terminals/:id/rotate */
  async rotateTerminal({ params, response }: HttpContext) {
    const result = await rotateTerminal(idParam(params.id, terminalNotFound))
    response.header('Cache-Control', 'no-store')
    return { data: result }
  }

  /** DELETE /api/v1/portal/terminals/:id */
  async destroyTerminal({ params, response }: HttpContext) {
    await deleteTerminal(idParam(params.id, terminalNotFound))
    return response.noContent()
  }

  // --- ledger -----------------------------------------------------------------

  /** GET /api/v1/portal/checkouts */
  async checkouts({ request }: HttpContext) {
    const qs = await checkoutListQueryValidator.validate(request.qs())
    return { data: await listCheckouts(qs) }
  }

  /** GET /api/v1/portal/checkouts/:id */
  async checkout({ params }: HttpContext) {
    return { data: await showCheckout(idParam(params.id, checkoutNotFound)) }
  }

  /** POST /api/v1/portal/checkouts/:id/void */
  async void({ auth, params, request }: HttpContext) {
    const id = idParam(params.id, checkoutNotFound)
    const payload = await request.validateUsing(voidCheckoutValidator)
    return { data: await voidCheckout(id, payload, auth.user?.id ?? null) }
  }

  /** POST /api/v1/portal/checkouts/:id/credit */
  async credit({ auth, params, request, response }: HttpContext) {
    const id = idParam(params.id, checkoutNotFound)
    const payload = await request.validateUsing(creditCheckoutValidator)
    const result = await creditCheckout(id, payload, auth.user?.id ?? null)
    response.header('Cache-Control', 'no-store')
    return { data: result }
  }

  /** POST /api/v1/portal/checkouts/:id/dismiss */
  async dismiss({ auth, params, request }: HttpContext) {
    const id = idParam(params.id, checkoutNotFound)
    const payload = await request.validateUsing(dismissCheckoutValidator)
    return { data: await dismissCheckout(id, payload, auth.user?.id ?? null) }
  }
}
