import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import User from '#models/user'

/**
 * `node ace dev:token [--user-id=1]` — print a fresh 1-hour bearer token for
 * the named user. Strictly a dev convenience for hitting auth-gated routes
 * from curl without going through the login flow.
 */
export default class DevTokenCommand extends BaseCommand {
  static commandName = 'dev:token'
  static description = 'Mint a short-lived bearer token for an existing user (dev use only).'

  static options: CommandOptions = {
    startApp: true,
  }

  @flags.number({ description: 'User id to mint a token for (default 1).', default: 1 })
  declare userId: number

  async run(): Promise<void> {
    const user = await User.findOrFail(this.userId)
    const token = await User.accessTokens.create(user, ['*'], {
      name: 'dev:token',
      expiresIn: '1 hour',
    })
    this.logger.log(token.value!.release())
  }
}
