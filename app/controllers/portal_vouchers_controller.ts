import { batchNotFound, idParam, voucherNotFound } from '#services/portal_errors'
import { page, parseIsoTime } from '#services/portal_params'
import {
  batchCsv,
  createBatch,
  deleteBatch,
  listBatches,
  listVouchers,
  lookupVoucher,
  revokeBatch,
  revokeVoucher,
  showBatch,
} from '#services/portal_vouchers'
import {
  batchListQueryValidator,
  createBatchValidator,
  voucherListQueryValidator,
  voucherLookupValidator,
} from '#validators/portal'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Voucher batches and vouchers (docs/gateway/portal.md section 11.4),
 * admin-only. Every answer that carries clear-text codes is
 * `Cache-Control: no-store`.
 */
export default class PortalVouchersController {
  /** POST /api/v1/portal/voucher-batches */
  async storeBatch({ auth, request, response }: HttpContext) {
    const payload = await request.validateUsing(createBatchValidator)
    const result = await createBatch(
      {
        portalId: payload.portalId ?? null,
        name: payload.name,
        note: payload.note ?? null,
        count: payload.count,
        codeLength: payload.codeLength ?? 10,
        durationMinutes: payload.durationMinutes ?? null,
        durationMode: payload.durationMode ?? 'wall_clock',
        startMode: payload.startMode ?? 'first_use',
        quotaBytes: payload.quotaBytes ?? null,
        downKbps: payload.downKbps ?? null,
        upKbps: payload.upKbps ?? null,
        maxDevices: payload.maxDevices ?? 1,
        redeemBy: parseIsoTime(payload.redeemBy, 'redeemBy') ?? null,
      },
      auth.user?.id ?? null
    )
    response.header('Cache-Control', 'no-store')
    response.status(201)
    return { data: result }
  }

  /** GET /api/v1/portal/voucher-batches?portalId= */
  async indexBatches({ request }: HttpContext) {
    const qs = await batchListQueryValidator.validate(request.qs())
    return { data: await listBatches(qs) }
  }

  /** GET /api/v1/portal/voucher-batches/:id */
  async showBatch({ params }: HttpContext) {
    return { data: await showBatch(idParam(params.id, batchNotFound)) }
  }

  /** GET /api/v1/portal/voucher-batches/:id/codes: the print sheet's data. */
  async codes({ params, response }: HttpContext) {
    const result = await showBatch(idParam(params.id, batchNotFound), true)
    response.header('Cache-Control', 'no-store')
    return { data: result }
  }

  /** GET /api/v1/portal/voucher-batches/:id/codes.csv */
  async csv({ params, response }: HttpContext) {
    const { filename, csv } = await batchCsv(idParam(params.id, batchNotFound))
    response.header('Cache-Control', 'no-store')
    response.header('Content-Type', 'text/csv; charset=utf-8')
    response.header('Content-Disposition', `attachment; filename="${filename}"`)
    response.header('X-Content-Type-Options', 'nosniff')
    return response.send(csv)
  }

  /** POST /api/v1/portal/voucher-batches/:id/revoke */
  async revokeBatch({ params }: HttpContext) {
    return { data: await revokeBatch(idParam(params.id, batchNotFound)) }
  }

  /** DELETE /api/v1/portal/voucher-batches/:id */
  async destroyBatch({ params, response }: HttpContext) {
    await deleteBatch(idParam(params.id, batchNotFound))
    return response.noContent()
  }

  /** GET /api/v1/portal/vouchers?batchId&portalId&status&limit&offset */
  async index({ request }: HttpContext) {
    const qs = await voucherListQueryValidator.validate(request.qs())
    return { data: await listVouchers({ ...qs, ...page(qs) }) }
  }

  /** POST /api/v1/portal/vouchers/lookup {code} */
  async lookup({ request }: HttpContext) {
    const { code } = await request.validateUsing(voucherLookupValidator)
    return { data: await lookupVoucher(code) }
  }

  /** POST /api/v1/portal/vouchers/:id/revoke */
  async revoke({ params }: HttpContext) {
    return { data: await revokeVoucher(idParam(params.id, voucherNotFound)) }
  }
}
