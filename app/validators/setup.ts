import vine from '@vinejs/vine'

/**
 * Shared atomic rules. Width/length bounds mirror the existing
 * `signupValidator` in `user.ts` so admin creation stays consistent with the
 * regular signup path (and the future invite flow that'll replace it).
 */
const email = () => vine.string().email().maxLength(254)
const password = () => vine.string().minLength(8).maxLength(128)

/**
 * Step 1 of the wizard. The unique-email rule prevents collisions with any
 * row that was created via the existing (about-to-be-locked) public signup.
 */
export const setupAdminValidator = vine.create({
  fullName: vine.string().minLength(1).maxLength(120).nullable(),
  email: email().unique({ table: 'users', column: 'email' }),
  password: password(),
  passwordConfirmation: password().sameAs('password'),
})

/**
 * Step 2 of the wizard. `timezone` accepts any string today; the frontend
 * should populate a dropdown of IANA names — we don't reject unknown values
 * because Luxon will simply fall back to UTC at format time.
 */
export const setupInstanceValidator = vine.create({
  siteName: vine.string().trim().minLength(1).maxLength(120),
  timezone: vine.string().trim().minLength(1).maxLength(64),
})

/**
 * Step 3 of the wizard. Poll-interval bounds: 5 s is the practical minimum
 * (the collector's snapshot cost is non-zero), 3600 s an arbitrary cap to
 * avoid typos like 86400 silently disabling collection for a day.
 */
export const setupCollectorValidator = vine.create({
  name: vine.string().trim().minLength(1).maxLength(120),
  baseUrl: vine.string().trim().url({ require_protocol: true }).maxLength(500),
  apiKey: vine.string().trim().minLength(1).maxLength(512).nullable().optional(),
  pollIntervalSeconds: vine.number().min(5).max(3600),
})
