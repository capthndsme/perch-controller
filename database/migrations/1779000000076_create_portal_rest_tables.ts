import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Guest portal REST layer (docs/gateway/portal.md section 11).
 *
 * - `portal_authorizations`: one row per accepted `POST
 *   /portal/authorizations` call (API client or admin token, over HTTP or the
 *   router relay). It is the idempotency ledger (`principal` + `external_ref`
 *   unique: a coin box that retries never credits the same payment twice) and
 *   the audit trail of what each integration granted. `principal` is
 *   `c:<apiClientId>` or `u:<userId>`; `request_sha` is the SHA-256 of the
 *   canonical request, so a replay with other values is refused. Pruned with
 *   the portal history (it names guest MACs).
 * - `portal_outbox`: what must reach a gateway's router (`authorize`,
 *   `deauthorize`, `configure`, `template`, `vouchers`, `sync`) until the
 *   collector socket (WP3) delivers it. One undelivered row per
 *   (gateway, `dedupe_key`): a new request merges into it. The socket side
 *   deletes the rows it has taken, inside the gateway's portal queue.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('portal_authorizations', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table.string('principal', 24).notNullable()
      table
        .integer('api_client_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('portal_api_clients')
        .onDelete('SET NULL')
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.string('external_ref', 64).nullable()
      table
        .integer('portal_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('portals')
        .onDelete('CASCADE')
      table
        .bigInteger('grant_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('portal_grants')
        .onDelete('SET NULL')
      table.specificType('mac', 'CHAR(17)').notNullable()
      table.string('outcome', 12).notNullable()
      table.integer('minutes').unsigned().nullable()
      table.bigInteger('bytes').unsigned().nullable()
      table.specificType('request_sha', 'CHAR(64)').notNullable()
      table.string('via', 8).notNullable().defaultTo('http')
      table.string('address', 45).nullable()
      table.datetime('created_at').notNullable()

      table.unique(['principal', 'external_ref'], 'portal_authorizations_principal_ref_unique_idx')
      table.index(['portal_id', 'created_at'], 'portal_authorizations_portal_time_idx')
      table.index(['created_at'], 'portal_authorizations_time_idx')
    })

    this.schema.createTable('portal_outbox', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('kind', 16).notNullable()
      table.string('dedupe_key', 48).notNullable()
      table
        .integer('portal_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('portals')
        .onDelete('CASCADE')
      table.text('grant_ids').nullable()
      table.integer('attempts').unsigned().notNullable().defaultTo(0)
      table.string('last_error', 255).nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['gateway_id', 'dedupe_key'], 'portal_outbox_gateway_key_unique_idx')
    })
  }

  async down() {
    this.schema.dropTable('portal_outbox')
    this.schema.dropTable('portal_authorizations')
  }
}
