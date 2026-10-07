import vine from '@vinejs/vine'

/** Sell Mode desk sales (docs/gateway/portal.md section 15.3). */

const id = () => vine.number().withoutDecimals().min(1)
const note = () => vine.string().trim().maxLength(200).nullable().optional()

export const createSaleValidator = vine.compile(
  vine.object({
    portalId: id(),
    amount: vine.number().withoutDecimals().min(1).max(1_000_000),
    priceRevision: id(),
    /** One per sale attempt, reused on retry: a double tap never sells twice. */
    clientRef: vine
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:-]{8,64}$/),
    note: note(),
  })
)

export const saleListQueryValidator = vine.compile(
  vine.object({
    from: vine.string().trim().maxLength(40).optional(),
    to: vine.string().trim().maxLength(40).optional(),
    portalId: id().optional(),
    sellerId: id().optional(),
    state: vine.enum(['paid', 'voided'] as const).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).max(10_000_000).optional(),
  })
)

export const voidSaleValidator = vine.compile(
  vine.object({
    refundAmount: vine.number().withoutDecimals().min(0).max(10_000_000).nullable().optional(),
    note: note(),
  })
)
