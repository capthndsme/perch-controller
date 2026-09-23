import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The config plane's agent wiring and apply lifecycle
 * (docs/gateway/config-plane.md sections 4, 5 and 6).
 *
 * `gateways`:
 * - `observed_ledger` (JSON): the router's sync ledger at the last read,
 *   which the apply planner needs (`planApply({ ledger })`).
 * - `observed_state` (JSON): the rest of the last read's context:
 *   `{ luciPending, uncommitted, readAt }`.
 * - `rejoin_offer` (JSON): set when a gateway came back reset or re-bound
 *   (README 3.7): `{ revision, reason, detectedAt }`; the dashboard offers to
 *   restore that (last confirmed) revision.
 * - `dns_label_names`: device label → DNS name policy (plan 2 section 4.2,
 *   README 7.10): `off` | `review` (default).
 *
 * `gateway_applies`:
 * - `agent_confirmed_at`: the agent half of a confirm (a fresh session and
 *   the first accepted push on it).
 * - `written`, `ledger`, `secret_refs`, `configs`, `changes` (JSON): what
 *   the planner produced, kept for the confirm and the API.
 * - `chain_perch_ids` (JSON, null = every section with work) and
 *   `chain_step`: after a job confirms, the lifecycle plans the next one of
 *   the same request (jobs go out one at a time).
 * - `retried`: a `stale_base` answer was retried once already.
 * - `signed`: sent HMAC-signed (plain-HTTP opt-in, README 7.1).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('gateways', (table) => {
      table.text('observed_ledger', 'mediumtext').nullable()
      table.text('observed_state').nullable()
      table.text('rejoin_offer').nullable()
      table.string('dns_label_names', 8).notNullable().defaultTo('review')
    })

    this.schema.alterTable('gateway_applies', (table) => {
      table.datetime('agent_confirmed_at').nullable()
      table.text('written', 'mediumtext').nullable()
      table.text('ledger').nullable()
      table.text('secret_refs').nullable()
      table.text('configs').nullable()
      table.text('changes', 'mediumtext').nullable()
      table.text('chain_perch_ids').nullable()
      table.smallint('chain_step').unsigned().notNullable().defaultTo(0)
      table.boolean('retried').notNullable().defaultTo(false)
      table.boolean('signed').notNullable().defaultTo(false)
    })
  }

  async down() {
    this.schema.alterTable('gateway_applies', (table) => {
      table.dropColumn('agent_confirmed_at')
      table.dropColumn('written')
      table.dropColumn('ledger')
      table.dropColumn('secret_refs')
      table.dropColumn('configs')
      table.dropColumn('changes')
      table.dropColumn('chain_perch_ids')
      table.dropColumn('chain_step')
      table.dropColumn('retried')
      table.dropColumn('signed')
    })
    this.schema.alterTable('gateways', (table) => {
      table.dropColumn('observed_ledger')
      table.dropColumn('observed_state')
      table.dropColumn('rejoin_offer')
      table.dropColumn('dns_label_names')
    })
  }
}
