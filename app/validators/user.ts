import vine from '@vinejs/vine'

/**
 * Shared rules for email and password.
 */
const email = () => vine.string().email().maxLength(254)
const password = () => vine.string().minLength(8).maxLength(128)

/**
 * Roles that an admin may assign when creating or updating another account.
 * `operator` is in the USER_ROLES enum for forward-compatibility but is not
 * yet exposed here — it will be added when it gets distinct route-level
 * permissions.
 */
const invitableRoles = ['admin', 'viewer'] as const

/**
 * Validator to use when performing self-signup
 */
export const signupValidator = vine.create({
  fullName: vine.string().nullable(),
  email: email().unique({ table: 'users', column: 'email' }),
  password: password(),
  passwordConfirmation: password().sameAs('password'),
})

/**
 * Validator to use before validating user credentials
 * during login
 */
export const loginValidator = vine.create({
  email: email(),
  password: vine.string(),
})

/**
 * Admin-only: create a new viewer or admin account.
 */
export const inviteUserValidator = vine.create({
  fullName: vine.string().minLength(1).maxLength(120).nullable(),
  email: email().unique({ table: 'users', column: 'email' }),
  password: password(),
  passwordConfirmation: password().sameAs('password'),
  role: vine.enum(invitableRoles),
})

/**
 * Admin-only: change the role of an existing account.
 */
export const updateUserRoleValidator = vine.create({
  role: vine.enum(invitableRoles),
})

/**
 * Self-service: authenticated user changes their own password.
 * `currentPassword` is verified in the controller (not a vine rule) because
 * the check requires the User model + hash comparison.
 */
export const changePasswordValidator = vine.create({
  currentPassword: vine.string(),
  password: password(),
  passwordConfirmation: password().sameAs('password'),
})
