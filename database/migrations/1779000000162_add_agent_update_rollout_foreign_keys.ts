import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Agent updates: `agent_update_jobs.rollout_id` (158) and
 * `agent_update_events.rollout_id` (161) were created before the rollouts
 * table (159); their foreign keys follow here. SET NULL: a deleted rollout
 * leaves its jobs and the audit trail in place.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('agent_update_jobs', (table) => {
      table
        .foreign('rollout_id', 'agent_update_jobs_rollout_fk')
        .references('id')
        .inTable('agent_update_rollouts')
        .onDelete('SET NULL')
    })
    this.schema.alterTable('agent_update_events', (table) => {
      table
        .foreign('rollout_id', 'agent_update_events_rollout_fk')
        .references('id')
        .inTable('agent_update_rollouts')
        .onDelete('SET NULL')
    })
  }

  async down() {
    this.schema.alterTable('agent_update_events', (table) => {
      table.dropForeign(['rollout_id'], 'agent_update_events_rollout_fk')
    })
    this.schema.alterTable('agent_update_jobs', (table) => {
      table.dropForeign(['rollout_id'], 'agent_update_jobs_rollout_fk')
    })
  }
}
