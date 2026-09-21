import User from '#models/user'
import { isSetupComplete } from '#services/setup_state'
import { signupValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'
import UserTransformer from '#transformers/user_transformer'

/**
 * Legacy public signup. The route stays mounted (so existing clients get a
 * clear, structured rejection rather than a 404), but it's now a dead end:
 *   - while setup is in progress, the `requireSetupComplete` middleware on
 *     the parent group answers with 503 + the next wizard step;
 *   - once setup completes, this controller answers with 403. The bootstrap
 *     admin is created via POST /api/v1/setup/admin instead, and additional
 *     users will land via a future invite flow.
 */
export default class NewAccountController {
  async store({ request, response, serialize }: HttpContext) {
    if (await isSetupComplete()) {
      return response.forbidden({
        error: 'signup_disabled',
        message:
          'Public signup is disabled. Ask an admin to create your account once the invite flow ships.',
      })
    }

    const { fullName, email, password } = await request.validateUsing(signupValidator)

    const user = await User.create({ fullName, email, password })
    const token = await User.accessTokens.create(user)

    return serialize({
      user: UserTransformer.transform(user),
      token: token.value!.release(),
    })
  }
}
